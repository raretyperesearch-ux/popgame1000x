"""
/wallet/status — server-authoritative check of whether the caller's
Privy embedded wallet is actually delegated to a quorum the backend
can sign with.

Background: the React @privy-io/react-auth Wallet shape exposes only
the legacy `delegated: boolean` flag, which is set by the deprecated
useDelegatedActions flow and does NOT flip for the new
useSigners().addSigners() flow. So the frontend can't tell from
linkedAccounts alone whether trade signing will work. This endpoint
hits Privy's `GET /v1/wallets/{wallet_id}` and inspects the wallet's
owner_id (key quorum ID) and additional_signers list — that's the
authoritative source of truth.
"""

import os
from typing import Any

from fastapi import APIRouter, Depends

import auth
from auth import AuthedUser, require_user

router = APIRouter()


@router.get("/status")
async def wallet_status(user: AuthedUser = Depends(require_user)) -> dict:
    """Returns the wallet's delegation state from Privy's perspective.

    delegated: bool   — true if the trade signing key (NEXT_PUBLIC_PRIVY_SIGNER_ID,
                        which the frontend mirrors here in addSigners) is in the
                        wallet's owner_id quorum or additional_signers list.
    quorum_id: str    — the wallet's owner key-quorum ID per Privy.
    additional: list  — extra signer-quorum IDs registered via addSigners.
    address: str      — the wallet address we resolved for the JWT user.
    """
    expected_signer = os.getenv("PRIVY_EXPECTED_SIGNER_ID", "")
    out: dict[str, Any] = {
        "address": user.address,
        "delegated": False,
        "quorum_id": None,
        "additional": [],
        "expected_signer": expected_signer or None,
    }
    if auth._privy_client is None:
        out["error"] = "Privy client not initialized"
        return out
    try:
        w = await auth._privy_client.wallets.get(wallet_id=user.wallet_id)
    except Exception as e:  # noqa: BLE001
        out["error"] = f"wallets.get failed: {e}"
        return out
    owner_id = getattr(w, "owner_id", None)
    additional = [
        getattr(s, "signer_id", None)
        for s in (getattr(w, "additional_signers", None) or [])
    ]
    additional = [a for a in additional if a]
    out["quorum_id"] = owner_id
    out["additional"] = additional
    if expected_signer:
        out["delegated"] = (
            expected_signer == owner_id or expected_signer in additional
        )
    else:
        # No expected-signer env set; treat any registered signer as
        # "delegated to something" — operator should set the env so
        # this endpoint can check the actual match.
        out["delegated"] = bool(owner_id) and bool(additional)
    return out
