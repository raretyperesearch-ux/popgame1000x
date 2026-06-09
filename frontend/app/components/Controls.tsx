"use client";

import type { CSSProperties } from "react";
import { isBelowMinPosition, minPositionHint } from "@/lib/trade-sizing";

type GameState = "IDLE" | "RUNNING" | "PREPARE" | "JUMPING" | "LIVE" | "STOPPED" | "DEAD";
type TradeDirection = "long" | "short";

interface ControlsProps {
  leverage: number;
  wager: number;
  balance: number;
  pnl: number | null;
  direction: TradeDirection;
  busy?: boolean;
  state: GameState;
  isConnected?: boolean;
  liveTradeReady?: boolean;
  settling?: boolean;
  addFuelPulseKey?: number;
  showFuelPanel?: boolean;
  fuelShortfall?: number;
  fuelTankAmount?: number;
  customFuelAmount?: string;
  customFuelSelected?: boolean;
  addFuelBusy?: boolean;
  onLeverageChange: (v: number) => void;
  onWagerChange: (v: number) => void;
  onAddFuel?: () => void;
  onSelectFuelAmount?: (amount: number) => void;
  onSelectCustomFuel?: () => void;
  onCustomFuelChange?: (value: string) => void;
  onFundFuel?: () => void;
  onAction: (direction?: TradeDirection) => void;
}

const CHIPS = [1, 25, 100, 1000];
const LOW_FUEL_TOP_UPS = [
  { label: "+$5", amount: 5 },
  { label: "+$25", amount: 25 },
];

export default function Controls({
  leverage,
  wager,
  balance,
  pnl,
  direction,
  busy = false,
  state,
  isConnected = false,
  liveTradeReady = true,
  settling = false,
  addFuelPulseKey = 0,
  showFuelPanel = false,
  fuelShortfall = 0,
  fuelTankAmount = 5,
  customFuelAmount = "50",
  customFuelSelected = false,
  addFuelBusy = false,
  onLeverageChange,
  onWagerChange,
  onAddFuel,
  onSelectFuelAmount,
  onSelectCustomFuel,
  onCustomFuelChange,
  onFundFuel,
  onAction,
}: ControlsProps) {
  const opening = busy && state === "IDLE";
  const disabled = state !== "IDLE" || opening;
  // Slider range scales to whichever is largest: the chip ceiling ($1000),
  // the user's actual balance, or the currently-set fuel. This way the
  // slider thumb always reaches the active chip selection even on a
  // small balance.
  const wagerMax = Math.max(1000, Math.floor(balance), wager);
  const boostHeat = Math.max(0, Math.min(1, (leverage - 75) / (500 - 75)));
  const wagerHeat = Math.max(0, Math.min(1, wager / Math.max(1, wagerMax)));
  const estimatedNetPnl = pnl === null ? null : pnl > 0 ? pnl * 0.975 : pnl;
  const estimatedNetCopy =
    estimatedNetPnl === null
      ? null
      : `${estimatedNetPnl >= 0 ? "+" : "\u2212"}$${Math.abs(estimatedNetPnl).toFixed(2)} est net`;

  let actionLabel = direction === "short" ? "dive" : "jump";
  let actionClass = "action";
  let actionLocked = false;
  if ((state === "STOPPED" || state === "DEAD") && settling) {
    actionLabel = state === "DEAD" ? "finalizing pnl" : "settling";
    actionClass = "action disabled";
    actionLocked = true;
  } else if (state === "STOPPED" && !settling) {
    actionLabel = "retry close";
    actionClass = "action stop";
  } else if (!liveTradeReady && state !== "IDLE") {
    actionLabel = "...";
    actionClass = "action disabled";
    actionLocked = true;
  } else if (state === "LIVE") {
    actionLabel = direction === "short" ? "surface" : "pull chute";
    actionClass = "action stop";
  } else if (opening) {
    actionLabel = "...";
    actionClass = "action disabled";
    actionLocked = true;
  } else if (disabled) {
    actionClass = "action disabled";
    actionLocked = true;
  }
  const showSplitAction = state === "IDLE" && !opening;
  const needsFunding = isConnected && wager > balance;
  const belowMinPosition = isConnected && !needsFunding && isBelowMinPosition(wager, leverage);
  const fundingShortfall = Math.max(0, wager - balance);
  const displayShortfall = showFuelPanel ? fuelShortfall : fundingShortfall;
  const addFuelPanelDetail = displayShortfall > 0
    ? `Need $${displayShortfall.toFixed(2)} more`
    : "Emergency top up";
  const fuelCoveredByBalance = showFuelPanel && balance >= fuelTankAmount;
  const addFuelFundingAmount = Math.max(1, Math.ceil(fuelTankAmount - balance));
  const addFuelButtonLabel = addFuelBusy
    ? "ADDING..."
    : fuelCoveredByBalance
      ? `ADD $${fuelTankAmount}`
      : `FUND $${addFuelFundingAmount}`;

  const actionButton = (
    <button type="button" className={actionClass} disabled={actionLocked} onClick={() => onAction()}>
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
  );

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
          max={500}
          step={1}
          value={leverage}
          disabled={disabled}
          onChange={(e) => onLeverageChange(parseInt(e.target.value, 10))}
        />
        <div className="slider-value">{leverage}x</div>
      </div>
      <div
        className="wager-panel"
        style={{ "--wager-heat": wagerHeat } as CSSProperties}
      >
        <div className="slider-row cash-row">
          <div className="slider-label">fuel</div>
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
        {needsFunding && !showFuelPanel && (
          <div className="fuel-helper-row">
            <span />
            <button
              key={addFuelPulseKey}
              type="button"
              className="add-fuel-inline pulse"
              onClick={onAddFuel}
            >
              add fuel
            </button>
          </div>
        )}
        {showFuelPanel ? (
          <>
            <div key={addFuelPulseKey} className="add-fuel-slot" role="dialog" aria-label="Add fuel">
              <div className="add-fuel-slot-copy">
                <span className="add-fuel-slot-siren" aria-hidden="true" />
                <strong>ADD FUEL</strong>
                <span>{addFuelPanelDetail}</span>
              </div>
              <div className="add-fuel-slot-amounts" aria-label="Fuel top-up amount">
                {LOW_FUEL_TOP_UPS.map(({ label, amount }) => (
                  <button
                    key={label}
                    type="button"
                    className={`add-fuel-slot-chip${!customFuelSelected && fuelTankAmount === amount ? " active" : ""}`}
                    onClick={() => onSelectFuelAmount?.(amount)}
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  className={`add-fuel-slot-chip${customFuelSelected ? " active" : ""}`}
                  onClick={onSelectCustomFuel}
                >
                  {customFuelSelected ? (
                    <span className="add-fuel-slot-custom" onClick={(e) => e.stopPropagation()}>
                      <span>$</span>
                      <input
                        value={customFuelAmount}
                        onChange={(e) => onCustomFuelChange?.(e.target.value)}
                        inputMode="numeric"
                        pattern="[0-9]*"
                        aria-label="Custom fuel amount"
                        autoFocus
                      />
                    </span>
                  ) : (
                    "CUSTOM"
                  )}
                </button>
              </div>
              <button
                type="button"
                className="add-fuel-slot-primary"
                onClick={onFundFuel ?? onAddFuel}
                disabled={addFuelBusy}
              >
                {addFuelButtonLabel}
              </button>
            </div>
            {state !== "IDLE" && actionButton}
          </>
        ) : showSplitAction ? (
          <>
            <div className="controls-action-hint">
              {!isConnected
                ? "try the game free · no login needed"
                : needsFunding
                  ? `Need $${fundingShortfall.toFixed(2)} more`
                  : belowMinPosition
                    ? minPositionHint(wager, leverage)
                    : "choose your move"}
            </div>
            <div
              className={`action-split${!isConnected ? " demo-hint" : ""}${needsFunding ? " funding-hint" : ""}${belowMinPosition ? " funding-hint" : ""}`}
              role="group"
              aria-label="Choose jump or dive"
            >
              <button type="button" className="action split-half jump" onClick={() => onAction("long")}>
                <span className="sr-only">jump</span>
              </button>
              <button type="button" className="action split-half dive" onClick={() => onAction("short")}>
                <span className="sr-only">dive</span>
              </button>
            </div>
          </>
        ) : (
          actionButton
        )}
      </div>
    </div>
  );
}
