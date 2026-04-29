"use client";

export interface HistoryEntry {
  amt: number;
  win: boolean;
}

interface HistoryStripProps {
  history: HistoryEntry[];
}

export default function HistoryStrip({ history }: HistoryStripProps) {
  const slots = Array.from({ length: 5 }, (_, i) => history[i] ?? null);

  return (
    <div className="history-row">
      <span className="label">LAST 5 TRADES</span>
      {slots.map((h, i) => {
        if (!h) {
          return (
            <span key={i} className="h-tag empty">
              &mdash;
            </span>
          );
        }
        const sign = h.win ? "+" : "\u2212$";
        return (
          <span
            key={i}
            className={`h-tag ${h.win ? "win" : "loss"}`}
          >
            {sign}{Math.abs(h.amt).toFixed(2)}
          </span>
        );
      })}
    </div>
  );
}
