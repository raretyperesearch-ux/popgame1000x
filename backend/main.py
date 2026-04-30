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
import persistence
from routes import trade, price, balance, wallet, history


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


async def _maybe_create_key_quorum(privy_client) -> None:
    """If PRIVY_AUTO_CREATE_QUORUM=1 is set on the env (and
    PRIVY_KEY_QUORUM_ID is NOT already set), create a Key Quorum that
    contains the public key derived from PRIVY_AUTH_PRIVATE_KEY, with
    threshold 1, and print the resulting quorum ID. The operator then
    sets PRIVY_KEY_QUORUM_ID, PRIVY_EXPECTED_SIGNER_ID, and the Vercel
    NEXT_PUBLIC_PRIVY_SIGNER_ID to that ID, removes the AUTO_CREATE
    flag, and the next boot is a no-op.

    This exists because Privy's python SDK doesn't expose a list
    endpoint for key quorums — there's no clean way to dedupe — so
    we gate creation behind an explicit operator-set flag instead of
    creating on every boot."""
    if os.getenv("PRIVY_KEY_QUORUM_ID"):
        return
    if os.getenv("PRIVY_AUTO_CREATE_QUORUM", "").lower() not in ("1", "true", "yes"):
        return
    auth_key = os.getenv("PRIVY_AUTH_PRIVATE_KEY", "")
    if not auth_key:
        print("⚠️  AUTO_CREATE_QUORUM requested but PRIVY_AUTH_PRIVATE_KEY is unset")
        return
    try:
        from privy_send import _normalize_auth_key
        from cryptography.hazmat.primitives import serialization
        body = _normalize_auth_key(auth_key)
        pem = (
            f"-----BEGIN PRIVATE KEY-----\n{body}\n-----END PRIVATE KEY-----"
        )
        priv = serialization.load_pem_private_key(pem.encode(), password=None)
        pub_pem = priv.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode()
        q = await privy_client.key_quorums.create(
            public_keys=[pub_pem],
            authorization_threshold=1,
            display_name="popgame1000x backend signer (auto-created)",
        )
        print()
        print("=" * 72)
        print(f"✓ Created Privy Key Quorum: {q.id}")
        print()
        print("ACTION REQUIRED — set these env vars now and remove")
        print("PRIVY_AUTO_CREATE_QUORUM so this doesn't run again:")
        print(f"  Railway   PRIVY_KEY_QUORUM_ID={q.id}")
        print(f"  Railway   PRIVY_EXPECTED_SIGNER_ID={q.id}")
        print(f"  Vercel    NEXT_PUBLIC_PRIVY_SIGNER_ID={q.id}")
        print("=" * 72)
        print()
    except Exception as e:  # noqa: BLE001
        print(f"⚠️  Key quorum auto-create failed: {e}")


async def _validate_quorum_alignment(privy_client) -> None:
    """Boot-time sanity check for the three-env-var trap that produces
    silent 401s on first trade.

    Three independent env vars must all match the same Privy key
    quorum ID:
      - PRIVY_KEY_QUORUM_ID       (Railway, this backend)
      - PRIVY_EXPECTED_SIGNER_ID  (Railway, used by /wallet/status)
      - NEXT_PUBLIC_PRIVY_SIGNER_ID (Vercel, used by frontend addSigners)

    The frontend var has to be checked at frontend build time; we mirror
    it on the backend env so we can at least flag mismatches in the
    logs. We also fetch the quorum from Privy and verify our auth
    key's public PEM is one of the registered keys — that's the
    actual cause of the 401 ("No valid authorization keys") when it
    happens.

    All checks are non-fatal: misalignment doesn't prevent boot, it
    just prints a giant banner so the operator sees it on Railway."""
    quorum_id = os.getenv("PRIVY_KEY_QUORUM_ID", "").strip()
    expected_signer = os.getenv("PRIVY_EXPECTED_SIGNER_ID", "").strip()
    public_signer = os.getenv("NEXT_PUBLIC_PRIVY_SIGNER_ID", "").strip()
    auth_key = os.getenv("PRIVY_AUTH_PRIVATE_KEY", "")

    if not quorum_id and not expected_signer and not public_signer:
        print(
            "⚠️  No PRIVY_KEY_QUORUM_ID / PRIVY_EXPECTED_SIGNER_ID set — "
            "delegated trades will 401 until a quorum is registered. "
            "Run `python -m scripts.setup_quorum` (or set "
            "PRIVY_AUTO_CREATE_QUORUM=1 once) to bootstrap."
        )
        return

    ids = {
        "PRIVY_KEY_QUORUM_ID": quorum_id,
        "PRIVY_EXPECTED_SIGNER_ID": expected_signer,
        "NEXT_PUBLIC_PRIVY_SIGNER_ID": public_signer,
    }
    set_ids = {k: v for k, v in ids.items() if v}
    distinct = set(set_ids.values())
    if len(distinct) > 1:
        print()
        print("=" * 72)
        print("✗ PRIVY SIGNER ID MISMATCH — delegated trades will 401 silently.")
        for k, v in ids.items():
            print(f"  {k}={v or '(unset)'}")
        print("All three vars must equal the SAME Privy key-quorum ID.")
        print("=" * 72)
        print()
        return

    # IDs all match (or only one is set). Now verify our auth key's
    # public PEM is one of the registered keys on that quorum.
    if not quorum_id:
        # Only frontend/expected vars are set; we can't fetch the quorum
        # without the ID. Warn so the operator notices the gap.
        print(
            "⚠️  PRIVY_KEY_QUORUM_ID is unset on the backend even though signer IDs "
            "are configured — set it to the quorum ID so this validator can "
            "verify the auth key's public PEM is registered on it."
        )
        return
    if not auth_key:
        print(
            "⚠️  PRIVY_KEY_QUORUM_ID set but PRIVY_AUTH_PRIVATE_KEY is unset — "
            "backend cannot sign. Set the auth key registered on the quorum."
        )
        return

    try:
        from privy_send import _normalize_auth_key
        from cryptography.hazmat.primitives import serialization

        body = _normalize_auth_key(auth_key)
        pem = f"-----BEGIN PRIVATE KEY-----\n{body}\n-----END PRIVATE KEY-----"
        priv = serialization.load_pem_private_key(pem.encode(), password=None)
        our_pub = priv.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode().strip()

        quorum = await privy_client.key_quorums.get(key_quorum_id=quorum_id)
        keys = getattr(quorum, "authorization_keys", None) or []
        registered_pems = []
        for k in keys:
            pk = (
                getattr(k, "public_key", None)
                or (k.get("public_key") if isinstance(k, dict) else None)
            )
            if isinstance(pk, str):
                registered_pems.append(pk.strip())
        ok = any(_pem_equal(our_pub, p) for p in registered_pems)
        if ok:
            print(
                f"✓ Privy quorum alignment verified — {quorum_id} contains "
                f"the public key derived from PRIVY_AUTH_PRIVATE_KEY."
            )
        else:
            print()
            print("=" * 72)
            print(f"✗ PRIVY AUTH KEY NOT REGISTERED on quorum {quorum_id}")
            print("  Delegated trades WILL 401. Either:")
            print("    a) PRIVY_AUTH_PRIVATE_KEY is wrong for this quorum, or")
            print("    b) The quorum is missing this key. Re-run "
                  "`python -m scripts.setup_quorum` (with the SAME auth key) "
                  "and align all three signer-ID env vars to the new quorum.")
            print(f"  Registered keys on quorum: {len(registered_pems)}")
            print("=" * 72)
            print()
    except Exception as e:  # noqa: BLE001
        print(
            f"⚠️  Privy quorum alignment check skipped — could not fetch "
            f"or compare quorum {quorum_id}: {e}"
        )


def _pem_equal(a: str, b: str) -> bool:
    """Compare two PEMs ignoring whitespace + line-wrap differences. Privy
    sometimes returns PEMs with different newline conventions than what we
    derive locally, so a literal string match would false-negative."""
    norm = lambda s: "".join(s.split())  # noqa: E731 — local one-shot
    return norm(a) == norm(b)


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
        await _maybe_create_key_quorum(privy_client)
        await _validate_quorum_alignment(privy_client)

    persistence.init()

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

def _parse_allowed_origins() -> list[str]:
    """Parse ALLOWED_ORIGINS env into a list. Wildcard ("*") is rejected
    here because allow_credentials=True is required for the
    Authorization + X-Wallet-Address headers, and the CORS spec forbids
    that combination — browsers silently drop the response. When unset,
    fall back to the standard local-dev origins so `npm run dev` and
    `next dev` work out of the box without CORS friction."""
    raw = os.getenv("ALLOWED_ORIGINS", "").strip()
    if not raw:
        print(
            "⚠️  ALLOWED_ORIGINS unset — defaulting to localhost dev origins. "
            "Set ALLOWED_ORIGINS to your Vercel URL in prod."
        )
        return [
            "http://localhost:3000",
            "http://localhost:5173",
            "http://127.0.0.1:3000",
            "http://127.0.0.1:5173",
        ]
    parsed = [o.strip() for o in raw.split(",") if o.strip()]
    if "*" in parsed:
        print(
            "⚠️  ALLOWED_ORIGINS=* is unsafe with credentialed requests. "
            "Replace with explicit origins (Vercel URL, localhost). "
            "Falling back to localhost defaults for safety."
        )
        return [
            "http://localhost:3000",
            "http://localhost:5173",
            "http://127.0.0.1:3000",
            "http://127.0.0.1:5173",
        ]
    return parsed


allowed_origins = _parse_allowed_origins()

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
app.include_router(history.router, prefix="/history", tags=["history"])


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
