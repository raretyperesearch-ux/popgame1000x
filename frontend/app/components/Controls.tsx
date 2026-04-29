"use client";

import type { CSSProperties } from "react";

type GameState = "IDLE" | "RUNNING" | "PREPARE" | "JUMPING" | "PREVIEW" | "LIVE" | "STOPPED" | "DEAD";

interface ControlsProps {
  leverage: number;
  wager: number;
  balance: number;
  pnl: number | null;
  busy?: boolean;
  state: GameState;
  onLeverageChange: (v: number) => void;
  onWagerChange: (v: number) => void;
  onAction: () => void;
}

const CHIPS = [1, 5, 10, 25];

export default function Controls({
  leverage,
  wager,
  balance,
  pnl,
  busy = false,
  state,
  onLeverageChange,
  onWagerChange,
  onAction,
}: ControlsProps) {
  const opening = busy && state === "IDLE";
  const disabled = state !== "IDLE" || opening;
  const wagerMax = Math.max(1, Math.floor(balance));
  const boostHeat = Math.max(0, Math.min(1, (leverage - 75) / (250 - 75)));
  const wagerHeat = Math.max(0, Math.min(1, wager / Math.max(1, wagerMax)));
  const estimatedNetPnl = pnl === null ? null : pnl > 0 ? pnl * 0.975 : pnl;
  const estimatedNetCopy =
    estimatedNetPnl === null
      ? null
      : `${estimatedNetPnl >= 0 ? "+" : "\u2212"}$${Math.abs(estimatedNetPnl).toFixed(2)} est net`;

  let actionLabel = "jump";
  let actionClass = "action";
  let actionLocked = false;
  if (state === "LIVE") {
    actionLabel = "pull chute";
    actionClass = "action stop";
  } else if (state === "PREVIEW") {
    // 3-second study window before the trade goes live. Position is
    // already open on Avantis (entry + crash were locked at /trade/open),
    // but we don't let the player close until LIVE so the countdown
    // can't be skipped accidentally and so the chart has a stable
    // moment to read the entry/crash lines.
    actionLabel = "get ready";
    actionClass = "action disabled";
    actionLocked = true;
  } else if (opening) {
    actionLabel = "entering";
    actionClass = "action disabled";
    actionLocked = true;
  } else if (balance < 1 && state === "IDLE") {
    actionLabel = "out";
    actionClass = "action disabled";
    actionLocked = true;
  } else if (disabled) {
    actionClass = "action disabled";
    actionLocked = true;
  }

  return (
    <div className="controls">
      <div
        className="slider-row boost-row"
        style={{ "--heat": boostHeat } as CSSProperties}
      >
        <div className="slider-label">boost</div>
        <input
          type="range"
          className="hand-slider"
          min={75}
          max={250}
          step={1}
          value={leverage}
          disabled={disabled}
          onChange={(e) => onLeverageChange(parseInt(e.target.value, 10))}
        />
        <div className="slider-value">{leverage}x</div>
      </div>
      <div
        className="wager-row"
        style={{ "--wager-heat": wagerHeat } as CSSProperties}
      >
        {CHIPS.map((amt) => (
          <button
            key={amt}
            className={`chip${wager === amt ? " active" : ""}${disabled ? " disabled" : ""}`}
            onClick={() => onWagerChange(amt)}
          >
            ${amt}
          </button>
        ))}
      </div>
      <div
        className="slider-row cash-row"
        style={{ "--wager-heat": wagerHeat } as CSSProperties}
      >
        <div className="slider-label">wager</div>
        <input
          type="range"
          className="hand-slider"
          min={1}
          max={wagerMax}
          step={1}
          value={Math.min(wager, wagerMax)}
          disabled={disabled}
          onChange={(e) => onWagerChange(parseInt(e.target.value, 10))}
        />
        <div className="slider-value">${wager}</div>
      </div>
      <button type="button" className={actionClass} disabled={actionLocked} onClick={onAction}>
        <span className="action-boss-pack left" aria-hidden="true">
          <span className="boss-sprite v1" />
          <span className="boss-sprite v2" />
          <span className="boss-sprite v3" />
          <span className="boss-sprite v4" />
        </span>
        <span className="action-copy">
          <span className="action-label">{actionLabel}</span>
          {state === "LIVE" && estimatedNetCopy && (
            <span className="action-est">{estimatedNetCopy}</span>
          )}
        </span>
        <span className="action-boss-pack right" aria-hidden="true">
          <span className="boss-sprite v5" />
          <span className="boss-sprite v6" />
          <span className="boss-sprite v1" />
          <span className="boss-sprite v3" />
        </span>
      </button>
    </div>
  );
}
