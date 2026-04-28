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
from routes import trade, price, balance


def _init_privy_client():
    """Best-effort Privy client init. None if env not configured —
    routes that need it will 503 with a clear message via auth.require_user."""
    app_id = os.getenv("PRIVY_APP_ID", "")
    app_secret = os.getenv("PRIVY_APP_SECRET", "")
    auth_key = os.getenv("PRIVY_AUTH_PRIVATE_KEY", "") or None
    if not app_id or not app_secret:
        print("• Privy not configured (PRIVY_APP_ID / PRIVY_APP_SECRET missing) — running in single-wallet legacy mode")
        return None
    try:
        from privy import PrivyAPI  # type: ignore
        client = PrivyAPI(
            app_id=app_id,
            app_secret=app_secret,
            authorization_private_key=auth_key,
        ) if auth_key else PrivyAPI(app_id=app_id, app_secret=app_secret)
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
