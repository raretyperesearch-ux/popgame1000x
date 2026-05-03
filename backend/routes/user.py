"""
/user — cross-game identity (Hiscore unified leaderboard).

  POST /user/register      — idempotent upsert of (privy_id, evm_wallet_address)
                             into the shared bm_players table. Called by the
                             frontend on first authenticated session and on every
                             subsequent login (cheap; the upsert collapses).
  POST /user/set-username  — pick or change the player's display name. Required
                             before they appear on hiscore.me/leaderboard.
  GET  /user/me            — current registry row for the authed user.

Mirrors the Hiscore main repo's Swallow Me register route. Both write to
public.bm_players via the SUPABASE_SERVICE_ROLE_KEY client (RLS would
otherwise block direct anon writes).

The pg_trades_sync_bm_players trigger keeps trade aggregates fresh on
the same row, keyed by evm_wallet_address — we don't touch those columns
here. If the trigger already inserted a wallet-keyed row before this
user logged in (the 3 existing SR wallets case), register_player patches
the row's privy_id rather than failing on the unique-wallet index.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import persistence
from auth import AuthedUser, require_user

router = APIRouter()


class SetUsernameRequest(BaseModel):
    username: str = Field(min_length=3, max_length=20)


def _registry_required() -> None:
    if not persistence.is_enabled():
        # The registry is the whole point of these endpoints — unlike
        # /history they have no useful empty-state response.
        raise HTTPException(503, "player registry disabled (Supabase env not configured)")


@router.post("/register")
async def register(user: AuthedUser = Depends(require_user)) -> dict:
    _registry_required()
    row = persistence.register_player(
        privy_id=user.did,
        evm_wallet_address=user.address,
    )
    if row is None:
        raise HTTPException(500, "could not register player")
    return {"player": row}


@router.get("/me")
async def me(user: AuthedUser = Depends(require_user)) -> dict:
    _registry_required()
    row = persistence.get_player_by_privy_id(user.did)
    return {"player": row}


@router.post("/set-username")
async def set_username(
    body: SetUsernameRequest,
    user: AuthedUser = Depends(require_user),
) -> dict:
    _registry_required()
    # Make sure the row exists before the username update — covers the
    # case where the user opened the username modal before /register
    # ever fired (race after a fresh login). Cheap upsert.
    persistence.register_player(
        privy_id=user.did,
        evm_wallet_address=user.address,
    )
    row, err = persistence.set_username(privy_id=user.did, username=body.username)
    if err:
        # 409 for conflicts (taken), 400 for validation. Frontend
        # distinguishes by status code so it can swap the field hint.
        status = 409 if "taken" in err else 400
        raise HTTPException(status, err)
    return {"player": row}
