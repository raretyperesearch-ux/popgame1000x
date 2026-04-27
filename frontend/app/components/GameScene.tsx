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
import EndOfGameModal, { type EndOfGameData } from "./EndOfGameModal";
import { connectPriceStream } from "@/lib/ws";
import { sounds } from "@/lib/sounds";

/* ============ CONSTANTS ============ */
const GRAVITY_P = 0.004; // price-space gravity per frame (60fps base)
const DRAG = 0.96;
const THRUST_MULT = 3.5; // thrust multiplier for smoothed price delta
const VY_CLAMP_P = 0.6; // max velocity in price-space
const FIG_X_PCT = 0.35; // figure at 35% from left
const CHART_TOP_PCT = 0.12; // chart area top
const CHART_BOT_PCT = 0.88; // chart area bottom
const TERRAIN_BASE_PCT = 0.66;
const TERRAIN_MIN_PCT = 0.48;
const TERRAIN_MAX_PCT = 0.76;
const VISIBLE_POINTS = 90; // price points visible on screen
const TOTAL_POINTS = 150; // buffer size
const CHART_SPEED_IDLE = 0.25; // sub-point scroll per frame (idle)
const CHART_SPEED_RUN = 1.0; // sub-point scroll per frame (running)
const CHART_SPEED_LIVE = 0.45; // sub-point scroll per frame (live)
const PRICE_VOL = 0.65; // random walk step for new chart points
const MOCK_DRIFT = 0.18; // per-frame mini drift
const STEP_FREQ = 4.2; // step cycles per second during run
const BODY_BOB_PX = 3.5; // vertical bob amplitude during run
const DUST_MAX = 15; // max dust particles alive
const DUST_LIFE = 0.45; // seconds each dust particle lives
const RUN_DURATION = 1200; // ms of running before jump
const JUMP_DURATION = 500; // ms of jump liftoff before LIVE
const BODY_HEIGHT_PX = 80;
const GAME_SPEED = 0.45;
const GRASS_GROUND_SRC = "/assets/grass-ground.png";
const WATER_HAZARD_SRC = "/assets/water-hazard.png";
const WATER_SRC_W = 2172;
const WATER_SRC_H = 350;
const GRASS_SRC_W = 1024;
const GRASS_SRC_H = 256;
const GRASS_TILE_W = 520;
const GRASS_TILE_H = 130;
const GRASS_SURFACE_Y = 36;
const GRASS_SLICE_W = 16;
const WATER_SHELF_TOP_PCT = 0.73;
const WATER_SURFACE_SRC_PCT = 0.34;
const WATER_SURFACE_DRAW_PCT = 0.42;
const TERRAIN_SCROLL_PX = 18;
const SPRITE_FRAME_W = 72;
const SPRITE_FRAME_H = 80;
const SPRITE_SCALE = 0.5;
const SPRITE_DISPLAY_W = SPRITE_FRAME_W * SPRITE_SCALE;
const SPRITE_DISPLAY_H = SPRITE_FRAME_H * SPRITE_SCALE;
const SPRITE_FOOT_GAP = 8 * SPRITE_SCALE;
const SPRITE_COLS = 5;
const RUN_FRAME_MS = 100; // 10fps run cycle
const RUN_FRAMES = [0, 1, 2, 3, 4];
const JUMP_FRAMES = [7, 10, 11];
// single calm hover loop — frames 11/12/13 share the same bbox so they
// don't pop vertically as they cycle. Avoids velocity-driven frame switching
// which was visibly glitchy as figPriceVel oscillated around the threshold.
const AIR_FRAMES = [11, 12, 13, 12];
const AIR_FRAME_MS = 150;
const LAND_FRAMES = [14, 15];
const LAND_FRAME_MS = 140;
type SpriteState = "idle" | "run" | "crouch" | "jump" | "air" | "land" | "fail";
const SPRITE_FRAME: Record<Exclude<SpriteState, "run" | "jump" | "air" | "land">, number> = {
  idle: 5,
  crouch: 6,
  fail: 16,
};
const CAMERA_LERP = 0.045;
const BODY_LERP = 0.35;
const ROTATION_LERP = 0.08;
const VELOCITY_LERP = 0.06;
const DEBUG_FEET = false;
const DEBUG_TERRAIN = false;

type GameState = "IDLE" | "RUNNING" | "PREPARE" | "JUMPING" | "LIVE" | "STOPPED" | "DEAD";

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
  const base = stageH * TERRAIN_BASE_PCT;
  const y = base
    + Math.sin(worldX * 0.018 + seed) * stageH * 0.012
    + Math.sin(worldX * 0.007 + seed * 1.7) * stageH * 0.018;
  return clamp(y, stageH * TERRAIN_MIN_PCT, stageH * TERRAIN_MAX_PCT);
}

function buildTerrainPoints(count: number, startWorldX: number, stageH: number, seed: number): number[] {
  const raw: number[] = [];
  for (let i = 0; i < count; i++) raw.push(terrainAt(startWorldX + i, stageH, seed));
  let out = [...raw];
  for (let pass = 0; pass < 3; pass++) {
    const next = [...out];
    for (let i = 1; i < count - 1; i++) {
      next[i] = (out[i - 1] + out[i] * 4 + out[i + 1]) / 6;
    }
    out = next;
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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
  const bannerRef = useRef<HTMLDivElement>(null);
  const parachuteRef = useRef<SVGSVGElement>(null);
  const spriteCanvasRef = useRef<HTMLCanvasElement>(null);
  const spriteImageRef = useRef<HTMLImageElement | null>(null);
  const spriteImageReadyRef = useRef(false);
  const groundImageRef = useRef<HTMLImageElement | null>(null);
  const groundImageReadyRef = useRef(false);
  const waterImageRef = useRef<HTMLImageElement | null>(null);
  const waterImageReadyRef = useRef(false);

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
    prepareStartTime: 0,
    jumpStartTime: 0, // timestamp when JUMPING began
    idleStartTime: 0, // timestamp when IDLE began (sprite-only)
    prevStepHalf: 0, // tracks half-cycle for dust spawn
    spriteState: "idle" as SpriteState,
    spriteRunStart: 0, // timestamp when run animation started
    spriteJumpStart: 0,
    spriteAirStart: 0,
    spriteLandStart: 0,
    spriteFrame: 5, // current sprite frame index
    skyAlt: 0, // 0 = ground/night, 1 = deep galaxies (smoothed)
    groundScrollAcc: 0, // monotonic scroll accumulator for grass tile texture
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
  const [endOfGame, setEndOfGame] = useState<EndOfGameData | null>(null);

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
      // skyAlt-driven dramatic camera: shrink the sprite and push it up the screen as we climb the atmosphere.
      // Reverses naturally when PnL drops because skyAlt lerps both directions.
      const lift = a.skyAlt * a.stageH * 0.25;
      const figScale = lerp(1, 0.4, a.skyAlt);
      const tx = (x - SPRITE_DISPLAY_W / 2).toFixed(1);
      const ty = (SPRITE_FOOT_GAP - alt - a.curBobY - lift).toFixed(1);
      fig.style.transform = `translate3d(${tx}px, ${ty}px, 0) rotate(${rot.toFixed(1)}deg) scale(${figScale.toFixed(3)})`;
    },
    [],
  );

  /* ============ SPRITE RENDERING ============ */
  const setSpriteState = useCallback(
    (state: SpriteState, time?: number) => {
      const a = anim.current;
      if (a.spriteState !== state) {
        a.spriteState = state;
        if (state === "run") a.spriteRunStart = time ?? performance.now();
        if (state === "jump") a.spriteJumpStart = time ?? performance.now();
        if (state === "air") a.spriteAirStart = time ?? performance.now();
        if (state === "land") a.spriteLandStart = time ?? performance.now();
      }
    },
    [],
  );

  const drawSprite = useCallback((time: number) => {
    const canvas = spriteCanvasRef.current;
    const img = spriteImageRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const a = anim.current;

    let frameIdx: number;
    if (a.spriteState === "run") {
      const elapsed = time - (a.spriteRunStart || time);
      frameIdx = RUN_FRAMES[Math.floor(elapsed / RUN_FRAME_MS) % RUN_FRAMES.length];
    } else if (a.spriteState === "jump") {
      const elapsed = time - (a.spriteJumpStart || time);
      frameIdx = JUMP_FRAMES[Math.min(JUMP_FRAMES.length - 1, Math.floor(elapsed / 115))];
    } else if (a.spriteState === "air") {
      const elapsed = time - (a.spriteAirStart || time);
      frameIdx = AIR_FRAMES[Math.floor(elapsed / AIR_FRAME_MS) % AIR_FRAMES.length];
    } else if (a.spriteState === "land") {
      const elapsed = time - (a.spriteLandStart || time);
      frameIdx = LAND_FRAMES[Math.min(LAND_FRAMES.length - 1, Math.floor(elapsed / LAND_FRAME_MS))];
    } else {
      frameIdx = SPRITE_FRAME[a.spriteState];
    }
    a.spriteFrame = frameIdx;

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(SPRITE_DISPLAY_W * dpr);
    const targetH = Math.round(SPRITE_DISPLAY_H * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!img || !spriteImageReadyRef.current) return;
    const sx = (frameIdx % SPRITE_COLS) * SPRITE_FRAME_W;
    const sy = Math.floor(frameIdx / SPRITE_COLS) * SPRITE_FRAME_H;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      img,
      sx, sy, SPRITE_FRAME_W, SPRITE_FRAME_H,
      0, 0, canvas.width, canvas.height,
    );
  }, []);

  const drawGrassGround = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number, pts: { x: number; y: number }[]) => {
    const smoothPts = pts.map((p, i) => {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      return { x: p.x, y: (prev.y + p.y * 4 + next.y) / 6 };
    });
    const groundYAt = (x: number) => {
      if (smoothPts.length < 2) return terrainAt(0, h, 0);
      for (let i = 1; i < smoothPts.length; i++) {
        if (x <= smoothPts[i].x) {
          const prev = smoothPts[i - 1];
          const cur = smoothPts[i];
          const span = Math.max(1, cur.x - prev.x);
          return lerp(prev.y, cur.y, clamp((x - prev.x) / span, 0, 1));
        }
      }
      return smoothPts[smoothPts.length - 1].y;
    };
    const img = groundImageRef.current;
    const firstY = groundYAt(0);
    const minY = Math.min(...smoothPts.map((p) => p.y));

    const shadow = ctx.createLinearGradient(0, firstY - 48, 0, firstY + 24);
    shadow.addColorStop(0, "rgba(0,0,0,0)");
    shadow.addColorStop(1, "rgba(0,0,0,0.24)");
    ctx.fillStyle = shadow;
    ctx.fillRect(0, minY - 48, w, 120);

    ctx.beginPath();
    ctx.moveTo(0, groundYAt(0) + GRASS_TILE_H - GRASS_SURFACE_Y - 10);
    for (let x = 0; x <= w; x += GRASS_SLICE_W) {
      const midX = x + GRASS_SLICE_W * 0.5;
      const endX = x + GRASS_SLICE_W;
      ctx.quadraticCurveTo(
        midX, groundYAt(midX) + GRASS_TILE_H - GRASS_SURFACE_Y - 10,
        endX, groundYAt(endX) + GRASS_TILE_H - GRASS_SURFACE_Y - 10,
      );
    }
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const dirt = ctx.createLinearGradient(0, firstY, 0, h);
    dirt.addColorStop(0, "#2d4a2a");
    dirt.addColorStop(0.35, "#3a2a18");
    dirt.addColorStop(1, "#1f1408");
    ctx.fillStyle = dirt;
    ctx.fill();

    if (img && groundImageReadyRef.current) {
      const scroll = (anim.current.groundScrollAcc * TERRAIN_SCROLL_PX) % GRASS_TILE_W;
      // Each slice overdraws SLICE_OVERLAP px past its right edge so slices
      // mutually cover each other. Without this, sharp slope changes between
      // adjacent slices leave visible vertical slivers because the skewed
      // parallelograms only kiss at one point per edge.
      const SLICE_OVERLAP = 10;
      for (let x = -GRASS_SLICE_W; x < w + GRASS_SLICE_W; x += GRASS_SLICE_W) {
        const leftY = groundYAt(x);
        const rightY = groundYAt(x + GRASS_SLICE_W);
        const skewY = (rightY - leftY) / GRASS_SLICE_W;
        const sourceX = Math.floor((((x + scroll) % GRASS_TILE_W) + GRASS_TILE_W) % GRASS_TILE_W / GRASS_TILE_W * GRASS_SRC_W);
        const drawW = GRASS_SLICE_W + SLICE_OVERLAP;
        const sourceW = Math.max(1, Math.min(GRASS_SRC_W - sourceX, Math.ceil(GRASS_SRC_W * drawW / GRASS_TILE_W)));
        ctx.save();
        // skew each slice so its top tilts to match the slope; adjacent slices meet at the exact same y
        ctx.transform(1, skewY, 0, 1, x, leftY - GRASS_SURFACE_Y);
        ctx.drawImage(
          img,
          sourceX, 0, sourceW, GRASS_SRC_H,
          0, 0, drawW, GRASS_TILE_H,
        );
        ctx.restore();
      }
      return;
    }

    const fallback = ctx.createLinearGradient(0, firstY, 0, h);
    fallback.addColorStop(0, "#3f8f3e");
    fallback.addColorStop(0.12, "#1f5f30");
    fallback.addColorStop(0.18, "#2f261d");
    fallback.addColorStop(1, "#05080d");
    ctx.fillStyle = fallback;
    ctx.fillRect(0, firstY - 8, w, h - firstY + 8);
  }, []);

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

      /* altitude-driven sky: 4 layers blended by skyAlt (0=night, 1=galaxies) */
      const skyAlt = a.skyAlt;
      const layerColors = [
        // night (default ground level)
        ["#000208", "#050818", "#0a1a30", "#0a1828", "#060a14"],
        // stratosphere (sun, warm horizon)
        ["#1a3050", "#3060a0", "#80a0c0", "#d09060", "#704030"],
        // space (deep blue → black, planets visible)
        ["#000010", "#02040c", "#050818", "#02040a", "#000005"],
        // galaxies (purple-black, nebula tint)
        ["#080018", "#180830", "#280a40", "#100525", "#02000a"],
      ];
      const layerIdx = clamp(Math.floor(skyAlt * 3), 0, 2);
      const layerLocal = clamp(skyAlt * 3 - layerIdx, 0, 1);
      const blendHex = (a1: string, b1: string, t: number) => {
        const ar = parseInt(a1.slice(1, 3), 16), ag = parseInt(a1.slice(3, 5), 16), ab = parseInt(a1.slice(5, 7), 16);
        const br = parseInt(b1.slice(1, 3), 16), bg = parseInt(b1.slice(3, 5), 16), bb = parseInt(b1.slice(5, 7), 16);
        const r = Math.round(ar + (br - ar) * t);
        const g = Math.round(ag + (bg - ag) * t);
        const bl = Math.round(ab + (bb - ab) * t);
        return `rgb(${r},${g},${bl})`;
      };
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      const stops = [0, 0.25, 0.5, 0.8, 1];
      for (let i = 0; i < stops.length; i++) {
        grad.addColorStop(stops[i], blendHex(layerColors[layerIdx][i], layerColors[layerIdx + 1][i], layerLocal));
      }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      /* stars — fade in as altitude increases */
      const starAlpha = clamp(1 - skyAlt * 0.2 + skyAlt * 0.6, 0.6, 1.4);
      ctx.fillStyle = "#f4ecd8";
      for (const s of stars) {
        ctx.globalAlpha = clamp(s.opacity * starAlpha, 0, 1);
        ctx.fillRect((s.x / 100) * w, (s.y / 100) * h, s.size, s.size);
      }
      ctx.globalAlpha = 1;

      /* extra deep-space stars (only visible past stratosphere) */
      if (skyAlt > 0.35) {
        const deepAlpha = clamp((skyAlt - 0.35) * 1.6, 0, 1);
        ctx.fillStyle = "#ffffff";
        for (let i = 0; i < 80; i++) {
          const sx = ((i * 137.5) % 100) / 100 * w;
          const sy = ((i * 91.7) % 100) / 100 * h * 0.7;
          const flicker = 0.5 + 0.5 * Math.sin(a.frame * 0.02 + i * 0.7);
          ctx.globalAlpha = deepAlpha * 0.6 * flicker;
          ctx.fillRect(sx, sy, 1.4, 1.4);
        }
        ctx.globalAlpha = 1;
      }

      /* moon — fades out as we leave the troposphere */
      const moonAlpha = Math.max(0, 0.18 - skyAlt * 0.4);
      if (moonAlpha > 0.01) {
        const moonX = w * 0.82, moonY = h * 0.09, moonR = 14;
        ctx.globalAlpha = moonAlpha;
        ctx.fillStyle = "#f4ecd8";
        ctx.beginPath();
        ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.arc(moonX + 7, moonY - 3, moonR * 0.85, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
      }

      /* sun — peaks in the stratosphere band (skyAlt 0.2 - 0.6) */
      const sunAlpha = Math.max(0, 1 - Math.abs(skyAlt - 0.4) * 3.2);
      if (sunAlpha > 0.01) {
        const sunX = w * 0.78, sunY = h * 0.18, sunR = 28;
        const sunGrad = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR * 3);
        sunGrad.addColorStop(0, `rgba(255,230,140,${sunAlpha})`);
        sunGrad.addColorStop(0.4, `rgba(255,180,90,${sunAlpha * 0.5})`);
        sunGrad.addColorStop(1, "rgba(255,140,80,0)");
        ctx.fillStyle = sunGrad;
        ctx.fillRect(0, 0, w, h * 0.5);
        ctx.fillStyle = `rgba(255,240,200,${sunAlpha})`;
        ctx.beginPath();
        ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
        ctx.fill();
      }

      /* planets — appear in the space band (skyAlt 0.5 - 1.0) */
      const planetAlpha = clamp((skyAlt - 0.45) * 2.0, 0, 1);
      if (planetAlpha > 0.05) {
        const planets = [
          { x: 0.18, y: 0.12, r: 18, color: "#c87850", ring: false },
          { x: 0.52, y: 0.22, r: 11, color: "#6890c0", ring: false },
          { x: 0.88, y: 0.35, r: 22, color: "#a08060", ring: true },
        ];
        for (const p of planets) {
          ctx.globalAlpha = planetAlpha;
          const px = w * p.x;
          const py = h * p.y;
          const pg = ctx.createRadialGradient(px - p.r * 0.3, py - p.r * 0.3, 0, px, py, p.r);
          pg.addColorStop(0, p.color);
          pg.addColorStop(1, "#000");
          ctx.fillStyle = pg;
          ctx.beginPath();
          ctx.arc(px, py, p.r, 0, Math.PI * 2);
          ctx.fill();
          if (p.ring) {
            ctx.strokeStyle = `rgba(200,180,140,${planetAlpha * 0.6})`;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.ellipse(px, py, p.r * 1.6, p.r * 0.35, -0.3, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      }

      /* nebula + galaxies — appear past skyAlt 0.65 */
      const nebulaAlpha = clamp((skyAlt - 0.6) * 2.5, 0, 1);
      if (nebulaAlpha > 0.05) {
        const blobs = [
          { x: 0.3, y: 0.3, r: 180, c1: "rgba(180,80,200,0.18)", c2: "rgba(80,40,120,0)" },
          { x: 0.75, y: 0.18, r: 150, c1: "rgba(80,140,220,0.15)", c2: "rgba(40,60,140,0)" },
          { x: 0.55, y: 0.5, r: 220, c1: "rgba(220,80,120,0.12)", c2: "rgba(120,40,80,0)" },
        ];
        ctx.globalAlpha = nebulaAlpha;
        for (const b of blobs) {
          const bx = w * b.x;
          const by = h * b.y;
          const bg = ctx.createRadialGradient(bx, by, 0, bx, by, b.r);
          bg.addColorStop(0, b.c1);
          bg.addColorStop(1, b.c2);
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, w, h * 0.7);
        }
        /* spiral galaxy hint */
        if (nebulaAlpha > 0.5) {
          const gx = w * 0.15, gy = h * 0.2;
          ctx.globalAlpha = nebulaAlpha * 0.35;
          for (let arm = 0; arm < 2; arm++) {
            const rot = arm * Math.PI;
            ctx.strokeStyle = "#e0d0ff";
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            for (let t = 0; t < 1; t += 0.05) {
              const r = t * 60;
              const ang = rot + t * Math.PI * 1.6;
              const px = gx + Math.cos(ang) * r;
              const py = gy + Math.sin(ang) * r * 0.7;
              if (t === 0) ctx.moveTo(px, py);
              else ctx.lineTo(px, py);
            }
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      }

      /* sketch clouds — fade out as we leave the troposphere */
      const cloudAlpha = Math.max(0, 1 - skyAlt * 2.5);
      const cloudScroll = a.scrollFrac * 0.08;
      const cloudPositions = [
        { x: 0.12, y: 0.06, s: 1.1 },
        { x: 0.35, y: 0.10, s: 0.8 },
        { x: 0.58, y: 0.04, s: 1.3 },
        { x: 0.78, y: 0.12, s: 0.9 },
        { x: 0.92, y: 0.07, s: 1.0 },
      ];
      ctx.strokeStyle = `rgba(244,236,216,${0.06 * cloudAlpha})`;
      ctx.lineWidth = 1.2;
      for (const c of cloudPositions) {
        const cx = ((c.x * w + cloudScroll * w * 0.5) % (w + 60)) - 30;
        const cy = c.y * h;
        const s = c.s * 18;
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx - s * 0.45, cy + 2, s * 0.35, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx + s * 0.45, cy + 2, s * 0.38, 0, Math.PI * 2);
        ctx.stroke();
      }

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
          groundPath.moveTo(pts[0]?.x ?? 0, h);
          for (let i = 0; i < pts.length; i++) groundPath.lineTo(pts[i].x, pts[i].y);
          groundPath.lineTo(pts[pts.length - 1]?.x ?? w, h);
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

      if (DEBUG_TERRAIN) {
        ctx.strokeStyle = "rgba(255,230,80,0.8)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
          else ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.stroke();
        for (let i = 6; i < pts.length; i += 8) {
          const nx = -(pts[i].y - pts[i - 1].y);
          const ny = pts[i].x - pts[i - 1].x;
          const len = Math.max(1e-6, Math.hypot(nx, ny));
          ctx.strokeStyle = "rgba(255,255,120,0.45)";
          ctx.beginPath();
          ctx.moveTo(pts[i].x, pts[i].y);
          ctx.lineTo(pts[i].x + (nx / len) * 8, pts[i].y + (ny / len) * 8);
          ctx.stroke();
        }
      }

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

      /* ground fades away as we climb out of the atmosphere */
      const groundAlpha = clamp(1 - a.skyAlt * 1.6, 0, 1);
      if (groundAlpha > 0.01) {
        ctx.save();
        ctx.globalAlpha = groundAlpha;
        drawGrassGround(ctx, w, h, pts);
        ctx.restore();
      }

      /* generated pixel-art water hazard fills the lower gap beneath the cliff */
      const waterImg = waterImageRef.current;
      const shelfTop = h * WATER_SHELF_TOP_PCT;
      const shelfH = h - shelfTop;
      if (waterImg && waterImageReadyRef.current) {
        const tileW = Math.max(w, shelfH * (WATER_SRC_W / WATER_SRC_H));
        const drift = (a.groundScrollAcc * TERRAIN_SCROLL_PX) % tileW;
        const waveBob = Math.round(Math.sin(a.frame * 0.055) * 2);
        const foamDrift = (drift * 1.18 + Math.round(Math.sin(a.frame * 0.035) * 10)) % tileW;
        const surfaceSrcH = Math.floor(WATER_SRC_H * WATER_SURFACE_SRC_PCT);
        const surfaceH = Math.ceil(shelfH * WATER_SURFACE_DRAW_PCT);
        ctx.save();
        ctx.globalAlpha = groundAlpha;
        ctx.imageSmoothingEnabled = false;
        for (let x = -drift - tileW; x < w + tileW; x += tileW) {
          ctx.drawImage(waterImg, Math.round(x), Math.round(shelfTop + waveBob), Math.round(tileW), Math.round(shelfH));
        }
        ctx.globalAlpha = groundAlpha * 0.78;
        for (let x = -foamDrift - tileW; x < w + tileW; x += tileW) {
          ctx.drawImage(
            waterImg,
            0, 0, WATER_SRC_W, surfaceSrcH,
            Math.round(x), Math.round(shelfTop - waveBob),
            Math.round(tileW), surfaceH,
          );
        }
        ctx.restore();
      }

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
    [drawGrassGround, stars],
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
    if (parachuteRef.current)
      parachuteRef.current.classList.remove("deployed");
    setSpriteState("idle");
    onPnlChange(null);
    setLevTagShow(false);
    setLevTagText("\u2014");
    a.figPriceVel = 0;
    a.smoothDelta = 0;
    a.curBobY = 0;
    a.stepPhase = 0;
    a.runFrame = 0;
    a.runStartTime = 0;
    a.prepareStartTime = 0;
    a.jumpStartTime = 0;
    a.idleStartTime = 0;
    a.spriteJumpStart = 0;
    a.spriteAirStart = 0;
    a.spriteLandStart = 0;
    a.prevStepHalf = 0;
    a.dustParticles.length = 0;
    a.loco.grounded = true;
    a.loco.stepPhase = 0;
    a.loco.plantedFoot = "left";
    a.loco.squash = 0;
  }, [setGameState, setSpriteState, onPnlChange]);

  /* ============ SPLAT (liquidation) ============ */
  const splat = useCallback(() => {
    const a = anim.current;
    if (a.state === "DEAD") return;
    a.state = "DEAD";
    setGameState("DEAD");
    setSpriteState("fail");
    sounds.play("rekt-crash");
    onHistoryPush({ amt: -a.positionWager, win: false });
    // brief pause so the splat animation reads, then show modal
    setTimeout(() => {
      setEndOfGame({
        kind: "rekt",
        pnlDollars: -a.positionWager,
        pnlPct: -1,
        entry: a.entry,
        exit: null,
        boost: a.positionLev,
        wager: a.positionWager,
      });
    }, 900);
  }, [setGameState, setSpriteState, onHistoryPush]);

  /* ============ STOP TRADE ============ */
  const stopTrade = useCallback(() => {
    const a = anim.current;
    if (a.state !== "LIVE") return;
    a.state = "STOPPED";
    setGameState("STOPPED");
    sounds.play("deploy-chute");
    if (parachuteRef.current) parachuteRef.current.classList.add("deployed");
    const move = (a.price - a.entry) / a.entry;
    const pnlPct = move * a.positionLev;
    const pnlDollars = pnlPct * a.positionWager;
    setBalance((prev: number) => prev + a.positionWager + pnlDollars);
    setSpriteState("land");
    onHistoryPush({ amt: pnlDollars, win: pnlDollars >= 0 });
    const kind: "win" | "loss" = pnlDollars >= 0 ? "win" : "loss";
    // wait for parachute descent to settle before showing modal
    setTimeout(() => {
      sounds.play(kind === "win" ? "win-fanfare" : "loss-thud");
      setEndOfGame({
        kind,
        pnlDollars,
        pnlPct,
        entry: a.entry,
        exit: a.price,
        boost: a.positionLev,
        wager: a.positionWager,
      });
    }, 900);
  }, [setGameState, setBalance, setSpriteState, onHistoryPush]);

  const closeEndOfGame = useCallback(() => {
    setEndOfGame(null);
    reset();
  }, [reset]);

  /* ============ START JUMP ============ */
  const startJump = useCallback(
    (lev: number, wag: number) => {
      const a = anim.current;
      sounds.play("lever-pull");
      a.state = "RUNNING";
      setGameState("RUNNING");
      a.positionLev = lev;
      a.positionWager = wag;
      a.runFrame = 0;
      a.stepPhase = 0;
      a.prevStepHalf = 0;
      a.runStartTime = 0; // set on first tick
      a.prepareStartTime = 0;
      a.jumpStartTime = 0;
      a.spriteJumpStart = 0;
      a.spriteAirStart = 0;
      a.spriteLandStart = 0;
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
      const dt = lastTime ? Math.min(time - lastTime, 33.33) : 16.67;
      lastTime = time;
      const dtNorm = dt / 16.67;
      const a = anim.current;

      /* price drift (mock mode) */
      a.price += (Math.random() - 0.485) * MOCK_DRIFT * dtNorm;
      a.renderPrice = lerp(a.renderPrice, a.price, 0.08 * dtNorm);

      /* chart scroll speed based on state */
      let speed = CHART_SPEED_IDLE;
      if (a.state === "RUNNING" || a.state === "PREPARE" || a.state === "JUMPING") speed = CHART_SPEED_RUN;
      else if (a.state === "IDLE" && a.idleStartTime > 0 && time - a.idleStartTime >= 800) speed = CHART_SPEED_RUN;
      else if (a.state === "LIVE") speed = CHART_SPEED_LIVE;
      else if (a.state === "STOPPED") speed = CHART_SPEED_IDLE;
      speed *= GAME_SPEED;

      /* advance chart scroll */
      a.scrollFrac += speed * dtNorm;
      a.groundScrollAcc += speed * dtNorm; // monotonic mirror; never wraps so the grass texture doesn't snap
      while (a.scrollFrac >= 1) {
        a.scrollFrac -= 1;
        /* add new price point from current price */
        const last = a.prices[a.prices.length - 1];
        const step = (a.renderPrice - last) * 0.26 + (Math.random() - 0.48) * PRICE_VOL * 0.75;
        a.prices.push(last + step);
        const i = a.terrainPoints.length;
        const terrainRaw = terrainAt(i, a.stageH || 700, a.terrainSeed);
        const prev = a.terrainPoints[a.terrainPoints.length - 1] ?? terrainRaw;
        const priceTilt = clamp(step, -1.2, 1.2) * -4;
        const desired = lerp(terrainRaw, prev + priceTilt, 0.18);
        const terrainNext = clamp(
          lerp(prev, desired, 0.08),
          (a.stageH || 700) * TERRAIN_MIN_PCT,
          (a.stageH || 700) * TERRAIN_MAX_PCT,
        );
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

      /* sky altitude target — climbs with PnL during LIVE, holds during STOPPED, decays otherwise */
      let skyTarget = 0;
      if (a.state === "LIVE") {
        const pnlPct = (a.price - a.entry) / a.entry * a.positionLev;
        skyTarget = clamp(pnlPct * 0.5, 0, 1);
      } else if (a.state === "STOPPED") {
        skyTarget = 0; // decay back to ground while parachuting
      } else if (a.state === "JUMPING") {
        skyTarget = 0.08; // brief lift during liftoff
      }
      a.skyAlt = lerp(a.skyAlt, skyTarget, 0.08 * dtNorm);

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
          /* green dot = raw getTerrainY at figWorldX */
          drawDot(figScreenX, getTerrainY(figWorldX), "#00ff00", 3.5);
        }
      }

      /* snap figure to terrain on very first frame */
      if (a.frame <= 1) {
        const initY = getTerrainY(figWorldX);
        a.smoothAlt = a.stageH - initY;
      }

      /* ---- state-specific logic ---- */
      if (a.state === "IDLE") {
        if (a.idleStartTime === 0) a.idleStartTime = time;
        const idleHold = time - a.idleStartTime < 800;
        setSpriteState(idleHold ? "idle" : "run", time);
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
        const ridgeY = getTerrainY(figWorldX);
        loco.bodyY = ridgeY - BODY_HEIGHT_PX;
        a.curBobY = 0;
        const slopeDeg = clamp(Math.atan(getTerrainSlope(figWorldX)) * (180 / Math.PI), -3, 3);
        a.smoothRot = lerp(a.smoothRot, slopeDeg, ROTATION_LERP * dtNorm);
        a.smoothAlt = lerp(a.smoothAlt, a.stageH - ridgeY, 0.65 * dtNorm);
        setFig(figScreenX, a.smoothAlt, a.smoothRot);
        a.figPrice = priceAtFig;
        a.smoothFigPrice = priceAtFig;

      } else if (a.state === "RUNNING") {
        /* set runStartTime on first frame */
        if (a.runStartTime === 0) a.runStartTime = time;
        const elapsed = time - a.runStartTime;
        setSpriteState("run", time);

        if (elapsed > RUN_DURATION) {
          a.state = "PREPARE";
          setGameState("PREPARE");
          a.prepareStartTime = time;
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
            sounds.play("footstep");
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
          const ridgeY = getTerrainY(figWorldX);
          loco.bodyY = ridgeY - BODY_HEIGHT_PX;
          a.curBobY = 0;
          const slopeDeg = clamp(Math.atan(getTerrainSlope(figWorldX)) * (180 / Math.PI), -3, 3);
          a.smoothRot = lerp(a.smoothRot, slopeDeg, ROTATION_LERP * dtNorm);
          a.smoothAlt = lerp(a.smoothAlt, a.stageH - ridgeY, 0.65 * dtNorm);
          setFig(figScreenX, a.smoothAlt, a.smoothRot);
        }
        a.figPrice = priceAtFig;
        a.smoothFigPrice = priceAtFig;

      } else if (a.state === "PREPARE") {
        const prepElapsed = time - (a.prepareStartTime || time);
        const t = clamp(prepElapsed / 150, 0, 1);
        a.curBobY = Math.sin(t * Math.PI) * 4.5;
        setSpriteState("crouch", time);
        setFig(figScreenX, a.smoothAlt - t * 2, a.smoothRot);
        if (prepElapsed >= 150) {
          a.state = "JUMPING";
          setGameState("JUMPING");
          a.jumpStartTime = time;
          a.curBobY = 0;
          sounds.play("liftoff");
        }

      } else if (a.state === "JUMPING") {
        /* liftoff from chart into air */
        if (a.jumpStartTime === 0) a.jumpStartTime = time;
        const elapsed = time - a.jumpStartTime;
        const loco = a.loco;
        setSpriteState(elapsed > JUMP_DURATION * 0.52 ? "air" : "jump", time);
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
          a.smoothRot = lerp(a.smoothRot, -10 * liftArc, ROTATION_LERP * dtNorm);
          setFig(figScreenX, a.smoothAlt, a.smoothRot);
          a.figPrice = priceAtFig;
          a.frame++;
        }

      } else if (a.state === "LIVE") {
        a.frame++;
        const loco = a.loco;
        setSpriteState("air", time);
        a.curBobY = 0;

        /* price delta for physics */
        const priceDelta = a.price - a.prevPrice;
        a.smoothDelta = lerp(a.smoothDelta, priceDelta, VELOCITY_LERP * dtNorm);

        /* physics */
        const thrust = clamp(a.smoothDelta * THRUST_MULT, -0.08, 0.12);
        if (a.smoothDelta > 0.001) {
          a.figPriceVel += thrust * 0.6 * dtNorm;
        } else if (Math.abs(a.smoothDelta) <= 0.0015) {
          a.figPriceVel += (-GRAVITY_P * 0.25) * dtNorm;
        } else {
          a.figPriceVel += (thrust * 0.25 - GRAVITY_P * 1.15) * dtNorm;
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

        /* gentle body tilt with thrust dust */
        if (a.smoothDelta > 0.001) {
          const targetRot = clamp(-a.figPriceVel * 35, -15, 15);
          a.smoothRot = lerp(a.smoothRot, targetRot, ROTATION_LERP * dtNorm);
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
          const targetRot = clamp(a.figPriceVel * 45, -15, 15);
          a.smoothRot = lerp(a.smoothRot, targetRot, (ROTATION_LERP * 0.7) * dtNorm);
        } else {
          a.smoothRot = lerp(a.smoothRot, 0, ROTATION_LERP * dtNorm);
        }

        /* position figure */
        if (priceToY) {
          const figY = priceToY(a.figPrice);
          const alt = a.stageH - figY;
          a.smoothAlt = lerp(a.smoothAlt, alt, BODY_LERP * dtNorm);
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
            setSpriteState("land", time);
          } else {
            setSpriteState("air", time);
          }
        }

      } else if (a.state === "DEAD") {
        /* keep the liquidated frame visible long enough to read */
        setSpriteState("fail", time);
        const groundY = getTerrainY(figWorldX);
        a.smoothAlt = lerp(a.smoothAlt, a.stageH - groundY + 2, 0.35 * dtNorm);
        setFig(figScreenX, a.smoothAlt, 0);
        a.frame++;
      }

      drawSprite(time);

      a.prevPrice = a.price;
      a.frame++;
      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [drawScene, drawSprite, setSpriteState, setFig, onPnlChange, splat, getTerrainY, getTerrainSlope, getTerrainNormal, setGameState]);

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
    setSpriteState("idle");
    const handleResize = () => resizeCanvas();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [resizeCanvas, setSpriteState]);

  /* ============ SPRITE IMAGE LOAD ============ */
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      spriteImageReadyRef.current = true;
    };
    img.src = "/spritesheet.png";
    spriteImageRef.current = img;
    return () => {
      spriteImageRef.current = null;
      spriteImageReadyRef.current = false;
    };
  }, []);

  /* ============ GROUND IMAGE LOAD ============ */
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      groundImageReadyRef.current = true;
    };
    img.src = GRASS_GROUND_SRC;
    groundImageRef.current = img;
    return () => {
      groundImageRef.current = null;
      groundImageReadyRef.current = false;
    };
  }, []);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      waterImageReadyRef.current = true;
    };
    img.src = WATER_HAZARD_SRC;
    waterImageRef.current = img;
    return () => {
      waterImageRef.current = null;
      waterImageReadyRef.current = false;
    };
  }, []);

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
      <div
        className="figure-wrap"
        ref={figRef}
        style={{
          zIndex: 3,
          opacity: 1,
          width: SPRITE_DISPLAY_W,
          height: SPRITE_DISPLAY_H,
          transformOrigin: "50% 100%",
        }}
      >
        <svg
          className="parachute"
          ref={parachuteRef}
          width={80}
          height={44}
          viewBox="0 0 80 44"
          style={{ bottom: SPRITE_DISPLAY_H * 0.7 }}
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
        <canvas
          ref={spriteCanvasRef}
          style={{
            position: "absolute",
            left: 0,
            bottom: 0,
            width: SPRITE_DISPLAY_W,
            height: SPRITE_DISPLAY_H,
            imageRendering: "pixelated",
            pointerEvents: "none",
          }}
        />
      </div>
      <div className="banner" ref={bannerRef} />
      <EndOfGameModal data={endOfGame} onClose={closeEndOfGame} />
    </div>
  );
});

export default GameScene;
