"use client";

type GameState = "IDLE" | "RUNNING" | "PREPARE" | "JUMPING" | "LIVE" | "STOPPED" | "DEAD";

interface ControlsProps {
  leverage: number;
  wager: number;
  balance: number;
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
  state,
  onLeverageChange,
  onWagerChange,
  onAction,
}: ControlsProps) {
  const disabled = state !== "IDLE";
  const wagerMax = Math.max(1, Math.floor(balance));

  let actionLabel = "jump";
  let actionClass = "action";
  if (state === "LIVE") {
    actionLabel = "stop";
    actionClass = "action stop";
  } else if (balance < 1 && state === "IDLE") {
    actionLabel = "out";
    actionClass = "action disabled";
  } else if (disabled) {
    actionClass = "action disabled";
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
      <div className="slider-row">
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
      <button className={actionClass} onClick={onAction}>
        <span className="action-sprite" aria-hidden="true" />
        <span className="action-label">{actionLabel}</span>
      </button>
    </div>
  );
}
