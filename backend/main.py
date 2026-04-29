"""
FastAPI entrypoint for pop-backend.
Run: uvicorn main:app --reload --port 8000
"""

import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# load .env BEFORE importing routes — routes/trade.py reads env at module level
load_dotenv()

import auth
from routes import trade, price, balance, wallet


def _init_privy_client():
    """Best-effort Privy client init. None if env not configured —
    routes that need it will 503 with a clear message via auth.require_user.

    AsyncPrivyAPI in privy-client 0.5 does NOT accept authorization_key
    (only the sync class does, and that subclass auto-signs requests
    for us). Async users must compute the
    privy-authorization-signature header per-request — that wiring
    lives in privy_send.py and reads PRIVY_AUTH_PRIVATE_KEY directly.

    All we use the AsyncPrivyAPI client for here is read-only ops
    (users.get for wallet lookup, etc.), which only need basic auth
    via app_id/app_secret."""
    app_id = os.getenv("PRIVY_APP_ID", "")
    app_secret = os.getenv("PRIVY_APP_SECRET", "")
    auth_key = os.getenv("PRIVY_AUTH_PRIVATE_KEY", "")
    if not app_id or not app_secret:
        print("• Privy not configured (PRIVY_APP_ID / PRIVY_APP_SECRET missing) — running in single-wallet legacy mode")
        return None
    if not auth_key:
        print(
            "⚠️  PRIVY_AUTH_PRIVATE_KEY missing — delegated tx signing will fail. "
            "Set the PEM/base64 private key on Railway."
        )
    else:
        # Derive and log the PUBLIC key + its SPKI sha256 fingerprint so
        # the operator can verify against the Privy dashboard by
        # fingerprint (the dashboard truncates long PEMs and "did I
        # paste the right one" trips operators up). Privy returns 401
        # "No valid authorization keys" when the env private key
        # doesn't pair with any key registered in a quorum on the app.
        try:
            import hashlib
            from privy_send import _normalize_auth_key
            from cryptography.hazmat.primitives import serialization
            body = _normalize_auth_key(auth_key)
            pem = (
                f"-----BEGIN PRIVATE KEY-----\n{body}\n-----END PRIVATE KEY-----"
            )
            priv = serialization.load_pem_private_key(pem.encode(), password=None)
            spki_der = priv.public_key().public_bytes(
                encoding=serialization.Encoding.DER,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            pub_pem = priv.public_key().public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            ).decode()
            fp = hashlib.sha256(spki_der).hexdigest()
            print(
                "✓ PRIVY_AUTH_PRIVATE_KEY loaded.\n"
                f"  SPKI sha256 fingerprint: {fp}\n"
                "  Public key (paste into Privy dashboard -> Authorization Keys ->\n"
                "  'Register key quorum instead' to make NEXT_PUBLIC_PRIVY_SIGNER_ID\n"
                "  resolve to a quorum that contains this key):\n"
                + pub_pem
            )
        except Exception as e:  # noqa: BLE001
            print(f"⚠️  Could not derive public key from PRIVY_AUTH_PRIVATE_KEY: {e}")
    try:
        from privy import AsyncPrivyAPI  # type: ignore
        client = AsyncPrivyAPI(app_id=app_id, app_secret=app_secret)
        print(f"✓ Privy client initialized for app {app_id}")
        return client
    except Exception as e:
        print(f"⚠️  Privy client init failed: {e}")
        return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Boot order:
      1. Price feed — fully independent of any signer setup.
      2. Privy client — needed for per-user trade execution.
      3. Avantis trader client — best-effort; legacy single-wallet
         fallback for local dev or Privy outage.

    Anything that fails here only disables its own dependent endpoints;
    the rest of the app stays up."""
    await price.start_feed_client()

    privy_client = _init_privy_client()
    if privy_client is not None:
        auth.set_privy_client(privy_client)

    try:
        await trade.init_trader()
    except Exception as e:
        print(
            f"⚠️  Trader init failed — /trade/* will return 503 until env is "
            f"fixed and the server is restarted: {e}"
        )
    try:
        yield
    finally:
        await price.stop_feed_client()


app = FastAPI(
    title="pop-backend",
    description="Leveraged ETH perp game backend (Avantis ZFP wrapper).",
    version="0.3.0",
    lifespan=lifespan,
)

allowed_origins = os.getenv("ALLOWED_ORIGINS", "*").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

app.include_router(trade.router, prefix="/trade", tags=["trade"])
app.include_router(price.router, prefix="/price", tags=["price"])
app.include_router(balance.router, prefix="/balance", tags=["balance"])
app.include_router(wallet.router, prefix="/wallet", tags=["wallet"])


@app.get("/")
def root():
    return {
        "ok": True,
        "service": "pop-backend",
        "phase": "P2 — Avantis SDK live",
        "version": app.version,
    }


@app.get("/health")
def health():
    return {"status": "ok"}
