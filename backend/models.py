"""
Pydantic models for the v3 API contract.
"""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field

HOUSE_FEE_BPS = 80  # 0.8%
MIN_LEVERAGE = 75
MAX_LEVERAGE = 250


class OpenTradeRequest(BaseModel):
    leverage: int = Field(ge=MIN_LEVERAGE, le=MAX_LEVERAGE)
    wager_usdc: float = Field(gt=0)


class OpenTradeResponse(BaseModel):
    trade_index: int
    avantis_pair_index: int
    leverage: int
    wager_usdc: float
    house_fee_usdc: float
    collateral_usdc: float
    entry_price: float
    liquidation_price: float
    opened_at: datetime
    tx_hash: str


class CloseTradeResponse(BaseModel):
    trade_index: int
    entry_price: float
    exit_price: float
    gross_pnl_usdc: float
    avantis_win_fee_usdc: float
    net_pnl_usdc: float
    was_liquidated: bool
    closed_at: datetime
    tx_hash: str


class ActiveTrade(BaseModel):
    trade_index: int
    avantis_pair_index: int
    leverage: int
    wager_usdc: float
    collateral_usdc: float
    entry_price: float
    current_price: float
    pnl_usdc: float
    pnl_pct: float
    liquidation_price: float
    opened_at: datetime


class PriceStreamMessage(BaseModel):
    eth_price: float
    timestamp: datetime
    active_trade: Optional[ActiveTrade] = None


class BalanceResponse(BaseModel):
    usdc_balance: float
    wallet_address: str


def calculate_house_fee(wager_usdc: float) -> float:
    return round(wager_usdc * HOUSE_FEE_BPS / 10_000, 4)
