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
const FOOT_SPREAD_PX = 16; // horizontal pixel spread for ground sampling
const BODY_BOB_PX = 3.5; // vertical bob amplitude during run
const DUST_MAX = 15; // max dust particles alive
const DUST_LIFE = 0.45; // seconds each dust particle lives
const RUN_DURATION = 1200; // ms of running before jump
const JUMP_DURATION = 500; // ms of jump liftoff before LIVE

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
    prevPrice: 3500,
    smoothDelta: 0,
    prices: generatePriceSeries(TOTAL_POINTS, 3500),
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
    runStartTime: 0, // timestamp when RUNNING began
    jumpStartTime: 0, // timestamp when JUMPING began
    prevStepHalf: 0, // tracks half-cycle for dust spawn
    dustParticles: [] as Array<{
      x: number; y: number; vx: number; vy: number;
      life: number; size: number;
    }>,
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
      const visiblePrices = a.prices.slice(startIdx);

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

      const priceToY = (p: number) =>
        chartBot - ((p - minP) / rangeP) * (chartBot - chartTop);

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
      for (let i = 0; i < visiblePrices.length; i++) {
        const x = (i - a.scrollFrac) * pointSpacing;
        const y = priceToY(visiblePrices[i]);
        pts.push({ x, y });
      }

      /* trend glow (soft color under line) */
      const lastP = a.prices[a.prices.length - 1];
      const refP = a.prices[Math.max(0, a.prices.length - 15)];
      const trendUp = lastP >= refP;
      ctx.globalAlpha = 0.08;
      ctx.strokeStyle = trendUp ? "#5dd39e" : "#ff5f56";
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
        const step = (a.price - last) * 0.3 + (Math.random() - 0.48) * PRICE_VOL;
        a.prices.push(last + step);
        if (a.prices.length > TOTAL_POINTS * 1.5) a.prices.shift();
      }

      /* update price display (throttled) */
      if (a.frame % 4 === 0) setPriceDisplay("ETH $" + a.price.toFixed(2));

      /* compute figScreenX and pointSpacing */
      const figScreenX = a.stageW * FIG_X_PCT;
      const pointSpacing = a.stageW / VISIBLE_POINTS;

      /* get chart Y at figure's X */
      const numVisible = Math.min(VISIBLE_POINTS + 2, a.prices.length);
      const startIdx = Math.max(0, a.prices.length - numVisible);
      const figDataIdx = a.scrollFrac + (figScreenX / pointSpacing);
      const iFloor = Math.floor(figDataIdx);
      const iFrac = figDataIdx - iFloor;
      const pi0 = startIdx + Math.max(0, Math.min(numVisible - 1, iFloor));
      const pi1 = startIdx + Math.max(0, Math.min(numVisible - 1, iFloor + 1));
      const priceAtFig = lerp(a.prices[pi0] ?? a.price, a.prices[pi1] ?? a.price, iFrac);

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

      /* helper: chart screen-Y at any screen-X */
      const getChartYAtX = (screenX: number): number => {
        if (!priceToY) return a.stageH * 0.5;
        const di = a.scrollFrac + screenX / pointSpacing;
        const fl = Math.floor(di);
        const fr = di - fl;
        const j0 = startIdx + Math.max(0, Math.min(numVisible - 1, fl));
        const j1 = startIdx + Math.max(0, Math.min(numVisible - 1, fl + 1));
        const p = lerp(a.prices[j0] ?? a.price, a.prices[j1] ?? a.price, fr);
        return priceToY(p);
      };

      /* update dust particles */
      for (let i = a.dustParticles.length - 1; i >= 0; i--) {
        const d = a.dustParticles[i];
        d.life -= dt / 1000;
        d.x += d.vx * dtNorm;
        d.y += d.vy * dtNorm;
        d.vy += 0.03 * dtNorm;
        if (d.life <= 0) a.dustParticles.splice(i, 1);
      }

      /* ---- state-specific logic ---- */
      if (a.state === "IDLE") {
        /* figure stands on chart line with slope alignment */
        const chartY = getChartYAtX(figScreenX);
        const targetAlt = a.stageH - chartY;
        a.smoothAlt = lerp(a.smoothAlt, targetAlt, 0.18 * dtNorm);
        const slopeL = getChartYAtX(figScreenX - FOOT_SPREAD_PX);
        const slopeR = getChartYAtX(figScreenX + FOOT_SPREAD_PX);
        const slopeDeg =
          Math.atan2(slopeR - slopeL, FOOT_SPREAD_PX * 2) * (180 / Math.PI);
        a.smoothRot = lerp(
          a.smoothRot,
          Math.max(-12, Math.min(12, slopeDeg * 0.6)),
          0.1 * dtNorm,
        );
        a.curBobY = 0;
        applyPose("standing", 0);
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
          /* advance step phase */
          a.stepPhase += STEP_FREQ * (dt / 1000) * Math.PI * 2;
          a.runFrame++;

          /* sample chart at left and right foot positions */
          const leftFootX = figScreenX - FOOT_SPREAD_PX * 0.5;
          const rightFootX = figScreenX + FOOT_SPREAD_PX * 0.5;
          const leftChartY = getChartYAtX(leftFootX);
          const rightChartY = getChartYAtX(rightFootX);

          /* planted foot synced with leg animation phase */
          const leftPlanted = Math.sin(a.stepPhase) <= 0;
          const plantedChartY = leftPlanted ? leftChartY : rightChartY;

          /* body bob: highest at mid-stride push-off, lowest at foot strike */
          a.curBobY = -Math.abs(Math.sin(a.stepPhase)) * BODY_BOB_PX;

          /* altitude from planted foot's ground contact */
          const targetAlt = a.stageH - plantedChartY;
          a.smoothAlt = lerp(a.smoothAlt, targetAlt, 0.35 * dtNorm);

          /* slope alignment from foot spread */
          const slopeDy = rightChartY - leftChartY;
          const slopeDeg =
            Math.atan2(slopeDy, FOOT_SPREAD_PX) * (180 / Math.PI);
          a.smoothRot = lerp(
            a.smoothRot,
            Math.max(-18, Math.min(18, slopeDeg * 0.7)),
            0.2 * dtNorm,
          );

          /* apply run pose synced to step cycle */
          applyPose("run", a.stepPhase / 0.5);
          setFig(figScreenX, a.smoothAlt, a.smoothRot);

          /* spawn dust on each foot plant (half-cycle boundary) */
          const stepHalf = Math.floor(a.stepPhase / Math.PI);
          if (stepHalf !== a.prevStepHalf && a.dustParticles.length < DUST_MAX) {
            const footX = leftPlanted ? leftFootX : rightFootX;
            const footY = leftPlanted ? leftChartY : rightChartY;
            for (let k = 0; k < 3; k++) {
              a.dustParticles.push({
                x: footX + (Math.random() - 0.5) * 6,
                y: footY + (Math.random() - 0.3) * 4,
                vx: -(0.3 + Math.random() * 0.7),
                vy: -(0.2 + Math.random() * 0.5),
                life: DUST_LIFE * (0.6 + Math.random() * 0.4),
                size: 1 + Math.random() * 1.8,
              });
            }
          }
          a.prevStepHalf = stepHalf;
        }
        a.figPrice = priceAtFig;
        a.smoothFigPrice = priceAtFig;

      } else if (a.state === "JUMPING") {
        /* liftoff from chart into air */
        if (a.jumpStartTime === 0) a.jumpStartTime = time;
        const elapsed = time - a.jumpStartTime;

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
          const chartY = getChartYAtX(figScreenX);
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

        /* price delta for physics */
        const priceDelta = a.price - a.prevPrice;
        a.smoothDelta = lerp(a.smoothDelta, priceDelta, 0.12 * dtNorm);

        /* physics */
        if (a.smoothDelta > 0) {
          a.figPriceVel += a.smoothDelta * THRUST_MULT * dtNorm;
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
          const targetRot = -Math.min(18, a.figPriceVel * 35);
          a.smoothRot = lerp(a.smoothRot, targetRot, 0.1 * dtNorm);
          applyPose("jetpack", a.frame);
        } else if (a.smoothDelta < -0.001) {
          setFlame(false);
          a.smoothFlameScale = lerp(a.smoothFlameScale, 0, 0.1 * dtNorm);
          const targetRot = (a.frame * 5) % 360;
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
          setFig(figScreenX, alt, a.smoothRot);
        }

        /* liquidation check */
        if (liqPrice !== null && (a.price <= liqPrice || a.figPrice <= liqPrice || pnlPct <= -1)) {
          splat();
        }

      } else if (a.state === "STOPPED") {
        /* parachute descent: lerp figPrice toward chart price */
        a.figPrice = lerp(a.figPrice, priceAtFig, 0.02 * dtNorm);
        if (priceToY) {
          const figY = priceToY(a.figPrice);
          const alt = a.stageH - figY;
          a.smoothRot = lerp(a.smoothRot, 0, 0.05 * dtNorm);
          setFig(figScreenX, alt, a.smoothRot);
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
  }, [drawScene, applyPose, setFig, setFlame, onPnlChange, splat]);

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
          zIndex: 1,
        }}
      />

      {/* HUD overlays */}
      <div className="price-tick">{priceDisplay}</div>
      <div className={`lev-tag${levTagShow ? " show" : ""}`}>
        {levTagText}
      </div>
      {pnlReadout}

      {/* FIGURE */}
      <div className="figure-wrap" ref={figRef} style={{ zIndex: 6 }}>
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
