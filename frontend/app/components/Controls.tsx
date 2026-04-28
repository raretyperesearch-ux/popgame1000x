"use client";

type GameState = "IDLE" | "RUNNING" | "PREPARE" | "JUMPING" | "LIVE" | "STOPPED" | "DEAD";

interface ControlsProps {
  leverage: number;
  wager: number;
  balance: number;
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
  busy = false,
  state,
  onLeverageChange,
  onWagerChange,
  onAction,
}: ControlsProps) {
  const opening = busy && state === "IDLE";
  const disabled = state !== "IDLE" || opening;
  const wagerMax = Math.max(1, Math.floor(balance));

  let actionLabel = "jump";
  let actionClass = "action";
  let actionLocked = false;
  if (state === "LIVE") {
    actionLabel = "stop";
    actionClass = "action stop";
  } else if (opening) {
    actionLabel = "opening";
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
      <div className="slider-row boost-row">
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
      <div className="wager-row">
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
      <div className="slider-row cash-row">
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
        <span className="action-label">{actionLabel}</span>
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
