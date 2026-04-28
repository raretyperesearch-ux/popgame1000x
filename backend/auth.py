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
from jwt import PyJWKClient
from fastapi import Header, HTTPException

_PRIVY_APP_ID = os.getenv("PRIVY_APP_ID", "")
_PRIVY_APP_SECRET = os.getenv("PRIVY_APP_SECRET", "")
_PRIVY_AUTH_PRIVATE_KEY = os.getenv("PRIVY_AUTH_PRIVATE_KEY", "")
_PRIVY_VERIFICATION_KEY = os.getenv("PRIVY_VERIFICATION_KEY", "")  # legacy fallback


def _normalize_pem(key: str) -> str:
    """Wrap a bare base64 SPKI body with PEM headers if missing.
    Used only when falling back to the static PRIVY_VERIFICATION_KEY env."""
    if not key:
        return key
    k = key.strip().replace("\\n", "\n")
    if "-----BEGIN" in k:
        return k
    body = "".join(k.split())
    wrapped = "\n".join(body[i : i + 64] for i in range(0, len(body), 64))
    return f"-----BEGIN PUBLIC KEY-----\n{wrapped}\n-----END PUBLIC KEY-----\n"


_PRIVY_VERIFICATION_KEY = _normalize_pem(_PRIVY_VERIFICATION_KEY)
_AUTH_DISABLE = os.getenv("AUTH_DISABLE", "").lower() in ("1", "true", "yes")

_JWT_AUDIENCE = _PRIVY_APP_ID
_JWT_ISSUER = "privy.io"

# Privy publishes its JWKS at this URL; PyJWKClient caches the keys
# and pyjwt picks the right one off the JWT's `kid` header. More robust
# than a hand-pasted PEM env var, which Railway's UI tends to mangle on
# embedded newlines.
_PRIVY_JWKS_URL = (
    f"https://auth.privy.io/api/v1/apps/{_PRIVY_APP_ID}/jwks.json"
    if _PRIVY_APP_ID
    else ""
)
_jwks_client: Optional[PyJWKClient] = (
    PyJWKClient(_PRIVY_JWKS_URL, cache_keys=True) if _PRIVY_JWKS_URL else None
)


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


def _resolve_signing_key(token: str):
    """Pick the signing key for a Privy JWT. Prefers the live JWKS endpoint
    (auto-rotates, no env-var formatting traps). Falls back to the static
    PRIVY_VERIFICATION_KEY env if JWKS is unreachable or unconfigured."""
    if _jwks_client is not None:
        try:
            return _jwks_client.get_signing_key_from_jwt(token).key
        except Exception:  # noqa: BLE001 — fall through to PEM env
            pass
    if _PRIVY_VERIFICATION_KEY:
        return _PRIVY_VERIFICATION_KEY
    raise HTTPException(
        500,
        "Privy JWT verification not configured: set PRIVY_APP_ID (for JWKS) "
        "or PRIVY_VERIFICATION_KEY (static PEM fallback).",
    )


def _verify_jwt(token: str) -> str:
    """Verify a Privy access token JWT and return the user DID (`sub`).
    Raises HTTPException(401) on invalid token."""
    key = _resolve_signing_key(token)
    try:
        decoded = jwt.decode(
            token,
            key,
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


async def _resolve_user_wallet(
    user_did: str,
    preferred_address: Optional[str] = None,
) -> tuple[str, str]:
    """Look up the user's Privy Ethereum wallet.

    Users can carry multiple embedded wallets (older + newer rotations) and
    optional external connections. The frontend's topbar/funding flow uses
    one specific address (user.wallet.address), so it forwards that as
    X-Wallet-Address — we honor it after confirming it belongs to the JWT
    subject. Without a hint, prefer Privy embedded over external; if there
    are several embedded entries, take the first."""
    if _privy_client is None:
        raise HTTPException(503, "Privy client not initialized")
    try:
        user = await _privy_client.users.get(user_did)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(404, f"Privy user lookup failed: {e}")

    pref = preferred_address.lower() if preferred_address else None
    matched: Optional[tuple[str, str]] = None
    embedded: Optional[tuple[str, str]] = None
    fallback: Optional[tuple[str, str]] = None
    for acc in getattr(user, "linked_accounts", []) or []:
        acc_type = getattr(acc, "type", None) or (acc.get("type") if isinstance(acc, dict) else None)
        chain = getattr(acc, "chain_type", None) or (acc.get("chain_type") if isinstance(acc, dict) else None)
        if acc_type != "wallet" or chain != "ethereum":
            continue
        wallet_id = getattr(acc, "id", None) or (acc.get("id") if isinstance(acc, dict) else None)
        address = getattr(acc, "address", None) or (acc.get("address") if isinstance(acc, dict) else None)
        if not (wallet_id and address):
            continue
        client_type = (
            getattr(acc, "wallet_client_type", None)
            or (acc.get("wallet_client_type") if isinstance(acc, dict) else None)
            or getattr(acc, "wallet_client", None)
            or (acc.get("wallet_client") if isinstance(acc, dict) else None)
        )
        entry = (str(wallet_id), str(address))
        if pref and address.lower() == pref:
            matched = entry
            break
        if client_type == "privy" and embedded is None:
            embedded = entry
        if fallback is None:
            fallback = entry

    chosen = matched or embedded or fallback
    if chosen is None:
        raise HTTPException(409, "User has no Ethereum embedded wallet — login first")
    if pref and matched is None:
        # Frontend hinted an address, but it isn't on the user's account.
        # Fail closed so we don't read someone else's balance.
        raise HTTPException(
            403,
            f"X-Wallet-Address {preferred_address} not linked to authenticated user",
        )
    source = (
        "header-match" if matched else "embedded-default" if embedded else "external-fallback"
    )
    print(f"[auth] resolved wallet for {user_did}: {chosen[1]} ({source})")
    return chosen


async def require_user(
    authorization: Optional[str] = Header(default=None),
    x_wallet_address: Optional[str] = Header(default=None),
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
    wallet_id, address = await _resolve_user_wallet(did, x_wallet_address)
    return AuthedUser(did=did, wallet_id=wallet_id, address=address)
