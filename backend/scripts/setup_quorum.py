"""
One-shot script: register a Privy Key Quorum containing the public
key derived from PRIVY_AUTH_PRIVATE_KEY, with threshold 1.

Run once from the backend directory:

    python -m scripts.setup_quorum

Prints the resulting Key Quorum ID. Set that ID as:
  - NEXT_PUBLIC_PRIVY_SIGNER_ID on Vercel (frontend addSigners target)
  - PRIVY_EXPECTED_SIGNER_ID on Railway (so /wallet/status pass/fail)

The script is idempotent in the sense that it always creates a NEW
quorum — Privy doesn't expose a list endpoint via the python SDK, so
we can't dedupe. Set PRIVY_KEY_QUORUM_ID after the first run; subsequent
runs are no-ops.

Reads:
  PRIVY_APP_ID
  PRIVY_APP_SECRET
  PRIVY_AUTH_PRIVATE_KEY  (PEM in any of the formats privy_send accepts)
  PRIVY_KEY_QUORUM_ID     (optional — if set, exits early)
"""

import asyncio
import os
import sys

from dotenv import load_dotenv


async def main() -> int:
    load_dotenv()

    if existing := os.getenv("PRIVY_KEY_QUORUM_ID"):
        print(f"PRIVY_KEY_QUORUM_ID already set ({existing}) — nothing to do.")
        return 0

    app_id = os.getenv("PRIVY_APP_ID")
    app_secret = os.getenv("PRIVY_APP_SECRET")
    auth_key = os.getenv("PRIVY_AUTH_PRIVATE_KEY")
    if not app_id or not app_secret or not auth_key:
        print(
            "ERROR: PRIVY_APP_ID, PRIVY_APP_SECRET, and PRIVY_AUTH_PRIVATE_KEY "
            "must all be set in env (or .env) before running this script.",
            file=sys.stderr,
        )
        return 1

    from privy import AsyncPrivyAPI  # type: ignore
    from cryptography.hazmat.primitives import serialization
    from privy_send import _normalize_auth_key  # type: ignore

    body = _normalize_auth_key(auth_key)
    pem = (
        f"-----BEGIN PRIVATE KEY-----\n{body}\n-----END PRIVATE KEY-----"
    )
    priv = serialization.load_pem_private_key(pem.encode(), password=None)
    pub_pem = priv.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()

    print("Public key being registered:")
    print(pub_pem)

    client = AsyncPrivyAPI(app_id=app_id, app_secret=app_secret)
    quorum = await client.key_quorums.create(
        public_keys=[pub_pem],
        authorization_threshold=1,
        display_name="popgame1000x backend signer",
    )
    print()
    print("✓ Key Quorum created")
    print(f"  ID:                {quorum.id}")
    print(f"  Authorization keys: {len(quorum.authorization_keys)}")
    print(f"  Threshold:          {quorum.authorization_threshold}")
    print()
    print("Set these env vars NOW (so this isn't accidentally re-run):")
    print(f"  Railway   PRIVY_KEY_QUORUM_ID={quorum.id}")
    print(f"  Railway   PRIVY_EXPECTED_SIGNER_ID={quorum.id}")
    print(f"  Vercel    NEXT_PUBLIC_PRIVY_SIGNER_ID={quorum.id}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
