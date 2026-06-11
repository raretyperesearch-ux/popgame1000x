"""
/trade/* endpoints — Avantis SDK calls scoped per Privy user.

Multi-user mode (default in prod): every /trade/* request requires a
valid Privy access token. The auth.require_user dependency resolves
the JWT to the user's embedded-wallet id + address, and trades are
executed against THAT wallet via Privy's eth_sendTransaction RPC.

Legacy single-wallet mode (AUTH_DISABLE=1 or no Privy env): the env
PRIVATE_KEY signs every trade and the existing
TraderClient.sign_and_get_receipt path is used. Only safe for local dev.

Endpoints:
  POST /trade/open         — open a ZFP long on ETH/USD
  POST /trade/close        — close the open trade (player tapped 'stop')
  POST /trade/force-close  — close with was_liquidated=True (figure hit water)
  GET  /trade/active       — get the currently open trade or null

SDK call sites match canonical examples at https://sdk.avantisfi.com/trade.html.
"""

import asyncio
import os
from collections import deque
from datetime import datetime, timezone
from time import monotonic, perf_counter
from typing import Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import JSONResponse

from avantis_trader_sdk import TraderClient
from avantis_trader_sdk.types import (
    MarginUpdateType,
    PriceSourcing,
    TradeInput,
    TradeInputOrderType,
)

import auth
from auth import AuthedUser, require_user
import persistence
from privy_send import send_via_privy
from routes import price as price_module
from usdc_approval import (
    build_usdc_approval_tx,
    build_usdc_transfer_tx,
    get_avantis_trading_address,
    get_eth_balance_wei,
    MIN_GAS_ETH_WEI,
    USDC_BASE_ADDRESS,
    USDC_DECIMALS,
)
from models import (
    OpenTradeRequest,
    OpenTradeResponse,
    AddMarginRequest,
    AddMarginResponse,
    CloseTradeResponse,
    ActiveTrade,
    ActiveTradeResponse,
    TradeStatusResponse,
    calculate_house_fee,
)

router = APIRouter()


# Per-wallet sliding-window rate limit on /trade/open. The Avantis open
# itself takes 5-7s on-chain so physical throughput is already capped,
# but pre-tx auth + Privy signing burn resources fast under spam. Keyed
# on the lowercased wallet address rather than IP — abuse surface is
# users sharing a single wallet, not many wallets behind one NAT.
_OPEN_RATE_WINDOW_S = 60.0
_OPEN_RATE_MAX = int(os.getenv("RATE_LIMIT_OPENS_PER_MIN", "10"))
_open_rate_history: dict[str, deque[float]] = {}


def _check_open_rate_limit(address: str) -> None:
    now = monotonic()
    cutoff = now - _OPEN_RATE_WINDOW_S
    history = _open_rate_history.setdefault(address.lower(), deque())
    while history and history[0] < cutoff:
        history.popleft()
    if len(history) >= _OPEN_RATE_MAX:
        retry_in = max(1, int(_OPEN_RATE_WINDOW_S - (now - history[0])))
        raise HTTPException(
            429,
            f"Too many opens. Limit is {_OPEN_RATE_MAX} per minute — "
            f"retry in {retry_in}s.",
        )
    history.append(now)

_PROVIDER_URL = os.getenv("BASE_RPC_URL", "https://mainnet.base.org")
_PRIVATE_KEY = os.getenv("PRIVATE_KEY")
_TREASURY_ADDRESS = os.getenv("TREASURY_ADDRESS")
_PAIR = "ETH/USD"
_USDC_APPROVAL_AMOUNT = 1000.0
_RECEIPT_POLL_INTERVAL = 1.0
_RECEIPT_POLL_MAX_TRIES = 20  # ~20 s; Railway's request timeout is 60s, must
                              # leave headroom for approval + open + this poll
_TRADE_OPEN_MODE = os.getenv("TRADE_OPEN_MODE", "optimistic").strip().lower()
_MIN_TRADE_NOTIONAL_USD = float(
    os.getenv("AVANTIS_MIN_POSITION_USD")
    or os.getenv("MIN_TRADE_NOTIONAL_USD")
    or "125"
)
_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
_SETTLEMENT_LOG_POLL_TRIES = 10
_SETTLEMENT_LOG_POLL_INTERVAL = 1.0

_trader_client: Optional[TraderClient] = None
_eth_pair_index: Optional[int] = None
_trader_address: Optional[str] = None  # legacy env wallet (single-wallet fallback only)
_open_sessions: dict[str, dict] = {}


class _OpenTradeTimer:
    def __init__(self, wallet_address: str):
        self.wallet_address = wallet_address
        self.started = perf_counter()
        self.previous = self.started

    def mark(self, step: str, **fields) -> None:
        now = perf_counter()
        extra = " ".join(f"{k}={v}" for k, v in fields.items() if v is not None)
        suffix = f" {extra}" if extra else ""
        print(
            f"[trade/open] {step} wallet={self.wallet_address} "
            f"+{now - self.previous:.3f}s total={now - self.started:.3f}s{suffix}"
        )
        self.previous = now


class _CloseTradeTimer:
    def __init__(self, wallet_address: str, was_liquidated: bool):
        self.wallet_address = wallet_address
        self.was_liquidated = was_liquidated
        self.started = perf_counter()
        self.previous = self.started

    def mark(self, step: str, **fields) -> None:
        now = perf_counter()
        extra = " ".join(f"{k}={v}" for k, v in fields.items() if v is not None)
        suffix = f" {extra}" if extra else ""
        print(
            f"[trade/close] {step} wallet={self.wallet_address} "
            f"liquidated={self.was_liquidated} "
            f"+{now - self.previous:.3f}s total={now - self.started:.3f}s{suffix}"
        )
        self.previous = now



def _min_position_detail(collateral: float, leverage: int) -> dict:
    current_notional = round(collateral * leverage, 4)
    suggested_min_wager = round(
        ((_MIN_TRADE_NOTIONAL_USD / max(leverage, 1)) / 0.975) + 0.005,
        2,
    )
    suggested_min_leverage = int(((_MIN_TRADE_NOTIONAL_USD / max(collateral, 1e-9)) + 0.9999))
    return {
        "error": "below_min_position",
        "message": "Position is below Avantis minimum size.",
        "min_notional_usd": _MIN_TRADE_NOTIONAL_USD,
        "current_notional_usd": current_notional,
        "suggested_min_wager": suggested_min_wager,
        "suggested_min_leverage": suggested_min_leverage,
    }


def _log_below_min_position(detail: dict) -> None:
    print(
        "[trade/open] rejected below min position "
        f"current_notional={detail['current_notional_usd']} "
        f"min={detail['min_notional_usd']} "
        f"suggested_min_wager={detail['suggested_min_wager']} "
        f"suggested_min_leverage={detail['suggested_min_leverage']}"
    )


def _below_min_position_response(collateral: float, leverage: int) -> JSONResponse:
    detail = _min_position_detail(collateral, leverage)
    _log_below_min_position(detail)
    return JSONResponse(status_code=400, content=detail)


def _reject_below_min_position(collateral: float, leverage: int) -> None:
    detail = _min_position_detail(collateral, leverage)
    _log_below_min_position(detail)
    raise HTTPException(status_code=400, detail=detail)


def _is_below_min_position_error(exc: Exception) -> bool:
    msg = str(exc).upper()
    return "BELOW_MIN_POS" in msg or "BELOW_MIN_POSITION" in msg


def _house_fee_idempotency_key(
    user: AuthedUser, trade_index: int, open_tx_hash: str
) -> str:
    # open_tx_hash is globally unique and stable for the Avantis open. Include
    # wallet/trade_index for readable Supabase rows and human reconciliation.
    return f"house-fee:{user.address.lower()}:{trade_index}:{open_tx_hash.lower()}"


def _fallback_session_id(user: AuthedUser, opened_at: datetime) -> str:
    return f"privy:{user.address.lower()}:{int(opened_at.timestamp() * 1000)}"


def _mark_house_fee_failed_safe(idempotency_key: Optional[str], error: str) -> None:
    if not idempotency_key:
        return
    try:
        persistence.mark_house_fee_failed(idempotency_key, error)
    except Exception as mark_err:  # noqa: BLE001
        print(
            f"[trade/open] async fee failed mark skipped "
            f"idempotency_key={idempotency_key} error={mark_err}"
        )


async def _collect_queued_house_fee(
    *,
    idempotency_key: str,
    user: AuthedUser,
    fee_usdc: float,
    treasury_address: str,
) -> None:
    claimed = persistence.claim_house_fee_event(idempotency_key)
    if not claimed:
        print(f"[trade/open] async fee skipped idempotency_key={idempotency_key}")
        return

    try:
        fee_tx = build_usdc_transfer_tx(treasury_address, fee_usdc)
        client = _require_trader()
        if _is_legacy_user(user):
            receipt = await client.sign_and_get_receipt(fee_tx)
            fee_hash = _tx_hash_str(receipt)
        else:
            fee_hash = await _send_user_tx(user, fee_tx)
        persistence.mark_house_fee_collected(idempotency_key, fee_hash)
        print(
            f"[trade/open] async fee collected idempotency_key={idempotency_key} "
            f"wallet={user.address} treasury={treasury_address} "
            f"fee_usdc={fee_usdc} tx_hash={fee_hash}"
        )
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        _mark_house_fee_failed_safe(idempotency_key, msg)
        print(
            f"[trade/open] async fee failed idempotency_key={idempotency_key} "
            f"wallet={user.address} fee_usdc={fee_usdc} error={msg}"
        )


def _session_response(session: dict) -> TradeStatusResponse:
    liq = session.get("liquidation_price")
    return TradeStatusResponse(
        status=session.get("status", "opening"),
        session_id=session["session_id"],
        tx_hash=session["tx_hash"],
        trade_index=session.get("trade_index"),
        entry_price=session.get("entry_price"),
        liq_price=liq,
        liquidation_price=liq,
        error=session.get("error"),
    )


def _session_from_persisted(row: dict) -> dict:
    return {
        "status": row.get("status", "opening"),
        "session_id": row["session_id"],
        "tx_hash": row.get("tx_hash") or row["session_id"],
        "wallet_address": (row.get("wallet_address") or "").lower(),
        "user": AuthedUser(
            did=row.get("did") or "recovered",
            wallet_id=row.get("wallet_id") or "",
            address=row.get("wallet_address") or "",
        ),
        "avantis_pair_index": row.get("pair_index"),
        "trade_index": row.get("trade_index"),
        "leverage": row.get("leverage"),
        "wager_usdc": float(row.get("wager_usdc") or 0),
        "house_fee_usdc": float(row.get("house_fee_usdc") or 0),
        "collateral_usdc": float(row.get("collateral_usdc") or 0),
        "treasury_address": row.get("treasury_address"),
        "is_long": row.get("is_long"),
        "entry_price": _float_or_none(row.get("entry_price")),
        "liquidation_price": _float_or_none(row.get("liquidation_price")),
        "opened_at": _iso_datetime(row.get("opened_at")),
        "error": row.get("error"),
        "house_fee_idempotency_key": row.get("house_fee_idempotency_key"),
    }


def _persisted_opening_session_for_wallet(wallet_address: str) -> Optional[dict]:
    row = persistence.opening_session_for_wallet(wallet_address)
    if not row:
        return None
    session = _session_from_persisted(row)
    if session.get("wallet_address") != wallet_address.lower():
        return None
    _open_sessions.setdefault(session["session_id"], session)
    return session


def _persisted_session_by_id(session_id: str, wallet_address: str) -> Optional[dict]:
    row = persistence.open_session_by_id(session_id)
    if not row:
        return None
    session = _session_from_persisted(row)
    if session.get("wallet_address") != wallet_address.lower():
        return None
    _open_sessions.setdefault(session_id, session)
    return session


def _find_opening_session_for_wallet(wallet_address: str) -> Optional[dict]:
    wallet = wallet_address.lower()
    for session in _open_sessions.values():
        if session.get("wallet_address") == wallet and session.get("status") == "opening":
            return session
    return _persisted_opening_session_for_wallet(wallet_address)


def _cancel_preflight_tasks(*tasks: Optional[asyncio.Task]) -> None:
    for task in tasks:
        if task is not None and not task.done():
            task.cancel()


def _record_open_and_queue_fee(
    *,
    user: AuthedUser,
    leverage: int,
    wager_usdc: float,
    house_fee: float,
    collateral: float,
    treasury_address: Optional[str],
    pair_index: int,
    trade,
    opened_at: datetime,
    tx_hash: str,
    background_tasks: Optional[BackgroundTasks] = None,
    idempotency_key: Optional[str] = None,
) -> tuple[bool, Optional[str]]:
    recorded = persistence.record_open(
        did=user.did,
        wallet_address=user.address,
        trade_index=trade.trade.trade_index,
        pair_index=pair_index,
        leverage=leverage,
        wager_usdc=wager_usdc,
        house_fee_usdc=house_fee,
        collateral_usdc=collateral,
        entry_price=float(trade.trade.open_price),
        liquidation_price=float(trade.liquidation_price),
        opened_at=opened_at,
        open_tx_hash=tx_hash,
    )
    if not recorded:
        print(
            f"[trade/open] session record failed wallet={user.address} "
            f"trade_index={trade.trade.trade_index} tx_hash={tx_hash}"
        )

    fee_idempotency_key: Optional[str] = None
    if house_fee > 0 and treasury_address:
        fee_idempotency_key = idempotency_key or _house_fee_idempotency_key(
            user, trade.trade.trade_index, tx_hash
        )
        fee_event = persistence.record_house_fee_pending(
            idempotency_key=fee_idempotency_key,
            did=user.did,
            wallet_address=user.address,
            wallet_id=user.wallet_id,
            trade_index=trade.trade.trade_index,
            session_id=tx_hash,
            collateral_usdc=collateral,
            fee_usdc=house_fee,
            treasury_address=treasury_address,
        )
        print(
            f"[trade/open] fee queued wallet={user.address} "
            f"idempotency_key={fee_idempotency_key} durable={bool(fee_event)}"
        )
        if fee_event and background_tasks:
            background_tasks.add_task(
                _collect_queued_house_fee,
                idempotency_key=fee_idempotency_key,
                user=user,
                fee_usdc=house_fee,
                treasury_address=treasury_address,
            )
        elif fee_event:
            asyncio.create_task(
                _collect_queued_house_fee(
                    idempotency_key=fee_idempotency_key,
                    user=user,
                    fee_usdc=house_fee,
                    treasury_address=treasury_address,
                )
            )
    return recorded, fee_idempotency_key


async def _finalize_optimistic_open(session_id: str) -> None:
    session = _open_sessions.get(session_id)
    if not session:
        persisted = persistence.open_session_by_id(session_id)
        if persisted:
            session = _session_from_persisted(persisted)
            _open_sessions[session_id] = session
    if not session:
        return
    fee_idempotency_key: Optional[str] = session.get("house_fee_idempotency_key")
    print(
        f"[trade/open] optimistic finalize start session_id={session_id} "
        f"fee_idempotency_key={fee_idempotency_key or '(pending)'}"
    )
    try:
        client = _require_trader()
        user = session["user"]
        treasury_address = session.get("treasury_address")
        if session.get("house_fee_usdc", 0) > 0 and not treasury_address:
            treasury_address = _valid_treasury_address()
            session["treasury_address"] = treasury_address
        trades = await _poll_for_trade(client, user.address, expect_present=True)
        if not trades:
            session["status"] = "failed_open"
            session["error"] = "open tx broadcast but trade did not appear after polling"
            persistence.update_open_session(
                session_id=session_id,
                status="failed_open",
                error=session["error"],
            )
            print(
                f"[trade/open] optimistic failed_open wallet={user.address} "
                f"session_id={session_id} tx_hash={session['tx_hash']}"
            )
            return
        trade = trades[0]
        opened_at = datetime.now(timezone.utc)
        _, fee_idempotency_key = _record_open_and_queue_fee(
            user=user,
            leverage=session["leverage"],
            wager_usdc=session["wager_usdc"],
            house_fee=session["house_fee_usdc"],
            collateral=session["collateral_usdc"],
            treasury_address=treasury_address,
            pair_index=session["avantis_pair_index"],
            trade=trade,
            opened_at=opened_at,
            tx_hash=session["tx_hash"],
            background_tasks=None,
            idempotency_key=fee_idempotency_key,
        )
        if fee_idempotency_key:
            session["house_fee_idempotency_key"] = fee_idempotency_key
        session.update(
            {
                "status": "live",
                "trade_index": trade.trade.trade_index,
                "entry_price": float(trade.trade.open_price),
                "liquidation_price": float(trade.liquidation_price),
                "opened_at": opened_at,
                "user": user,
            }
        )
        persistence.update_open_session(
            session_id=session_id,
            status="live",
            trade_index=int(trade.trade.trade_index),
            entry_price=float(trade.trade.open_price),
            liquidation_price=float(trade.liquidation_price),
            house_fee_idempotency_key=fee_idempotency_key,
        )
        print(
            f"[trade/open] trade visible/confirmed wallet={user.address} "
            f"session_id={session_id} trade_index={trade.trade.trade_index}"
        )
        print(
            f"[trade/open] optimistic live wallet={user.address} "
            f"session_id={session_id} trade_index={trade.trade.trade_index}"
        )
        print(
            f"[trade/open] finalize optimistic live session_id={session_id} "
            f"fee_idempotency_key={fee_idempotency_key or '(none)'}"
        )
    except Exception as e:  # noqa: BLE001
        session["status"] = "failed_open"
        session["error"] = str(e)
        msg = str(e)
        _mark_house_fee_failed_safe(fee_idempotency_key, msg)
        persistence.update_open_session(
            session_id=session_id,
            status="failed_open",
            error=msg,
        )
        print(f"[trade/open] optimistic finalize failed session_id={session_id}: {e}")

def _valid_treasury_address() -> Optional[str]:
    """Return a configured treasury address, ignoring local placeholders."""
    if not _TREASURY_ADDRESS:
        return None
    treasury = _TREASURY_ADDRESS.strip()
    if treasury.lower() in {"0x", "0x0", "0x0000000000000000000000000000000000000000"}:
        return None
    if not treasury.startswith("0x") or len(treasury) != 42:
        return None
    return treasury


async def init_trader():
    """Initialize a SHARED TraderClient used for read-only ops (pair info,
    get_trades, get_usdc_balance) AND legacy single-wallet signing when
    AUTH_DISABLE is set. On any failure, leaves _trader_client = None
    so /trade/* will return 503 via _require_trader until the env is
    fixed and init succeeds on a future restart."""
    global _trader_client, _eth_pair_index, _trader_address

    try:
        _trader_client = TraderClient(_PROVIDER_URL)

        # Set local signer only if a key is present — single-wallet
        # legacy fallback. In multi-user prod (no PRIVATE_KEY env),
        # mutating ops go via Privy and don't need a local signer.
        if _PRIVATE_KEY:
            _trader_client.set_local_signer(_PRIVATE_KEY)
            _trader_address = _trader_client.get_signer().get_ethereum_address()

        _eth_pair_index = await _trader_client.pairs_cache.get_pair_index(_PAIR)

        # Pair info validation is best-effort. The SDK's pairs_cache shape
        # has changed across versions — older versions return a dict keyed
        # by string pair name, newer ones may use a different shape.
        # get_pair_index already validated the pair exists, so the rest
        # is just sanity logging.
        try:
            pairs = await _trader_client.pairs_cache.get_pairs_info()
            eth = pairs.get(_PAIR) if hasattr(pairs, "get") else pairs[_PAIR]
            if eth and hasattr(eth, "values") and not eth.values.is_usdc_aligned:
                raise RuntimeError(f"{_PAIR} is not USDC-aligned")
            min_lev = getattr(getattr(eth, "leverages", None), "min_leverage", None)
            max_lev = getattr(getattr(eth, "leverages", None), "max_leverage", None)
            if min_lev is not None and min_lev > 75:
                raise RuntimeError(
                    f"{_PAIR} min leverage is {min_lev} — ZFP requires <=75"
                )
            if max_lev is not None and max_lev < 500:
                print(f"⚠️  {_PAIR} max leverage is {max_lev}, our cap is 500")
            lev_str = f"{min_lev}-{max_lev}" if min_lev is not None and max_lev is not None else "unknown"
            print(
                f"✓ Avantis ready: pair={_PAIR} index={_eth_pair_index} "
                f"trader={_trader_address or '(per-user via Privy)'} lev_range={lev_str}"
            )
        except (KeyError, AttributeError, TypeError) as e:
            print(
                f"⚠️  Could not validate pair info ({e}); continuing with "
                f"pair_index={_eth_pair_index}, trader={_trader_address or '(per-user via Privy)'}"
            )
    except Exception:
        _trader_client = None
        _eth_pair_index = None
        _trader_address = None
        raise


def _require_trader() -> TraderClient:
    if _trader_client is None:
        raise HTTPException(503, "trader client not initialized")
    return _trader_client


def _is_legacy_user(user: AuthedUser) -> bool:
    return user.wallet_id == "local-dev"


def _tx_hash_str(receipt) -> str:
    th = getattr(receipt, "transactionHash", None)
    if th is None:
        return ""
    if hasattr(th, "hex"):
        return th.hex()
    return str(th)


async def _poll_for_trade(client: TraderClient, address: str, *, expect_present: bool, retries: int = _RECEIPT_POLL_MAX_TRIES):
    """Poll get_trades until the trade list reaches the expected state.
    Returns the latest trades list."""
    trades = []
    for _ in range(retries):
        trades, _info = await client.trade.get_trades(address)
        if expect_present and trades:
            return trades
        if not expect_present and not trades:
            return trades
        await asyncio.sleep(_RECEIPT_POLL_INTERVAL)
    return trades


_PRIVY_SEND_TIMEOUT_S = 20.0


def _env_flag(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


def _sponsored_gas_enabled() -> bool:
    return _env_flag("PRIVY_SPONSOR_GAS_ON_BASE")


_SPONSORED_OPEN_GAS_LIMIT = int(os.getenv("PRIVY_SPONSORED_OPEN_GAS_LIMIT", "1200000"))
_SPONSORED_CLOSE_GAS_LIMIT = int(os.getenv("PRIVY_SPONSORED_CLOSE_GAS_LIMIT", "900000"))
_SPONSORED_MARGIN_GAS_LIMIT = int(os.getenv("PRIVY_SPONSORED_MARGIN_GAS_LIMIT", "900000"))


async def _build_user_trade_open_tx(
    client: TraderClient,
    trade_input: TradeInput,
    trade_input_order_type: TradeInputOrderType,
    *,
    slippage_percentage: int,
):
    if not _sponsored_gas_enabled():
        return await client.trade.build_trade_open_tx(
            trade_input,
            trade_input_order_type,
            slippage_percentage=slippage_percentage,
        )

    Trading = client.contracts.get("Trading")
    if (
        trade_input_order_type in {TradeInputOrderType.MARKET, TradeInputOrderType.MARKET_ZERO_FEE}
        and not trade_input.openPrice
    ):
        sourcing = await client.trade._resolve_price_sourcing(trade_input.pairIndex)
        if sourcing == PriceSourcing.PRO:
            lazer_feed_id = await client.pairs_cache.get_lazer_feed_id(trade_input.pairIndex)
            price_data = await client.feed_client.get_latest_lazer_price([lazer_feed_id])
            price_feed = next(
                (
                    f
                    for f in price_data.price_feeds
                    if f.price_feed_id == lazer_feed_id
                ),
                price_data.price_feeds[0],
            )
            trade_input.openPrice = int(price_feed.converted_price * 10**10)
        else:
            price_data = await client.feed_client.get_price_update_data(trade_input.pairIndex)
            trade_input.openPrice = int(price_data.core.price * 10**10)

    execution_fee_wei = 0
    if trade_input_order_type != TradeInputOrderType.MARKET_ZERO_FEE:
        execution_fee_wei = await client.trade.get_trade_execution_fee()

    return await Trading.functions.openTrade(
        trade_input.model_dump(),
        trade_input_order_type.value,
        slippage_percentage * 10**10,
    ).build_transaction(
        {
            "from": trade_input.trader,
            "value": execution_fee_wei,
            "chainId": client.chain_id,
            "nonce": await client.get_transaction_count(trade_input.trader),
            "gas": _SPONSORED_OPEN_GAS_LIMIT,
        }
    )


async def _build_user_trade_close_tx(
    client: TraderClient,
    *,
    pair_index: int,
    trade_index: int,
    collateral_to_close: float,
    trader: str,
):
    if not _sponsored_gas_enabled():
        return await client.trade.build_trade_close_tx(
            pair_index=pair_index,
            trade_index=trade_index,
            collateral_to_close=collateral_to_close,
            trader=trader,
        )

    Trading = client.contracts.get("Trading")
    return await Trading.functions.closeTradeMarket(
        pair_index,
        trade_index,
        int(collateral_to_close * 10**6),
    ).build_transaction(
        {
            "from": trader,
            "chainId": client.chain_id,
            "nonce": await client.get_transaction_count(trader),
            "value": 0,
            "gas": _SPONSORED_CLOSE_GAS_LIMIT,
        }
    )


async def _build_user_trade_margin_update_tx(
    client: TraderClient,
    *,
    pair_index: int,
    trade_index: int,
    margin_update_type: MarginUpdateType,
    collateral_change: float,
    trader: str,
):
    if not _sponsored_gas_enabled():
        return await client.trade.build_trade_margin_update_tx(
            pair_index=pair_index,
            trade_index=trade_index,
            margin_update_type=margin_update_type,
            collateral_change=collateral_change,
            trader=trader,
        )

    Trading = client.contracts.get("Trading")
    price_sourcing = await client.trade._resolve_price_sourcing(pair_index)
    price_data = await client.feed_client.get_price_update_data(pair_index)
    if price_sourcing == PriceSourcing.PRO:
        price_update_data = price_data.pro.price_update_data
    else:
        price_update_data = price_data.core.price_update_data

    return await Trading.functions.updateMargin(
        pair_index,
        trade_index,
        margin_update_type.value,
        int(collateral_change * 10**6),
        [price_update_data],
        price_sourcing.value,
    ).build_transaction(
        {
            "from": trader,
            "chainId": client.chain_id,
            "value": 0,
            "nonce": await client.get_transaction_count(trader),
            "gas": _SPONSORED_MARGIN_GAS_LIMIT,
        }
    )


async def _send_user_tx(user: AuthedUser, raw_tx) -> str:
    """Route an Avantis-built tx through Privy for user-scoped signing.

    Bounded with a hard timeout — Privy's RPC has been seen to hang
    indefinitely in some edge cases (delegation not propagated, signer
    quorum not ready, Privy backend slow). Without the bound, the
    request would sit past Railway's edge timeout and the browser sees
    the connection drop as a generic "Failed to fetch" with no
    actionable detail."""
    if auth._privy_client is None:
        raise HTTPException(503, "Privy client not initialized for user-scoped trades")
    try:
        return await asyncio.wait_for(
            send_via_privy(auth._privy_client, user.wallet_id, raw_tx),
            timeout=_PRIVY_SEND_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            504,
            "Privy signer didn't respond in 20s. Most common cause: the wallet "
            "hasn't been delegated yet — open the avatar menu and accept the "
            "delegation prompt, then retry.",
        )
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if (
            "No valid authorization keys or user signing keys available" in msg
            and auth._privy_client is not None
        ):
            expected = os.getenv("PRIVY_EXPECTED_SIGNER_ID", "")
            try:
                w = await auth._privy_client.wallets.get(wallet_id=user.wallet_id)
                owner_id = getattr(w, "owner_id", None)
                additional = [
                    getattr(s, "signer_id", None)
                    for s in (getattr(w, "additional_signers", None) or [])
                ]
                additional = [a for a in additional if a]
                delegated = bool(expected) and (
                    expected == owner_id or expected in additional
                )
                hint = (
                    " Delegation audit: "
                    f"expected_signer={expected or '(unset)'} "
                    f"owner_id={owner_id or '(none)'} "
                    f"additional_signers={additional} "
                    f"delegated_match={delegated}. "
                    "Call GET /wallet/delegation-audit and align "
                    "NEXT_PUBLIC_PRIVY_SIGNER_ID, PRIVY_EXPECTED_SIGNER_ID, "
                    "and PRIVY_KEY_QUORUM_ID to the same quorum ID."
                )
                msg = f"{msg}.{hint}"
            except Exception as diag_err:  # noqa: BLE001
                msg = (
                    f"{msg}. Delegation audit lookup failed: {diag_err}. "
                    "Call GET /wallet/delegation-audit."
                )
        # Privy errors carry useful messages (e.g. "insufficient funds for
        # gas") that the user can act on. Surface them verbatim under a
        # 502 so the frontend toast shows something specific.
        print(f"[privy/send] rejected wallet={user.address}: {msg}")
        raise HTTPException(502, f"Privy signer rejected the tx: {msg}")


async def _base_rpc(method: str, params: list) -> Optional[dict | str | list]:
    payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    try:
        async with httpx.AsyncClient(timeout=5.0) as ax:
            r = await ax.post(_PROVIDER_URL, json=payload)
            r.raise_for_status()
            body = r.json()
    except Exception as e:  # noqa: BLE001
        print(f"[trade/settlement] rpc failed method={method}: {e}")
        return None
    if body.get("error"):
        print(f"[trade/settlement] rpc error method={method}: {body['error']}")
        return None
    return body.get("result")


async def _tx_block_number(tx_hash: str) -> Optional[int]:
    result = await _base_rpc("eth_getTransactionReceipt", [tx_hash])
    if not isinstance(result, dict):
        return None
    block = result.get("blockNumber")
    if not isinstance(block, str) or not block.startswith("0x"):
        return None
    return int(block, 16)


async def _latest_base_block() -> Optional[int]:
    result = await _base_rpc("eth_blockNumber", [])
    if not isinstance(result, str) or not result.startswith("0x"):
        return None
    return int(result, 16)


def _address_topic(address: str) -> str:
    return "0x" + address.lower().replace("0x", "").rjust(64, "0")


async def _incoming_usdc_between_blocks(address: str, from_block: int, to_block: int) -> Optional[float]:
    if to_block < from_block:
        return 0.0
    result = await _base_rpc(
        "eth_getLogs",
        [
            {
                "address": USDC_BASE_ADDRESS,
                "fromBlock": hex(from_block),
                "toBlock": hex(to_block),
                "topics": [_TRANSFER_TOPIC, None, _address_topic(address)],
            }
        ],
    )
    if not isinstance(result, list):
        return None
    raw_total = 0
    for log in result:
        if not isinstance(log, dict):
            continue
        data = log.get("data")
        if isinstance(data, str) and data.startswith("0x"):
            raw_total += int(data, 16)
    return raw_total / (10**USDC_DECIMALS)


async def _poll_close_settlement_received(tx_hash: str, address: str) -> Optional[float]:
    """Return USDC transferred into the wallet after a close tx.

    Avantis settlement can arrive in a follow-up tx one or two blocks after
    the user's close tx. Transfer logs are narrower than wallet balance deltas:
    they ignore unrelated outgoing transfers and give us a block-bounded view
    of settlement receipts. None means RPC/receipt was unavailable, so caller
    should fall back to the older balance-poll path.
    """
    close_block: Optional[int] = None
    for attempt in range(_SETTLEMENT_LOG_POLL_TRIES):
        if close_block is None:
            close_block = await _tx_block_number(tx_hash)
        latest = await _latest_base_block() if close_block is not None else None
        if close_block is not None and latest is not None:
            received = await _incoming_usdc_between_blocks(address, close_block, latest)
            if received is None:
                return None
            if received > 0:
                return round(received, 6)
            if latest >= close_block + 3 and attempt >= 3:
                return 0.0
        if attempt < _SETTLEMENT_LOG_POLL_TRIES - 1:
            await asyncio.sleep(_SETTLEMENT_LOG_POLL_INTERVAL)
    if close_block is None:
        return None
    return 0.0


async def _poll_balance_after_close(
    client: TraderClient,
    address: str,
    balance_before: float,
    *,
    tries: int = 18,
    interval: float = 0.75,
) -> Optional[float]:
    for attempt in range(tries):
        balance_after = float(await client.get_usdc_balance(address))
        if balance_after != balance_before:
            return balance_after
        if attempt < tries - 1:
            await asyncio.sleep(interval)
    return None


@router.post("/open", response_model=OpenTradeResponse)
async def open_trade(
    body: OpenTradeRequest,
    background_tasks: BackgroundTasks,
    user: AuthedUser = Depends(require_user),
):
    timer = _OpenTradeTimer(user.address)
    timer.mark(
        "start",
        wager_usdc=body.wager_usdc,
        leverage=body.leverage,
        is_long=body.is_long,
    )
    _check_open_rate_limit(user.address)
    timer.mark("auth resolved", did=user.did)
    client = _require_trader()
    pair_index = _eth_pair_index
    if pair_index is None:
        raise HTTPException(503, "pair index not initialized")

    gas_task = None
    if not _is_legacy_user(user) and not _sponsored_gas_enabled():
        gas_task = asyncio.create_task(get_eth_balance_wei(user.address))
    existing_task = asyncio.create_task(client.trade.get_trades(user.address))
    usdc_task = asyncio.create_task(client.get_usdc_balance(user.address))
    allowance_task = asyncio.create_task(client.get_usdc_allowance_for_trading(user.address))

    existing, _ = await existing_task
    if existing:
        _cancel_preflight_tasks(gas_task, usdc_task, allowance_task)
        raise HTTPException(
            409,
            f"trade already open (index {existing[0].trade.trade_index}) — close first",
        )

    # Pre-flight: embedded wallet must have ETH on Base for gas. Without
    # it the Privy eth_sendTransaction below would fail with an opaque
    # Privy error after a long delay (often as a "Failed to fetch" if
    # the timeout exceeds Railway's 60s window). Direct JSON-RPC call
    # so we don't depend on the SDK's web3 attribute path. Skip for
    # legacy single-wallet — that signer pays its own gas and is a dev
    # concern, not user-facing.
    if gas_task is not None:
        try:
            eth_wei = await gas_task
        except Exception as e:  # noqa: BLE001
            print(f"[trade] gas pre-flight RPC failed, allowing through: {e}")
            eth_wei = MIN_GAS_ETH_WEI
        if eth_wei < MIN_GAS_ETH_WEI:
            _cancel_preflight_tasks(usdc_task, allowance_task)
            raise HTTPException(
                402,
                "Embedded wallet needs ETH on Base for gas. "
                "Open Fund -> ETH (gas) and add a small amount (~$0.50 worth) "
                "before trading.",
            )

    house_fee = calculate_house_fee(body.wager_usdc)
    collateral = round(body.wager_usdc - house_fee, 4)
    if collateral <= 0:
        raise HTTPException(400, "wager too small after house fee")
    if collateral * body.leverage < _MIN_TRADE_NOTIONAL_USD:
        _cancel_preflight_tasks(allowance_task)
        return _below_min_position_response(collateral, body.leverage)
    treasury_address = _valid_treasury_address() if house_fee > 0 else None
    if house_fee > 0 and not treasury_address:
        _cancel_preflight_tasks(usdc_task, allowance_task)
        raise HTTPException(
            503,
            "House fee treasury is not configured. Set TREASURY_ADDRESS before "
            "accepting real-money trades.",
        )

    usdc_balance = float(await usdc_task)
    timer.mark("balances checked", usdc_balance=f"{usdc_balance:.4f}")
    if usdc_balance + 1e-9 < body.wager_usdc:
        _cancel_preflight_tasks(allowance_task)
        raise HTTPException(
            402,
            f"Insufficient USDC. Need {body.wager_usdc:.2f} USDC for wager "
            f"including {house_fee:.4f} USDC house fee; wallet has "
            f"{usdc_balance:.4f} USDC.",
        )

    allowance = await allowance_task
    timer.mark(
        "allowance checked",
        allowance=f"{float(allowance):.4f}",
        collateral=collateral,
    )
    if allowance < collateral:
        # Approve via the user's wallet — same Privy relay path as the
        # trade itself. One-time per user (or until their allowance is
        # consumed). The SDK's build_*_approval_tx helper isn't public,
        # so for multi-user we construct the ERC-20 approve(spender,
        # amount) calldata manually; legacy single-wallet keeps the
        # SDK's mutating helper.
        if _is_legacy_user(user):
            await client.approve_usdc_for_trading(_USDC_APPROVAL_AMOUNT)
        else:
            spender = get_avantis_trading_address(client)
            approval_tx = build_usdc_approval_tx(spender, _USDC_APPROVAL_AMOUNT)
            _ = await _send_user_tx(user, approval_tx)
            # Wait for the approval to land before opening — otherwise
            # build_trade_open_tx would simulate against pre-approval
            # state and revert. Poll allowance instead of fixed sleep so
            # we don't burn time on fast networks or under-wait on slow.
            for _ in range(15):
                await asyncio.sleep(1.0)
                if (await client.get_usdc_allowance_for_trading(user.address)) >= collateral:
                    break
            else:
                raise HTTPException(
                    504,
                    "USDC approval tx broadcast but allowance didn't land in 15s",
                )
        allowance = await client.get_usdc_allowance_for_trading(user.address)
        timer.mark(
            "allowance checked",
            allowance=f"{float(allowance):.4f}",
            approved=True,
        )

    trade_input = TradeInput(
        trader=user.address,
        open_price=None,
        pair_index=pair_index,
        collateral_in_trade=collateral,
        is_long=body.is_long,
        leverage=body.leverage,
        index=0,
        tp=0,
        sl=0,
        timestamp=0,
    )
    try:
        open_tx = await _build_user_trade_open_tx(
            client,
            trade_input,
            TradeInputOrderType.MARKET_ZERO_FEE,
            slippage_percentage=1,
        )
    except Exception as e:  # noqa: BLE001
        if _is_below_min_position_error(e):
            return _below_min_position_response(collateral, body.leverage)
        print(f"[trade/open] Avantis tx build failed wallet={user.address}: {e}")
        raise
    timer.mark("Avantis tx built")

    try:
        if _is_legacy_user(user):
            receipt = await client.sign_and_get_receipt(open_tx)
            tx_hash = _tx_hash_str(receipt)
        else:
            tx_hash = await _send_user_tx(user, open_tx)
    except Exception as e:  # noqa: BLE001
        if _is_below_min_position_error(e):
            return _below_min_position_response(collateral, body.leverage)
        raise
    tx_hash = (tx_hash or "").strip()
    timer.mark("Avantis tx sent", tx_hash=tx_hash or "(empty)")

    opened_at = datetime.now(timezone.utc)
    session_id = tx_hash or _fallback_session_id(user, opened_at)
    if _TRADE_OPEN_MODE == "optimistic":
        _open_sessions[session_id] = {
            "status": "opening",
            "session_id": session_id,
            "tx_hash": tx_hash or session_id,
            "wallet_address": user.address.lower(),
            "user": user,
            "avantis_pair_index": pair_index,
            "leverage": body.leverage,
            "wager_usdc": body.wager_usdc,
            "house_fee_usdc": house_fee,
            "collateral_usdc": collateral,
            "treasury_address": treasury_address,
            "is_long": body.is_long,
            "opened_at": opened_at,
        }
        persistence.record_open_session_pending(
            session_id=session_id,
            did=user.did,
            wallet_address=user.address,
            wallet_id=user.wallet_id,
            tx_hash=tx_hash or session_id,
            pair_index=pair_index,
            leverage=body.leverage,
            wager_usdc=body.wager_usdc,
            house_fee_usdc=house_fee,
            collateral_usdc=collateral,
            treasury_address=treasury_address,
            is_long=body.is_long,
            opened_at=opened_at,
        )
        background_tasks.add_task(_finalize_optimistic_open, session_id)
        timer.mark("response returned", status="opening", session_id=session_id, tx_hash=tx_hash or "(fallback)")
        return OpenTradeResponse(
            status="opening",
            session_id=session_id,
            trade_index=None,
            avantis_pair_index=pair_index,
            leverage=body.leverage,
            wager_usdc=body.wager_usdc,
            house_fee_usdc=house_fee,
            collateral_usdc=collateral,
            entry_price=None,
            liquidation_price=None,
            opened_at=opened_at,
            tx_hash=tx_hash or session_id,
            is_long=body.is_long,
        )

    trades = await _poll_for_trade(client, user.address, expect_present=True)
    if not trades:
        raise HTTPException(
            500,
            f"open tx broadcast ({tx_hash}) but trade did not appear after polling",
        )
    new_trade = trades[0]
    timer.mark("trade visible/confirmed", trade_index=new_trade.trade.trade_index)
    opened_at = datetime.now(timezone.utc)

    recorded, _ = _record_open_and_queue_fee(
        user=user,
        leverage=body.leverage,
        wager_usdc=body.wager_usdc,
        house_fee=house_fee,
        collateral=collateral,
        treasury_address=treasury_address,
        pair_index=pair_index,
        trade=new_trade,
        opened_at=opened_at,
        tx_hash=tx_hash,
        background_tasks=background_tasks,
    )
    timer.mark(
        "session recorded" if recorded else "session record failed",
        trade_index=new_trade.trade.trade_index,
    )
    timer.mark("session recorded", trade_index=new_trade.trade.trade_index)

    response = OpenTradeResponse(
        status="live",
        session_id=session_id,
        trade_index=new_trade.trade.trade_index,
        avantis_pair_index=pair_index,
        leverage=body.leverage,
        wager_usdc=body.wager_usdc,
        house_fee_usdc=house_fee,
        collateral_usdc=collateral,
        entry_price=new_trade.trade.open_price,
        liquidation_price=new_trade.liquidation_price,
        opened_at=opened_at,
        tx_hash=tx_hash,
        is_long=body.is_long,
    )
    timer.mark("response returned", trade_index=response.trade_index)
    return response


@router.get("/session/{session_id}", response_model=TradeStatusResponse)
async def trade_session_status(
    session_id: str,
    user: AuthedUser = Depends(require_user),
):
    session = _open_sessions.get(session_id)
    if not session:
        session = _persisted_session_by_id(session_id, user.address)
        if session and session.get("status") == "opening":
            asyncio.create_task(_finalize_optimistic_open(session_id))
    if session:
        if session.get("wallet_address") != user.address.lower():
            raise HTTPException(404, "trade session not found")
        return _session_response(session)

    client = _require_trader()
    trades, _ = await client.trade.get_trades(user.address)
    if trades:
        trade = trades[0]
        return TradeStatusResponse(
            status="live",
            session_id=session_id,
            tx_hash=session_id,
            trade_index=trade.trade.trade_index,
            entry_price=float(trade.trade.open_price),
            liq_price=float(trade.liquidation_price),
            liquidation_price=float(trade.liquidation_price),
            error=None,
        )
    return TradeStatusResponse(
        status="failed_open",
        session_id=session_id,
        tx_hash=session_id,
        error="trade is not visible for this wallet",
    )


def _exit_price_from_pnl(
    entry_price: float,
    leverage: float,
    collateral: float,
    gross_pnl: float,
) -> Optional[float]:
    """Back-compute the effective on-chain exit price from realized
    gross PnL. Mathematically self-consistent with the SDK's win-fee
    accounting (we already invert that fee in net_pnl above), so the
    returned price matches what the contract actually filled at —
    typically within a few cents of the live mark for a same-block
    close. Returns None when leverage*collateral is zero (defensive)."""
    denom = leverage * collateral
    if denom <= 0 or entry_price <= 0:
        return None
    move = gross_pnl / denom
    return round(entry_price * (1.0 + move), 4)


def _is_invalid_close_amount_error(exc: Exception) -> bool:
    return "INV_AMOUNT" in str(exc)


def _collateral_to_close_for_trade(target, feed_price_at_close: Optional[float]) -> float:
    """Avantis rejects close amounts above the remaining collateral in
    badly losing trades. Prefer the SDK's remaining-collateral field when
    it is present; otherwise estimate the remaining collateral from the
    live mark so force-close near liquidation does not revert with
    INV_AMOUNT."""
    open_collateral = float(target.trade.open_collateral)
    current_collateral = _float_or_none(getattr(target.trade, "collateral_in_trade", None))
    if current_collateral is not None and current_collateral > 0:
        return round(current_collateral, 6)

    if feed_price_at_close is None:
        return round(open_collateral, 6)

    entry_price = float(target.trade.open_price)
    leverage = float(target.trade.leverage)
    is_long = bool(getattr(target.trade, "is_long", True))
    pnl_usdc, _ = _compute_pnl(
        entry_price=entry_price,
        current_price=float(feed_price_at_close),
        leverage=leverage,
        collateral=open_collateral,
        is_long=is_long,
    )
    if pnl_usdc >= 0:
        return round(open_collateral, 6)
    remaining = max(0.000001, open_collateral + pnl_usdc)
    return round(min(open_collateral, remaining), 6)


def _trade_current_collateral(t) -> float:
    current = _float_or_none(getattr(t.trade, "collateral_in_trade", None))
    if current is not None and current > 0:
        return current
    open_collateral = _float_or_none(getattr(t.trade, "open_collateral", None))
    return open_collateral or 0.0


def _trade_open_collateral(t, local_row: Optional[dict] = None) -> float:
    local_collateral = _float_or_none(local_row.get("collateral_usdc")) if local_row else None
    if local_collateral is not None and local_collateral > 0:
        return local_collateral
    open_collateral = _float_or_none(getattr(t.trade, "open_collateral", None))
    if open_collateral is not None and open_collateral > 0:
        return open_collateral
    return _trade_current_collateral(t)


def _raise_liquidation_settlement_pending(
    *,
    target,
    reason: str,
    timer: _CloseTradeTimer,
) -> None:
    timer.mark(
        "liquidation settlement pending",
        trade_index=target.trade.trade_index,
        reason=reason,
    )
    raise HTTPException(
        409,
        {
            "error": "liquidation_settlement_pending",
            "message": (
                "Liquidation settlement is not final yet. No local full-loss "
                "record was written; retry recovery or refresh after the chain settles."
            ),
            "trade_index": int(target.trade.trade_index),
            "reason": reason,
        },
    )


async def _close_active_trade(user: AuthedUser, was_liquidated: bool) -> CloseTradeResponse:
    timer = _CloseTradeTimer(user.address, was_liquidated)
    timer.mark("close start")
    timer.mark("auth resolved", did=user.did)
    opening = _find_opening_session_for_wallet(user.address)
    if opening:
        raise HTTPException(409, "Still opening trade — wait for Avantis confirmation before closing.")
    client = _require_trader()
    trades, _ = await client.trade.get_trades(user.address)
    if not trades:
        raise HTTPException(404, "no open trade")
    target = trades[0]
    local_open = persistence.active_open_for_wallet(user.address)
    if local_open and _int_or_none(local_open.get("trade_index")) != int(target.trade.trade_index):
        local_open = None
    timer.mark("current trade/session loaded", trade_index=target.trade.trade_index)

    balance_before = float(await client.get_usdc_balance(user.address))

    # Snapshot the price *before* broadcast — by the time the receipt
    # lands the feed will have ticked one or more times, and the player
    # cares about the price that triggered their close, not whatever the
    # mark is two seconds later. Used as a cross-check against the
    # back-computed price below.
    feed_price_at_close = price_module.get_latest_price()

    collateral_to_close = _collateral_to_close_for_trade(target, feed_price_at_close)
    try:
        close_tx = await _build_user_trade_close_tx(
            client,
            pair_index=target.trade.pair_index,
            trade_index=target.trade.trade_index,
            collateral_to_close=collateral_to_close,
            trader=user.address,
        )
    except Exception as exc:
        if was_liquidated and _is_invalid_close_amount_error(exc):
            _raise_liquidation_settlement_pending(
                target=target,
                reason="invalid-close-amount",
                timer=timer,
            )
        raise
    timer.mark("Avantis close tx built", trade_index=target.trade.trade_index)

    try:
        if _is_legacy_user(user):
            receipt = await client.sign_and_get_receipt(close_tx)
            tx_hash = _tx_hash_str(receipt)
        else:
            tx_hash = await _send_user_tx(user, close_tx)
    except Exception as exc:
        if was_liquidated:
            timer.mark("liquidation close tx send failed", error=str(exc)[:160])
            _raise_liquidation_settlement_pending(
                target=target,
                reason="close-send-failed",
                timer=timer,
            )
        raise
    timer.mark("close tx sent", tx_hash=tx_hash)

    settlement_received = None
    balance_after = await _poll_balance_after_close(client, user.address, balance_before)
    if balance_after is None:
        settlement_received = await _poll_close_settlement_received(tx_hash, user.address)
        if settlement_received is not None:
            balance_after = balance_before + settlement_received
        else:
            balance_after = balance_before

    timer.mark(
        "close confirmed/settled",
        balance_before=float(balance_before),
        balance_after=float(balance_after),
        settlement_received=settlement_received,
    )

    close_collateral = _trade_current_collateral(target)
    received = balance_after - balance_before
    net_pnl = round(received - close_collateral, 4)

    if net_pnl > 0:
        gross_pnl = round(net_pnl / 0.975, 4)
        avantis_win_fee = round(gross_pnl * 0.025, 4)
    else:
        gross_pnl = net_pnl
        avantis_win_fee = 0.0

    # Prefer the back-computed exit (matches realized PnL exactly).
    # Fall back to the live feed snapshot if the math degenerates
    # (zero collateral / leverage) or to 0.0 as a last resort so the
    # response_model doesn't reject the payload.
    entry_price = float(target.trade.open_price)
    leverage = float(target.trade.leverage)
    open_collateral = _trade_open_collateral(target, local_open)
    exit_price = _exit_price_from_pnl(entry_price, leverage, open_collateral, gross_pnl)
    if exit_price is None and feed_price_at_close is not None:
        exit_price = float(feed_price_at_close)
    if exit_price is None:
        exit_price = 0.0

    closed_at = datetime.now(timezone.utc)

    persistence.record_close(
        wallet_address=user.address,
        trade_index=target.trade.trade_index,
        exit_price=float(exit_price),
        gross_pnl_usdc=float(gross_pnl),
        avantis_win_fee_usdc=float(avantis_win_fee),
        net_pnl_usdc=float(net_pnl),
        was_liquidated=was_liquidated,
        closed_at=closed_at,
        close_tx_hash=tx_hash,
    )
    timer.mark("persistence recorded", trade_index=target.trade.trade_index)

    response = CloseTradeResponse(
        trade_index=target.trade.trade_index,
        entry_price=entry_price,
        exit_price=exit_price,
        gross_pnl_usdc=gross_pnl,
        avantis_win_fee_usdc=avantis_win_fee,
        net_pnl_usdc=net_pnl,
        was_liquidated=was_liquidated,
        closed_at=closed_at,
        tx_hash=tx_hash,
    )
    timer.mark("response returned", trade_index=response.trade_index)
    return response


@router.post("/close", response_model=CloseTradeResponse)
async def close_trade(user: AuthedUser = Depends(require_user)):
    return await _close_active_trade(user, was_liquidated=False)


@router.post("/force-close", response_model=CloseTradeResponse)
async def force_close_trade(user: AuthedUser = Depends(require_user)):
    return await _close_active_trade(user, was_liquidated=True)


@router.post("/add-margin", response_model=AddMarginResponse)
async def add_trade_margin(
    body: AddMarginRequest,
    user: AuthedUser = Depends(require_user),
):
    client = _require_trader()
    opening = _find_opening_session_for_wallet(user.address)
    if opening:
        raise HTTPException(409, "Still opening trade — wait for Avantis confirmation before adding fuel.")

    amount = round(float(body.amount_usdc), 6)
    if amount <= 0:
        raise HTTPException(400, "amount_usdc must be positive")

    gas_task = None
    if not _is_legacy_user(user) and not _sponsored_gas_enabled():
        gas_task = asyncio.create_task(get_eth_balance_wei(user.address))
    trades_task = asyncio.create_task(client.trade.get_trades(user.address))
    balance_task = asyncio.create_task(client.get_usdc_balance(user.address))
    allowance_task = asyncio.create_task(client.get_usdc_allowance_for_trading(user.address))

    trades, _ = await trades_task
    if not trades:
        _cancel_preflight_tasks(gas_task, balance_task, allowance_task)
        raise HTTPException(404, "no open trade")
    target = trades[0]

    if gas_task is not None:
        try:
            eth_wei = await gas_task
        except Exception as e:  # noqa: BLE001
            print(f"[trade/add-margin] gas pre-flight RPC failed, allowing through: {e}")
            eth_wei = MIN_GAS_ETH_WEI
        if eth_wei < MIN_GAS_ETH_WEI:
            _cancel_preflight_tasks(balance_task, allowance_task)
            raise HTTPException(
                402,
                "Embedded wallet needs ETH on Base for gas. "
                "Open Fund -> ETH (gas) and add a small amount before adding fuel.",
            )

    usdc_balance = float(await balance_task)
    if usdc_balance + 1e-9 < amount:
        _cancel_preflight_tasks(allowance_task)
        raise HTTPException(
            402,
            f"Insufficient USDC. Need {amount:.2f} USDC to add fuel; wallet has {usdc_balance:.4f} USDC.",
        )

    allowance = float(await allowance_task)
    if allowance + 1e-9 < amount:
        if _is_legacy_user(user):
            await client.approve_usdc_for_trading(_USDC_APPROVAL_AMOUNT)
        else:
            spender = get_avantis_trading_address(client)
            approval_tx = build_usdc_approval_tx(spender, _USDC_APPROVAL_AMOUNT)
            _ = await _send_user_tx(user, approval_tx)
            for _ in range(15):
                await asyncio.sleep(1.0)
                if float(await client.get_usdc_allowance_for_trading(user.address)) + 1e-9 >= amount:
                    break
            else:
                raise HTTPException(
                    504,
                    "USDC approval tx broadcast but allowance didn't land in 15s",
                )

    before_collateral = float(
        getattr(target.trade, "collateral_in_trade", None)
        or getattr(target.trade, "open_collateral", 0)
        or 0
    )
    margin_tx = await _build_user_trade_margin_update_tx(
        client,
        pair_index=target.trade.pair_index,
        trade_index=target.trade.trade_index,
        margin_update_type=MarginUpdateType.DEPOSIT,
        collateral_change=amount,
        trader=user.address,
    )

    if _is_legacy_user(user):
        receipt = await client.sign_and_get_receipt(margin_tx)
        tx_hash = _tx_hash_str(receipt)
    else:
        tx_hash = await _send_user_tx(user, margin_tx)

    updated = target
    poll_error = None
    for attempt in range(12):
        try:
            latest, _ = await client.trade.get_trades(user.address)
        except Exception as exc:  # noqa: BLE001
            poll_error = exc
            print(
                f"[trade/add-margin] post-tx poll failed "
                f"wallet={user.address} trade_index={target.trade.trade_index} "
                f"attempt={attempt + 1}/12 tx_hash={tx_hash}: {str(exc)[:220]}"
            )
            if attempt < 11:
                await asyncio.sleep(1.0)
                continue
            break
        match = next(
            (
                t for t in latest
                if int(t.trade.trade_index) == int(target.trade.trade_index)
                and int(t.trade.pair_index) == int(target.trade.pair_index)
            ),
            None,
        )
        if match is not None:
            updated = match
            current_collateral = float(
                getattr(match.trade, "collateral_in_trade", None)
                or getattr(match.trade, "open_collateral", 0)
                or 0
            )
            if current_collateral >= before_collateral + amount - 0.0001:
                break
        if attempt < 11:
            await asyncio.sleep(1.0)

    collateral = float(
        getattr(updated.trade, "collateral_in_trade", None)
        or getattr(updated.trade, "open_collateral", 0)
        or 0
    )
    if poll_error is not None and collateral < before_collateral + amount - 0.0001:
        print(
            f"[trade/add-margin] returning last-known collateral after poll errors "
            f"wallet={user.address} trade_index={target.trade.trade_index} "
            f"tx_hash={tx_hash} before={before_collateral} amount={amount} "
            f"collateral={collateral}"
        )
    if collateral > before_collateral:
        persistence.update_current_collateral(
            wallet_address=user.address,
            trade_index=int(target.trade.trade_index),
            current_collateral_usdc=round(collateral, 6),
        )
    return AddMarginResponse(
        trade_index=int(target.trade.trade_index),
        avantis_pair_index=int(target.trade.pair_index),
        amount_usdc=amount,
        collateral_usdc=round(collateral, 6),
        liquidation_price=float(getattr(updated, "liquidation_price", 0) or 0),
        tx_hash=tx_hash,
        updated_at=datetime.now(timezone.utc),
    )


def _opened_at_from_trade(t) -> datetime:
    """Pull the on-chain open timestamp off an SDK trade, with graceful
    fallback. Avantis exposes the seconds-since-epoch on
    `t.trade.timestamp` in current SDK versions; older shapes used
    `open_timestamp`. If neither is present (or zero — the SDK uses 0
    as a sentinel for "set by contract on submit"), fall back to now()
    so the field is at least monotonically increasing for the client."""
    for attr in ("timestamp", "open_timestamp", "block_timestamp"):
        ts = getattr(t.trade, attr, None)
        if isinstance(ts, (int, float)) and ts > 0:
            try:
                return datetime.fromtimestamp(int(ts), tz=timezone.utc)
            except (OverflowError, OSError, ValueError):
                continue
    return datetime.now(timezone.utc)


def _compute_pnl(
    entry_price: float,
    current_price: float,
    leverage: float,
    collateral: float,
    is_long: bool = True,
    notional_usd: Optional[float] = None,
) -> tuple[float, float]:
    """Mark-to-market PnL for an Avantis perp. Returns (pnl_usdc, pnl_pct).
    pnl_pct is expressed as the fraction of current collateral, so -1.0 = full
    liquidation, +0.5 = +50% on the current margin. Slippage and the 2.5%
    Avantis win fee are not modeled here — this is the unrealized number."""
    if entry_price <= 0 or collateral <= 0:
        return 0.0, 0.0
    move = (current_price - entry_price) / entry_price
    if not is_long:
        move = -move
    notional = notional_usd if notional_usd is not None and notional_usd > 0 else collateral * leverage
    pnl_usdc = move * notional
    pnl_pct = pnl_usdc / collateral
    return round(pnl_usdc, 4), round(pnl_pct, 6)


def _float_or_none(value) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _int_or_none(value) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _recover_missing_local_open(user: AuthedUser, t) -> Optional[dict]:
    """Best-effort local row recovery when Avantis still has an open trade."""
    entry = float(t.trade.open_price)
    collateral = _trade_current_collateral(t)
    wager = round(collateral / 0.975, 4)
    opened_at = _opened_at_from_trade(t)
    synthetic_tx = (
        f"recovered:{user.address.lower()}:"
        f"{int(t.trade.trade_index)}:{int(opened_at.timestamp())}"
    )
    recorded = persistence.record_open(
        did=user.did,
        wallet_address=user.address,
        trade_index=int(t.trade.trade_index),
        pair_index=int(t.trade.pair_index),
        leverage=int(float(t.trade.leverage)),
        wager_usdc=wager,
        house_fee_usdc=round(wager * 0.025, 4),
        collateral_usdc=collateral,
        entry_price=entry,
        liquidation_price=float(t.liquidation_price),
        opened_at=opened_at,
        open_tx_hash=synthetic_tx,
    )
    if recorded:
        print(
            f"[trade/active] recovered local open row wallet={user.address} "
            f"trade_index={t.trade.trade_index} open_tx_hash={synthetic_tx}"
        )
        return persistence.active_open_for_wallet(user.address)
    return None


def _active_response_from_trade(user: AuthedUser, t, local_row: Optional[dict]) -> ActiveTradeResponse:
    entry = float(t.trade.open_price)
    leverage = float(t.trade.leverage)
    collateral = _trade_current_collateral(t)
    open_collateral = _trade_open_collateral(t, local_row)
    notional_usd = round(open_collateral * leverage, 6)
    latest = price_module.get_latest_price()
    current = float(latest) if latest is not None else entry
    is_long = bool(getattr(t.trade, "is_long", True))
    pnl_usdc, pnl_pct = _compute_pnl(
        entry,
        current,
        leverage,
        collateral,
        is_long=is_long,
        notional_usd=notional_usd,
    )
    opened_at = _opened_at_from_trade(t)
    open_tx_hash = local_row.get("open_tx_hash") if local_row else None
    session_id = open_tx_hash
    live_wager = round(collateral / 0.975, 4)
    local_wager = _float_or_none(local_row.get("wager_usdc")) if local_row else None
    wager = max(local_wager or 0.0, live_wager)
    house_fee = _float_or_none(local_row.get("house_fee_usdc")) if local_row else None
    return ActiveTradeResponse(
        exists=True,
        status="live",
        wallet=user.address,
        session_id=session_id,
        open_tx_hash=open_tx_hash,
        tx_hash=open_tx_hash,
        trade_index=int(t.trade.trade_index),
        avantis_pair_index=int(t.trade.pair_index),
        leverage=int(leverage),
        wager_usdc=wager,
        collateral_usdc=collateral,
        open_collateral_usdc=round(open_collateral, 6),
        notional_usd=notional_usd,
        house_fee_usdc=house_fee,
        entry_price=entry,
        current_price=current,
        pnl_usdc=pnl_usdc,
        pnl_pct=pnl_pct,
        liq_price=float(t.liquidation_price),
        liquidation_price=float(t.liquidation_price),
        opened_at=_iso_datetime(local_row.get("opened_at")) if local_row else opened_at,
        is_long=is_long,
        error=None,
    )


def _iso_datetime(value) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            pass
    return datetime.now(timezone.utc)


@router.get("/active", response_model=ActiveTradeResponse)
async def get_active_trade(user: AuthedUser = Depends(require_user)):
    client = _require_trader()
    local_open = persistence.active_open_for_wallet(user.address)
    opening = _find_opening_session_for_wallet(user.address)

    trades, _ = await client.trade.get_trades(user.address)
    if trades:
        t = trades[0]
        local_trade_index = _int_or_none(local_open.get("trade_index")) if local_open else None
        if local_open and local_trade_index != int(t.trade.trade_index):
            persistence.mark_stale_open_reconciled(
                wallet_address=user.address,
                trade_index=local_trade_index or -1,
                reason="replaced-by-avantis-active",
                finalize_as_liquidation=True,
            )
            print(
                f"[trade/active] stale local session reconciled wallet={user.address} "
                f"trade_index={local_open.get('trade_index')} active_trade_index={t.trade.trade_index}"
            )
            local_open = None
        if local_open:
            print(
                f"[trade/active] active local session found wallet={user.address} "
                f"trade_index={local_open.get('trade_index')}"
            )
        else:
            print(
                f"[trade/active] active Avantis trade found wallet={user.address} "
                f"trade_index={t.trade.trade_index} local_missing=true"
            )
            local_open = _recover_missing_local_open(user, t)
        if opening and opening.get("status") == "opening":
            session_id = opening.get("session_id")
            if session_id:
                opening.update(
                    {
                        "status": "live",
                        "trade_index": t.trade.trade_index,
                        "entry_price": float(t.trade.open_price),
                        "liquidation_price": float(t.liquidation_price),
                    }
                )
                persistence.update_open_session(
                    session_id=session_id,
                    status="live",
                    trade_index=int(t.trade.trade_index),
                    entry_price=float(t.trade.open_price),
                    liquidation_price=float(t.liquidation_price),
                )
                print(
                    f"[trade/active] opening session promoted to live wallet={user.address} "
                    f"session_id={session_id} trade_index={t.trade.trade_index}"
                )
        return _active_response_from_trade(user, t, local_open)

    if opening:
        print(f"[trade/active] active local session found wallet={user.address} session_id={opening['session_id']}")
        return ActiveTradeResponse(
            exists=True,
            status=opening.get("status", "opening"),
            wallet=user.address,
            session_id=opening.get("session_id"),
            open_tx_hash=opening.get("tx_hash"),
            tx_hash=opening.get("tx_hash"),
            trade_index=opening.get("trade_index"),
            avantis_pair_index=opening.get("avantis_pair_index"),
            leverage=opening.get("leverage"),
            wager_usdc=opening.get("wager_usdc"),
            collateral_usdc=opening.get("collateral_usdc"),
            open_collateral_usdc=opening.get("collateral_usdc"),
            notional_usd=round(
                float(opening.get("collateral_usdc") or 0) * float(opening.get("leverage") or 0),
                6,
            ),
            house_fee_usdc=opening.get("house_fee_usdc"),
            entry_price=opening.get("entry_price"),
            current_price=_float_or_none(price_module.get_latest_price()),
            liq_price=opening.get("liquidation_price"),
            liquidation_price=opening.get("liquidation_price"),
            opened_at=opening.get("opened_at"),
            is_long=opening.get("is_long"),
            error=opening.get("error"),
        )

    if local_open:
        trade_index = _int_or_none(local_open.get("trade_index"))
        if trade_index is not None:
            persistence.mark_stale_open_reconciled(
                wallet_address=user.address,
                trade_index=trade_index,
                reason="avantis-empty",
                finalize_as_liquidation=True,
            )
        print(
            f"[trade/active] stale local session reconciled wallet={user.address} "
            f"trade_index={local_open.get('trade_index')}"
        )
    else:
        print(f"[trade/active] no active trade wallet={user.address}")

    return ActiveTradeResponse(exists=False)
