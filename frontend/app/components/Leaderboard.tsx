"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sounds } from "@/lib/sounds";
import {
  getLeaderboard,
  type LeaderboardRow,
} from "@/lib/api";

interface LeaderboardProps {
  authenticated: boolean;
  walletAddress: string | null | undefined;
  getAccessToken: () => Promise<string | null>;
  paperMode: boolean;
  /* Bumped by the host page after every trade close so the dropdown
     reflects fresh standings without polling. Initial value just needs
     to be stable across renders. */
  refreshKey: number;
  /* Fires whenever this dropdown opens. The parent uses it to close
     sibling dropdowns (wallet menu, avatar menu) explicitly — the
     outside-click handlers eventually catch them too, but matching
     the existing explicit close-others pattern in Topbar avoids any
     render-order edge case where two dropdowns are visible briefly. */
  onOpen?: () => void;
}

/* Decorative top-of-board entries the operator pins regardless of
   real standings — aspirational benchmarks so a fresh leaderboard
   doesn't read as empty / sad. Sit above the real rows in the
   dropdown but are excluded from "your rank" math (we never tell a
   player they're outranked by a ghost). */
const PINNED_ROWS: LeaderboardRow[] = [
  {
    wallet_address: "0x1ab74c20e7af4a3e0d9c2b8f6e1f4a8d5c3b9f2c",
    net_pnl_usdc: 712.0,
    trade_count: 41,
    liquidations: 2,
    last_closed_at: null,
  },
  {
    wallet_address: "0x8d3e7b2a90f4c1d6e5b8a7f9d2c4e1b6f3a8c541",
    net_pnl_usdc: 244.6,
    trade_count: 18,
    liquidations: 1,
    last_closed_at: null,
  },
];

function truncate(addr: string): string {
  if (!addr || addr.length < 10) return addr || "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatPnl(n: number): string {
  const sign = n >= 0 ? "+" : "−";
  const abs = Math.abs(n);
  if (abs >= 1000) return `${sign}$${abs.toFixed(0)}`;
  if (abs >= 100) return `${sign}$${abs.toFixed(1)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

export default function Leaderboard({
  authenticated,
  walletAddress,
  getAccessToken,
  paperMode,
  refreshKey,
  onOpen,
}: LeaderboardProps) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  /* Fetch on mount, on wallet change, and whenever the host bumps
     refreshKey (i.e. after a trade close). The /history/leaderboard
     endpoint is public so we fetch even when not authenticated — a
     visitor arriving on the marketing-first state should see real
     standings before being asked to deposit. We still pass the token
     getter when available so authed users get a faster path through
     the backend's CORS/auth middleware in case it's later tightened. */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getLeaderboard(
      20,
      authenticated ? getAccessToken : undefined,
      walletAddress ?? undefined,
    )
      .then((res) => {
        if (cancelled) return;
        setRows(res.rows ?? []);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[leaderboard] fetch failed:", e);
        setError(msg.slice(0, 120));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authenticated, paperMode, walletAddress, getAccessToken, refreshKey]);

  /* Display order: pinned mocks first, then real rows sorted by net
     PnL desc. Cap at 10 visible rows so the dropdown stays compact —
     "view top 20" lives in the footer for users who want more. */
  const displayRows = useMemo(() => {
    const real = (rows ?? [])
      .slice()
      .sort((a, b) => (b.net_pnl_usdc ?? 0) - (a.net_pnl_usdc ?? 0));
    return [...PINNED_ROWS, ...real].slice(0, 10);
  }, [rows]);

  /* "Your rank" only counts real rows — the pinned mocks aren't a real
     standings benchmark and we don't want to demoralize the player by
     telling them they're #3 behind two ghosts when they're actually
     #1 of real traders. Returns null when the player isn't in the top
     20 we fetched (or hasn't closed any trades yet). */
  const myRank = useMemo(() => {
    if (!rows || !walletAddress) return null;
    const lower = walletAddress.toLowerCase();
    const sorted = rows
      .slice()
      .sort((a, b) => (b.net_pnl_usdc ?? 0) - (a.net_pnl_usdc ?? 0));
    const idx = sorted.findIndex(
      (r) => (r.wallet_address ?? "").toLowerCase() === lower,
    );
    return idx >= 0 ? idx + 1 : null;
  }, [rows, walletAddress]);

  /* Outside-click and Escape dismiss — same idiom as the topbar
     wallet/avatar menus and HistoryStrip popover. */
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const onToggle = useCallback(() => {
    sounds.play("ui-click");
    setOpen((v) => {
      const next = !v;
      if (next) onOpen?.();
      return next;
    });
  }, [onOpen]);

  // No early bail on unauthenticated/paperMode — the leaderboard is a
  // public conversion surface. `myRank` just falls back to "—" without
  // a wallet address.
  const lower = walletAddress?.toLowerCase() ?? "";
  const rankLabel = myRank !== null ? `#${myRank}` : "—";

  return (
    <div className="leaderboard-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`leaderboard-pill ${open ? "open" : ""}`}
        title="Leaderboard"
        aria-label="Leaderboard"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="leaderboard-trophy" aria-hidden="true">★</span>
        <span className="leaderboard-rank">{rankLabel}</span>
      </button>
      {open && (
        <div className="leaderboard-menu" role="dialog" aria-label="Top traders">
          <div className="leaderboard-header">
            <span className="leaderboard-title">TOP TRADERS</span>
            <span className="leaderboard-sub">realized PnL · all time</span>
          </div>

          {loading && rows === null && (
            <div className="leaderboard-state">loading…</div>
          )}
          {error && (
            <div className="leaderboard-state error">
              couldn&apos;t load leaderboard
            </div>
          )}
          {!loading && !error && displayRows.length === 0 && (
            <div className="leaderboard-state">no trades yet</div>
          )}

          {displayRows.length > 0 && (
            <ol className="leaderboard-list">
              {displayRows.map((r, i) => {
                const isMe =
                  lower !== "" &&
                  (r.wallet_address ?? "").toLowerCase() === lower;
                const positive = (r.net_pnl_usdc ?? 0) >= 0;
                return (
                  <li
                    key={`${r.wallet_address}-${i}`}
                    className={`leaderboard-row ${isMe ? "me" : ""}`}
                  >
                    <span className="leaderboard-pos">{i + 1}</span>
                    <span className="leaderboard-addr">
                      {isMe ? "you" : truncate(r.wallet_address)}
                    </span>
                    <span
                      className={`leaderboard-pnl ${positive ? "win" : "loss"}`}
                    >
                      {formatPnl(r.net_pnl_usdc ?? 0)}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="leaderboard-footer">
            {!authenticated && (
              <span className="leaderboard-foot-note">
                log in + close a trade to make the board
              </span>
            )}
            {authenticated && myRank === null && rows && rows.length > 0 && (
              <span className="leaderboard-foot-note">
                you&apos;re not in the top 20 yet
              </span>
            )}
            {authenticated && myRank === null && rows && rows.length === 0 && (
              <span className="leaderboard-foot-note">
                close a trade to make the board
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
