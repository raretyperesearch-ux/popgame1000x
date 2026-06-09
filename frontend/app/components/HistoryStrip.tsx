"use client";

import { useState, useRef, useEffect, useCallback } from "react";

export interface HistoryEntry {
  amt: number;
  win: boolean;
  direction?: "long" | "short";
  /* Optional rich detail. Present when the entry was loaded from
     /history/me or pushed locally after a closed trade with full
     detail. Absent for legacy callers that only know amt + win. */
  entry?: number;
  exit?: number | null;
  leverage?: number;
  wager?: number;
  openedAt?: string;
  closedAt?: string | null;
  liquidated?: boolean;
}

interface HistoryStripProps {
  history: HistoryEntry[];
}

function formatPrice(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p) || p === 0) return "—";
  if (p >= 1000) return `$${p.toFixed(2)}`;
  if (p >= 1) return `$${p.toFixed(4)}`;
  return `$${p.toFixed(6)}`;
}

function relativeTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diffMs = Date.now() - t;
  const sec = Math.max(0, Math.round(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export default function HistoryStrip({ history }: HistoryStripProps) {
  const slots = Array.from({ length: 5 }, (_, i) => history[i] ?? null);
  /* One popover open at a time, identified by slot index. null means
     none open. We track this in state (rather than CSS :hover) so
     touch / keyboard users can pin a detail card open. */
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [detailShift, setDetailShift] = useState(0);
  const stripRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  /* Close the popover on outside click + Escape. Mirrors the topbar
     menu behaviour so the interaction model is consistent. */
  useEffect(() => {
    if (openIdx === null) return;
    const onDocClick = (e: MouseEvent) => {
      if (!stripRef.current) return;
      if (!stripRef.current.contains(e.target as Node)) setOpenIdx(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenIdx(null);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [openIdx]);

  /* When the underlying history shifts (a new trade closes mid-popover
     and slice-tail rolls the array), the chip the popover was anchored
     to now shows different data. Close it instead of misleading the
     reader. */
  useEffect(() => {
    setOpenIdx(null);
  }, [history]);

  const clampDetailToViewport = useCallback(() => {
    const el = detailRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gutter = 10;
    const maxRight = window.innerWidth - gutter;
    const baseLeft = rect.left - detailShift;
    const baseRight = rect.right - detailShift;
    const minShift = gutter - baseLeft;
    const maxShift = maxRight - baseRight;
    const next = Math.round(Math.min(Math.max(0, minShift), maxShift));
    setDetailShift(next);
  }, [detailShift]);

  useEffect(() => {
    if (openIdx === null) {
      setDetailShift(0);
      return;
    }
    const raf = window.requestAnimationFrame(clampDetailToViewport);
    window.addEventListener("resize", clampDetailToViewport);
    window.visualViewport?.addEventListener("resize", clampDetailToViewport);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", clampDetailToViewport);
      window.visualViewport?.removeEventListener("resize", clampDetailToViewport);
    };
  }, [openIdx, clampDetailToViewport]);

  const toggle = useCallback((idx: number, hasDetail: boolean) => {
    if (!hasDetail) return;
    setDetailShift(0);
    setOpenIdx((prev) => (prev === idx ? null : idx));
  }, []);

  return (
    <div className="history-row" ref={stripRef}>
      <span className="label">LAST 5 SCALPS</span>
      {slots.map((h, i) => {
        if (!h) {
          return (
            <span key={i} className="h-tag empty">
              &mdash;
            </span>
          );
        }
        const hasDetail =
          h.entry !== undefined ||
          h.exit !== undefined ||
          h.leverage !== undefined ||
          h.wager !== undefined ||
          Boolean(h.openedAt);
        const sign = h.win ? "+" : "−$";
        const label = `${sign}${Math.abs(h.amt).toFixed(2)}`;
        const className = `h-tag ${h.win ? "win" : "loss"}${
          h.liquidated ? " liq" : ""
        }${hasDetail ? " has-detail" : ""}${openIdx === i ? " open" : ""}`;
        return (
          <span key={i} className="h-tag-wrap">
            <button
              type="button"
              className={className}
              onClick={() => toggle(i, hasDetail)}
              aria-label={
                hasDetail
                  ? `Trade ${i + 1}: ${label}, click for detail`
                  : `Trade ${i + 1}: ${label}`
              }
              aria-expanded={hasDetail ? openIdx === i : undefined}
              disabled={!hasDetail}
            >
              {label}
            </button>
            {hasDetail && openIdx === i && (
              <div
                ref={detailRef}
                className="h-detail"
                role="dialog"
                aria-label="Trade detail"
                style={
                  detailShift
                    ? { transform: `translateX(calc(-50% + ${detailShift}px))` }
                    : undefined
                }
              >
                <div className="h-detail-row">
                  <span className="h-detail-label">net</span>
                  <span className={`h-detail-value ${h.win ? "win" : "loss"}`}>
                    {h.win ? "+" : "−$"}
                    {Math.abs(h.amt).toFixed(2)}
                    {h.liquidated ? " · liq" : ""}
                  </span>
                </div>
                {h.entry !== undefined && (
                  <div className="h-detail-row">
                    <span className="h-detail-label">entry</span>
                    <span className="h-detail-value">{formatPrice(h.entry)}</span>
                  </div>
                )}
                {(h.exit !== undefined && h.exit !== null) && (
                  <div className="h-detail-row">
                    <span className="h-detail-label">exit</span>
                    <span className="h-detail-value">{formatPrice(h.exit)}</span>
                  </div>
                )}
                {(h.leverage !== undefined || h.wager !== undefined) && (
                  <div className="h-detail-row">
                    <span className="h-detail-label">size</span>
                    <span className="h-detail-value">
                      {h.leverage !== undefined ? `${h.leverage}x` : "—"}
                      {h.wager !== undefined ? ` · $${h.wager.toFixed(2)}` : ""}
                    </span>
                  </div>
                )}
                {h.openedAt && (
                  <div className="h-detail-row">
                    <span className="h-detail-label">when</span>
                    <span className="h-detail-value">{relativeTime(h.openedAt)}</span>
                  </div>
                )}
              </div>
            )}
          </span>
        );
      })}
    </div>
  );
}
