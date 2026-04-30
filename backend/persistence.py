"""
Supabase persistence — best-effort trade history + leaderboard.

Wired in lazily so an unconfigured (or temporarily broken) Supabase env
never blocks real-money trade execution. All public helpers swallow
errors after logging — the caller treats persistence as a side effect,
not a contract.

Schema lives in `migrations/0001_init.sql`. Apply it once on the
project before pointing prod at it (the SUPABASE_SERVICE_ROLE_KEY this
module uses bypasses RLS, so the migration's policies are advisory for
direct anon access only — not for these writes).

Exposed surface:
  init()                  — boot-time client init (idempotent, no-op when env unset)
  is_enabled()            — quick check for read endpoints
  record_open(...)        — upsert on (wallet_address, trade_index) at open
  record_close(...)       — patch the same row at close
  recent_trades_for(...)  — paged history of one wallet
  leaderboard(...)        — top traders by net realized PnL
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any, Optional

# We import supabase lazily inside init() so the module can be imported
# in environments where the package isn't installed (e.g. unit tests
# that monkeypatch _client directly).

_client: Any = None
_enabled: bool = False
_TABLE = "pg_trades"
_LEADERBOARD_VIEW = "pg_trade_leaderboard"


def init() -> None:
    """Initialize the module's singleton Supabase client. Safe to call
    multiple times. No-op when SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY
    is unset — lets the rest of the backend run unchanged for local dev."""
    global _client, _enabled

    url = os.getenv("SUPABASE_URL", "").strip()
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        print("• Supabase not configured — trade history disabled")
        _client = None
        _enabled = False
        return

    try:
        from supabase import create_client  # type: ignore
    except ImportError:
        print(
            "⚠️  SUPABASE_URL/SERVICE_ROLE_KEY set but `supabase` package "
            "missing from requirements — install to enable history."
        )
        _client = None
        _enabled = False
        return

    try:
        _client = create_client(url, key)
        _enabled = True
        print(f"✓ Supabase client initialized (host={_host(url)})")
    except Exception as e:  # noqa: BLE001
        print(f"⚠️  Supabase client init failed: {e}")
        _client = None
        _enabled = False


def is_enabled() -> bool:
    return _enabled and _client is not None


def _host(url: str) -> str:
    try:
        from urllib.parse import urlparse
        return urlparse(url).hostname or url
    except Exception:  # noqa: BLE001
        return url


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt is not None else None


def record_open(
    *,
    did: str,
    wallet_address: str,
    trade_index: int,
    pair_index: int,
    leverage: int,
    wager_usdc: float,
    house_fee_usdc: float,
    collateral_usdc: float,
    entry_price: float,
    liquidation_price: float,
    opened_at: datetime,
    open_tx_hash: str,
) -> None:
    """Insert a row when a trade opens. Best-effort — never raises.

    Uses upsert on (wallet_address, trade_index) so if the same trade
    index ever cycles for the same wallet (Avantis recycles indices on
    close), a re-open won't 23505 us; the older row's `closed_at` will
    already be set, so we'll just overwrite it with fresh open data."""
    if not is_enabled():
        return
    row = {
        "did": did,
        "wallet_address": wallet_address.lower(),
        "trade_index": trade_index,
        "pair_index": pair_index,
        "leverage": leverage,
        "wager_usdc": wager_usdc,
        "house_fee_usdc": house_fee_usdc,
        "collateral_usdc": collateral_usdc,
        "entry_price": entry_price,
        "liquidation_price": liquidation_price,
        "opened_at": _iso(opened_at),
        "open_tx_hash": open_tx_hash,
        # Reset close fields so a recycled index doesn't carry over
        # stale close data from a previous trade with the same index.
        "closed_at": None,
        "exit_price": None,
        "gross_pnl_usdc": None,
        "avantis_win_fee_usdc": None,
        "net_pnl_usdc": None,
        "was_liquidated": None,
        "close_tx_hash": None,
    }
    try:
        _client.table(_TABLE).upsert(
            row,
            on_conflict="wallet_address,trade_index",
        ).execute()
    except Exception as e:  # noqa: BLE001
        print(f"[persistence] record_open failed for {wallet_address} #{trade_index}: {e}")


def record_close(
    *,
    wallet_address: str,
    trade_index: int,
    exit_price: float,
    gross_pnl_usdc: float,
    avantis_win_fee_usdc: float,
    net_pnl_usdc: float,
    was_liquidated: bool,
    closed_at: datetime,
    close_tx_hash: str,
) -> None:
    """Patch the close fields on the existing open row.

    If the open row never made it (Supabase was down at open time), we
    silently skip — leaderboard/history will just be missing this
    trade. Failing the close response on a logging miss isn't worth it."""
    if not is_enabled():
        return
    patch = {
        "exit_price": exit_price,
        "gross_pnl_usdc": gross_pnl_usdc,
        "avantis_win_fee_usdc": avantis_win_fee_usdc,
        "net_pnl_usdc": net_pnl_usdc,
        "was_liquidated": was_liquidated,
        "closed_at": _iso(closed_at),
        "close_tx_hash": close_tx_hash,
    }
    try:
        _client.table(_TABLE).update(patch).eq(
            "wallet_address", wallet_address.lower()
        ).eq("trade_index", trade_index).execute()
    except Exception as e:  # noqa: BLE001
        print(f"[persistence] record_close failed for {wallet_address} #{trade_index}: {e}")


def recent_trades_for(wallet_address: str, limit: int = 25) -> list[dict]:
    """Return the latest N trades for a wallet, newest first. Empty
    list when persistence is disabled or the query fails."""
    if not is_enabled():
        return []
    limit = max(1, min(int(limit), 100))
    try:
        res = (
            _client.table(_TABLE)
            .select("*")
            .eq("wallet_address", wallet_address.lower())
            .order("opened_at", desc=True)
            .limit(limit)
            .execute()
        )
        return list(res.data or [])
    except Exception as e:  # noqa: BLE001
        print(f"[persistence] recent_trades_for {wallet_address} failed: {e}")
        return []


def leaderboard(limit: int = 20) -> list[dict]:
    """Sum net realized PnL per wallet over closed trades, top N.

    Implemented as a SQL view (`pg_trade_leaderboard`) defined in the
    migration so we can sort/aggregate server-side. Falls back to an
    in-process aggregation only if the view is missing — cheap on a
    small table, but logged so the operator notices the missing view."""
    if not is_enabled():
        return []
    limit = max(1, min(int(limit), 100))
    try:
        res = (
            _client.table(_LEADERBOARD_VIEW)
            .select("*")
            .order("net_pnl_usdc", desc=True)
            .limit(limit)
            .execute()
        )
        return list(res.data or [])
    except Exception as e:  # noqa: BLE001
        print(f"[persistence] leaderboard view query failed ({e}); falling back to in-process aggregation")
        return _leaderboard_fallback(limit)


def _leaderboard_fallback(limit: int) -> list[dict]:
    try:
        res = (
            _client.table(_TABLE)
            .select("wallet_address,net_pnl_usdc,was_liquidated")
            .not_.is_("closed_at", "null")
            .execute()
        )
        rows = res.data or []
    except Exception as e:  # noqa: BLE001
        print(f"[persistence] leaderboard fallback failed: {e}")
        return []
    agg: dict[str, dict[str, Any]] = {}
    for r in rows:
        addr = (r.get("wallet_address") or "").lower()
        if not addr:
            continue
        slot = agg.setdefault(addr, {
            "wallet_address": addr,
            "net_pnl_usdc": 0.0,
            "trade_count": 0,
            "liquidations": 0,
        })
        slot["net_pnl_usdc"] += float(r.get("net_pnl_usdc") or 0)
        slot["trade_count"] += 1
        if r.get("was_liquidated"):
            slot["liquidations"] += 1
    out = sorted(agg.values(), key=lambda x: x["net_pnl_usdc"], reverse=True)
    return out[:limit]
