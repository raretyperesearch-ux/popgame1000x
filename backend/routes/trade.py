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
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from avantis_trader_sdk import TraderClient
from avantis_trader_sdk.types import TradeInput, TradeInputOrderType

import auth
from auth import AuthedUser, require_user
from privy_send import send_via_privy
from routes import price as price_module
from usdc_approval import (
    build_usdc_approval_tx,
    get_avantis_trading_address,
    get_eth_balance_wei,
    MIN_GAS_ETH_WEI,
)
from models import (
    OpenTradeRequest,
    OpenTradeResponse,
    CloseTradeResponse,
    ActiveTrade,
    calculate_house_fee,
)

router = APIRouter()

_PROVIDER_URL = os.getenv("BASE_RPC_URL", "https://mainnet.base.org")
_PRIVATE_KEY = os.getenv("PRIVATE_KEY")
_TREASURY_ADDRESS = os.getenv("TREASURY_ADDRESS")
_PAIR = "ETH/USD"
_USDC_APPROVAL_AMOUNT = 1000.0
_RECEIPT_POLL_INTERVAL = 1.0
_RECEIPT_POLL_MAX_TRIES = 20  # ~20 s; Railway's request timeout is 60s, must
                              # leave headroom for approval + open + this poll

_trader_client: Optional[TraderClient] = None
_eth_pair_index: Optional[int] = None
_trader_address: Optional[str] = None  # legacy env wallet (single-wallet fallback only)


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
            if max_lev is not None and max_lev < 250:
                print(f"⚠️  {_PAIR} max leverage is {max_lev}, our cap is 250")
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
async def open_trade(body: OpenTradeRequest, user: AuthedUser = Depends(require_user)):
    client = _require_trader()
    pair_index = _eth_pair_index
    if pair_index is None:
        raise HTTPException(503, "pair index not initialized")

    existing, _ = await client.trade.get_trades(user.address)
    if existing:
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
    if not _is_legacy_user(user):
        try:
            eth_wei = await get_eth_balance_wei(user.address)
        except Exception as e:  # noqa: BLE001
            print(f"[trade] gas pre-flight RPC failed, allowing through: {e}")
            eth_wei = MIN_GAS_ETH_WEI
        if eth_wei < MIN_GAS_ETH_WEI:
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

    allowance = await client.get_usdc_allowance_for_trading(user.address)
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

    trade_input = TradeInput(
        trader=user.address,
        open_price=None,
        pair_index=pair_index,
        collateral_in_trade=collateral,
        is_long=True,
        leverage=body.leverage,
        index=0,
        tp=0,
        sl=0,
        timestamp=0,
    )
    open_tx = await client.trade.build_trade_open_tx(
        trade_input,
        TradeInputOrderType.MARKET_ZERO_FEE,
        slippage_percentage=1,
    )

    if _is_legacy_user(user):
        receipt = await client.sign_and_get_receipt(open_tx)
        tx_hash = _tx_hash_str(receipt)
    else:
        tx_hash = await _send_user_tx(user, open_tx)

    trades = await _poll_for_trade(client, user.address, expect_present=True)
    if not trades:
        raise HTTPException(
            500,
            f"open tx broadcast ({tx_hash}) but trade did not appear after polling",
        )
    new_trade = trades[0]

    return OpenTradeResponse(
        trade_index=new_trade.trade.trade_index,
        avantis_pair_index=pair_index,
        leverage=body.leverage,
        wager_usdc=body.wager_usdc,
        house_fee_usdc=house_fee,
        collateral_usdc=collateral,
        entry_price=new_trade.trade.open_price,
        liquidation_price=new_trade.liquidation_price,
        opened_at=datetime.now(timezone.utc),
        tx_hash=tx_hash,
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

    return CloseTradeResponse(
        trade_index=target.trade.trade_index,
        entry_price=entry_price,
        exit_price=exit_price,
        gross_pnl_usdc=gross_pnl,
        avantis_win_fee_usdc=avantis_win_fee,
        net_pnl_usdc=net_pnl,
        was_liquidated=was_liquidated,
        closed_at=datetime.now(timezone.utc),
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
    pnl_usdc, pnl_pct = _compute_pnl(entry, current, leverage, collateral)

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
    )
