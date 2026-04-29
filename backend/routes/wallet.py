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

import hashlib
import os
from typing import Any

from fastapi import APIRouter, Depends

import auth
from auth import AuthedUser, require_user
from privy_send import _normalize_auth_key
from cryptography.hazmat.primitives import serialization

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


@router.get("/delegation-audit")
async def wallet_delegation_audit(user: AuthedUser = Depends(require_user)) -> dict:
    """Deep signer audit for one authenticated wallet.

    Returns an explicit pass/fail matrix for the moving parts that must
    all align for Privy delegated signing to succeed:
      - expected signer IDs from env
      - wallet owner/additional signers in Privy
      - auth private key loadability + derived public-key fingerprint
    """
    expected_frontend = os.getenv("NEXT_PUBLIC_PRIVY_SIGNER_ID", "")
    expected_backend = os.getenv("PRIVY_EXPECTED_SIGNER_ID", "")
    expected_quorum = os.getenv("PRIVY_KEY_QUORUM_ID", "")
    raw_auth_key = os.getenv("PRIVY_AUTH_PRIVATE_KEY", "")

    out: dict[str, Any] = {
        "address": user.address,
        "wallet_id": user.wallet_id,
        "env": {
            "next_public_privy_signer_id": expected_frontend or None,
            "privy_expected_signer_id": expected_backend or None,
            "privy_key_quorum_id": expected_quorum or None,
            "all_ids_equal": bool(expected_frontend) and (
                expected_frontend == expected_backend == expected_quorum
            ),
        },
        "wallet": {"owner_id": None, "additional_signers": []},
        "auth_key": {
            "present": bool(raw_auth_key),
            "loadable": False,
            "public_key_pem": None,
            "spki_sha256": None,
            "error": None,
        },
        "checks": {
            "expected_id_set": bool(expected_frontend),
            "wallet_matches_expected": False,
            "wallet_has_any_signer": False,
        },
    }

    if raw_auth_key:
        try:
            body = _normalize_auth_key(raw_auth_key)
            pem = f"-----BEGIN PRIVATE KEY-----\n{body}\n-----END PRIVATE KEY-----"
            priv = serialization.load_pem_private_key(pem.encode(), password=None)
            spki_der = priv.public_key().public_bytes(
                encoding=serialization.Encoding.DER,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            pub_pem = priv.public_key().public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            ).decode()
            out["auth_key"]["loadable"] = True
            out["auth_key"]["public_key_pem"] = pub_pem
            out["auth_key"]["spki_sha256"] = hashlib.sha256(spki_der).hexdigest()
        except Exception as e:  # noqa: BLE001
            out["auth_key"]["error"] = str(e)

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
    out["wallet"]["owner_id"] = owner_id
    out["wallet"]["additional_signers"] = additional
    out["checks"]["wallet_has_any_signer"] = bool(owner_id) or bool(additional)

    expected = expected_frontend or expected_backend or expected_quorum
    if expected:
        out["checks"]["wallet_matches_expected"] = (
            expected == owner_id or expected in additional
        )

    return out
