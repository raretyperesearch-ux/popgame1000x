"""
/balance endpoint stub.
P4: read real USDC balance from user's Privy-managed wallet.
"""

from fastapi import APIRouter
from models import BalanceResponse

router = APIRouter()


@router.get("", response_model=BalanceResponse)
async def get_balance():
    return BalanceResponse(
        usdc_balance=100.0,
        wallet_address="0xstub",
    )
