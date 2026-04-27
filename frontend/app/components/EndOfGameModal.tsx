"use client";

import { useEffect, useRef } from "react";
import { sounds } from "@/lib/sounds";

export type EndOfGameKind = "win" | "loss" | "rekt";

export interface EndOfGameData {
  kind: EndOfGameKind;
  pnlDollars: number;
  pnlPct: number;       // e.g. 0.159 for +15.9%
  entry: number;
  exit: number | null;  // null on liquidation
  boost: number;        // leverage multiplier, displayed as "Nx LONG ETH"
  wager: number;
}

interface Props {
  data: EndOfGameData | null;
  onClose: () => void;
}

const KIND_COPY: Record<EndOfGameKind, { subtitle: string; badge: string; spriteFrame: 11 | 15 | 16; exitFallback: string }> = {
  win: {
    subtitle: "YOU CAME. YOU SCALPED. YOU WON.",
    badge: "WIN",
    spriteFrame: 11,
    exitFallback: "—",
  },
  loss: {
    subtitle: "YOU CAME. YOU SCALPED. YOU FOLDED.",
    badge: "LOSS",
    spriteFrame: 15,
    exitFallback: "—",
  },
  rekt: {
    subtitle: "YOU CAME. YOU SCALPED. YOU GOT REKT.",
    badge: "REKT",
    spriteFrame: 16,
    exitFallback: "LIQUIDATED",
  },
};

function fmtMoney(n: number, sign = true): string {
  const abs = Math.abs(n);
  const formatted = abs >= 1000 ? Math.round(abs).toLocaleString() : abs.toFixed(2);
  if (!sign) return "$" + formatted;
  return (n >= 0 ? "+$" : "−$") + formatted;
}

function fmtPct(n: number): string {
  const v = n * 100;
  return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1) + "%";
}

function fmtPrice(n: number): string {
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function BadgeIcon({ kind }: { kind: EndOfGameKind }) {
  if (kind === "win") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path d="M3 2 H11 V5 Q11 8 7 9 Q3 8 3 5 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M5 9 H9 V11 H5 Z" fill="currentColor" />
        <rect x="4" y="11" width="6" height="1.5" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "loss") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path d="M2 4 L6 8 L8 6 L12 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
        <path d="M9 11 L12 11 L12 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <ellipse cx="7" cy="6" rx="4" ry="3.5" fill="currentColor" />
      <rect x="5" y="9" width="4" height="2.5" fill="currentColor" />
      <rect x="5" y="4.5" width="1.5" height="1.5" fill="#000" />
      <rect x="7.5" y="4.5" width="1.5" height="1.5" fill="#000" />
      <rect x="6.5" y="11.5" width="1" height="1" fill="currentColor" />
    </svg>
  );
}

/**
 * USDC coin with 3D depth — radial highlight gradient, dark rim,
 * inner crescent gleam, and the proper USDC mark (split parentheses + $).
 */
function UsdcCoin({ broken = false }: { broken?: boolean }) {
  // unique gradient ids per render so multiple instances don't share state
  const id = (broken ? "rkt" : "usd") + Math.random().toString(36).slice(2, 6);
  if (broken) {
    return (
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <radialGradient id={`${id}-face`} cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#7a2020" />
            <stop offset="55%" stopColor="#3a0808" />
            <stop offset="100%" stopColor="#180202" />
          </radialGradient>
        </defs>
        <circle cx="16" cy="16" r="14.5" fill="#000" opacity="0.6" />
        <circle cx="16" cy="16" r="14" fill={`url(#${id}-face)`} />
        <circle cx="16" cy="16" r="13" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="0.6" />
        <path d="M10 10 L22 22 M22 10 L10 22" stroke="#ff5f56" strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  }
  const arcStroke = 2.2;
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <radialGradient id={`${id}-face`} cx="32%" cy="28%" r="78%">
          <stop offset="0%" stopColor="#7eb6f0" />
          <stop offset="45%" stopColor="#3a86d4" />
          <stop offset="80%" stopColor="#2775ca" />
          <stop offset="100%" stopColor="#143966" />
        </radialGradient>
        <radialGradient id={`${id}-shine`} cx="35%" cy="25%" r="40%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.55)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
      </defs>
      {/* dark rim/shadow halo */}
      <circle cx="16" cy="16.4" r="14.2" fill="#000" opacity="0.55" />
      {/* coin face with radial gradient for top-left light */}
      <circle cx="16" cy="16" r="14" fill={`url(#${id}-face)`} />
      {/* inner stroke groove */}
      <circle cx="16" cy="16" r="13.1" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="0.6" />
      <circle cx="16" cy="16" r="12.4" fill="none" stroke="rgba(0,0,0,0.25)" strokeWidth="0.5" />
      {/* USDC mark — left parenthesis (3 segments) */}
      <path d="M 11.5 7.6 A 9.6 9.6 0 0 0 8.0 11.6" fill="none" stroke="#fff" strokeWidth={arcStroke} strokeLinecap="round" />
      <path d="M 6.6 13.7 A 9.6 9.6 0 0 0 6.6 18.3" fill="none" stroke="#fff" strokeWidth={arcStroke} strokeLinecap="round" />
      <path d="M 8.0 20.4 A 9.6 9.6 0 0 0 11.5 24.4" fill="none" stroke="#fff" strokeWidth={arcStroke} strokeLinecap="round" />
      {/* right parenthesis */}
      <path d="M 20.5 7.6 A 9.6 9.6 0 0 1 24.0 11.6" fill="none" stroke="#fff" strokeWidth={arcStroke} strokeLinecap="round" />
      <path d="M 25.4 13.7 A 9.6 9.6 0 0 1 25.4 18.3" fill="none" stroke="#fff" strokeWidth={arcStroke} strokeLinecap="round" />
      <path d="M 24.0 20.4 A 9.6 9.6 0 0 1 20.5 24.4" fill="none" stroke="#fff" strokeWidth={arcStroke} strokeLinecap="round" />
      {/* center $ */}
      <text
        x="16"
        y="22.2"
        textAnchor="middle"
        fontFamily="'Arial Black', 'Helvetica Neue', sans-serif"
        fontWeight={900}
        fontSize="13"
        fill="#fff"
      >$</text>
      {/* top-left specular highlight crescent on top of everything */}
      <ellipse cx="11" cy="9.5" rx="6" ry="3.2" fill={`url(#${id}-shine)`} opacity="0.7" />
    </svg>
  );
}

/* Decorative scattered sparkles + USDC coins. Positions are deterministic (no Math.random in render). */
function Decorations({ kind }: { kind: EndOfGameKind }) {
  const sparks = [
    { top: "10%", left: "6%", rot: 0, scale: 1 },
    { top: "22%", left: "92%", rot: 15, scale: 0.7 },
    { top: "60%", left: "4%", rot: -10, scale: 0.85 },
    { top: "75%", left: "94%", rot: 25, scale: 1 },
    { top: "8%", left: "70%", rot: -20, scale: 0.6 },
    { top: "88%", left: "30%", rot: 10, scale: 0.7 },
  ];
  const coins = kind === "win"
    ? [
        { top: "15%", left: "85%", rot: -10 },
        { top: "70%", left: "3%", rot: 20 },
        { top: "32%", left: "90%", rot: 35 },
      ]
    : kind === "loss"
    ? [{ top: "78%", left: "8%", rot: 25 }]
    : [{ top: "70%", left: "8%", rot: 45 }];
  return (
    <>
      {sparks.map((s, i) => (
        <span
          key={`s${i}`}
          className="eog-decor eog-spark"
          style={{ top: s.top, left: s.left, transform: `translate(-50%, -50%) rotate(${s.rot}deg) scale(${s.scale})` }}
        />
      ))}
      {coins.map((c, i) => (
        <span
          key={`c${i}`}
          className="eog-decor eog-coin"
          style={{ top: c.top, left: c.left, transform: `translate(-50%, -50%) rotate(${c.rot}deg)` }}
        >
          <UsdcCoin broken={kind === "rekt"} />
        </span>
      ))}
    </>
  );
}

/* Renders a 1080x1080 square share image to a hidden canvas and returns a PNG blob. */
async function renderShareImage(data: EndOfGameData): Promise<Blob | null> {
  const W = 1080;
  const H = 1080;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const copy = KIND_COPY[data.kind];

  // Background palette
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  if (data.kind === "win") {
    bgGrad.addColorStop(0, "#0e1d2c");
    bgGrad.addColorStop(0.6, "#0a1828");
    bgGrad.addColorStop(1, "#061018");
  } else if (data.kind === "loss") {
    bgGrad.addColorStop(0, "#1f1810");
    bgGrad.addColorStop(0.6, "#1a1408");
    bgGrad.addColorStop(1, "#0f0a04");
  } else {
    bgGrad.addColorStop(0, "#240808");
    bgGrad.addColorStop(0.6, "#1a0606");
    bgGrad.addColorStop(1, "#0d0202");
  }
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // Border
  const accent = data.kind === "win" ? "#5dd39e" : data.kind === "loss" ? "#ff9933" : "#ff5f56";
  ctx.strokeStyle = data.kind === "win" ? "#2a4456" : data.kind === "loss" ? "#4a3818" : "#5a1818";
  ctx.lineWidth = 12;
  ctx.strokeRect(6, 6, W - 12, H - 12);

  // Decorative sparkles
  ctx.fillStyle = data.kind === "win" ? "#ffd700" : accent;
  const sparkPos = [[80, 110], [990, 200], [60, 720], [1000, 800], [820, 100], [320, 950]];
  for (const [x, y] of sparkPos) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-12, -12, 24, 24);
    ctx.restore();
  }

  // USDC coins scattered (or broken USDC for rekt)
  const drawUsdcCoin = (cx: number, cy: number, r: number, rot: number) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    if (data.kind === "rekt") {
      const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, 0, 0, 0, r);
      grad.addColorStop(0, "#5a1a1a");
      grad.addColorStop(1, "#100");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#400";
      ctx.lineWidth = r * 0.12;
      ctx.stroke();
      // X mark
      ctx.strokeStyle = "#ff5f56";
      ctx.lineWidth = r * 0.22;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-r * 0.5, -r * 0.5);
      ctx.lineTo(r * 0.5, r * 0.5);
      ctx.moveTo(r * 0.5, -r * 0.5);
      ctx.lineTo(-r * 0.5, r * 0.5);
      ctx.stroke();
    } else {
      // shadow halo for depth
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.beginPath();
      ctx.arc(0, r * 0.04, r * 1.02, 0, Math.PI * 2);
      ctx.fill();
      // coin face with radial gradient (top-left light)
      const grad = ctx.createRadialGradient(-r * 0.36, -r * 0.42, 0, 0, 0, r * 1.05);
      grad.addColorStop(0, "#7eb6f0");
      grad.addColorStop(0.45, "#3a86d4");
      grad.addColorStop(0.8, "#2775ca");
      grad.addColorStop(1, "#143966");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      // inner ring grooves
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      ctx.lineWidth = r * 0.04;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.94, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = r * 0.035;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.88, 0, Math.PI * 2);
      ctx.stroke();
      // two split parentheses + center dollar (matches the official mark)
      ctx.strokeStyle = "#ffffff";
      ctx.lineCap = "round";
      ctx.lineWidth = r * 0.13;
      const arcR = r * 0.7;
      // left parenthesis: 3 segments at -180+/-Δ angles
      const segs: Array<[number, number]> = [
        [Math.PI * 0.78, Math.PI * 0.92],   // top-left
        [Math.PI * 0.96, Math.PI * 1.04],   // mid-left
        [Math.PI * 1.08, Math.PI * 1.22],   // bottom-left
      ];
      for (const [a1, a2] of segs) {
        ctx.beginPath();
        ctx.arc(0, 0, arcR, a1, a2);
        ctx.stroke();
      }
      // right parenthesis: mirrored
      for (const [a1, a2] of segs) {
        ctx.beginPath();
        ctx.arc(0, 0, arcR, -a2 + Math.PI * 2, -a1 + Math.PI * 2);
        ctx.stroke();
      }
      // center dollar sign — system bold so it renders crisply
      ctx.fillStyle = "#ffffff";
      ctx.font = `900 ${(r * 0.95).toFixed(0)}px "Arial Black", "Helvetica Neue", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("$", 0, r * 0.06);
      ctx.textBaseline = "alphabetic";
      // top-left specular highlight crescent for the 3D feel
      const shine = ctx.createRadialGradient(-r * 0.45, -r * 0.55, 0, -r * 0.4, -r * 0.5, r * 0.55);
      shine.addColorStop(0, "rgba(255,255,255,0.55)");
      shine.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = shine;
      ctx.beginPath();
      ctx.ellipse(-r * 0.32, -r * 0.42, r * 0.45, r * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };
  const coinPositions = data.kind === "rekt"
    ? [{ x: 130, y: 730, r: 32, rot: 0.3 }]
    : data.kind === "loss"
    ? [{ x: 140, y: 770, r: 30, rot: 0.5 }]
    : [
        { x: 950, y: 250, r: 36, rot: -0.2 },
        { x: 130, y: 720, r: 34, rot: 0.4 },
        { x: 1000, y: 420, r: 28, rot: 0.6 },
      ];
  for (const c of coinPositions) drawUsdcCoin(c.x, c.y, c.r, c.rot);

  ctx.fillStyle = "#f4ecd8";
  ctx.font = '48px "Press Start 2P", monospace';
  ctx.textAlign = "center";
  ctx.fillText("END OF GAME", W / 2, 130);

  ctx.fillStyle = data.kind === "win" ? "#4dd0e1" : data.kind === "loss" ? "#ffc56b" : "#ff8a82";
  ctx.font = '22px "Press Start 2P", monospace';
  ctx.fillText(copy.subtitle, W / 2, 180);

  // Badge top right
  const badgeX = W - 120;
  const badgeY = 90;
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  const bw = 180, bh = 60;
  ctx.fillRect(badgeX - bw, badgeY - bh / 2, bw, bh);
  ctx.strokeRect(badgeX - bw, badgeY - bh / 2, bw, bh);
  ctx.fillStyle = accent;
  ctx.font = '32px "Press Start 2P", monospace';
  ctx.textAlign = "right";
  ctx.fillText(copy.badge, badgeX - 16, badgeY + 12);
  ctx.textAlign = "center";

  // Sprite — load and draw
  const img = new Image();
  img.src = "/spritesheet.png";
  await new Promise((res) => {
    if (img.complete) return res(null);
    img.onload = () => res(null);
    img.onerror = () => res(null);
  });
  if (img.complete && img.naturalWidth > 0) {
    const sx = (copy.spriteFrame % 5) * 72;
    const sy = Math.floor(copy.spriteFrame / 5) * 80;
    const dw = 360, dh = 400;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, sx, sy, 72, 80, 80, 280, dw, dh);
  }

  // PNL big number on right
  ctx.textAlign = "center";
  ctx.fillStyle = "#f4ecd8";
  ctx.font = '32px "Press Start 2P", monospace';
  ctx.fillText("> PNL <", 720, 360);

  ctx.fillStyle = accent;
  ctx.font = '120px "Press Start 2P", monospace';
  ctx.fillText(fmtMoney(data.pnlDollars), 720, 510);

  // Pct pill
  ctx.fillStyle = data.kind === "win" ? "rgba(93,211,158,0.22)" : data.kind === "loss" ? "rgba(255,153,51,0.22)" : "rgba(255,95,86,0.25)";
  const pillW = 220, pillH = 52;
  ctx.fillRect(720 - pillW / 2, 555, pillW, pillH);
  ctx.fillStyle = accent;
  ctx.font = '34px "Press Start 2P", monospace';
  ctx.fillText(fmtPct(data.pnlPct), 720, 595);

  // Stats row
  const statsY = 800;
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(80, statsY - 60, W - 160, 160);
  ctx.strokeStyle = "rgba(244,236,216,0.12)";
  ctx.lineWidth = 2;
  ctx.strokeRect(80, statsY - 60, W - 160, 160);

  const statCols = [
    { label: "ENTRY", value: fmtPrice(data.entry), sub: "" },
    { label: "EXIT", value: data.exit !== null ? fmtPrice(data.exit) : copy.exitFallback, sub: "" },
    { label: "BOOST", value: data.boost + "x", sub: "LONG ETH" },
  ];
  ctx.textAlign = "center";
  statCols.forEach((s, i) => {
    const cx = 80 + (W - 160) * (i + 0.5) / 3;
    ctx.fillStyle = "#6e6e75";
    ctx.font = '18px "Press Start 2P", monospace';
    ctx.fillText(s.label, cx, statsY - 10);
    ctx.fillStyle = "#f4ecd8";
    ctx.font = '28px "Press Start 2P", monospace';
    ctx.fillText(s.value, cx, statsY + 30);
    if (s.sub) {
      ctx.fillStyle = "#6e6e75";
      ctx.font = '14px "Press Start 2P", monospace';
      ctx.fillText(s.sub, cx, statsY + 60);
    }
  });

  // Footer brand
  ctx.fillStyle = "rgba(244,236,216,0.4)";
  ctx.font = '20px "Press Start 2P", monospace';
  ctx.textAlign = "center";
  ctx.fillText("popgame1000x", W / 2, H - 40);

  return new Promise((res) => canvas.toBlob((b) => res(b), "image/png"));
}

export default function EndOfGameModal({ data, onClose }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!data) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data, onClose]);

  if (!data) return null;
  const copy = KIND_COPY[data.kind];

  const handleDownload = async () => {
    sounds.play("coin-clink");
    const blob = await renderShareImage(data);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `popgame-${data.kind}-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleShare = async () => {
    sounds.play("coin-clink");
    const blob = await renderShareImage(data);
    if (!blob) return;
    const file = new File([blob], `popgame-${data.kind}.png`, { type: "image/png" });
    const shareText = data.kind === "win"
      ? `Just scalped ${fmtMoney(data.pnlDollars)} on popgame1000x 🚀`
      : data.kind === "loss"
      ? `Took a ${fmtMoney(data.pnlDollars)} L on popgame1000x. We move.`
      : `Got fully rekt on popgame1000x. ${data.boost}x leverage was a choice.`;
    const navAny = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (navigator.share && navAny.canShare && navAny.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: shareText, title: "popgame1000x" });
        return;
      } catch {
        // user cancelled — fall through to download
      }
    }
    // fallback: download + copy text
    handleDownload();
    try { await navigator.clipboard.writeText(shareText); } catch { /* noop */ }
  };

  return (
    <div className="eog-overlay" ref={overlayRef} onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}>
      <div className={`eog-card ${data.kind}`}>
        <Decorations kind={data.kind} />

        <div className="eog-header">
          <div>
            <div className="eog-title">END OF GAME</div>
            <div className="eog-subtitle">{copy.subtitle}</div>
          </div>
          <div className={`eog-badge ${data.kind}`}>
            <BadgeIcon kind={data.kind} />
            <span>{copy.badge}</span>
          </div>
        </div>

        <div className="eog-body">
          <div className={`eog-sprite-frame f${copy.spriteFrame}`} aria-hidden="true" />
          <div className="eog-pnl-block">
            <div className="eog-pnl-label">PNL</div>
            <div className="eog-pnl-amount">
              <span>{fmtMoney(data.pnlDollars)}</span>
              <span className="eog-pnl-coin"><UsdcCoin broken={data.kind === "rekt"} /></span>
            </div>
            <div className="eog-pnl-pct">{fmtPct(data.pnlPct)}</div>
          </div>
        </div>

        <div className="eog-stats">
          <div className="eog-stat">
            <div className="eog-stat-label">ENTRY</div>
            <div className="eog-stat-value">{fmtPrice(data.entry)}</div>
          </div>
          <div className="eog-stat-divider" />
          <div className="eog-stat">
            <div className="eog-stat-label">EXIT</div>
            <div className="eog-stat-value">{data.exit !== null ? fmtPrice(data.exit) : copy.exitFallback}</div>
          </div>
          <div className="eog-stat-divider" />
          <div className="eog-stat">
            <div className="eog-stat-label">BOOST</div>
            <div className="eog-stat-value">{data.boost}x</div>
            <div className="eog-stat-sub">LONG ETH</div>
          </div>
        </div>

        <div className="eog-actions">
          <button className="eog-btn" onClick={handleShare}>SHARE</button>
          <button className="eog-btn" onClick={handleDownload}>DOWNLOAD</button>
          <button className="eog-btn primary" onClick={() => { sounds.play("ui-click"); onClose(); }}>CONTINUE</button>
        </div>
      </div>
    </div>
  );
}
