"""
/trade/* endpoints — real Avantis SDK calls.

Single-wallet test mode: backend uses ONE private key (from .env) and the same
wallet acts as both trader and treasury. Multi-user comes in P3 with Privy.

Endpoints:
  POST /trade/open         — open a ZFP long on ETH/USD
  POST /trade/close        — close the open trade (player tapped 'stop')
  POST /trade/force-close  — close with was_liquidated=True (figure hit water)
  GET  /trade/active       — get the currently open trade or null

SDK call sites match canonical examples at https://sdk.avantisfi.com/trade.html
"""

import asyncio
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException

from avantis_trader_sdk import TraderClient
from avantis_trader_sdk.types import TradeInput, TradeInputOrderType

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

_trader_client: Optional[TraderClient] = None
_eth_pair_index: Optional[int] = None
_trader_address: Optional[str] = None


async def init_trader():
    global _trader_client, _eth_pair_index, _trader_address

    if not _PRIVATE_KEY:
        raise RuntimeError("PRIVATE_KEY env var is required")
    if not _TREASURY_ADDRESS:
        raise RuntimeError("TREASURY_ADDRESS env var is required")

    _trader_client = TraderClient(_PROVIDER_URL)
    _trader_client.set_local_signer(_PRIVATE_KEY)
    _trader_address = _trader_client.get_signer().get_ethereum_address()

    _eth_pair_index = await _trader_client.pairs_cache.get_pair_index(_PAIR)

    pairs = await _trader_client.pairs_cache.get_pairs_info()
    eth = pairs[_PAIR]

    if not eth.values.is_usdc_aligned:
        raise RuntimeError(f"{_PAIR} is not USDC-aligned")
    if eth.leverages.min_leverage > 75:
        raise RuntimeError(
            f"{_PAIR} min leverage is {eth.leverages.min_leverage} — ZFP requires <=75"
        )
    if eth.leverages.max_leverage < 250:
        print(
            f"⚠️  {_PAIR} max leverage is {eth.leverages.max_leverage}, our cap is 250"
        )

    print(
        f"✓ Avantis ready: pair={_PAIR} index={_eth_pair_index} "
        f"trader={_trader_address} lev_range="
        f"{eth.leverages.min_leverage}-{eth.leverages.max_leverage}"
    )


def _require_trader() -> TraderClient:
    if _trader_client is None:
        raise HTTPException(503, "trader client not initialized")
    return _trader_client


def _tx_hash_str(receipt) -> str:
    th = getattr(receipt, "transactionHash", None)
    if th is None:
        return ""
    if hasattr(th, "hex"):
        return th.hex()
    return str(th)


@router.post("/open", response_model=OpenTradeResponse)
async def open_trade(body: OpenTradeRequest):
    client = _require_trader()

    existing, _ = await client.trade.get_trades(_trader_address)
    if existing:
        raise HTTPException(
            409,
            f"trade already open (index {existing[0].trade.trade_index}) — close first",
        )

    house_fee = calculate_house_fee(body.wager_usdc)
    collateral = round(body.wager_usdc - house_fee, 4)
    if collateral <= 0:
        raise HTTPException(400, "wager too small after house fee")

    allowance = await client.get_usdc_allowance_for_trading(_trader_address)
    if allowance < collateral:
        print(
            f"  approving {_USDC_APPROVAL_AMOUNT} USDC for trading "
            f"(current allowance {allowance})..."
        )
        await client.approve_usdc_for_trading(_USDC_APPROVAL_AMOUNT)

    # TODO P3: USDC.transfer(TREASURY_ADDRESS, house_fee) multicalled with the open

    trade_input = TradeInput(
        trader=_trader_address,
        open_price=None,
        pair_index=_eth_pair_index,
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
    receipt = await client.sign_and_get_receipt(open_tx)

    trades, _ = await client.trade.get_trades(_trader_address)
    if not trades:
        await asyncio.sleep(1.0)
        trades, _ = await client.trade.get_trades(_trader_address)
        if not trades:
            raise HTTPException(
                500,
                f"trade tx confirmed ({_tx_hash_str(receipt)}) but get_trades returned empty after retry",
            )

    new_trade = trades[0]

    return OpenTradeResponse(
        trade_index=new_trade.trade.trade_index,
        avantis_pair_index=_eth_pair_index,
        leverage=body.leverage,
        wager_usdc=body.wager_usdc,
        house_fee_usdc=house_fee,
        collateral_usdc=collateral,
        entry_price=new_trade.trade.open_price,
        liquidation_price=new_trade.liquidation_price,
        opened_at=datetime.now(timezone.utc),
        tx_hash=_tx_hash_str(receipt),
    )


async def _close_active_trade(was_liquidated: bool) -> CloseTradeResponse:
    client = _require_trader()

    trades, _ = await client.trade.get_trades(_trader_address)
    if not trades:
        raise HTTPException(404, "no open trade")
    target = trades[0]

    balance_before = await client.get_usdc_balance(_trader_address)

    close_tx = await client.trade.build_trade_close_tx(
        pair_index=target.trade.pair_index,
        trade_index=target.trade.trade_index,
        collateral_to_close=target.trade.open_collateral,
        trader=_trader_address,
    )
    receipt = await client.sign_and_get_receipt(close_tx)

    balance_after = balance_before
    for _ in range(5):
        balance_after = await client.get_usdc_balance(_trader_address)
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

    return CloseTradeResponse(
        trade_index=target.trade.trade_index,
        entry_price=target.trade.open_price,
        exit_price=0.0,  # TODO post-P4: parse exit_price from MarketExecuted event
        gross_pnl_usdc=gross_pnl,
        avantis_win_fee_usdc=avantis_win_fee,
        net_pnl_usdc=net_pnl,
        was_liquidated=was_liquidated,
        closed_at=datetime.now(timezone.utc),
        tx_hash=_tx_hash_str(receipt),
    )


@router.post("/close", response_model=CloseTradeResponse)
async def close_trade():
    return await _close_active_trade(was_liquidated=False)


@router.post("/force-close", response_model=CloseTradeResponse)
async def force_close_trade():
    return await _close_active_trade(was_liquidated=True)


@router.get("/active", response_model=Optional[ActiveTrade])
async def get_active_trade():
    client = _require_trader()

    trades, _ = await client.trade.get_trades(_trader_address)
    if not trades:
        return None

    t = trades[0]

    return ActiveTrade(
        trade_index=t.trade.trade_index,
        avantis_pair_index=t.trade.pair_index,
        leverage=int(t.trade.leverage),
        wager_usdc=t.trade.open_collateral,
        collateral_usdc=t.trade.open_collateral,
        entry_price=t.trade.open_price,
        current_price=t.trade.open_price,
        pnl_usdc=0.0,
        pnl_pct=0.0,
        liquidation_price=t.liquidation_price,
        opened_at=datetime.now(timezone.utc),
    )
