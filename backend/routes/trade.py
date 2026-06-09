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

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import JSONResponse

from avantis_trader_sdk import TraderClient
from avantis_trader_sdk.types import TradeInput, TradeInputOrderType

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
)
from models import (
    OpenTradeRequest,
    OpenTradeResponse,
    CloseTradeResponse,
    ActiveTrade,
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
        persistence.mark_house_fee_failed(idempotency_key, msg)
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


def _find_opening_session_for_wallet(wallet_address: str) -> Optional[dict]:
    wallet = wallet_address.lower()
    for session in _open_sessions.values():
        if session.get("wallet_address") == wallet and session.get("status") == "opening":
            return session
    return None


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
        return
    fee_idempotency_key: Optional[str] = session.get("house_fee_idempotency_key")
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
        if fee_idempotency_key:
            try:
                persistence.mark_house_fee_failed(fee_idempotency_key, msg)
            except Exception as mark_err:  # noqa: BLE001
                print(
                    f"[trade/open] async fee failed mark skipped "
                    f"idempotency_key={fee_idempotency_key} error={mark_err}"
                )
        print(f"[trade/open] optimistic finalize failed session_id={session_id}: {e}")

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
        persistence.mark_house_fee_failed(idempotency_key, msg)
        print(
            f"[trade/open] async fee failed idempotency_key={idempotency_key} "
            f"wallet={user.address} fee_usdc={fee_usdc} error={msg}"
        )

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
        raise HTTPException(502, f"Privy signer rejected the tx: {msg}")


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
    if not _is_legacy_user(user):
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
        open_tx = await client.trade.build_trade_open_tx(
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
    timer.mark("Avantis tx sent", tx_hash=tx_hash)

    opened_at = datetime.now(timezone.utc)
    session_id = tx_hash
    if _TRADE_OPEN_MODE == "optimistic":
        _open_sessions[session_id] = {
            "status": "opening",
            "session_id": session_id,
            "tx_hash": tx_hash,
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
        background_tasks.add_task(_finalize_optimistic_open, session_id)
        timer.mark("response returned", status="opening", tx_hash=tx_hash)
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
            tx_hash=tx_hash,
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


async def _close_active_trade(user: AuthedUser, was_liquidated: bool) -> CloseTradeResponse:
    opening = _find_opening_session_for_wallet(user.address)
    if opening:
        raise HTTPException(409, "Still opening trade — wait for Avantis confirmation before closing.")
    client = _require_trader()
    trades, _ = await client.trade.get_trades(user.address)
    if not trades:
        raise HTTPException(404, "no open trade")
    target = trades[0]

    balance_before = await client.get_usdc_balance(user.address)

    # Snapshot the price *before* broadcast — by the time the receipt
    # lands the feed will have ticked one or more times, and the player
    # cares about the price that triggered their close, not whatever the
    # mark is two seconds later. Used as a cross-check against the
    # back-computed price below.
    feed_price_at_close = price_module.get_latest_price()

    close_tx = await client.trade.build_trade_close_tx(
        pair_index=target.trade.pair_index,
        trade_index=target.trade.trade_index,
        collateral_to_close=target.trade.open_collateral,
        trader=user.address,
    )

    if _is_legacy_user(user):
        receipt = await client.sign_and_get_receipt(close_tx)
        tx_hash = _tx_hash_str(receipt)
    else:
        tx_hash = await _send_user_tx(user, close_tx)

    balance_after = balance_before
    for _ in range(5):
        balance_after = await client.get_usdc_balance(user.address)
        if balance_after != balance_before:
            break
        await asyncio.sleep(1.0)

    received = balance_after - balance_before
    net_pnl = round(received - target.trade.open_collateral, 4)

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
    collateral = float(target.trade.open_collateral)
    exit_price = _exit_price_from_pnl(entry_price, leverage, collateral, gross_pnl)
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

    return CloseTradeResponse(
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


@router.post("/close", response_model=CloseTradeResponse)
async def close_trade(user: AuthedUser = Depends(require_user)):
    return await _close_active_trade(user, was_liquidated=False)


@router.post("/force-close", response_model=CloseTradeResponse)
async def force_close_trade(user: AuthedUser = Depends(require_user)):
    return await _close_active_trade(user, was_liquidated=True)


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
) -> tuple[float, float]:
    """Mark-to-market PnL for an Avantis perp. Returns (pnl_usdc, pnl_pct).
    pnl_pct is expressed as the fraction of collateral, so -1.0 = full
    liquidation, +0.5 = +50% on the wager. Slippage and the 2.5% Avantis
    win fee are not modeled here — this is the unrealized number."""
    if entry_price <= 0 or collateral <= 0:
        return 0.0, 0.0
    move = (current_price - entry_price) / entry_price
    if not is_long:
        move = -move
    pnl_pct = move * leverage
    pnl_usdc = pnl_pct * collateral
    return round(pnl_usdc, 4), round(pnl_pct, 6)


@router.get("/active", response_model=Optional[ActiveTrade])
async def get_active_trade(user: AuthedUser = Depends(require_user)):
    client = _require_trader()
    trades, _ = await client.trade.get_trades(user.address)
    if not trades:
        return None

    t = trades[0]
    entry = float(t.trade.open_price)
    leverage = float(t.trade.leverage)
    collateral = float(t.trade.open_collateral)
    # Latest tick from the shared Avantis Lazer feed. None until the
    # first feed tick lands; in that window we surface entry as the
    # current price (PnL=0) so the client gets a coherent snapshot
    # rather than a 503.
    latest = price_module.get_latest_price()
    current = float(latest) if latest is not None else entry
    is_long = bool(getattr(t.trade, "is_long", True))
    pnl_usdc, pnl_pct = _compute_pnl(entry, current, leverage, collateral, is_long=is_long)

    return ActiveTrade(
        trade_index=t.trade.trade_index,
        avantis_pair_index=t.trade.pair_index,
        leverage=int(leverage),
        wager_usdc=collateral,
        collateral_usdc=collateral,
        entry_price=entry,
        current_price=current,
        pnl_usdc=pnl_usdc,
        pnl_pct=pnl_pct,
        liquidation_price=t.liquidation_price,
        opened_at=_opened_at_from_trade(t),
        is_long=is_long,
    )
