"""
/history — read-only views into Supabase-persisted trade history.

Returns 404-free, never 503: when persistence is disabled (no Supabase
env), we serve empty lists rather than failing. The frontend treats an
empty history the same way regardless of cause.

  GET /history/me         — paged trade list for the calling user
  GET /history/leaderboard — top traders by realized net PnL
"""

from typing import Optional

from fastapi import APIRouter, Depends, Query

import persistence
from auth import AuthedUser, require_user

router = APIRouter()


@router.get("/me")
async def my_history(
    user: AuthedUser = Depends(require_user),
    limit: int = Query(default=25, ge=1, le=100),
) -> dict:
    return {
        "enabled": persistence.is_enabled(),
        "wallet_address": user.address,
        "trades": persistence.recent_trades_for(user.address, limit=limit),
    }


@router.get("/leaderboard")
async def leaderboard(
    limit: int = Query(default=20, ge=1, le=100),
    # Auth is required to keep the endpoint scoped to actual game users
    # rather than scraped — Supabase service-role data shouldn't be a
    # public REST endpoint, even if the data itself is non-sensitive.
    _user: Optional[AuthedUser] = Depends(require_user),
) -> dict:
    return {
        "enabled": persistence.is_enabled(),
        "rows": persistence.leaderboard(limit=limit),
    }
