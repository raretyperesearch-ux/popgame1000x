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
from datetime import datetime, timezone
from typing import Any, Optional

# We import supabase lazily inside init() so the module can be imported
# in environments where the package isn't installed (e.g. unit tests
# that monkeypatch _client directly).

_client: Any = None
_enabled: bool = False
_TABLE = "pg_trades"
_LEADERBOARD_VIEW = "pg_trade_leaderboard"
_BM_PLAYERS = "bm_players"
_HOUSE_FEE_EVENTS = "pg_house_fee_events"


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
) -> bool:
    """Insert a row when a trade opens. Best-effort — never raises.

    Conflict key is open_tx_hash, which is globally unique on-chain. An
    earlier scheme keyed on (wallet_address, trade_index) but Avantis
    recycles trade_index per wallet on close, so every reopen of a
    recycled index silently overwrote the previous trade's row. Keying
    on the tx hash gives every real trade its own row; idempotent retries
    of the same record_open just re-update the same row."""
    if not is_enabled():
        return False
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
        return False
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
        return True
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "pg_trades_one_open_per_index" in msg:
            try:
                stale_close = _iso(opened_at)
                _client.table(_TABLE).update(
                    {
                        "closed_at": stale_close,
                        "close_tx_hash": f"stale-before:{open_tx_hash}",
                    }
                ).eq("wallet_address", wallet_address.lower()).eq(
                    "trade_index", trade_index
                ).is_("closed_at", "null").neq(
                    "open_tx_hash", open_tx_hash
                ).execute()
                _client.table(_TABLE).upsert(
                    row,
                    on_conflict="open_tx_hash",
                ).execute()
                print(
                    f"[persistence] record_open recovered stale open row "
                    f"for {wallet_address} #{trade_index}"
                )
                return True
            except Exception as retry_err:  # noqa: BLE001
                print(
                    f"[persistence] record_open stale-row recovery failed "
                    f"for {wallet_address} #{trade_index}: {retry_err}"
                )
        print(f"[persistence] record_open failed for {wallet_address} #{trade_index}: {e}")
        return False


def active_open_for_wallet(wallet_address: str) -> Optional[dict]:
    """Return the newest locally-open trade row for a wallet, if any."""
    if not is_enabled():
        return None
    try:
        res = (
            _client.table(_TABLE)
            .select("*")
            .eq("wallet_address", wallet_address.lower())
            .is_("closed_at", "null")
            .order("opened_at", desc=True)
            .limit(1)
            .execute()
        )
        if res.data:
            return dict(res.data[0])
    except Exception as e:  # noqa: BLE001
        print(f"[persistence] active_open_for_wallet failed for {wallet_address}: {e}")
    return None


def mark_stale_open_reconciled(*, wallet_address: str, trade_index: int, reason: str) -> bool:
    """Close a stale local open row when Avantis no longer has it open."""
    if not is_enabled():
        return False
    try:
        now = _iso(datetime.now(timezone.utc))
        _client.table(_TABLE).update(
            {
                "closed_at": now,
                "close_tx_hash": f"reconciled-stale:{reason}",
            }
        ).eq("wallet_address", wallet_address.lower()).eq(
            "trade_index", trade_index
        ).is_("closed_at", "null").execute()
        return True
    except Exception as e:  # noqa: BLE001
        print(
            f"[persistence] mark_stale_open_reconciled failed "
            f"for {wallet_address} #{trade_index}: {e}"
        )
        return False


def record_house_fee_pending(
    *,
    idempotency_key: str,
    did: str,
    wallet_address: str,
    wallet_id: str,
    trade_index: int,
    session_id: str,
    collateral_usdc: float,
    fee_usdc: float,
    treasury_address: str,
) -> Optional[dict]:
    """Durably queue a house-fee collection event.

    The idempotency key is unique. If an event already exists, return it
    without resetting status/tx_hash so retries cannot turn a collected
    fee back into a pending fee.
    """
    if not is_enabled():
        print(
            f"[persistence] house fee queue skipped: Supabase disabled "
            f"({idempotency_key})"
        )
        return None
    try:
        existing = (
            _client.table(_HOUSE_FEE_EVENTS)
            .select("*")
            .eq("idempotency_key", idempotency_key)
            .limit(1)
            .execute()
        )
        if existing.data:
            return dict(existing.data[0])
    except Exception as e:  # noqa: BLE001
        print(f"[persistence] house fee lookup failed ({idempotency_key}): {e}")

    now = _iso(datetime.now(timezone.utc))
    row = {
        "idempotency_key": idempotency_key,
        "did": did,
        "wallet_address": wallet_address.lower(),
        "wallet_id": wallet_id,
        "trade_index": trade_index,
        "session_id": session_id,
        "collateral_usdc": collateral_usdc,
        "fee_usdc": fee_usdc,
        "treasury_address": treasury_address.lower(),
        "status": "pending",
        "tx_hash": None,
        "attempt_count": 0,
        "last_error": None,
        "created_at": now,
        "updated_at": now,
    }
    try:
        res = _client.table(_HOUSE_FEE_EVENTS).insert(row).execute()
        return dict((res.data or [row])[0])
    except Exception as e:  # noqa: BLE001
        # A concurrent retry may have inserted the row first. Read it back
        # so the caller still has the durable event identity.
        try:
            existing = (
                _client.table(_HOUSE_FEE_EVENTS)
                .select("*")
                .eq("idempotency_key", idempotency_key)
                .limit(1)
                .execute()
            )
            if existing.data:
                return dict(existing.data[0])
        except Exception:  # noqa: BLE001
            pass
        print(f"[persistence] house fee insert failed ({idempotency_key}): {e}")
        return None


def claim_house_fee_event(idempotency_key: str) -> Optional[dict]:
    """Atomically claim a pending/failed house-fee event for collection."""
    if not is_enabled():
        return None
    try:
        res = _client.rpc(
            "pg_claim_house_fee_event",
            {"p_idempotency_key": idempotency_key},
        ).execute()
        if res.data:
            return dict(res.data[0])
        return None
    except Exception as e:  # noqa: BLE001
        print(f"[persistence] house fee claim failed ({idempotency_key}): {e}")
        return None


def mark_house_fee_collected(idempotency_key: str, tx_hash: str) -> None:
    if not is_enabled():
        return
    try:
        _client.rpc(
            "pg_mark_house_fee_collected",
            {"p_idempotency_key": idempotency_key, "p_tx_hash": tx_hash},
        ).execute()
    except Exception as e:  # noqa: BLE001
        print(
            f"[persistence] house fee collected update failed "
            f"({idempotency_key}): {e}"
        )


def mark_house_fee_failed(idempotency_key: str, error: str) -> None:
    if not is_enabled():
        return
    try:
        _client.rpc(
            "pg_mark_house_fee_failed",
            {"p_idempotency_key": idempotency_key, "p_error": error[:2000]},
        ).execute()
    except Exception as e:  # noqa: BLE001
        print(
            f"[persistence] house fee failed update failed "
            f"({idempotency_key}): {e}"
        )


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
    """Idempotent registration of a Hiscore identity row keyed on privy_id.

    Mirrors the canonical register pattern from the Hiscore main repo's
    Swallow Me route. Run with the service-role client (we already are —
    `_client` was created with SUPABASE_SERVICE_ROLE_KEY in init()), so
    RLS doesn't block the write.

    Why we don't use ON CONFLICT (privy_id):
      bm_players_privy_id_key is a PARTIAL unique index
      (`WHERE privy_id IS NOT NULL`). Postgres can't infer a partial
      unique index from `ON CONFLICT (privy_id)` alone — the matching
      WHERE predicate must be specified, but PostgREST's `on_conflict`
      query parameter doesn't accept it. The probe `INSERT ... ON
      CONFLICT (privy_id) DO UPDATE` returns 42P10 ("there is no unique
      or exclusion constraint matching the ON CONFLICT specification").
      So we do try-update-then-insert manually.

    Branch logic:
      1. UPDATE by privy_id. If a row exists, we're done (also covers
         re-login: just bumps last_active_at).
      2. Otherwise INSERT a new row. Two ways that INSERT can 23505:
         a) lower(evm_wallet_address) conflict — the trigger already
            backfilled a row for this wallet (the 3 existing SR users).
            Patch THAT row's privy_id instead.
         b) privy_id conflict — a concurrent register won the race;
            our second UPDATE-by-privy_id will succeed.
    """
    if not is_enabled():
        return None
    if not privy_id or not evm_wallet_address:
        print(f"[bm_players] register_player: missing privy_id={privy_id!r} or wallet={evm_wallet_address!r}")
        return None
    wallet = evm_wallet_address.lower()
    now = datetime.now(timezone.utc).isoformat()

    # Step 1: try UPDATE by privy_id.
    try:
        upd = (
            _client.table(_BM_PLAYERS)
            .update({"evm_wallet_address": wallet, "last_active_at": now})
            .eq("privy_id", privy_id)
            .execute()
        )
        if list(upd.data or []):
            return get_player_by_privy_id(privy_id)
    except Exception as e:  # noqa: BLE001
        # An UPDATE can still 23505 if our wallet collides with another
        # row's evm_wallet_address. That's a real merge conflict (split
        # rows for one human across games) — log and fall through; the
        # caller can still surface the SM-side data via /me.
        msg = str(e).lower()
        if "lower(evm_wallet_address)" in msg or "evm_wallet_address" in msg:
            print(f"[bm_players] register_player: wallet collision on UPDATE for {privy_id} / {wallet}: {e}")
            return get_player_by_privy_id(privy_id)
        print(f"[bm_players] register_player: UPDATE-by-privy_id failed for {privy_id}: {e}")
        # Continue to INSERT path — UPDATE might have failed for an
        # unrelated reason and INSERT may still succeed.

    # Step 2: no row matched privy_id, try INSERT.
    try:
        (
            _client.table(_BM_PLAYERS)
            .insert(
                {
                    "privy_id": privy_id,
                    "evm_wallet_address": wallet,
                    "last_active_at": now,
                }
            )
            .execute()
        )
        return get_player_by_privy_id(privy_id)
    except Exception as e:  # noqa: BLE001
        msg = str(e).lower()
        # 2a) Trigger-backfilled wallet row: patch its privy_id.
        if "lower(evm_wallet_address)" in msg or "bm_players_evm_wallet_address" in msg:
            try:
                (
                    _client.table(_BM_PLAYERS)
                    .update({"privy_id": privy_id, "last_active_at": now})
                    .eq("evm_wallet_address", wallet)
                    .execute()
                )
                return get_player_by_privy_id(privy_id)
            except Exception as patch_err:  # noqa: BLE001
                print(f"[bm_players] wallet-keyed patch failed for {wallet}: {patch_err}")
                return None
        # 2b) Privy_id race — another concurrent register beat us to the
        # insert. Re-run the UPDATE we tried in step 1.
        if "privy_id" in msg and ("duplicate key" in msg or "23505" in msg):
            try:
                (
                    _client.table(_BM_PLAYERS)
                    .update({"evm_wallet_address": wallet, "last_active_at": now})
                    .eq("privy_id", privy_id)
                    .execute()
                )
                return get_player_by_privy_id(privy_id)
            except Exception as race_err:  # noqa: BLE001
                print(f"[bm_players] privy_id race retry failed for {privy_id}: {race_err}")
                return None
        print(f"[bm_players] register_player INSERT failed for {privy_id} / {wallet}: {e}")
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

    Usernames are unique across ALL games via the bm_players_username_unique
    index on LOWER(username), so "Alice" and "alice" collide. We report
    a clear "taken" error rather than letting a 23505 surface raw.

    The existing 331 rows in bm_players have username == display_name
    (Swallow Me / Holy Liquid keep both in sync). We mirror that pattern
    so SR-set names render identically on hiscore.me regardless of which
    column the unified leaderboard reads.

    Returns the updated row on success, or (None, "<reason>") on
    validation/conflict failure.
    """
    if not is_enabled():
        return None, "registry disabled"
    if not privy_id:
        return None, "missing privy_id"
    name = (username or "").strip()
    # Server-side input policing. Length window matches what the existing
    # 331 rows fit into for typical traffic; the DB has no CHECK so any
    # cap here is a UX choice, not a DB safety net.
    if len(name) < 3 or len(name) > 32:
        return None, "username must be 3-32 characters"
    # ASCII-only — Python's isalnum() is Unicode-aware and would let
    # confusables through ("admin" vs Cyrillic "аdmin"). Cross-game
    # uniqueness compares raw bytes (LOWER(username)), so we lock the
    # alphabet here too. Allowed: A-Z a-z 0-9 _ - . All existing 331
    # usernames pass this regex (verified against prod data).
    if not all((c.isascii() and c.isalnum()) or c in "_-" for c in name):
        return None, "username can only contain letters, numbers, _ and -"
    try:
        res = (
            _client.table(_BM_PLAYERS)
            .update(
                {
                    "username": name,
                    "display_name": name,
                    "last_active_at": datetime.now(timezone.utc).isoformat(),
                }
            )
            .eq("privy_id", privy_id)
            .execute()
        )
        rows = list(res.data or [])
        if not rows:
            return None, "player not registered yet"
        return rows[0], None
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        lo = msg.lower()
        if (
            "duplicate key" in lo
            or "bm_players_username" in lo
            or ("username" in lo and "unique" in lo)
        ):
            return None, "username already taken"
        print(f"[bm_players] set_username failed for {privy_id}: {e}")
        return None, "could not set username"
