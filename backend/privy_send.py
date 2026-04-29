"""
Privy transaction relay — direct REST call with manual signature.

privy-client 0.2.x's AsyncPrivyAPI does not auto-sign requests with
the authorization key (only the sync PrivyAPI does, via a custom
httpx.Client subclass that overrides send()). For delegated wallet
operations like eth_sendTransaction we need the
`privy-authorization-signature` header or Privy returns 401 "No valid
authorization keys".

Rather than fight the SDK or pre-compute signatures and pass them via
the rpc kwarg, we just call Privy's REST API directly with httpx:

  POST {base_url}/v1/wallets/{wallet_id}/rpc
  headers:
    privy-app-id: <app_id>
    privy-authorization-signature: <ECDSA P-256 sig over canonical body>
    Authorization: Basic base64(app_id:app_secret)
  body:
    { method, caip2, params: { transaction: {...} } }

The signature helper (get_authorization_signature) is reused from the
SDK — it's pure crypto, no client coupling.
"""

import base64
import os
from typing import Any, Optional

import httpx
from cryptography.hazmat.primitives import serialization

# get_authorization_signature handles canonicalization + ECDSA P-256
# signing. It's pure, no client deps. We pass it the same fields the
# SDK's sync HTTP client would pass internally.
from privy.lib.authorization_signatures import get_authorization_signature


PRIVY_API_BASE = os.getenv("PRIVY_API_BASE_URL", "https://api.privy.io")
BASE_CAIP2 = "eip155:8453"


def _normalize_auth_key(raw: str) -> str:
    """Privy's signing helper hardcodes the PKCS8 wrapper:

      -----BEGIN PRIVATE KEY-----
      <base64 body>
      -----END PRIVATE KEY-----

    so the value we pass it must be a bare PKCS8 base64 body. Users
    typically generate the auth key with `openssl ecparam -name
    secp256r1 -genkey -noout -out k.pem`, which produces an
    `EC PRIVATE KEY` (sec1) format that mismatches the wrapper and
    fails with MismatchedTags("PRIVATE KEY", "EC PRIVATE KEY").

    Accept either form, plus a fully-formed PKCS8 PEM, and emit the
    bare PKCS8 base64 body the SDK expects."""
    s = raw.strip().replace("\\n", "\n")
    s = s.replace("wallet-auth:", "")

    # If it's bare base64 (no headers), trust it. The SDK will wrap as
    # PKCS8 — the user must have generated PKCS8 form for this to work.
    if "-----BEGIN" not in s:
        return "".join(s.split())

    # Has PEM headers. Load via cryptography, re-emit as PKCS8, strip.
    try:
        key = serialization.load_pem_private_key(s.encode("utf-8"), password=None)
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(
            f"PRIVY_AUTH_PRIVATE_KEY isn't a loadable PEM private key: {e}"
        )
    pkcs8_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    body = "".join(
        line for line in pkcs8_pem.splitlines()
        if line and not line.startswith("-----")
    )
    return body


def _to_hex(v: Any) -> Any:
    """Convert numeric tx fields to 0x-prefixed hex (Privy expects hex strings)."""
    if isinstance(v, int):
        return hex(v) if v >= 0 else hex(v & ((1 << 256) - 1))
    if isinstance(v, bytes):
        return "0x" + v.hex()
    return v


def _normalize_tx(raw: Any) -> dict:
    """Turn an Avantis SDK transaction object into the dict shape Privy
    expects under params.transaction.

    Per privy-client 0.5 EthSendTransactionParamsTransaction the only
    keys we care about for our use case are to/data/value. chainId is
    rejected (chain comes from caip2). nonce/gas* are auto-populated
    by Privy's relayer."""
    src: dict
    if isinstance(raw, dict):
        src = raw
    elif hasattr(raw, "to_dict"):
        src = raw.to_dict()
    elif hasattr(raw, "tx") and isinstance(getattr(raw, "tx"), dict):
        src = raw.tx
    else:
        src = {
            k: getattr(raw, k)
            for k in ("to", "data", "value")
            if hasattr(raw, k)
        }

    out: dict = {}
    if "to" in src:
        out["to"] = src["to"]
    if "data" in src:
        out["data"] = _to_hex(src["data"])
    if "value" in src:
        out["value"] = _to_hex(src["value"])
    return out


async def send_via_privy(
    privy_client: Any,
    wallet_id: str,
    raw_tx: Any,
) -> str:
    """Send a built Avantis transaction via Privy. Returns the tx hash.

    `privy_client` is only consulted for app_id / app_secret — the
    actual HTTP call is made via httpx so we can attach the
    privy-authorization-signature header that the async SDK doesn't
    set on its own."""
    app_id: Optional[str] = getattr(privy_client, "app_id", None)
    app_secret: Optional[str] = getattr(privy_client, "app_secret", None)
    if not app_id or not app_secret:
        raise RuntimeError(
            "Privy client missing app_id/app_secret — can't send tx"
        )

    raw_auth_key = os.getenv("PRIVY_AUTH_PRIVATE_KEY", "")
    if not raw_auth_key:
        raise RuntimeError(
            "PRIVY_AUTH_PRIVATE_KEY not set — cannot sign delegated tx. "
            "Set this on Railway with the PEM private key registered as an "
            "Authorization Key on the Privy dashboard."
        )
    auth_key = _normalize_auth_key(raw_auth_key)

    transaction = _normalize_tx(raw_tx)
    body = {
        "method": "eth_sendTransaction",
        "caip2": BASE_CAIP2,
        "params": {"transaction": transaction},
    }
    url = f"{PRIVY_API_BASE.rstrip('/')}/v1/wallets/{wallet_id}/rpc"

    signature = get_authorization_signature(
        url=url,
        body=body,
        method="POST",
        app_id=app_id,
        private_key=auth_key,
    )

    basic = base64.b64encode(f"{app_id}:{app_secret}".encode()).decode()
    headers = {
        "privy-app-id": app_id,
        "privy-authorization-signature": signature,
        "Authorization": f"Basic {basic}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=20.0) as ax:
        r = await ax.post(url, headers=headers, json=body)

    if r.status_code != 200:
        # Surface the Privy error verbatim so the upstream toast is useful.
        raise RuntimeError(f"Privy {r.status_code}: {r.text}")

    payload = r.json()
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise RuntimeError(f"Privy returned no data: {payload}")
    tx_hash = data.get("hash")
    if not isinstance(tx_hash, str):
        raise RuntimeError(f"Privy returned no tx hash: {payload}")
    return tx_hash
