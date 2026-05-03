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
_BM_PLAYERS = "bm_players"


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

    Conflict key is open_tx_hash, which is globally unique on-chain. An
    earlier scheme keyed on (wallet_address, trade_index) but Avantis
    recycles trade_index per wallet on close, so every reopen of a
    recycled index silently overwrote the previous trade's row. Keying
    on the tx hash gives every real trade its own row; idempotent retries
    of the same record_open just re-update the same row."""
    if not is_enabled():
        return
    # Defensive: if the receipt unwrap upstream ever returns "" (web3.py
    # receipt without a transactionHash attribute), every empty-hash
    # record_open would collide on the unique index and silently
    # overwrite the previous one — re-introducing the original bug.
    # Skip loudly instead.
    if not open_tx_hash:
        print(
            f"[persistence] record_open skipped: empty open_tx_hash for "
            f"{wallet_address} #{trade_index}"
        )
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
    }
    try:
        _client.table(_TABLE).upsert(
            row,
            on_conflict="open_tx_hash",
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
    """Patch the close fields on the still-open row.

    The (wallet_address, trade_index) pair alone is ambiguous: Avantis
    recycles trade_index, so historical rows can share that pair with
    the current open trade. The `closed_at IS NULL` filter narrows the
    update to the one row that's actually open right now — guaranteed
    unique by the partial-unique index added in migration 0002.

    If no row matches (Supabase was down at open, so there's no row to
    patch), the update is a silent no-op — leaderboard/history will be
    missing this trade. Not worth failing the close response over a
    logging miss."""
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
        ).eq("trade_index", trade_index).is_("closed_at", "null").execute()
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


# ---------------------------------------------------------------------------
# Cross-game identity (bm_players) — shared with Swallow Me / Holy Liquid.
#
# privy_id is the canonical join key across all Hiscore games. evm_wallet_address
# is the secondary key used by the pg_trades_sync_bm_players trigger when a
# trade lands before the user has logged in via this register flow.
# ---------------------------------------------------------------------------


def register_player(*, privy_id: str, evm_wallet_address: str) -> Optional[dict]:
    """Idempotent upsert of a Hiscore identity row keyed on privy_id.

    Mirrors the canonical register pattern from the Hiscore main repo's
    Swallow Me route. Run with the service-role client (we already are —
    `_client` was created with SUPABASE_SERVICE_ROLE_KEY in init()), so
    RLS doesn't block the write.

    A pg_trades trigger may have already inserted a row keyed on
    evm_wallet_address (with privy_id NULL) for this wallet from prior
    SR play. The onConflict=privy_id upsert wouldn't see that row — but
    Postgres also has unique(lower(evm_wallet_address)), so the insert
    would 23505 with a duplicate-key error. We swallow that and patch
    the wallet-keyed row's privy_id instead, completing the linkage.
    """
    if not is_enabled():
        return None
    if not privy_id or not evm_wallet_address:
        print(f"[bm_players] register_player: missing privy_id={privy_id!r} or wallet={evm_wallet_address!r}")
        return None
    wallet = evm_wallet_address.lower()
    now = datetime.utcnow().isoformat()
    row = {
        "privy_id": privy_id,
        "evm_wallet_address": wallet,
        "last_active_at": now,
    }
    try:
        res = (
            _client.table(_BM_PLAYERS)
            .upsert(row, on_conflict="privy_id")
            .execute()
        )
        data = list(res.data or [])
        return data[0] if data else None
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        # Trigger-backfilled row already exists for this wallet (privy_id
        # NULL). Patch it: set privy_id + bump last_active_at on the row
        # the unique-wallet index pointed to.
        if "bm_players_evm_wallet_address" in msg or "lower(evm_wallet_address)" in msg or "duplicate key" in msg:
            try:
                patch_res = (
                    _client.table(_BM_PLAYERS)
                    .update({"privy_id": privy_id, "last_active_at": now})
                    .eq("evm_wallet_address", wallet)
                    .execute()
                )
                data = list(patch_res.data or [])
                return data[0] if data else None
            except Exception as patch_err:  # noqa: BLE001
                print(f"[bm_players] wallet-keyed patch failed for {wallet}: {patch_err}")
                return None
        print(f"[bm_players] register_player upsert failed for {privy_id} / {wallet}: {e}")
        return None


def get_player_by_privy_id(privy_id: str) -> Optional[dict]:
    if not is_enabled() or not privy_id:
        return None
    try:
        res = (
            _client.table(_BM_PLAYERS)
            .select("privy_id,evm_wallet_address,wallet_address,username,created_at,last_active_at")
            .eq("privy_id", privy_id)
            .limit(1)
            .execute()
        )
        rows = list(res.data or [])
        return rows[0] if rows else None
    except Exception as e:  # noqa: BLE001
        print(f"[bm_players] get_player_by_privy_id {privy_id} failed: {e}")
        return None


def set_username(*, privy_id: str, username: str) -> tuple[Optional[dict], Optional[str]]:
    """Set the player's display name. Returns (row, error_msg).

    Usernames are unique across ALL games (the bm_players.username unique
    constraint enforces that), so we report a clear "taken" error rather
    than letting a 23505 surface raw to the user. Returns the updated
    row on success, or (None, "<reason>") on validation/conflict failure.
    """
    if not is_enabled():
        return None, "registry disabled"
    if not privy_id:
        return None, "missing privy_id"
    name = (username or "").strip()
    # Mild input policing — server-side guard since the public client
    # could call this directly. The DB constraints are still the source
    # of truth on uniqueness.
    if len(name) < 3 or len(name) > 20:
        return None, "username must be 3-20 characters"
    if not all(c.isalnum() or c in "_-" for c in name):
        return None, "username can only contain letters, numbers, _ and -"
    try:
        res = (
            _client.table(_BM_PLAYERS)
            .update({"username": name, "last_active_at": datetime.utcnow().isoformat()})
            .eq("privy_id", privy_id)
            .execute()
        )
        rows = list(res.data or [])
        if not rows:
            return None, "player not registered yet"
        return rows[0], None
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "duplicate key" in msg or "username" in msg.lower() and "unique" in msg.lower():
            return None, "username already taken"
        print(f"[bm_players] set_username failed for {privy_id}: {e}")
        return None, "could not set username"
