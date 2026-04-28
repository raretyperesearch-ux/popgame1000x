"""
Privy auth helpers — JWT verification + per-user wallet lookup.

Multi-user game uses Privy embedded wallets. The frontend logs the user
in via Privy and gets a short-lived JWT (access token). Every /trade/*
and /balance call presents the JWT in `Authorization: Bearer <token>`.

This module:
  - Initializes a single PrivyAPI client at app startup (in main.py).
  - Verifies incoming JWTs by fetching Privy's JWKS (cached).
  - Resolves the user's DID -> their first Ethereum embedded wallet
    (wallet_id + Ethereum address). The backend then uses that wallet_id
    to send transactions via Privy's eth_sendTransaction RPC.

Single-wallet fallback: if PRIVY_APP_ID/PRIVY_APP_SECRET are missing
(local dev), require_user falls back to the legacy env wallet so the
existing flow keeps working without auth. This keeps mock/dev mode
playable without setting up Privy locally.
"""

import os
from dataclasses import dataclass
from typing import Optional

import jwt
from fastapi import Header, HTTPException

_PRIVY_APP_ID = os.getenv("PRIVY_APP_ID", "")
_PRIVY_APP_SECRET = os.getenv("PRIVY_APP_SECRET", "")
_PRIVY_AUTH_PRIVATE_KEY = os.getenv("PRIVY_AUTH_PRIVATE_KEY", "")
_PRIVY_VERIFICATION_KEY = os.getenv("PRIVY_VERIFICATION_KEY", "")  # JWKS PEM
_AUTH_DISABLE = os.getenv("AUTH_DISABLE", "").lower() in ("1", "true", "yes")

_JWT_AUDIENCE = _PRIVY_APP_ID
_JWT_ISSUER = "privy.io"


@dataclass
class AuthedUser:
    did: str  # Privy user DID (e.g., did:privy:cm...)
    wallet_id: str  # Privy wallet id (used for /v1/wallets/{id}/rpc)
    address: str  # Ethereum address (checksummed)


_privy_client = None  # set by main.py at startup


def set_privy_client(client) -> None:
    """Called from main.py lifespan after PrivyAPI() init."""
    global _privy_client
    _privy_client = client


def is_privy_configured() -> bool:
    return bool(_PRIVY_APP_ID and _PRIVY_APP_SECRET)


def _verify_jwt(token: str) -> str:
    """Verify a Privy access token JWT and return the user DID (`sub`).
    Raises HTTPException(401) on invalid token."""
    if not _PRIVY_VERIFICATION_KEY:
        raise HTTPException(
            500,
            "PRIVY_VERIFICATION_KEY env var not set — cannot verify JWTs",
        )
    try:
        decoded = jwt.decode(
            token,
            _PRIVY_VERIFICATION_KEY,
            algorithms=["ES256"],
            audience=_JWT_AUDIENCE,
            issuer=_JWT_ISSUER,
        )
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"invalid Privy access token: {e}")
    sub = decoded.get("sub")
    if not isinstance(sub, str) or not sub:
        raise HTTPException(401, "Privy access token missing `sub` claim")
    return sub


async def _resolve_user_wallet(user_did: str) -> tuple[str, str]:
    """Look up the user's first Ethereum embedded wallet via Privy."""
    if _privy_client is None:
        raise HTTPException(503, "Privy client not initialized")
    try:
        user = await _privy_client.users.get(user_did)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(404, f"Privy user lookup failed: {e}")
    # linked_accounts is a list of dicts with type field. Filter for
    # Ethereum embedded wallets.
    for acc in getattr(user, "linked_accounts", []) or []:
        # The Privy SDK returns objects; access via getattr to be tolerant.
        acc_type = getattr(acc, "type", None) or (acc.get("type") if isinstance(acc, dict) else None)
        chain = getattr(acc, "chain_type", None) or (acc.get("chain_type") if isinstance(acc, dict) else None)
        if acc_type == "wallet" and chain == "ethereum":
            wallet_id = getattr(acc, "id", None) or (acc.get("id") if isinstance(acc, dict) else None)
            address = getattr(acc, "address", None) or (acc.get("address") if isinstance(acc, dict) else None)
            if wallet_id and address:
                return str(wallet_id), str(address)
    raise HTTPException(409, "User has no Ethereum embedded wallet — login first")


async def require_user(
    authorization: Optional[str] = Header(default=None),
) -> AuthedUser:
    """FastAPI dependency: validates `Authorization: Bearer <jwt>` and
    returns the authed user with their Privy wallet metadata.

    When AUTH_DISABLE=1 OR Privy is not configured, falls back to the
    legacy single-wallet env (PRIVATE_KEY + the trader address derived
    from it). That fallback is only safe for local dev — in prod, set
    PRIVY_APP_ID / PRIVY_APP_SECRET / PRIVY_VERIFICATION_KEY and don't
    set AUTH_DISABLE."""
    if _AUTH_DISABLE or not is_privy_configured():
        # Single-wallet legacy mode — used for local dev without Privy.
        from routes import trade as trade_module
        if trade_module._trader_address is None:
            raise HTTPException(
                503,
                "Auth disabled but legacy env wallet not initialized (PRIVATE_KEY)",
            )
        return AuthedUser(
            did="local-dev",
            wallet_id="local-dev",
            address=trade_module._trader_address,
        )

    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "missing Bearer token")
    token = authorization.split(" ", 1)[1].strip()
    did = _verify_jwt(token)
    wallet_id, address = await _resolve_user_wallet(did)
    return AuthedUser(did=did, wallet_id=wallet_id, address=address)
