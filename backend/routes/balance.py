"""
/balance — returns the calling user's wallet USDC balance.

Per-user via auth.require_user: the Privy access token resolves to the
user's embedded-wallet address, and we read its on-chain USDC balance
via the shared TraderClient. Frontend uses this on mount and after
every trade settles to keep the displayed balance honest.

Returns 503 when the trader client isn't initialized (matches the
/trade/* failure mode).
"""

from fastapi import APIRouter, Depends, HTTPException

from auth import AuthedUser, require_user
from models import BalanceResponse
from routes import trade as trade_module
from usdc_approval import get_eth_balance_wei

router = APIRouter()


@router.get("", response_model=BalanceResponse)
async def get_balance(user: AuthedUser = Depends(require_user)):
    client = trade_module._trader_client
    if client is None:
        raise HTTPException(503, "trader client not initialized")
    usdc = await client.get_usdc_balance(user.address)
    eth_balance = 0.0
    try:
        eth_balance = await get_eth_balance_wei(user.address) / 10**18
    except Exception as e:  # noqa: BLE001
        print(f"[balance] ETH gas balance read failed for {user.address}: {e}")
    return BalanceResponse(
        usdc_balance=float(usdc),
        eth_balance=eth_balance,
        wallet_address=user.address,
    )
