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
const GRAVITY = 0.32;
const DRAG = 0.94;
const THRUST = 0.55;
const FALL_FORCE = 0.22;
const VY_CLAMP = 9;
const FIG_BODY_X = 18;
const FIGURE_FOOT_OFFSET = 10;

type GameState = "IDLE" | "RUNNING" | "JUMPING" | "LIVE" | "STOPPED" | "DEAD";
type Tier = "ground" | "clouds" | "strato" | "space";

const TIER_LABELS: Record<Tier, string> = {
  ground: "SEA LEVEL",
  clouds: "CLOUDS",
  strato: "STRATOSPHERE",
  space: "SPACE",
};

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

/* ============ CLOUD DATA ============ */
const CLOUD_POSITIONS = [
  { left: 8, bottom: 15, scale: 1.1, opacity: 0.7 },
  { left: 55, bottom: 22, scale: 1.4, opacity: 0.85 },
  { left: 30, bottom: 40, scale: 0.9, opacity: 0.6 },
  { left: 70, bottom: 55, scale: 1.2, opacity: 0.75 },
  { left: 12, bottom: 65, scale: 1.0, opacity: 0.65 },
  { left: 45, bottom: 75, scale: 1.3, opacity: 0.8 },
  { left: 78, bottom: 85, scale: 0.85, opacity: 0.5 },
  { left: 22, bottom: 90, scale: 1.1, opacity: 0.7 },
];

const STRATO_POSITIONS = [
  { left: 20, bottom: 20, scale: 0.7, opacity: 0.35 },
  { left: 65, bottom: 45, scale: 0.6, opacity: 0.3 },
  { left: 35, bottom: 70, scale: 0.5, opacity: 0.25 },
  { left: 80, bottom: 85, scale: 0.4, opacity: 0.2 },
];

const LOW_CLOUDS = [
  { left: 18, top: 8, scale: 0.7, opacity: 0.4 },
  { left: 60, top: 14, scale: 0.6, opacity: 0.35 },
];

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
    balance,
    setBalance,
    leverage,
    wager,
    gameState,
    setGameState,
    onHistoryPush,
    onPnlChange,
    pnlReadout,
  },
  ref,
) {
  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const figRef = useRef<HTMLDivElement>(null);
  const waveRefs = useRef<(SVGPathElement | null)[]>([]);
  const foamRef = useRef<SVGGElement>(null);
  const flameRef = useRef<SVGGElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const parachuteRef = useRef<SVGSVGElement>(null);
  const dangerRef = useRef<HTMLDivElement>(null);

  /* limb refs for direct DOM mutation in animation loop */
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

  /* mutable animation state (useRef to avoid re-renders on every tick) */
  const anim = useRef({
    price: 3500,
    figAlt: 0,
    vy: 0,
    vx: 0,
    bgOffset: 0,
    frame: 0,
    curBobY: 0,
    waveOffset: 0,
    stageW: 0,
    stageH: 0,
    cliffEdgeX: 0,
    cliffTopY: 0,
    waterY: 0,
    SCROLL_CEILING: 0,
    WORLD_HEIGHT: 0,
    state: "IDLE" as GameState,
    entry: 3500,
    positionLev: 100,
    positionWager: 5,
    currentTier: "ground" as Tier,
    lastBeepFrame: 0,
  });

  /* render-triggering state */
  const [priceDisplay, setPriceDisplay] = useState("ETH $3500.00");
  const [tierClass, setTierClass] = useState("tier-tag ground");
  const [tierLabel, setTierLabel] = useState("SEA LEVEL");
  const [levTagText, setLevTagText] = useState("\u2014");
  const [levTagShow, setLevTagShow] = useState(false);

  /* stars (generated once) */
  const [spaceStars] = useState(() =>
    Array.from({ length: 70 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      bottom: Math.random() * 100,
      opacity: +(Math.random() * 0.6 + 0.4).toFixed(2),
      bright: Math.random() > 0.85,
    })),
  );
  const [stratoStars] = useState(() =>
    Array.from({ length: 10 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      bottom: 50 + Math.random() * 50,
      opacity: +(Math.random() * 0.4 + 0.2).toFixed(2),
    })),
  );

  /* foam line refs */
  const FOAM_COUNT = 7;
  const foamLineRefs = useRef<(SVGLineElement | null)[]>([]);

  const waveYBase = [10, 26, 42, 58, 74, 90];
  const waveAmp = [3.5, 3, 2.5, 2, 1.6, 1.2];

  /* ============ MEASURE ============ */
  const measure = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const a = anim.current;
    a.stageW = r.width;
    a.stageH = r.height;
    a.cliffEdgeX = a.stageW * 0.4;
    a.cliffTopY = a.stageH * 0.5;
    a.waterY = a.stageH * 0.78;
    a.SCROLL_CEILING = a.stageH * 0.65;
    a.WORLD_HEIGHT = a.stageH * 4;
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
    const setL = (
      el: SVGLineElement | null,
      a: LimbAttrs,
    ) => {
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

  /* ============ PLACE FIGURE IDLE ============ */
  const placeFigureIdle = useCallback(() => {
    measure();
    const a = anim.current;
    const fig = figRef.current;
    if (fig) fig.style.transition = "none";
    a.figAlt = a.stageH - a.cliffTopY;
    a.curBobY = 0;
    setFig(8 + FIG_BODY_X, a.figAlt, 0);
    a.bgOffset = 0;
    const w = worldRef.current;
    if (w) w.style.transform = "translate3d(0px, 0px, 0)";
    setTimeout(() => {
      if (fig) fig.style.transition = "transform 0.18s ease";
    }, 50);
  }, [measure, setFig]);

  /* ============ SETUP WORLD ============ */
  const setupWorld = useCallback(() => {
    measure();
    const a = anim.current;
    const w = worldRef.current;
    if (w) w.style.height = a.WORLD_HEIGHT + "px";
  }, [measure]);

  /* ============ BANNER ============ */
  const showBanner = useCallback((kind: "win" | "loss", text: string) => {
    const b = bannerRef.current;
    if (!b) return;
    b.textContent = text;
    b.className = "banner show " + kind;
    setTimeout(() => b.classList.remove("show"), 1500);
  }, []);

  /* ============ SPLASH ============ */
  const spawnSplash = useCallback(() => {
    const stageEl = stageRef.current;
    const figEl = figRef.current;
    if (!stageEl || !figEl) return;
    const stageBox = stageEl.getBoundingClientRect();
    const figBox = figEl.getBoundingClientRect();
    const a = anim.current;
    const cx = figBox.left + figBox.width / 2 - stageBox.left;
    const cy = stageBox.height - (a.stageH - a.waterY);
    for (let i = 0; i < 24; i++) {
      const p = document.createElement("div");
      p.className = "splash-particle";
      p.style.left = cx + "px";
      p.style.top = cy + "px";
      stageEl.appendChild(p);
      const angle =
        -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.95;
      const dist = 35 + Math.random() * 100;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      p.animate(
        [
          { transform: "translate(0,0)", opacity: "1" },
          {
            transform: `translate(${dx}px,${dy + 60}px)`,
            opacity: "0",
          },
        ],
        { duration: 900, easing: "cubic-bezier(0.4,0,0.6,1)" },
      );
      setTimeout(() => p.remove(), 950);
    }
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
    placeFigureIdle();
    onPnlChange(null);
    setLevTagShow(false);
    setLevTagText("\u2014");
    a.currentTier = "ground";
    setTierClass("tier-tag ground");
    setTierLabel("SEA LEVEL");
    if (dangerRef.current) dangerRef.current.style.opacity = "1";
  }, [setGameState, setFlame, applyPose, placeFigureIdle, onPnlChange]);

  /* ============ SPLAT ============ */
  const splat = useCallback(() => {
    const a = anim.current;
    if (a.state === "DEAD") return;
    a.state = "DEAD";
    setGameState("DEAD");
    setFlame(false);
    const fig = figRef.current;
    if (fig) {
      fig.style.transition = "transform 0.3s ease-in";
      a.figAlt = a.stageH - a.waterY - 6;
      const tx = (a.cliffEdgeX + 60 - FIG_BODY_X).toFixed(1);
      const ty = (FIGURE_FOOT_OFFSET - a.figAlt).toFixed(1);
      fig.style.transform = `translate3d(${tx}px, ${ty}px, 0) rotate(180deg) scale(1.3, 0.35)`;
    }
    const w = worldRef.current;
    if (w) {
      w.style.transition = "transform 0.3s ease-out";
      w.style.transform = "translate3d(0px, 0px, 0)";
      a.bgOffset = 0;
      setTimeout(() => {
        if (w) w.style.transition = "none";
      }, 400);
    }
    spawnSplash();
    showBanner("loss", "\u2212$" + a.positionWager.toFixed(2));
    onHistoryPush({ amt: -a.positionWager, win: false });
    setTimeout(reset, 1900);
  }, [setGameState, setFlame, spawnSplash, showBanner, onHistoryPush, reset]);

  /* ============ STOP ============ */
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
    setBalance((prev: number) => {
      const next = prev + a.positionWager + pnlDollars;
      return next;
    });
    applyPose("parachute", 0);
    const fig = figRef.current;
    if (fig) {
      fig.style.transition = "transform 1.4s cubic-bezier(0.4,0,0.2,1)";
      a.figAlt = a.stageH - a.cliffTopY + 60;
      setFig(a.cliffEdgeX + 60, a.figAlt, 0);
    }
    const w = worldRef.current;
    if (w) {
      w.style.transition = "transform 1.4s cubic-bezier(0.4,0,0.2,1)";
      w.style.transform = "translate3d(0px, 0px, 0)";
      a.bgOffset = 0;
      setTimeout(() => {
        if (w) w.style.transition = "none";
      }, 1500);
    }
    const sign = pnlDollars >= 0 ? "+" : "\u2212";
    showBanner(
      pnlDollars >= 0 ? "win" : "loss",
      sign + "$" + Math.abs(pnlDollars).toFixed(2),
    );
    onHistoryPush({ amt: pnlDollars, win: pnlDollars >= 0 });
    setTimeout(reset, 2000);
  }, [
    setGameState,
    setFlame,
    setBalance,
    applyPose,
    setFig,
    showBanner,
    onHistoryPush,
    reset,
  ]);

  /* ============ JUMP SEQUENCE ============ */
  const startJump = useCallback(
    (lev: number, wag: number) => {
      const a = anim.current;
      a.state = "RUNNING";
      setGameState("RUNNING");
      a.positionLev = lev;
      a.positionWager = wag;

      /* run phase */
      measure();
      const fig = figRef.current;
      if (fig) fig.style.transition = "transform 1.0s ease-out";
      const runStartX = 8 + FIG_BODY_X;
      const runEndX = a.cliffEdgeX - 18 + FIG_BODY_X;
      let runFrameCount = 0;
      const runStartTime = performance.now();

      const runInterval = setInterval(() => {
        applyPose("run", runFrameCount);
        const elapsed = performance.now() - runStartTime;
        const runProgress = Math.min(1, elapsed / 1600);
        const easeProgress = 1 - Math.pow(1 - runProgress, 3);
        const x = runStartX + (runEndX - runStartX) * easeProgress;
        a.curBobY = -Math.abs(Math.sin(runFrameCount * 0.5)) * 1.8;
        if (fig) fig.style.transition = "none";
        setFig(x, a.figAlt, 0);
        runFrameCount += 1;
      }, 50);

      setTimeout(() => {
        clearInterval(runInterval);
        a.curBobY = 0;

        /* jump phase */
        a.state = "JUMPING";
        setGameState("JUMPING");
        measure();
        if (fig)
          fig.style.transition =
            "transform 0.6s cubic-bezier(0.2, 0, 0.4, 1.4)";
        a.figAlt = a.stageH - a.cliffTopY + 50;
        setFig(a.cliffEdgeX + 56 + FIG_BODY_X, a.figAlt, -8);
        applyPose("jetpack", 0);

        setTimeout(() => {
          /* enter airborne */
          measure();
          a.state = "LIVE";
          setGameState("LIVE");
          a.entry = a.price;
          setLevTagText(lev + "x");
          setLevTagShow(true);
          if (fig) fig.style.transition = "none";
          const w = worldRef.current;
          if (w) w.style.transition = "none";
          a.curBobY = 0;
          a.vy = 1.8;
          a.vx = 0;
          a.frame = 0;
        }, 600);
      }, 1600);
    },
    [measure, setGameState, applyPose, setFig],
  );

  useImperativeHandle(ref, () => ({ startJump, stopTrade }), [
    startJump,
    stopTrade,
  ]);

  /* ============ TICK ============ */
  useEffect(() => {
    const interval = setInterval(() => {
      const a = anim.current;

      /* animate waves */
      a.waveOffset += 0.1;
      for (let i = 0; i < 6; i++) {
        const wave = waveRefs.current[i];
        if (!wave) continue;
        const yb = waveYBase[i];
        const amp = waveAmp[i];
        const ph = a.waveOffset * (1 - i * 0.08) + i * 0.7;
        const x1c = 65 + Math.sin(ph) * 12;
        const x2c = 165 + Math.sin(ph + 0.9) * 12;
        const x3c = 265 + Math.sin(ph + 1.7) * 12;
        const x4c = 365 + Math.sin(ph + 2.5) * 12;
        const y1 = yb - amp * Math.sin(ph);
        const y2 = yb + amp * 0.7 * Math.sin(ph + 1.2);
        const y3 = yb - amp * 0.85 * Math.sin(ph + 2.0);
        const y4 = yb + amp * Math.sin(ph + 2.8);
        const yEnd = yb + amp * 0.5 * Math.sin(ph + 3.5);
        wave.setAttribute(
          "d",
          `M0,${yb.toFixed(1)} Q${x1c.toFixed(0)},${y1.toFixed(1)} ${x2c.toFixed(0)},${y2.toFixed(1)} T${x3c.toFixed(0)},${y3.toFixed(1)} T${x4c.toFixed(0)},${y4.toFixed(1)} T400,${yEnd.toFixed(1)}`,
        );
      }

      /* foam crests */
      for (let i = 0; i < FOAM_COUNT; i++) {
        const ln = foamLineRefs.current[i];
        if (!ln) continue;
        const x = i * 60;
        const fx = x + ((a.waveOffset * 8) % 60);
        const fy =
          waveYBase[0] +
          Math.sin((x + a.waveOffset * 30) * 0.05) * 2 -
          1;
        ln.setAttribute("x1", (fx - 2).toFixed(1));
        ln.setAttribute("x2", (fx + 2).toFixed(1));
        ln.setAttribute("y1", (fy - 1.5).toFixed(1));
        ln.setAttribute("y2", (fy + 1.5).toFixed(1));
      }

      /* price drift (mock mode) */
      a.price += (Math.random() - 0.485) * 0.32;
      setPriceDisplay("ETH $" + a.price.toFixed(2));

      if (a.state !== "LIVE") return;

      a.frame++;
      const stageEl = stageRef.current;
      if (stageEl) {
        const r = stageEl.getBoundingClientRect();
        a.stageW = r.width;
        a.stageH = r.height;
        a.cliffEdgeX = a.stageW * 0.4;
        a.cliffTopY = a.stageH * 0.5;
        a.waterY = a.stageH * 0.78;
        a.SCROLL_CEILING = a.stageH * 0.65;
        a.WORLD_HEIGHT = a.stageH * 4;
      }

      const move = (a.price - a.entry) / a.entry;
      const pnlPct = move * a.positionLev;
      const pnlDollars = pnlPct * a.positionWager;
      onPnlChange(pnlDollars);

      /* physics */
      let force = -GRAVITY;
      if (pnlPct > 0) force += Math.min(pnlPct, 5) * THRUST;
      else if (pnlPct < 0)
        force -= Math.min(1, -pnlPct) * FALL_FORCE;
      a.vy += force;
      a.vy *= DRAG;
      a.vy = Math.max(-VY_CLAMP, Math.min(VY_CLAMP * 1.5, a.vy));
      a.figAlt += a.vy;
      a.vx += Math.sin(a.frame * 0.04) * 0.3 - a.vx * 0.1;

      const minAlt = a.stageH - a.waterY - 4;
      const figScreenAlt = Math.min(a.figAlt, a.SCROLL_CEILING);
      const maxScroll = a.WORLD_HEIGHT - a.stageH;
      a.bgOffset = Math.max(
        0,
        Math.min(maxScroll, a.figAlt - a.SCROLL_CEILING),
      );
      const w = worldRef.current;
      if (w)
        w.style.transform = `translate3d(0px, ${a.bgOffset.toFixed(1)}px, 0)`;

      if (dangerRef.current)
        dangerRef.current.style.opacity =
          a.bgOffset > a.stageH * 0.5 ? "0" : "1";

      const baseX = a.cliffEdgeX + 60;
      const figX = baseX + a.vx * 8;

      /* tier detection */
      let t: Tier;
      if (pnlPct < 0.5) t = "ground";
      else if (pnlPct < 1.5) t = "clouds";
      else if (pnlPct < 3.5) t = "strato";
      else t = "space";
      if (t !== a.currentTier) {
        a.currentTier = t;
        setTierClass("tier-tag " + t);
        setTierLabel(TIER_LABELS[t]);
      }

      /* pose + flame */
      let rotation = 0;
      if (pnlPct > 0.03) {
        const flameScale =
          1 +
          Math.min(2, pnlPct) * 0.6 +
          Math.sin(a.frame * 0.6) * 0.18;
        setFlame(true, flameScale);
        rotation = -Math.min(15, pnlPct * 10);
        applyPose("jetpack", a.frame);
      } else if (pnlPct < -0.03) {
        setFlame(false);
        rotation = (a.frame * 7) % 360;
        applyPose("falling", a.frame);
      } else {
        setFlame(false);
        applyPose("standing", a.frame);
      }

      setFig(figX, figScreenAlt, rotation);

      if (a.figAlt <= minAlt || pnlPct <= -1) splat();
    }, 60);

    return () => clearInterval(interval);
  }, [applyPose, setFig, setFlame, onPnlChange, splat]);

  /* ============ PRICE STREAM ============ */
  useEffect(() => {
    const disconnect = connectPriceStream((msg) => {
      anim.current.price = msg.eth_price;
    });
    return disconnect;
  }, []);

  /* ============ INIT ============ */
  useEffect(() => {
    setupWorld();
    applyPose("standing", 0);
    requestAnimationFrame(() => {
      setupWorld();
      placeFigureIdle();
    });
    const handleResize = () => {
      setupWorld();
      if (anim.current.state === "IDLE") placeFigureIdle();
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [setupWorld, applyPose, placeFigureIdle]);

  /* sync external state into anim ref */
  useEffect(() => {
    anim.current.state = gameState;
  }, [gameState]);

  return (
    <div className="stage" ref={stageRef}>
      <div className="world" ref={worldRef}>
        {/* SPACE zone */}
        <div
          className="zone"
          style={{ bottom: "300%", height: "100%" }}
        >
          {spaceStars.map((s) => (
            <div
              key={s.id}
              className={`star${s.bright ? " bright" : ""}`}
              style={{
                left: s.left + "%",
                bottom: s.bottom + "%",
                opacity: s.opacity,
              }}
            />
          ))}
          {/* SUN */}
          <div
            style={{
              position: "absolute",
              left: "32%",
              top: "14%",
              width: 90,
              height: 90,
              pointerEvents: "none",
            }}
          >
            <svg
              width="120"
              height="120"
              viewBox="0 0 120 120"
              style={{
                display: "block",
                transform: "translate(-15px, -15px)",
              }}
            >
              <path
                d="M 38 60 C 38 42, 52 36, 62 36 C 76 38, 84 50, 82 64 C 80 78, 66 84, 54 82 C 42 80, 36 70, 38 60 Z"
                fill="none"
                stroke="#f4ecd8"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M 39 60 C 39 43, 53 37, 62 37 C 75 39, 83 50, 81 63"
                fill="none"
                stroke="#f4ecd8"
                strokeWidth="0.7"
                opacity="0.5"
                strokeLinecap="round"
                transform="translate(0.5, -0.3)"
              />
              <g
                stroke="#f4ecd8"
                fill="none"
                strokeWidth="1.4"
                strokeLinecap="round"
                opacity="0.85"
              >
                <line x1="60" y1="22" x2="60" y2="10" />
                <line x1="60" y1="98" x2="60" y2="108" />
                <line x1="20" y1="60" x2="10" y2="60" />
                <line x1="100" y1="60" x2="110" y2="60" />
                <line x1="32" y1="32" x2="24" y2="24" />
                <line x1="88" y1="32" x2="96" y2="24" />
                <line x1="32" y1="88" x2="24" y2="96" />
                <line x1="88" y1="88" x2="96" y2="96" />
              </g>
              <g
                stroke="#f4ecd8"
                fill="none"
                strokeWidth="0.6"
                opacity="0.4"
                strokeLinecap="round"
              >
                <line x1="48" y1="52" x2="55" y2="59" />
                <line x1="46" y1="60" x2="53" y2="67" />
                <line x1="55" y1="48" x2="62" y2="55" />
                <line x1="52" y1="65" x2="59" y2="72" />
                <line x1="63" y1="50" x2="70" y2="57" />
                <line x1="60" y1="68" x2="67" y2="75" />
              </g>
            </svg>
          </div>
          {/* PLANET */}
          <div
            style={{
              position: "absolute",
              right: "8%",
              top: "52%",
              width: 40,
              height: 40,
            }}
          >
            <svg width="40" height="40" viewBox="0 0 40 40">
              <path
                d="M 4 20 C 4 8, 14 4, 22 6 C 32 8, 38 18, 36 28 C 32 36, 22 38, 14 34 C 6 30, 3 24, 4 20 Z"
                fill="none"
                stroke="#f4ecd8"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
              <g
                stroke="#f4ecd8"
                strokeWidth="0.5"
                opacity="0.45"
                fill="none"
                strokeLinecap="round"
              >
                <line x1="14" y1="14" x2="22" y2="22" />
                <line x1="12" y1="20" x2="20" y2="28" />
                <line x1="18" y1="12" x2="26" y2="20" />
                <line x1="20" y1="26" x2="28" y2="32" />
              </g>
            </svg>
          </div>
          {/* RING */}
          <div
            style={{
              position: "absolute",
              right: "2%",
              top: "54%",
              width: 60,
              height: 14,
              transform: "rotate(-18deg)",
            }}
          >
            <svg width="60" height="14" viewBox="0 0 60 14">
              <ellipse
                cx="30"
                cy="7"
                rx="28"
                ry="5"
                fill="none"
                stroke="#f4ecd8"
                strokeWidth="0.9"
                opacity="0.55"
              />
            </svg>
          </div>
          {/* MOON */}
          <div
            style={{
              position: "absolute",
              left: "12%",
              top: "70%",
              width: 16,
              height: 16,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16">
              <path
                d="M 2 8 C 2 4, 6 2, 10 3 C 13 4, 14 8, 13 11 C 11 13, 7 14, 4 12 C 2 11, 1 9, 2 8 Z"
                fill="none"
                stroke="#f4ecd8"
                strokeWidth="0.9"
                strokeLinecap="round"
              />
            </svg>
          </div>
        </div>

        {/* STRATO zone */}
        <div
          className="zone"
          style={{ bottom: "200%", height: "100%" }}
        >
          {STRATO_POSITIONS.map((p, i) => (
            <div
              key={i}
              className="cloud-puff"
              style={{
                left: p.left + "%",
                bottom: p.bottom + "%",
                opacity: p.opacity,
                transform: `scale(${p.scale})`,
              }}
            >
              <svg width="80" height="20" viewBox="0 0 80 20">
                <ellipse cx="40" cy="10" rx="38" ry="6" fill="#b6a8e1" />
              </svg>
            </div>
          ))}
          {stratoStars.map((s) => (
            <div
              key={s.id}
              className="star"
              style={{
                left: s.left + "%",
                bottom: s.bottom + "%",
                opacity: s.opacity,
              }}
            />
          ))}
        </div>

        {/* CLOUDS zone */}
        <div
          className="zone"
          style={{ bottom: "100%", height: "100%" }}
        >
          {CLOUD_POSITIONS.map((p, i) => (
            <div
              key={i}
              className="cloud-puff"
              style={{
                left: p.left + "%",
                bottom: p.bottom + "%",
                opacity: p.opacity,
                transform: `scale(${p.scale})`,
              }}
            >
              <svg width="80" height="32" viewBox="0 0 80 32">
                <ellipse cx="20" cy="20" rx="14" ry="9" fill="#b6c2e1" />
                <ellipse cx="38" cy="14" rx="18" ry="11" fill="#c8d2ed" />
                <ellipse cx="58" cy="20" rx="16" ry="9" fill="#b6c2e1" />
                <ellipse cx="40" cy="22" rx="20" ry="7" fill="#a5b3d8" />
              </svg>
            </div>
          ))}
        </div>

        {/* GROUND zone */}
        <div className="zone" style={{ bottom: 0, height: "100%" }}>
          {/* low clouds */}
          {LOW_CLOUDS.map((p, i) => (
            <div
              key={i}
              className="cloud-puff"
              style={{
                left: p.left + "%",
                top: p.top + "%",
                opacity: p.opacity,
                transform: `scale(${p.scale})`,
              }}
            >
              <svg width="60" height="22" viewBox="0 0 60 22">
                <ellipse cx="15" cy="14" rx="10" ry="6" fill="#3a4565" />
                <ellipse cx="30" cy="10" rx="13" ry="7" fill="#4a5575" />
                <ellipse cx="45" cy="14" rx="11" ry="6" fill="#3a4565" />
              </svg>
            </div>
          ))}

          {/* CLIFF */}
          <div
            className="cliff-container"
            style={{
              width: "40%",
              height: "32%",
              bottom: "22%",
            }}
          >
            <svg
              viewBox="0 0 160 130"
              preserveAspectRatio="none"
              style={{ width: "100%", height: "100%", display: "block" }}
            >
              {/* back range silhouette */}
              <path
                d="M -10 130 L 0 80 L 25 55 L 50 75 L 85 40 L 120 65 L 150 30 L 170 90 L 170 130 Z"
                fill="#0a0a14"
                opacity="0.85"
              />
              <path
                d="M 0 80 L 25 55 L 50 75 L 85 40 L 120 65 L 150 30"
                stroke="#f4ecd8"
                strokeWidth="0.7"
                fill="none"
                opacity="0.35"
                strokeLinecap="round"
              />
              {/* main cliff body */}
              <path
                d="M 0 15 L 130 15 L 145 28 L 155 55 L 158 85 L 156 115 L 154 122 L 148 128 L 140 124 L 130 130 L 118 125 L 108 130 L 96 126 L 84 130 L 72 125 L 60 130 L 48 126 L 36 130 L 22 124 L 10 130 L 0 128 Z"
                fill="#08080f"
                stroke="#f4ecd8"
                strokeWidth="1.4"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {/* second-pass overlapping stroke */}
              <path
                d="M 0 15.5 L 130 15.5 L 145 28.5 L 155 55.5 L 158 85.5"
                stroke="#f4ecd8"
                strokeWidth="0.6"
                fill="none"
                opacity="0.5"
                strokeLinejoin="round"
              />
              {/* cross-hatching on shaded right face */}
              <g
                stroke="#f4ecd8"
                strokeWidth="0.5"
                opacity="0.5"
                strokeLinecap="round"
              >
                <line x1="135" y1="35" x2="148" y2="48" />
                <line x1="133" y1="45" x2="150" y2="62" />
                <line x1="135" y1="55" x2="153" y2="73" />
                <line x1="138" y1="65" x2="155" y2="83" />
                <line x1="138" y1="75" x2="156" y2="93" />
                <line x1="140" y1="85" x2="157" y2="103" />
                <line x1="140" y1="95" x2="156" y2="113" />
                <line x1="142" y1="105" x2="155" y2="120" />
              </g>
              {/* vertical crack */}
              <path
                d="M 80 15 Q 78 35 82 55 Q 85 75 82 100 Q 80 115 84 130"
                stroke="#f4ecd8"
                strokeWidth="0.5"
                fill="none"
                opacity="0.35"
                strokeLinecap="round"
              />
              {/* grass tufts */}
              <path
                d="M 18 15 q 1 -6 2 -1 q 1 -7 2 -1"
                stroke="#f4ecd8"
                strokeWidth="0.7"
                fill="none"
                strokeLinecap="round"
                opacity="0.85"
              />
              <path
                d="M 28 15 q 1 -7 2 -2 q 1 -6 2 -1"
                stroke="#f4ecd8"
                strokeWidth="0.7"
                fill="none"
                strokeLinecap="round"
                opacity="0.85"
              />
              <path
                d="M 56 15 q 1 -8 2 -2 q 1 -7 2 -1"
                stroke="#f4ecd8"
                strokeWidth="0.7"
                fill="none"
                strokeLinecap="round"
                opacity="0.85"
              />
              <path
                d="M 68 15 q 1 -7 2 -2 q 1 -6 2 -1"
                stroke="#f4ecd8"
                strokeWidth="0.7"
                fill="none"
                strokeLinecap="round"
                opacity="0.85"
              />
              <path
                d="M 96 15 q 1 -8 2 -2 q 1 -7 2 -1"
                stroke="#f4ecd8"
                strokeWidth="0.7"
                fill="none"
                strokeLinecap="round"
                opacity="0.85"
              />
              <path
                d="M 110 15 q 1 -6 2 -1 q 1 -5 2 -1"
                stroke="#f4ecd8"
                strokeWidth="0.7"
                fill="none"
                strokeLinecap="round"
                opacity="0.85"
              />
              {/* splash/water-line marks */}
              <g
                stroke="#f4ecd8"
                strokeWidth="0.7"
                fill="none"
                opacity="0.65"
                strokeLinecap="round"
              >
                <path d="M 8 132 q 4 -3 8 0 q 4 3 8 0" />
                <path d="M 32 134 q 4 -2 7 0 q 4 2 7 0" />
                <path d="M 56 132 q 4 -3 8 0 q 4 2 7 0" />
                <path d="M 82 134 q 4 -2 7 0 q 4 3 7 0" />
                <path d="M 108 132 q 4 -3 7 0 q 3 2 6 0" />
                <path d="M 132 135 q 4 -2 7 0" />
                <line x1="20" y1="128" x2="22" y2="125" opacity="0.5" />
                <line x1="44" y1="129" x2="46" y2="126" opacity="0.5" />
                <line x1="68" y1="128" x2="70" y2="125" opacity="0.5" />
                <line
                  x1="100"
                  y1="129"
                  x2="102"
                  y2="126"
                  opacity="0.5"
                />
              </g>
              {/* rocks at base */}
              <circle
                cx="22"
                cy="125"
                r="2.5"
                fill="#08080f"
                stroke="#f4ecd8"
                strokeWidth="0.7"
                opacity="0.85"
              />
              <circle
                cx="48"
                cy="129"
                r="2"
                fill="#08080f"
                stroke="#f4ecd8"
                strokeWidth="0.7"
                opacity="0.8"
              />
              <circle
                cx="78"
                cy="124"
                r="2.2"
                fill="#08080f"
                stroke="#f4ecd8"
                strokeWidth="0.7"
                opacity="0.85"
              />
              <circle
                cx="105"
                cy="127"
                r="2.4"
                fill="#08080f"
                stroke="#f4ecd8"
                strokeWidth="0.7"
                opacity="0.8"
              />
              <circle
                cx="135"
                cy="130"
                r="2"
                fill="#08080f"
                stroke="#f4ecd8"
                strokeWidth="0.7"
                opacity="0.75"
              />
            </svg>
          </div>

          {/* WATER */}
          <div
            className="water-container"
            style={{ bottom: 0, height: "22%" }}
          >
            <div className="water-bg" />
            <svg
              className="wave-svg"
              viewBox="0 0 400 100"
              preserveAspectRatio="none"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: 0,
                bottom: 0,
                width: "100%",
                height: "100%",
                zIndex: 3,
              }}
            >
              {[0.9, 0.75, 0.6, 0.45, 0.35, 0.28].map(
                (op, i) => (
                  <path
                    key={i}
                    ref={(el) => {
                      waveRefs.current[i] = el;
                    }}
                    stroke="#f4ecd8"
                    strokeWidth={[1.5, 1.3, 1.2, 1.1, 1, 0.9][i]}
                    fill="none"
                    strokeLinecap="round"
                    opacity={op}
                  />
                ),
              )}
              <g ref={foamRef}>
                {Array.from({ length: FOAM_COUNT }, (_, i) => (
                  <line
                    key={i}
                    ref={(el) => {
                      foamLineRefs.current[i] = el;
                    }}
                    stroke="#f4ecd8"
                    strokeWidth="1"
                    strokeLinecap="round"
                    opacity="0.7"
                  />
                ))}
              </g>
            </svg>
          </div>
        </div>
      </div>

      {/* HUD overlays */}
      <div className="price-tick">{priceDisplay}</div>
      <div className={`lev-tag${levTagShow ? " show" : ""}`}>
        {levTagText}
      </div>
      <div className={tierClass}>{tierLabel}</div>
      <div className="danger-label" ref={dangerRef}>
        &mdash; LIQUIDATION ZONE &mdash;
      </div>
      {pnlReadout}

      {/* FIGURE */}
      <div className="figure-wrap" ref={figRef}>
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
          <path
            d="M 14 28 Q 19 17 25 11"
            stroke="#9a2828"
            strokeWidth="0.4"
            fill="none"
            opacity="0.55"
          />
          <path
            d="M 28 30 Q 32 19 36 9"
            stroke="#9a2828"
            strokeWidth="0.4"
            fill="none"
            opacity="0.55"
          />
          <path
            d="M 52 30 Q 48 19 44 9"
            stroke="#9a2828"
            strokeWidth="0.4"
            fill="none"
            opacity="0.55"
          />
          <path
            d="M 66 28 Q 61 17 55 11"
            stroke="#9a2828"
            strokeWidth="0.4"
            fill="none"
            opacity="0.55"
          />
          <path
            d="M 8 29 Q 20 36 34 44"
            stroke="#f4ecd8"
            strokeWidth="0.6"
            fill="none"
            opacity="0.75"
            strokeLinecap="round"
          />
          <path
            d="M 22 29 Q 30 36 37 44"
            stroke="#f4ecd8"
            strokeWidth="0.6"
            fill="none"
            opacity="0.75"
            strokeLinecap="round"
          />
          <path
            d="M 40 8 L 40 44"
            stroke="#f4ecd8"
            strokeWidth="0.6"
            opacity="0.75"
            strokeLinecap="round"
          />
          <path
            d="M 58 29 Q 50 36 43 44"
            stroke="#f4ecd8"
            strokeWidth="0.6"
            fill="none"
            opacity="0.75"
            strokeLinecap="round"
          />
          <path
            d="M 72 29 Q 60 36 46 44"
            stroke="#f4ecd8"
            strokeWidth="0.6"
            fill="none"
            opacity="0.75"
            strokeLinecap="round"
          />
        </svg>
        <svg
          width="36"
          height="58"
          viewBox="0 0 36 58"
          className="fig-glow"
        >
          {/* jetpack */}
          <g>
            <path
              d="M 14 13 Q 15 11 16.5 11"
              stroke="#f4ecd8"
              strokeWidth="0.8"
              fill="none"
              strokeLinecap="round"
            />
            <path
              d="M 22 13 Q 21 11 19.5 11"
              stroke="#f4ecd8"
              strokeWidth="0.8"
              fill="none"
              strokeLinecap="round"
            />
            <path
              d="M 11 13 C 11 12, 12 12, 13 12 L 23 12 C 24 12, 25 12, 25 13 L 25 27 C 25 28, 24 28, 23 28 L 13 28 C 12 28, 11 28, 11 27 Z"
              fill="#08080f"
              stroke="#f4ecd8"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
            <path
              d="M 11.3 13.2 L 24.7 13.2 M 11.3 27.5 L 24.7 27.5"
              stroke="#f4ecd8"
              strokeWidth="0.5"
              opacity="0.5"
              strokeLinecap="round"
            />
            <line
              x1="12"
              y1="17"
              x2="24"
              y2="17"
              stroke="#f4ecd8"
              strokeWidth="0.5"
              opacity="0.55"
            />
            <line
              x1="12"
              y1="22"
              x2="24"
              y2="22"
              stroke="#f4ecd8"
              strokeWidth="0.5"
              opacity="0.4"
            />
            <path
              d="M 12 28 L 12 30 L 14.5 30 L 14.5 28"
              stroke="#f4ecd8"
              strokeWidth="1"
              fill="#08080f"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M 21.5 28 L 21.5 30 L 24 30 L 24 28"
              stroke="#f4ecd8"
              strokeWidth="1"
              fill="#08080f"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
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
            <path
              d="M 13.25 30 C 12 35, 10 40, 12 45 C 13 42, 13.5 44, 13.5 41 C 14 44, 14.8 41, 15 43 C 15.5 38, 15 34, 14 30 Z"
              fill="#ff9933"
              stroke="#ff9933"
              strokeWidth="0.5"
              opacity="0.85"
            />
            <path
              d="M 22.75 30 C 21.5 35, 19.5 40, 21.5 45 C 22.5 42, 23 44, 23 41 C 23.5 44, 24.3 41, 24.5 43 C 25 38, 24.5 34, 23.5 30 Z"
              fill="#ff9933"
              stroke="#ff9933"
              strokeWidth="0.5"
              opacity="0.85"
            />
            <path
              d="M 13.25 31 C 12.5 34, 11.5 38, 12.5 41 C 13.2 39, 13.5 40, 13.5 38 C 14 40, 14.5 38, 14.5 39 C 15 36, 14.5 33, 14 31 Z"
              fill="#ffd966"
              stroke="none"
              opacity="0.95"
            />
            <path
              d="M 22.75 31 C 22 34, 21 38, 22 41 C 22.7 39, 23 40, 23 38 C 23.5 40, 24 38, 24 39 C 24.5 36, 24 33, 23.5 31 Z"
              fill="#ffd966"
              stroke="none"
              opacity="0.95"
            />
          </g>
          {/* helmet */}
          <path
            d="M 12.5 6 C 12.5 2, 23 2, 23.5 6.5 C 23.5 10, 22 11, 18 11 C 14 11, 12.5 10, 12.5 6 Z"
            className="helmet-fill"
          />
          <path
            d="M 12.7 6 C 13 2.5, 22.5 2.5, 23.3 6.3"
            stroke="#f4ecd8"
            strokeWidth="0.6"
            fill="none"
            opacity="0.5"
          />
          <rect
            x="14"
            y="5.5"
            width="8"
            height="2"
            rx="0.5"
            className="visor"
          />
          <line
            x1="14"
            y1="9"
            x2="22"
            y2="9"
            stroke="#f4ecd8"
            strokeWidth="0.6"
            opacity="0.7"
          />
          {/* body */}
          <line
            className="figure-line"
            x1="18"
            y1="11"
            x2="18"
            y2="28"
          />
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
