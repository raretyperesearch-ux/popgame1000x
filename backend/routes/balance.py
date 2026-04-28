"""
/balance — returns the trader wallet's live USDC balance from the
Avantis SDK (via TraderClient.get_usdc_balance). Single-wallet test
mode for now; per-user balances arrive with Privy delegated signing in
P3+.

Returns 503 if the trader client isn't initialized (same pattern as
/trade/* endpoints), so the failure is loud rather than masked behind
a 100 USDC stub.
"""

from fastapi import APIRouter, HTTPException

from models import BalanceResponse
from routes import trade as trade_module

router = APIRouter()


@router.get("", response_model=BalanceResponse)
async def get_balance():
    client = trade_module._trader_client
    address = trade_module._trader_address
    if client is None or address is None:
        raise HTTPException(503, "trader client not initialized")
    usdc = await client.get_usdc_balance(address)
    return BalanceResponse(
        usdc_balance=float(usdc),
        wallet_address=address,
    )
