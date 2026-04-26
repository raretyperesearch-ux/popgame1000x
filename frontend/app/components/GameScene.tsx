"use client";

import {
  useEffect,
  useRef,
  useCallback,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react";
import type { HistoryEntry } from "./HistoryStrip";
import { connectPriceStream } from "@/lib/ws";

/* ============ CONSTANTS ============ */
const GRAVITY_P = 0.004; // price-space gravity per frame (60fps base)
const DRAG = 0.96;
const THRUST_MULT = 3.5; // thrust multiplier for smoothed price delta
const VY_CLAMP_P = 0.6; // max velocity in price-space
const FIG_BODY_X = 18;
const FIGURE_FOOT_OFFSET = 10;
const FIG_X_PCT = 0.35; // figure at 35% from left
const CHART_TOP_PCT = 0.12; // chart area top
const CHART_BOT_PCT = 0.88; // chart area bottom
const VISIBLE_POINTS = 90; // price points visible on screen
const TOTAL_POINTS = 150; // buffer size
const CHART_SPEED_IDLE = 0.25; // sub-point scroll per frame (idle)
const CHART_SPEED_RUN = 1.0; // sub-point scroll per frame (running)
const CHART_SPEED_LIVE = 0.45; // sub-point scroll per frame (live)
const PRICE_VOL = 0.65; // random walk step for new chart points
const MOCK_DRIFT = 0.18; // per-frame mini drift
const JITTER = 1.0; // hand-drawn jitter amplitude
const STEP_FREQ = 4.2; // step cycles per second during run
const BODY_BOB_PX = 3.5; // vertical bob amplitude during run
const DUST_MAX = 15; // max dust particles alive
const DUST_LIFE = 0.45; // seconds each dust particle lives
const RUN_DURATION = 1200; // ms of running before jump
const JUMP_DURATION = 500; // ms of jump liftoff before LIVE
const BODY_HEIGHT_PX = 22;
const CAMERA_LERP = 0.2;
const DEBUG_FEET = false;

type GameState = "IDLE" | "RUNNING" | "JUMPING" | "LIVE" | "STOPPED" | "DEAD";

/* ============ FIGURE POSE HELPERS ============ */
const HIP = { x: 18, y: 28 };
const SHO = { x: 18, y: 14 };
const UP_LEG = 10,
  LO_LEG = 10,
  UP_ARM = 7,
  LO_ARM = 7;

function limbPos(
  origin: { x: number; y: number },
  angle: number,
  len: number,
) {
  return {
    x: origin.x + Math.sin(angle) * len,
    y: origin.y + Math.cos(angle) * len,
  };
}

interface LimbAttrs {
  x1: string;
  y1: string;
  x2: string;
  y2: string;
}

function legAttrs(
  hipAngle: number,
  kneeBend: number,
): { up: LimbAttrs; lo: LimbAttrs; foot: { cx: string; cy: string } } {
  const knee = limbPos(HIP, hipAngle, UP_LEG);
  const loAngle = hipAngle - kneeBend;
  const foot = limbPos(knee, loAngle, LO_LEG);
  return {
    up: {
      x1: HIP.x.toFixed(1),
      y1: HIP.y.toFixed(1),
      x2: knee.x.toFixed(1),
      y2: knee.y.toFixed(1),
    },
    lo: {
      x1: knee.x.toFixed(1),
      y1: knee.y.toFixed(1),
      x2: foot.x.toFixed(1),
      y2: foot.y.toFixed(1),
    },
    foot: { cx: foot.x.toFixed(1), cy: (foot.y + 0.5).toFixed(1) },
  };
}

function armAttrs(
  shoulderAngle: number,
  elbowBend: number,
): { up: LimbAttrs; lo: LimbAttrs; hand: { cx: string; cy: string } } {
  const elbow = limbPos(SHO, shoulderAngle, UP_ARM);
  const loAngle = shoulderAngle - elbowBend;
  const hand = limbPos(elbow, loAngle, LO_ARM);
  return {
    up: {
      x1: SHO.x.toFixed(1),
      y1: SHO.y.toFixed(1),
      x2: elbow.x.toFixed(1),
      y2: elbow.y.toFixed(1),
    },
    lo: {
      x1: elbow.x.toFixed(1),
      y1: elbow.y.toFixed(1),
      x2: hand.x.toFixed(1),
      y2: hand.y.toFixed(1),
    },
    hand: { cx: hand.x.toFixed(1), cy: hand.y.toFixed(1) },
  };
}

function getPose(name: string, frame: number) {
  let lL, lR, aL, aR;
  switch (name) {
    case "standing":
      lL = legAttrs(-0.18, 0);
      lR = legAttrs(0.18, 0);
      aL = armAttrs(-0.4, 0.2);
      aR = armAttrs(0.4, 0.2);
      break;
    case "run": {
      const phase = frame * 0.5;
      const phaseL = phase,
        phaseR = phase + Math.PI;
      lL = legAttrs(
        Math.sin(phaseL) * 0.85,
        Math.max(0.2, 0.4 - Math.sin(phaseL) * 0.9),
      );
      lR = legAttrs(
        Math.sin(phaseR) * 0.85,
        Math.max(0.2, 0.4 - Math.sin(phaseR) * 0.9),
      );
      aL = armAttrs(Math.sin(phaseR) * 0.7 - 0.1, 1.2);
      aR = armAttrs(Math.sin(phaseL) * 0.7 + 0.1, 1.2);
      break;
    }
    case "jetpack": {
      const wob = Math.sin(frame * 0.3) * 0.08;
      lL = legAttrs(-0.15 + wob, 0.2);
      lR = legAttrs(0.15 - wob, 0.2);
      aL = armAttrs(-1.4 + wob, 0.3);
      aR = armAttrs(1.4 - wob, 0.3);
      break;
    }
    case "falling": {
      const flailA = Math.sin(frame * 0.35) * 0.7;
      const flailB = Math.cos(frame * 0.4) * 0.7;
      lL = legAttrs(-0.6 + flailA, 0.6);
      lR = legAttrs(0.6 + flailB, 0.6);
      aL = armAttrs(-1.8 + flailB, 0.9);
      aR = armAttrs(1.8 - flailA, 0.9);
      break;
    }
    case "parachute":
      lL = legAttrs(-0.2, 0.1);
      lR = legAttrs(0.2, 0.1);
      aL = armAttrs(-2.4, 0.3);
      aR = armAttrs(2.4, 0.3);
      break;
    default:
      lL = legAttrs(-0.18, 0);
      lR = legAttrs(0.18, 0);
      aL = armAttrs(-0.4, 0.2);
      aR = armAttrs(0.4, 0.2);
  }
  return { lL, lR, aL, aR };
}

/* ============ UTILITY ============ */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function generatePriceSeries(count: number, start: number): number[] {
  const prices = [start];
  for (let i = 1; i < count; i++) {
    prices.push(prices[i - 1] + (Math.random() - 0.48) * PRICE_VOL);
  }
  return prices;
}

function featureNoise(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

function terrainAt(worldX: number, stageH: number, seed: number): number {
  const x = worldX * 12;
  const baseY = stageH * 0.48;
  const a1 = stageH * 0.22;
  const a2 = stageH * 0.12;
  const a3 = stageH * 0.06;
  let y = baseY
    + Math.sin(x * 0.006 + seed) * a1
    + Math.sin(x * 0.014 + seed * 2.1) * a2
    + Math.sin(x * 0.031 + seed * 4.7) * a3;

  const featureSpan = 600 + featureNoise(seed + Math.floor(x / 700)) * 300;
  const featureId = Math.floor(x / featureSpan);
  const local = (x - featureId * featureSpan) / featureSpan; // 0..1
  const mode = Math.floor(featureNoise(seed * 3.7 + featureId * 0.91) * 5);
  if (mode === 0) y -= Math.sin(local * Math.PI) * stageH * 0.14; // peak
  else if (mode === 1) y += Math.sin(local * Math.PI) * stageH * 0.13; // valley
  else if (mode === 2) y -= local * stageH * 0.18; // up ramp
  else if (mode === 3) y += local * stageH * 0.18; // down ramp
  else y += Math.sin(local * Math.PI * 2) * stageH * 0.07; // rolling

  return clamp(y, stageH * 0.22, stageH * 0.72);
}

function buildTerrainPoints(count: number, startWorldX: number, stageH: number, seed: number): number[] {
  const raw: number[] = [];
  for (let i = 0; i < count; i++) raw.push(terrainAt(startWorldX + i, stageH, seed));
  const out = [...raw];
  for (let i = 1; i < count - 1; i++) {
    out[i] = (raw[i - 1] + raw[i] * 2 + raw[i + 1]) / 4;
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function solveKnee(
  hip: { x: number; y: number },
  foot: { x: number; y: number },
  bendDir: 1 | -1,
) {
  const dx = foot.x - hip.x;
  const dy = foot.y - hip.y;
  const dist = Math.max(0.001, Math.hypot(dx, dy));
  const d = Math.min(dist, UP_LEG + LO_LEG - 0.001);
  const midX = hip.x + (dx * 0.5);
  const midY = hip.y + (dy * 0.5);
  const h = Math.sqrt(Math.max(0, UP_LEG * UP_LEG - (d * d) / 4));
  const nx = (-dy / dist) * bendDir;
  const ny = (dx / dist) * bendDir;
  return { x: midX + nx * h, y: midY + ny * h };
}

function terrainifyNorm(t: number): number {
  const c = clamp(t, 0, 1);
  const ridge = Math.sin(c * Math.PI) * 0.045;
  return clamp(Math.pow(c, 0.88) + ridge, 0, 1);
}

/* ============ COMPONENT INTERFACE ============ */
export interface GameSceneHandle {
  startJump: (leverage: number, wager: number) => void;
  stopTrade: () => void;
}

interface GameSceneProps {
  balance: number;
  setBalance: (b: number | ((prev: number) => number)) => void;
  leverage: number;
  wager: number;
  gameState: GameState;
  setGameState: (s: GameState) => void;
  onHistoryPush: (entry: HistoryEntry) => void;
  onPnlChange: (pnl: number | null) => void;
  pnlReadout?: React.ReactNode;
}

const GameScene = forwardRef<GameSceneHandle, GameSceneProps>(function GameScene(
  {
    setBalance,
    gameState,
    setGameState,
    onHistoryPush,
    onPnlChange,
    pnlReadout,
  },
  ref,
) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const figRef = useRef<HTMLDivElement>(null);
  const flameRef = useRef<SVGGElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const parachuteRef = useRef<SVGSVGElement>(null);

  /* limb refs for direct DOM mutation */
  const upArmLRef = useRef<SVGLineElement>(null);
  const loArmLRef = useRef<SVGLineElement>(null);
  const upArmRRef = useRef<SVGLineElement>(null);
  const loArmRRef = useRef<SVGLineElement>(null);
  const upLegLRef = useRef<SVGLineElement>(null);
  const loLegLRef = useRef<SVGLineElement>(null);
  const upLegRRef = useRef<SVGLineElement>(null);
  const loLegRRef = useRef<SVGLineElement>(null);
  const handLRef = useRef<SVGCircleElement>(null);
  const handRRef = useRef<SVGCircleElement>(null);
  const footLRef = useRef<SVGEllipseElement>(null);
  const footRRef = useRef<SVGEllipseElement>(null);

  /* mutable animation state */
  const anim = useRef({
    price: 3500,
    renderPrice: 3500,
    prevPrice: 3500,
    smoothDelta: 0,
    prices: generatePriceSeries(TOTAL_POINTS, 3500),
    terrainSeed: Math.random() * Math.PI * 2,
    terrainPoints: Array.from({ length: TOTAL_POINTS }, () => 320),
    scrollFrac: 0,
    stageW: 0,
    stageH: 0,
    state: "IDLE" as GameState,
    entry: 3500,
    positionLev: 100,
    positionWager: 5,
    figPrice: 3500, // figure's virtual price-level during LIVE
    figPriceVel: 0,
    frame: 0,
    curBobY: 0,
    smoothMinP: 3450,
    smoothMaxP: 3550,
    smoothRot: 0,
    smoothFlameScale: 0,
    smoothAlt: 200, // lerped figure altitude for smooth ground following
    smoothFigPrice: 3500, // lerped price at figure position
    stepPhase: 0, // step cycle phase (radians)
    runFrame: 0,
    cameraWorldX: 0,
    chartMinP: 3450,
    chartMaxP: 3550,
    chartPointSpacing: 4,
    chartStartIdx: 0,
    chartVisibleCount: 0,
    mountainCache: null as HTMLCanvasElement | null,
    mountainCacheKey: "",
    runStartTime: 0, // timestamp when RUNNING began
    jumpStartTime: 0, // timestamp when JUMPING began
    prevStepHalf: 0, // tracks half-cycle for dust spawn
    dustParticles: [] as Array<{
      x: number; y: number; vx: number; vy: number;
      life: number; size: number;
    }>,
    loco: {
      bodyX: 0,
      bodyY: 0,
      velocityX: 0,
      velocityY: 0,
      grounded: true,
      leftFoot: { x: 0, y: 0, planted: true },
      rightFoot: { x: 0, y: 0, planted: false },
      plantedFoot: "left" as "left" | "right",
      stepPhase: 0,
      stepLength: 2.8,
      stepHeight: 7,
      squash: 0,
      leftTargetX: 0,
      rightTargetX: 0,
    },
  });

  /* render-triggering state */
  const [priceDisplay, setPriceDisplay] = useState("ETH $3500.00");
  const [levTagText, setLevTagText] = useState("\u2014");
  const [levTagShow, setLevTagShow] = useState(false);

  /* stars (generated once for atmosphere) */
  const [stars] = useState(() =>
    Array.from({ length: 35 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 40,
      opacity: +(Math.random() * 0.5 + 0.3).toFixed(2),
      size: Math.random() > 0.85 ? 2.5 : 1.5,
    })),
  );

  /* ============ CANVAS SETUP ============ */
  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const a = anim.current;
    a.stageW = rect.width;
    a.stageH = rect.height;
    const terrainCount = Math.max(a.terrainPoints.length || 0, a.prices.length || TOTAL_POINTS);
    const startWorld = Math.max(0, a.prices.length - terrainCount);
    a.terrainPoints = buildTerrainPoints(terrainCount, startWorld, rect.height, a.terrainSeed);
  }, []);

  /* ============ FIGURE POSITIONING ============ */
  const setFig = useCallback(
    (x: number, alt: number, rot: number) => {
      const fig = figRef.current;
      if (!fig) return;
      const a = anim.current;
      const tx = (x - FIG_BODY_X).toFixed(1);
      const ty = (FIGURE_FOOT_OFFSET - alt + a.curBobY).toFixed(1);
      fig.style.transform = `translate3d(${tx}px, ${ty}px, 0) rotate(${rot.toFixed(1)}deg)`;
    },
    [],
  );

  const getTerrainY = useCallback((worldX: number) => {
    const a = anim.current;
    const base = Math.floor(worldX);
    const frac = worldX - base;
    const i0 = clamp(base, 0, a.terrainPoints.length - 1);
    const i1 = clamp(base + 1, 0, a.terrainPoints.length - 1);
    return lerp(a.terrainPoints[i0] ?? a.stageH * 0.6, a.terrainPoints[i1] ?? a.stageH * 0.6, frac);
  }, []);

  const getTerrainSlope = useCallback((worldX: number) => {
    const a = anim.current;
    const dx = 0.6;
    const y0 = getTerrainY(worldX - dx);
    const y1 = getTerrainY(worldX + dx);
    const pxDx = dx * Math.max(1, a.chartPointSpacing);
    return (y1 - y0) / Math.max(1, pxDx);
  }, [getTerrainY]);

  const getTerrainNormal = useCallback((worldX: number) => {
    const slope = getTerrainSlope(worldX);
    const nx = -slope;
    const ny = 1;
    const len = Math.max(1e-6, Math.hypot(nx, ny));
    return { x: nx / len, y: ny / len };
  }, [getTerrainSlope]);

  const applyRunPose = useCallback(
    (phase01: number, leftFoot: { x: number; y: number }, rightFoot: { x: number; y: number }, squash = 0) => {
      const setL = (el: SVGLineElement | null, p0: { x: number; y: number }, p1: { x: number; y: number }) => {
        if (!el) return;
        el.setAttribute("x1", p0.x.toFixed(1));
        el.setAttribute("y1", p0.y.toFixed(1));
        el.setAttribute("x2", p1.x.toFixed(1));
        el.setAttribute("y2", p1.y.toFixed(1));
      };
      const hip = { x: HIP.x, y: HIP.y + squash * 1.6 };
      const lKnee = solveKnee(hip, leftFoot, -1);
      const rKnee = solveKnee(hip, rightFoot, 1);
      setL(upLegLRef.current, hip, lKnee);
      setL(loLegLRef.current, lKnee, leftFoot);
      setL(upLegRRef.current, hip, rKnee);
      setL(loLegRRef.current, rKnee, rightFoot);
      if (footLRef.current) {
        footLRef.current.setAttribute("cx", leftFoot.x.toFixed(1));
        footLRef.current.setAttribute("cy", (leftFoot.y + 0.4).toFixed(1));
      }
      if (footRRef.current) {
        footRRef.current.setAttribute("cx", rightFoot.x.toFixed(1));
        footRRef.current.setAttribute("cy", (rightFoot.y + 0.4).toFixed(1));
      }

      const swing = Math.sin(phase01 * Math.PI * 2) * 0.75;
      const aL = armAttrs(-0.25 - swing, 1.1);
      const aR = armAttrs(0.25 + swing, 1.1);
      setL(upArmLRef.current, { x: +aL.up.x1, y: +aL.up.y1 }, { x: +aL.up.x2, y: +aL.up.y2 });
      setL(loArmLRef.current, { x: +aL.lo.x1, y: +aL.lo.y1 }, { x: +aL.lo.x2, y: +aL.lo.y2 });
      setL(upArmRRef.current, { x: +aR.up.x1, y: +aR.up.y1 }, { x: +aR.up.x2, y: +aR.up.y2 });
      setL(loArmRRef.current, { x: +aR.lo.x1, y: +aR.lo.y1 }, { x: +aR.lo.x2, y: +aR.lo.y2 });
      if (handLRef.current) {
        handLRef.current.setAttribute("cx", aL.hand.cx);
        handLRef.current.setAttribute("cy", aL.hand.cy);
      }
      if (handRRef.current) {
        handRRef.current.setAttribute("cx", aR.hand.cx);
        handRRef.current.setAttribute("cy", aR.hand.cy);
      }
    },
    [],
  );

  const applyPose = useCallback((poseName: string, frame: number) => {
    const p = getPose(poseName, frame);
    const setL = (el: SVGLineElement | null, a: LimbAttrs) => {
      if (!el) return;
      el.setAttribute("x1", a.x1);
      el.setAttribute("y1", a.y1);
      el.setAttribute("x2", a.x2);
      el.setAttribute("y2", a.y2);
    };
    setL(upLegLRef.current, p.lL.up);
    setL(loLegLRef.current, p.lL.lo);
    setL(upLegRRef.current, p.lR.up);
    setL(loLegRRef.current, p.lR.lo);
    setL(upArmLRef.current, p.aL.up);
    setL(loArmLRef.current, p.aL.lo);
    setL(upArmRRef.current, p.aR.up);
    setL(loArmRRef.current, p.aR.lo);
    if (handLRef.current) {
      handLRef.current.setAttribute("cx", p.aL.hand.cx);
      handLRef.current.setAttribute("cy", p.aL.hand.cy);
    }
    if (handRRef.current) {
      handRRef.current.setAttribute("cx", p.aR.hand.cx);
      handRRef.current.setAttribute("cy", p.aR.hand.cy);
    }
    if (footLRef.current) {
      footLRef.current.setAttribute("cx", p.lL.foot.cx);
      footLRef.current.setAttribute("cy", p.lL.foot.cy);
    }
    if (footRRef.current) {
      footRRef.current.setAttribute("cx", p.lR.foot.cx);
      footRRef.current.setAttribute("cy", p.lR.foot.cy);
    }
  }, []);

  const setFlame = useCallback((on: boolean, scale?: number) => {
    const g = flameRef.current;
    if (!g) return;
    if (on) {
      g.setAttribute("opacity", "1");
      g.style.transform = `scaleY(${(scale || 1).toFixed(2)})`;
    } else {
      g.setAttribute("opacity", "0");
      g.style.transform = "scaleY(1)";
    }
  }, []);

  /* ============ CHART DRAWING ============ */
  const drawScene = useCallback(
    (isLive: boolean, entryPrice: number | null, liqPrice: number | null) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const a = anim.current;
      const w = a.stageW;
      const h = a.stageH;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      /* background gradient */
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "#000208");
      grad.addColorStop(0.25, "#050818");
      grad.addColorStop(0.5, "#0a1a30");
      grad.addColorStop(0.8, "#0a1828");
      grad.addColorStop(1, "#060a14");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      /* stars */
      ctx.fillStyle = "#f4ecd8";
      for (const s of stars) {
        ctx.globalAlpha = s.opacity;
        ctx.fillRect((s.x / 100) * w, (s.y / 100) * h, s.size, s.size);
      }
      ctx.globalAlpha = 1;

      /* price-to-Y mapping */
      const chartTop = h * CHART_TOP_PCT;
      const chartBot = h * CHART_BOT_PCT;
      const pointSpacing = w / VISIBLE_POINTS;
      const numVisible = Math.min(VISIBLE_POINTS + 2, a.prices.length);
      const startIdx = Math.max(0, a.prices.length - numVisible);
      a.chartStartIdx = startIdx;
      a.chartVisibleCount = numVisible;
      const visiblePrices = a.prices.slice(startIdx);
      const visibleTerrain = a.terrainPoints.slice(startIdx, startIdx + numVisible);

      /* compute auto-scale range */
      let rawMin = Infinity,
        rawMax = -Infinity;
      for (const p of visiblePrices) {
        rawMin = Math.min(rawMin, p);
        rawMax = Math.max(rawMax, p);
      }
      if (isLive) {
        if (entryPrice !== null) {
          rawMin = Math.min(rawMin, entryPrice);
          rawMax = Math.max(rawMax, entryPrice);
        }
        if (liqPrice !== null) rawMin = Math.min(rawMin, liqPrice);
        rawMin = Math.min(rawMin, a.figPrice);
        rawMax = Math.max(rawMax, a.figPrice);
      }
      const rawRange = rawMax - rawMin || 1;
      const pad = rawRange * 0.2;
      const targetMin = rawMin - pad;
      const targetMax = rawMax + pad;
      a.smoothMinP = lerp(a.smoothMinP, targetMin, 0.06);
      a.smoothMaxP = lerp(a.smoothMaxP, targetMax, 0.06);
      const minP = a.smoothMinP;
      const maxP = a.smoothMaxP;
      const rangeP = maxP - minP || 1;
      a.chartMinP = minP;
      a.chartMaxP = maxP;

      const priceToY = (p: number) => {
        const n = (p - minP) / rangeP;
        const terrainN = terrainifyNorm(n);
        return chartBot - terrainN * (chartBot - chartTop);
      };

      /* faint grid lines */
      const gridLines = 6;
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= gridLines; i++) {
        const gp = minP + (rangeP * i) / gridLines;
        const gy = priceToY(gp);
        ctx.strokeStyle = "rgba(244,236,216,0.04)";
        ctx.setLineDash([3, 7]);
        ctx.beginPath();
        ctx.moveTo(0, gy + (Math.random() - 0.5) * 0.5);
        ctx.lineTo(w, gy + (Math.random() - 0.5) * 0.5);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      /* build chart screen points */
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < visibleTerrain.length; i++) {
        const x = (i - a.scrollFrac) * pointSpacing;
        const y = visibleTerrain[i] ?? h * 0.65;
        pts.push({ x, y });
      }
      a.chartPointSpacing = pointSpacing;

      const terrainKey = `${startIdx}-${w}-${h}-${Math.round(pts[0]?.y ?? 0)}-${Math.round(pts[pts.length - 1]?.y ?? 0)}`;
      if (!a.mountainCache || a.mountainCache.width !== w || a.mountainCache.height !== h) {
        a.mountainCache = document.createElement("canvas");
        a.mountainCache.width = w;
        a.mountainCache.height = h;
        a.mountainCacheKey = "";
      }
      if (a.mountainCacheKey !== terrainKey && a.mountainCache) {
        const bg = a.mountainCache.getContext("2d");
        if (bg) {
          bg.clearRect(0, 0, w, h);
          /* far parallax mountains */
          const drawRidge = (baseY: number, amp: number, color: string, alpha: number, freq: number) => {
            bg.globalAlpha = alpha;
            bg.fillStyle = color;
            bg.beginPath();
            bg.moveTo(0, h);
            for (let x = 0; x <= w; x += 8) {
              const y = baseY + Math.sin((x + startIdx * 3) * freq) * amp + Math.sin((x + startIdx * 2) * freq * 0.55) * (amp * 0.5);
              bg.lineTo(x, y);
            }
            bg.lineTo(w, h);
            bg.closePath();
            bg.fill();
          };
          drawRidge(h * 0.56, h * 0.09, "#10243a", 0.55, 0.012);
          drawRidge(h * 0.64, h * 0.07, "#0b1c2f", 0.65, 0.018);

          const groundPath = new Path2D();
          groundPath.moveTo(pts[0]?.x ?? 0, chartBot);
          for (let i = 0; i < pts.length; i++) groundPath.lineTo(pts[i].x, pts[i].y);
          groundPath.lineTo(pts[pts.length - 1]?.x ?? w, chartBot);
          groundPath.closePath();

          const groundFill = bg.createLinearGradient(0, chartTop, 0, h);
          groundFill.addColorStop(0, "rgba(28,58,35,0.88)");
          groundFill.addColorStop(0.42, "rgba(20,42,28,0.92)");
          groundFill.addColorStop(1, "rgba(8,14,18,0.95)");
          bg.fillStyle = groundFill;
          bg.fill(groundPath);

          bg.save();
          bg.clip(groundPath);
          /* rock faces / cliff shadows */
          for (let i = 2; i < pts.length; i += 3) {
            const slopeSeg = pts[i].y - pts[i - 1].y;
            bg.globalAlpha = 0.14;
            bg.strokeStyle = slopeSeg > 1.2 ? "#7b2e2a" : "#8ea596";
            bg.lineWidth = 1.1;
            bg.beginPath();
            bg.moveTo(pts[i].x, pts[i].y + 3);
            bg.lineTo(pts[i].x - 8, pts[i].y + 18 + (featureNoise(i * 1.3) * 10));
            bg.stroke();
          }
          /* moss patches */
          for (let i = 2; i < pts.length; i += 2) {
            bg.globalAlpha = 0.18;
            bg.fillStyle = i % 5 === 0 ? "#5fae58" : "#4e8d49";
            bg.fillRect(pts[i].x - 1, pts[i].y + 2, 2 + (i % 3), 8 + (i % 4));
          }
          /* valley mist */
          for (let m = 0; m < 3; m++) {
            const mistY = h * (0.62 + m * 0.06);
            const mg = bg.createLinearGradient(0, mistY - 20, 0, mistY + 20);
            mg.addColorStop(0, "rgba(200,220,235,0)");
            mg.addColorStop(0.5, "rgba(200,220,235,0.08)");
            mg.addColorStop(1, "rgba(200,220,235,0)");
            bg.fillStyle = mg;
            bg.fillRect(0, mistY - 18, w, 36);
          }
          /* pine silhouettes near flatter sections */
          for (let i = 3; i < pts.length; i += 8) {
            const slopeAbs = Math.abs(pts[i].y - pts[i - 1].y);
            if (slopeAbs > 2.8) continue;
            const tx = pts[i].x;
            const ty = pts[i].y + 14;
            bg.globalAlpha = 0.42;
            bg.fillStyle = "#0a1712";
            bg.beginPath();
            bg.moveTo(tx, ty - 9);
            bg.lineTo(tx - 4, ty + 2);
            bg.lineTo(tx + 4, ty + 2);
            bg.closePath();
            bg.fill();
          }
          bg.restore();
          a.mountainCacheKey = terrainKey;
        }
      }
      if (a.mountainCache) ctx.drawImage(a.mountainCache, 0, 0);

      /* bold cream glow backbone */
      ctx.globalAlpha = 0.18;
      ctx.strokeStyle = "#f4ecd8";
      ctx.lineWidth = 10;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
        else ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      /* trend glow by segment direction */
      ctx.lineWidth = 7;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (let i = 1; i < pts.length; i++) {
        const up = pts[i].y <= pts[i - 1].y;
        ctx.globalAlpha = 0.13;
        ctx.strokeStyle = up ? "#5dd39e" : "#ff5f56";
        ctx.beginPath();
        ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
        ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      /* main chart line (hand-drawn double-pass) */
      for (let pass = 0; pass < 2; pass++) {
        ctx.globalAlpha = pass === 0 ? 0.85 : 0.3;
        ctx.strokeStyle = "#f4ecd8";
        ctx.lineWidth = pass === 0 ? 2 : 1.2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        const j = pass === 0 ? JITTER : JITTER * 1.6;
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const jx = pts[i].x + (Math.random() - 0.5) * j;
          const jy = pts[i].y + (Math.random() - 0.5) * j;
          if (i === 0) ctx.moveTo(jx, jy);
          else {
            /* smooth curves through midpoints */
            if (i < pts.length - 1) {
              const nx = pts[i + 1].x + (Math.random() - 0.5) * j;
              const ny = pts[i + 1].y + (Math.random() - 0.5) * j;
              const mx = (jx + nx) / 2;
              const my = (jy + ny) / 2;
              ctx.quadraticCurveTo(jx, jy, mx, my);
            } else {
              ctx.lineTo(jx, jy);
            }
          }
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      /* entry price line */
      if (isLive && entryPrice !== null) {
        const ey = priceToY(entryPrice);
        ctx.strokeStyle = "rgba(244,236,216,0.25)";
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(0, ey + (Math.random() - 0.5) * 0.6);
        ctx.lineTo(w, ey + (Math.random() - 0.5) * 0.6);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(244,236,216,0.35)";
        ctx.font = '9px "Press Start 2P", monospace';
        ctx.textAlign = "right";
        ctx.fillText("ENTRY", w - 6, ey - 5);
        ctx.textAlign = "start";
      }

      /* subtle liquidation water zone at bottom */
      const waterTop = h * 0.82;
      const water = ctx.createLinearGradient(0, waterTop, 0, h);
      water.addColorStop(0, "rgba(77,208,225,0.02)");
      water.addColorStop(1, "rgba(77,208,225,0.10)");
      ctx.fillStyle = water;
      ctx.fillRect(0, waterTop, w, h - waterTop);

      /* liquidation line + zone */
      if (isLive && liqPrice !== null) {
        const ly = priceToY(liqPrice);

        /* zone fill */
        ctx.fillStyle = "rgba(255,95,86,0.04)";
        ctx.fillRect(0, ly, w, h - ly);

        /* dashed line with jitter */
        ctx.strokeStyle = "rgba(255,95,86,0.65)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([7, 4]);
        ctx.beginPath();
        for (let x = 0; x < w; x += 4) {
          const jy = ly + (Math.random() - 0.5) * 1.2;
          if (x === 0) ctx.moveTo(x, jy);
          else ctx.lineTo(x, jy);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        /* label */
        ctx.fillStyle = "rgba(255,95,86,0.55)";
        ctx.font = '7px "Press Start 2P", monospace';
        ctx.textAlign = "center";
        ctx.fillText("\u2014 LIQUIDATION ZONE \u2014", w / 2, ly + 14);
        ctx.textAlign = "start";
      }

      /* price label on right */
      ctx.fillStyle = "rgba(244,236,216,0.4)";
      ctx.font = '10px "VT323", monospace';
      const curY = priceToY(a.price);
      ctx.fillText("$" + a.price.toFixed(2), w - 72, curY - 4);

      /* dust particles */
      const dust = anim.current.dustParticles;
      for (const d of dust) {
        const alpha = Math.max(0, d.life / DUST_LIFE) * 0.5;
        if (alpha < 0.01) continue;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = "#f4ecd8";
        const sz = d.size * (d.life / DUST_LIFE);
        ctx.beginPath();
        ctx.arc(d.x, d.y, Math.max(0.3, sz), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      /* return priceToY so the tick can use it */
      return priceToY;
    },
    [stars],
  );

  /* ============ BANNER ============ */
  const showBanner = useCallback((kind: "win" | "loss", text: string) => {
    const b = bannerRef.current;
    if (!b) return;
    b.textContent = text;
    b.className = "banner show " + kind;
    setTimeout(() => b.classList.remove("show"), 1500);
  }, []);

  /* ============ RESET ============ */
  const reset = useCallback(() => {
    const a = anim.current;
    a.state = "IDLE";
    setGameState("IDLE");
    setFlame(false);
    if (parachuteRef.current)
      parachuteRef.current.classList.remove("deployed");
    applyPose("standing", 0);
    onPnlChange(null);
    setLevTagShow(false);
    setLevTagText("\u2014");
    a.figPriceVel = 0;
    a.smoothDelta = 0;
    a.curBobY = 0;
    a.stepPhase = 0;
    a.runFrame = 0;
    a.runStartTime = 0;
    a.jumpStartTime = 0;
    a.prevStepHalf = 0;
    a.dustParticles.length = 0;
    a.loco.grounded = true;
    a.loco.stepPhase = 0;
    a.loco.plantedFoot = "left";
    a.loco.squash = 0;
  }, [setGameState, setFlame, applyPose, onPnlChange]);

  /* ============ SPLAT (liquidation) ============ */
  const splat = useCallback(() => {
    const a = anim.current;
    if (a.state === "DEAD") return;
    a.state = "DEAD";
    setGameState("DEAD");
    setFlame(false);
    applyPose("falling", a.frame);
    showBanner("loss", "\u2212$" + a.positionWager.toFixed(2));
    onHistoryPush({ amt: -a.positionWager, win: false });
    setTimeout(reset, 1900);
  }, [setGameState, setFlame, applyPose, showBanner, onHistoryPush, reset]);

  /* ============ STOP TRADE ============ */
  const stopTrade = useCallback(() => {
    const a = anim.current;
    if (a.state !== "LIVE") return;
    a.state = "STOPPED";
    setGameState("STOPPED");
    setFlame(false);
    if (parachuteRef.current) parachuteRef.current.classList.add("deployed");
    const move = (a.price - a.entry) / a.entry;
    const pnlPct = move * a.positionLev;
    const pnlDollars = pnlPct * a.positionWager;
    setBalance((prev: number) => prev + a.positionWager + pnlDollars);
    applyPose("parachute", 0);
    const sign = pnlDollars >= 0 ? "+" : "\u2212";
    showBanner(
      pnlDollars >= 0 ? "win" : "loss",
      sign + "$" + Math.abs(pnlDollars).toFixed(2),
    );
    onHistoryPush({ amt: pnlDollars, win: pnlDollars >= 0 });
    setTimeout(reset, 2000);
  }, [setGameState, setFlame, setBalance, applyPose, showBanner, onHistoryPush, reset]);

  /* ============ START JUMP ============ */
  const startJump = useCallback(
    (lev: number, wag: number) => {
      const a = anim.current;
      a.state = "RUNNING";
      setGameState("RUNNING");
      a.positionLev = lev;
      a.positionWager = wag;
      a.runFrame = 0;
      a.stepPhase = 0;
      a.prevStepHalf = 0;
      a.runStartTime = 0; // set on first tick
      a.jumpStartTime = 0;
      a.dustParticles.length = 0;
      a.loco.grounded = true;
      a.loco.stepPhase = 0;
      a.loco.plantedFoot = "left";
      a.loco.leftFoot = { x: a.loco.bodyX - 1.2, y: a.loco.bodyY + BODY_HEIGHT_PX, planted: true };
      a.loco.rightFoot = { x: a.loco.bodyX + 1.2, y: a.loco.bodyY + BODY_HEIGHT_PX, planted: false };
      a.loco.squash = 0;
    },
    [setGameState],
  );

  useImperativeHandle(ref, () => ({ startJump, stopTrade }), [
    startJump,
    stopTrade,
  ]);

  /* ============ MAIN ANIMATION LOOP ============ */
  useEffect(() => {
    let lastTime = 0;
    let animId = 0;

    const tick = (time: number) => {
      const dt = lastTime ? Math.min(time - lastTime, 50) : 16.67;
      lastTime = time;
      const dtNorm = dt / 16.67;
      const a = anim.current;

      /* price drift (mock mode) */
      a.price += (Math.random() - 0.485) * MOCK_DRIFT * dtNorm;
      a.renderPrice = lerp(a.renderPrice, a.price, 0.08 * dtNorm);

      /* chart scroll speed based on state */
      let speed = CHART_SPEED_IDLE;
      if (a.state === "RUNNING" || a.state === "JUMPING") speed = CHART_SPEED_RUN;
      else if (a.state === "LIVE") speed = CHART_SPEED_LIVE;
      else if (a.state === "STOPPED") speed = CHART_SPEED_IDLE;

      /* advance chart scroll */
      a.scrollFrac += speed * dtNorm;
      while (a.scrollFrac >= 1) {
        a.scrollFrac -= 1;
        /* add new price point from current price */
        const last = a.prices[a.prices.length - 1];
        const step = (a.renderPrice - last) * 0.26 + (Math.random() - 0.48) * PRICE_VOL * 0.75;
        a.prices.push(last + step);
        const i = a.terrainPoints.length;
        const terrainRaw = terrainAt(i, a.stageH || 700, a.terrainSeed);
        const prev = a.terrainPoints[a.terrainPoints.length - 1] ?? terrainRaw;
        const terrainNext = lerp(prev, terrainRaw, 0.38);
        a.terrainPoints.push(terrainNext);
        if (a.prices.length > TOTAL_POINTS * 1.5) a.prices.shift();
        if (a.terrainPoints.length > TOTAL_POINTS * 1.5) a.terrainPoints.shift();
      }

      /* update price display (throttled) */
      if (a.frame % 4 === 0) setPriceDisplay("ETH $" + a.price.toFixed(2));

      /* compute figScreenX and pointSpacing */
      const figScreenX = a.stageW * FIG_X_PCT;
      const pointSpacing = a.stageW / VISIBLE_POINTS;

      /* world camera + figure world anchor */
      const numVisible = Math.min(VISIBLE_POINTS + 2, a.prices.length);
      const startIdx = Math.max(0, a.prices.length - numVisible);
      const worldLeft = startIdx + a.scrollFrac;
      const figDataIdx = worldLeft + (figScreenX / pointSpacing);
      const iFloor = Math.floor(figDataIdx);
      const iFrac = figDataIdx - iFloor;
      const pi0 = Math.max(0, Math.min(a.prices.length - 1, iFloor));
      const pi1 = Math.max(0, Math.min(a.prices.length - 1, iFloor + 1));
      const priceAtFig = lerp(a.prices[pi0] ?? a.price, a.prices[pi1] ?? a.price, iFrac);
      const figWorldX = figDataIdx;
      a.cameraWorldX = lerp(a.cameraWorldX || worldLeft, worldLeft, CAMERA_LERP * dtNorm);

      /* compute liqPrice */
      const liqPrice = a.state === "LIVE" || a.state === "STOPPED"
        ? a.entry - a.entry / a.positionLev
        : null;
      const isLive = a.state === "LIVE" || a.state === "STOPPED";

      /* draw chart (returns priceToY function) */
      const priceToY = drawScene(
        isLive,
        isLive ? a.entry : null,
        liqPrice,
      );

      const worldToScreenX = (worldX: number) =>
        (worldX - a.cameraWorldX) * pointSpacing;

      /* update dust particles */
      for (let i = a.dustParticles.length - 1; i >= 0; i--) {
        const d = a.dustParticles[i];
        d.life -= dt / 1000;
        d.x += d.vx * dtNorm;
        d.y += d.vy * dtNorm;
        d.vy += 0.03 * dtNorm;
        if (d.life <= 0) a.dustParticles.splice(i, 1);
      }

      if (DEBUG_FEET) {
        const ctx = canvasRef.current?.getContext("2d");
        if (ctx) {
          const lx = worldToScreenX(a.loco.leftFoot.x);
          const rx = worldToScreenX(a.loco.rightFoot.x);
          const ly = getTerrainY(a.loco.leftFoot.x);
          const ry = getTerrainY(a.loco.rightFoot.x);
          const drawDot = (x: number, y: number, c: string, r = 3) => {
            ctx.fillStyle = c;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
          };
          drawDot(worldToScreenX(a.loco.leftTargetX), getTerrainY(a.loco.leftTargetX), "#ff4444", 2.6);
          drawDot(worldToScreenX(a.loco.rightTargetX), getTerrainY(a.loco.rightTargetX), "#4499ff", 2.6);
          drawDot(lx, ly, "#ffd94d", 2.4);
          drawDot(rx, ry, "#ffd94d", 2.4);
          drawDot(figScreenX, a.stageH - a.smoothAlt, "#ffffff", 2.2);
        }
      }

      /* ---- state-specific logic ---- */
      if (a.state === "IDLE") {
        const loco = a.loco;
        const stepHz = 1.8;
        loco.bodyX = figWorldX;
        loco.grounded = true;
        loco.stepPhase = (loco.stepPhase + stepHz * (dt / 1000)) % 1;
        const supportLeft = loco.plantedFoot === "left";
        const planted = supportLeft ? loco.leftFoot : loco.rightFoot;
        const swing = supportLeft ? loco.rightFoot : loco.leftFoot;
        if (!planted.x) {
          planted.x = figWorldX - loco.stepLength * 0.5;
          planted.y = getTerrainY(planted.x);
        }
        planted.y = getTerrainY(planted.x);
        const stepT = loco.stepPhase;
        const swingTargetX = planted.x + loco.stepLength;
        swing.x = lerp(swing.x || planted.x, planted.x + loco.stepLength * stepT, 0.55 * dtNorm);
        swing.y = lerp(swing.y || planted.y, getTerrainY(swingTargetX) - Math.sin(stepT * Math.PI) * loco.stepHeight, 0.55 * dtNorm);
        if (stepT >= 0.99) {
          swing.x = swingTargetX;
          swing.y = getTerrainY(swing.x);
          swing.planted = true;
          planted.planted = false;
          loco.plantedFoot = supportLeft ? "right" : "left";
          loco.stepPhase = 0;
        }
        const midX = (loco.leftFoot.x + loco.rightFoot.x) * 0.5;
        const midY = (loco.leftFoot.y + loco.rightFoot.y) * 0.5;
        loco.bodyY = midY - BODY_HEIGHT_PX;
        a.curBobY = -Math.sin(stepT * Math.PI) * BODY_BOB_PX * 0.45;
        const slopeDeg = clamp(Math.atan(getTerrainSlope(midX)) * (180 / Math.PI), -14, 14);
        a.smoothRot = lerp(a.smoothRot, slopeDeg, 0.15 * dtNorm);
        const leftLocal = { x: 18 + (loco.leftFoot.x - midX) * pointSpacing, y: 48 + (loco.leftFoot.y - midY) };
        const rightLocal = { x: 18 + (loco.rightFoot.x - midX) * pointSpacing, y: 48 + (loco.rightFoot.y - midY) };
        applyRunPose(stepT, leftLocal, rightLocal, loco.squash);
        a.smoothAlt = lerp(a.smoothAlt, a.stageH - midY, 0.35 * dtNorm);
        setFig(figScreenX, a.smoothAlt, a.smoothRot);
        a.figPrice = priceAtFig;
        a.smoothFigPrice = priceAtFig;

      } else if (a.state === "RUNNING") {
        /* set runStartTime on first frame */
        if (a.runStartTime === 0) a.runStartTime = time;
        const elapsed = time - a.runStartTime;

        if (elapsed > RUN_DURATION) {
          /* transition to JUMPING */
          a.state = "JUMPING";
          setGameState("JUMPING");
          a.jumpStartTime = time;
          a.curBobY = 0;
          applyPose("jetpack", 0);
          setFig(figScreenX, a.smoothAlt, a.smoothRot);
        } else {
          const loco = a.loco;
          loco.grounded = true;
          loco.bodyX = figWorldX;
          const slope = getTerrainSlope(loco.bodyX);
          const slopeFactor = clamp(1 - slope * 3.2, 0.7, 1.3);
          const stepHz = STEP_FREQ * 0.28 * slopeFactor;
          const speedMag = Math.abs(stepHz * loco.stepLength);
          const roughness = Math.abs(getTerrainSlope(loco.bodyX - 1.5) - getTerrainSlope(loco.bodyX + 1.5)) * 80;
          loco.stepLength = clamp(speedMag * 12, 18, 42);
          loco.stepHeight = 12 + roughness * 0.4;
          loco.stepPhase = (loco.stepPhase + stepHz * (dt / 1000)) % 1;
          const supportLeft = loco.plantedFoot === "left";
          const planted = supportLeft ? loco.leftFoot : loco.rightFoot;
          const swing = supportLeft ? loco.rightFoot : loco.leftFoot;
          if (!planted.x) {
            planted.x = figWorldX - loco.stepLength * 0.5;
            planted.y = getTerrainY(planted.x);
          }
          planted.y = getTerrainY(planted.x);
          const stepT = loco.stepPhase;
          let swingTargetX = loco.bodyX + loco.stepLength * slopeFactor;
          if (Math.abs(getTerrainSlope(swingTargetX)) > 0.95) {
            swingTargetX = planted.x + loco.stepLength * 0.6 * slopeFactor;
          }
          swingTargetX = clamp(swingTargetX, planted.x - 8, planted.x + 4.2);
          if (supportLeft) loco.rightTargetX = swingTargetX;
          else loco.leftTargetX = swingTargetX;
          swing.x = lerp(swing.x || planted.x, planted.x + (swingTargetX - planted.x) * stepT, 0.62 * dtNorm);
          swing.y = lerp(
            swing.y || planted.y,
            getTerrainY(swingTargetX) - Math.sin(stepT * Math.PI) * loco.stepHeight,
            0.62 * dtNorm,
          );
          if (stepT >= 0.99) {
            swing.x = swingTargetX;
            swing.y = getTerrainY(swing.x);
            swing.planted = true;
            planted.planted = false;
            loco.plantedFoot = supportLeft ? "right" : "left";
            loco.stepPhase = 0;
            if (a.dustParticles.length < DUST_MAX) {
              const sx = worldToScreenX(swing.x);
              for (let k = 0; k < 3; k++) {
                a.dustParticles.push({
                  x: sx + (Math.random() - 0.5) * 6,
                  y: swing.y + (Math.random() - 0.3) * 4,
                  vx: -(0.3 + Math.random() * 0.7),
                  vy: -(0.2 + Math.random() * 0.5),
                  life: DUST_LIFE * (0.6 + Math.random() * 0.4),
                  size: 1 + Math.random() * 1.8,
                });
              }
            }
          }
          const midX = (loco.leftFoot.x + loco.rightFoot.x) * 0.5;
          const midY = (loco.leftFoot.y + loco.rightFoot.y) * 0.5;
          loco.bodyY = midY - BODY_HEIGHT_PX;
          a.curBobY = -Math.sin(stepT * Math.PI) * BODY_BOB_PX;
          const slopeDeg = clamp(Math.atan(getTerrainSlope(midX)) * (180 / Math.PI), -14, 14);
          a.smoothRot = lerp(a.smoothRot, slopeDeg, 0.2 * dtNorm);
          const leftLocal = { x: 18 + (loco.leftFoot.x - midX) * pointSpacing, y: 48 + (loco.leftFoot.y - midY) };
          const rightLocal = { x: 18 + (loco.rightFoot.x - midX) * pointSpacing, y: 48 + (loco.rightFoot.y - midY) };
          applyRunPose(stepT, leftLocal, rightLocal, loco.squash);
          a.smoothAlt = lerp(a.smoothAlt, a.stageH - midY, 0.35 * dtNorm);
          setFig(figScreenX, a.smoothAlt, a.smoothRot);
        }
        a.figPrice = priceAtFig;
        a.smoothFigPrice = priceAtFig;

      } else if (a.state === "JUMPING") {
        /* liftoff from chart into air */
        if (a.jumpStartTime === 0) a.jumpStartTime = time;
        const elapsed = time - a.jumpStartTime;
        const loco = a.loco;
        if (loco.grounded) {
          loco.grounded = false;
          const n = getTerrainNormal(loco.bodyX || figWorldX);
          loco.velocityX = 0.55;
          loco.velocityY = -0.22 - n.x * 0.25;
          a.figPriceVel = 0.06 + n.y * 0.02;
        }

        if (elapsed > JUMP_DURATION) {
          /* enter LIVE */
          a.state = "LIVE";
          setGameState("LIVE");
          a.entry = a.price;
          a.figPrice = a.price;
          a.figPriceVel = 0.08;
          a.smoothDelta = 0;
          a.frame = 0;
          setLevTagText(a.positionLev + "x");
          setLevTagShow(true);
          const fig = figRef.current;
          if (fig) fig.style.transition = "none";
        } else {
          /* rising arc from chart line */
          const liftT = elapsed / JUMP_DURATION;
          const liftArc = Math.sin(liftT * Math.PI * 0.5);
          const chartY = getTerrainY(figWorldX);
          const baseAlt = a.stageH - chartY;
          a.smoothAlt = baseAlt + 40 * liftArc;
          a.curBobY = 0;
          a.smoothRot = lerp(a.smoothRot, -10 * liftArc, 0.15 * dtNorm);
          applyPose("jetpack", a.frame);
          setFig(figScreenX, a.smoothAlt, a.smoothRot);
          a.figPrice = priceAtFig;
          a.frame++;
        }

      } else if (a.state === "LIVE") {
        a.frame++;
        const loco = a.loco;

        /* price delta for physics */
        const priceDelta = a.price - a.prevPrice;
        a.smoothDelta = lerp(a.smoothDelta, priceDelta, 0.12 * dtNorm);

        /* physics */
        const thrust = clamp(a.smoothDelta * THRUST_MULT, -0.08, 0.12);
        if (a.smoothDelta > 0.001) {
          a.figPriceVel += thrust * dtNorm;
        } else if (Math.abs(a.smoothDelta) <= 0.0015) {
          a.figPriceVel += (-GRAVITY_P * 0.25) * dtNorm;
        } else {
          a.figPriceVel += (thrust * 0.35 - GRAVITY_P * 1.2) * dtNorm;
        }
        a.figPriceVel -= GRAVITY_P * dtNorm;
        a.figPriceVel *= Math.pow(DRAG, dtNorm);
        a.figPriceVel = Math.max(-VY_CLAMP_P, Math.min(VY_CLAMP_P, a.figPriceVel));
        a.figPrice += a.figPriceVel * dtNorm;

        /* PnL */
        const move = (a.price - a.entry) / a.entry;
        const pnlPct = move * a.positionLev;
        const pnlDollars = pnlPct * a.positionWager;
        if (a.frame % 3 === 0) onPnlChange(pnlDollars);

        /* pose + flame */
        if (a.smoothDelta > 0.001) {
          const targetFlame = 1 + Math.min(2, a.smoothDelta * 80) * 0.6 +
            Math.sin(a.frame * 0.6) * 0.15;
          a.smoothFlameScale = lerp(a.smoothFlameScale, targetFlame, 0.15 * dtNorm);
          setFlame(true, a.smoothFlameScale);
          const targetRot = clamp(-a.figPriceVel * 35, -15, 15);
          a.smoothRot = lerp(a.smoothRot, targetRot, 0.1 * dtNorm);
          applyPose("jetpack", a.frame);
          if (a.dustParticles.length < DUST_MAX) {
            a.dustParticles.push({
              x: figScreenX - 6 + Math.random() * 5,
              y: a.stageH - (a.smoothAlt - 20),
              vx: -0.5 - Math.random() * 0.6,
              vy: 0.2 + Math.random() * 0.4,
              life: 0.2 + Math.random() * 0.2,
              size: 0.6 + Math.random() * 1.2,
            });
          }
        } else if (a.smoothDelta < -0.001) {
          setFlame(false);
          a.smoothFlameScale = lerp(a.smoothFlameScale, 0, 0.1 * dtNorm);
          const targetRot = clamp(a.figPriceVel * 45, -15, 15);
          a.smoothRot = lerp(a.smoothRot, targetRot, 0.05 * dtNorm);
          applyPose("falling", a.frame);
        } else {
          setFlame(false);
          a.smoothFlameScale = lerp(a.smoothFlameScale, 0, 0.1 * dtNorm);
          a.smoothRot = lerp(a.smoothRot, 0, 0.08 * dtNorm);
          applyPose("jetpack", a.frame);
        }

        /* position figure */
        if (priceToY) {
          const figY = priceToY(a.figPrice);
          const alt = a.stageH - figY;
          a.smoothAlt = lerp(a.smoothAlt, alt, 0.22 * dtNorm);
          setFig(figScreenX, a.smoothAlt, a.smoothRot);
          const groundY = getTerrainY(figWorldX);
          if (figY >= groundY - 4 && a.figPriceVel < 0) {
            loco.grounded = true;
            loco.bodyX = figWorldX;
            loco.bodyY = groundY - BODY_HEIGHT_PX;
            loco.leftFoot = { x: figWorldX - 1.2, y: getTerrainY(figWorldX - 1.2), planted: true };
            loco.rightFoot = { x: figWorldX + 1.2, y: getTerrainY(figWorldX + 1.2), planted: true };
            loco.plantedFoot = "left";
            loco.squash = 2.5;
            a.state = "RUNNING";
            setGameState("RUNNING");
            a.runStartTime = time - RUN_DURATION * 0.72;
            setFlame(false);
          }
        }

        /* liquidation check */
        if (liqPrice !== null && (a.price <= liqPrice || a.figPrice <= liqPrice || pnlPct <= -1)) {
          splat();
        }

      } else if (a.state === "STOPPED") {
        /* parachute descent: lerp figPrice toward chart price and land softly */
        a.figPrice = lerp(a.figPrice, priceAtFig, 0.02 * dtNorm);
        if (priceToY) {
          const figY = priceToY(a.figPrice);
          const alt = a.stageH - figY;
          a.smoothRot = lerp(a.smoothRot, 0, 0.05 * dtNorm);
          setFig(figScreenX, alt, a.smoothRot);
          const groundY = getTerrainY(figWorldX);
          if (figY >= groundY - 3) {
            const loco = a.loco;
            loco.grounded = true;
            loco.bodyX = figWorldX;
            loco.bodyY = groundY - BODY_HEIGHT_PX;
            loco.leftFoot = { x: figWorldX - 1.1, y: getTerrainY(figWorldX - 1.1), planted: true };
            loco.rightFoot = { x: figWorldX + 1.1, y: getTerrainY(figWorldX + 1.1), planted: true };
            loco.squash = lerp(loco.squash, 2.2, 0.5);
            applyRunPose(0, { x: 16, y: 49 }, { x: 20, y: 49 }, loco.squash);
          } else {
            applyPose("parachute", 0);
          }
        }

      } else if (a.state === "DEAD") {
        /* figure falls off screen */
        a.figPrice -= 0.5 * dtNorm;
        if (priceToY) {
          const figY = priceToY(a.figPrice);
          const alt = a.stageH - figY;
          setFig(figScreenX, Math.max(-100, alt), (a.frame * 8) % 360);
        }
        a.frame++;
      }

      a.prevPrice = a.price;
      a.frame++;
      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [drawScene, applyPose, applyRunPose, setFig, setFlame, onPnlChange, splat, getTerrainY, getTerrainSlope, getTerrainNormal, setGameState]);

  /* ============ PRICE STREAM ============ */
  useEffect(() => {
    const disconnect = connectPriceStream((msg) => {
      anim.current.price = msg.eth_price;
    });
    return disconnect;
  }, []);

  /* ============ INIT + RESIZE ============ */
  useEffect(() => {
    resizeCanvas();
    applyPose("standing", 0);
    const handleResize = () => resizeCanvas();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [resizeCanvas, applyPose]);

  /* sync external state */
  useEffect(() => {
    anim.current.state = gameState;
  }, [gameState]);

  return (
    <div className="stage" ref={stageRef}>
      {/* Chart canvas */}
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          zIndex: 2,
        }}
      />

      {/* HUD overlays */}
      <div className="price-tick">{priceDisplay}</div>
      <div className={`lev-tag${levTagShow ? " show" : ""}`}>
        {levTagText}
      </div>
      {pnlReadout}

      {/* FIGURE */}
      <div className="figure-wrap" ref={figRef} style={{ zIndex: 3, opacity: 1 }}>
        <svg
          className="parachute"
          ref={parachuteRef}
          width="80"
          height="44"
          viewBox="0 0 80 44"
        >
          <path
            d="M 4 30 C 8 12, 22 8, 40 8 C 58 8, 72 12, 76 30 C 70 26, 62 29, 56 27 C 48 30, 40 27, 32 30 C 24 27, 14 29, 4 30 Z"
            fill="#ff5f56"
            stroke="#9a2828"
            strokeWidth="0.8"
            strokeLinejoin="round"
          />
          <path d="M 14 28 Q 19 17 25 11" stroke="#9a2828" strokeWidth="0.4" fill="none" opacity="0.55" />
          <path d="M 28 30 Q 32 19 36 9" stroke="#9a2828" strokeWidth="0.4" fill="none" opacity="0.55" />
          <path d="M 52 30 Q 48 19 44 9" stroke="#9a2828" strokeWidth="0.4" fill="none" opacity="0.55" />
          <path d="M 66 28 Q 61 17 55 11" stroke="#9a2828" strokeWidth="0.4" fill="none" opacity="0.55" />
          <path d="M 8 29 Q 20 36 34 44" stroke="#f4ecd8" strokeWidth="0.6" fill="none" opacity="0.75" strokeLinecap="round" />
          <path d="M 22 29 Q 30 36 37 44" stroke="#f4ecd8" strokeWidth="0.6" fill="none" opacity="0.75" strokeLinecap="round" />
          <path d="M 40 8 L 40 44" stroke="#f4ecd8" strokeWidth="0.6" opacity="0.75" strokeLinecap="round" />
          <path d="M 58 29 Q 50 36 43 44" stroke="#f4ecd8" strokeWidth="0.6" fill="none" opacity="0.75" strokeLinecap="round" />
          <path d="M 72 29 Q 60 36 46 44" stroke="#f4ecd8" strokeWidth="0.6" fill="none" opacity="0.75" strokeLinecap="round" />
        </svg>
        <svg
          width="36"
          height="58"
          viewBox="0 0 36 58"
          className="fig-glow"
        >
          {/* jetpack */}
          <g>
            <path d="M 14 13 Q 15 11 16.5 11" stroke="#f4ecd8" strokeWidth="0.8" fill="none" strokeLinecap="round" />
            <path d="M 22 13 Q 21 11 19.5 11" stroke="#f4ecd8" strokeWidth="0.8" fill="none" strokeLinecap="round" />
            <path
              d="M 11 13 C 11 12, 12 12, 13 12 L 23 12 C 24 12, 25 12, 25 13 L 25 27 C 25 28, 24 28, 23 28 L 13 28 C 12 28, 11 28, 11 27 Z"
              fill="#08080f"
              stroke="#f4ecd8"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
            <path d="M 11.3 13.2 L 24.7 13.2 M 11.3 27.5 L 24.7 27.5" stroke="#f4ecd8" strokeWidth="0.5" opacity="0.5" strokeLinecap="round" />
            <line x1="12" y1="17" x2="24" y2="17" stroke="#f4ecd8" strokeWidth="0.5" opacity="0.55" />
            <line x1="12" y1="22" x2="24" y2="22" stroke="#f4ecd8" strokeWidth="0.5" opacity="0.4" />
            <path d="M 12 28 L 12 30 L 14.5 30 L 14.5 28" stroke="#f4ecd8" strokeWidth="1" fill="#08080f" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M 21.5 28 L 21.5 30 L 24 30 L 24 28" stroke="#f4ecd8" strokeWidth="1" fill="#08080f" strokeLinecap="round" strokeLinejoin="round" />
          </g>
          {/* flames */}
          <g
            ref={flameRef}
            opacity="0"
            style={{
              transformOrigin: "50% 0%",
              transformBox: "fill-box" as const,
            }}
          >
            <path d="M 13.25 30 C 12 35, 10 40, 12 45 C 13 42, 13.5 44, 13.5 41 C 14 44, 14.8 41, 15 43 C 15.5 38, 15 34, 14 30 Z" fill="#ff9933" stroke="#ff9933" strokeWidth="0.5" opacity="0.85" />
            <path d="M 22.75 30 C 21.5 35, 19.5 40, 21.5 45 C 22.5 42, 23 44, 23 41 C 23.5 44, 24.3 41, 24.5 43 C 25 38, 24.5 34, 23.5 30 Z" fill="#ff9933" stroke="#ff9933" strokeWidth="0.5" opacity="0.85" />
            <path d="M 13.25 31 C 12.5 34, 11.5 38, 12.5 41 C 13.2 39, 13.5 40, 13.5 38 C 14 40, 14.5 38, 14.5 39 C 15 36, 14.5 33, 14 31 Z" fill="#ffd966" stroke="none" opacity="0.95" />
            <path d="M 22.75 31 C 22 34, 21 38, 22 41 C 22.7 39, 23 40, 23 38 C 23.5 40, 24 38, 24 39 C 24.5 36, 24 33, 23.5 31 Z" fill="#ffd966" stroke="none" opacity="0.95" />
          </g>
          {/* helmet */}
          <path
            d="M 12.5 6 C 12.5 2, 23 2, 23.5 6.5 C 23.5 10, 22 11, 18 11 C 14 11, 12.5 10, 12.5 6 Z"
            className="helmet-fill"
          />
          <path d="M 12.7 6 C 13 2.5, 22.5 2.5, 23.3 6.3" stroke="#f4ecd8" strokeWidth="0.6" fill="none" opacity="0.5" />
          <rect x="14" y="5.5" width="8" height="2" rx="0.5" className="visor" />
          <line x1="14" y1="9" x2="22" y2="9" stroke="#f4ecd8" strokeWidth="0.6" opacity="0.7" />
          {/* body */}
          <line className="figure-line" x1="18" y1="11" x2="18" y2="28" />
          <line className="figure-line" ref={upArmLRef} x1="18" y1="14" x2="14" y2="21" />
          <line className="figure-line" ref={loArmLRef} x1="14" y1="21" x2="11" y2="28" />
          <line className="figure-line" ref={upArmRRef} x1="18" y1="14" x2="22" y2="21" />
          <line className="figure-line" ref={loArmRRef} x1="22" y1="21" x2="25" y2="28" />
          <circle className="hand-foot" ref={handLRef} cx="11" cy="28" r="1.4" />
          <circle className="hand-foot" ref={handRRef} cx="25" cy="28" r="1.4" />
          <line className="figure-line" ref={upLegLRef} x1="18" y1="28" x2="14" y2="38" />
          <line className="figure-line" ref={loLegLRef} x1="14" y1="38" x2="11" y2="48" />
          <line className="figure-line" ref={upLegRRef} x1="18" y1="28" x2="22" y2="38" />
          <line className="figure-line" ref={loLegRRef} x1="22" y1="38" x2="25" y2="48" />
          <ellipse className="hand-foot" ref={footLRef} cx="11" cy="48.5" rx="2.2" ry="1.2" />
          <ellipse className="hand-foot" ref={footRRef} cx="25" cy="48.5" rx="2.2" ry="1.2" />
        </svg>
      </div>
      <div className="banner" ref={bannerRef} />
    </div>
  );
});

export default GameScene;
