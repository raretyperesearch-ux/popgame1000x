"use client";

interface PnLReadoutProps {
  pnlDollars: number | null;
}

export default function PnLReadout({ pnlDollars }: PnLReadoutProps) {
  if (pnlDollars === null) {
    return <div className="pnl-readout">PNL &mdash;</div>;
  }

  const cls =
    pnlDollars >= 0 ? "pnl-readout up" : "pnl-readout down";
  const sign = pnlDollars >= 0 ? "+" : "\u2212";

  return (
    <div className={cls}>
      PNL {sign}${Math.abs(pnlDollars).toFixed(2)}
    </div>
  );
}
