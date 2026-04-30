"use client";

interface PnLReadoutProps {
  pnlDollars: number | null;
}

export default function PnLReadout({ pnlDollars }: PnLReadoutProps) {
  if (pnlDollars === null) {
    return (
      <div className="pnl-readout">
        <span className="pnl-readout-label">PNL</span>
        <span className="pnl-readout-amount">&mdash;</span>
      </div>
    );
  }

  const cls =
    pnlDollars >= 0 ? "pnl-readout up" : "pnl-readout down";
  const sign = pnlDollars >= 0 ? "+" : "\u2212";

  return (
    <div className={cls}>
      <span className="pnl-readout-label">PNL</span>
      <span className="pnl-readout-amount">{sign}${Math.abs(pnlDollars).toFixed(2)}</span>
    </div>
  );
}
