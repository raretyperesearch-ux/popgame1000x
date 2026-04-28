# Deploy

End-to-end deploy guide for the multi-user game. ~30 minutes once you have
the accounts.

```
                ┌─────────────────────┐
                │ Vercel (frontend)   │
                │ Next.js auto-build  │
                │ Privy login + UI    │
                └──────────┬──────────┘
                           │  WSS / HTTPS
                           ▼
                ┌─────────────────────┐
                │ Railway (backend)   │
                │ FastAPI + uvicorn   │
                │ Avantis SDK + Lazer │
                │ Privy delegated sig │
                └─────┬────────────┬──┘
                      │            │
                      ▼            ▼
            Avantis Lazer    Privy REST API
            + Base RPC       (signs as user)
```

Each player gets their own Privy-managed embedded wallet on Base. When
they click JUMP, the backend uses Privy's delegated-signer API to sign
the Avantis trade as that user — no per-trade wallet popup. Players
fund their own wallets with USDC + a tiny bit of ETH for gas.

## Prerequisites

- GitHub account with this repo
- Privy account with this app already configured (app ID
  `cmm1yn38100dm0cldx1mcej4t` per `frontend/.env.example`)
- Railway account (https://railway.app) — sign in with GitHub
- Vercel account (https://vercel.com) — sign in with GitHub

## 0 — Privy dashboard setup

Before deploying, configure the Privy app for delegated signing:

1. **App ID** — already set; copy it from Privy → App Settings → Basics.
2. **App secret** — Privy → App Settings → API Keys → "App Secret".
   Copy this; you'll paste it into Railway as `PRIVY_APP_SECRET`.
3. **Verification key** — Privy → App Settings → JWKS / Verification Key.
   Copy the PEM-formatted public key. This is what the backend uses to
   verify access tokens. Paste into Railway as `PRIVY_VERIFICATION_KEY`.
4. **Embedded wallets** — Privy → Embedded Wallets → set "Create wallets"
   to **"all users"** (matches frontend `createOnLogin: "all-users"`).
5. **Authorization key** — generate locally with:

   ```bash
   openssl ecparam -name secp256r1 -genkey -noout -out privy-auth.pem
   openssl ec -in privy-auth.pem -pubout -out privy-auth.pub.pem
   cat privy-auth.pem        # the private key — Railway env
   cat privy-auth.pub.pem    # the public key — Privy dashboard
   ```

   Privy → App Settings → Authorization Keys → "Add key" → paste the
   public PEM. Paste the **private** PEM into Railway as
   `PRIVY_AUTH_PRIVATE_KEY`.
6. **Delegation policy** *(recommended for safety)* — Privy → Policies →
   "New policy" → restrict the authorization key's permissions to:
   - Method: `eth_sendTransaction`
   - Allowed contracts: the Avantis trading contract address on Base
     (find it in the Avantis docs or extract from a previous trade tx).

   Without a policy, the auth key can sign ANY transaction on behalf of
   any user who has delegated to your app. The policy locks this down
   to "place Avantis trades only".

## 1 — Backend on Railway

1. Railway → **New Project** → **Deploy from GitHub repo** → pick this repo.
2. After the project lands, open **Settings → Service**:
   - **Root Directory**: `backend`
   - Builder: `Dockerfile` (auto-detected from `backend/railway.json`)
3. Open **Variables** and add:

   | Key | Value | Notes |
   |---|---|---|
   | `BASE_RPC_URL` | `https://mainnet.base.org` | Or your own Alchemy/Infura RPC |
   | `ALLOWED_ORIGINS` | `https://YOUR-VERCEL-URL.vercel.app` | Comma-sep if multiple. Set after the Vercel deploy. |
   | `PRIVY_APP_ID` | `cmm1yn38100dm0cldx1mcej4t` | Same as frontend |
   | `PRIVY_APP_SECRET` | `…` | From step 0.2 above |
   | `PRIVY_VERIFICATION_KEY` | (PEM) | From step 0.3 above |
   | `PRIVY_AUTH_PRIVATE_KEY` | (PEM) | From step 0.5 above |
   | `PRIVY_POLICY_ID` | `…` | From step 0.6 if you created one |
   | `TREASURY_ADDRESS` | `0x…` | House-fee recipient address |
   | `ETH_LAZER_FEED_ID` | `2` | Optional; only set if Avantis re-numbers |
   | `PRICE_FEED_DISABLE` | (unset) | Set to `1` to skip the FeedClient (testing only) |
   | `AUTH_DISABLE` | (unset) | Local-dev convenience. Never set in prod. |
   | `PRIVATE_KEY` | (unset in prod) | Legacy single-wallet env. Leave empty when Privy is configured — falls back to single-wallet only if Privy vars are missing. |

4. Click **Deploy**. Watch the build logs — you should see:

   ```
   ✓ Avantis FeedClient started (lazer feed id=2)
   ✓ Avantis ready: pair=ETH/USD index=2 trader=0x…
   INFO: Uvicorn running on http://0.0.0.0:8000
   ```

5. Settings → **Networking** → **Generate Domain**. Copy the public URL
   (e.g. `https://pop-backend-production.up.railway.app`).
6. Verify: `curl https://YOUR-RAILWAY-URL/health` → `{"status":"ok"}`.

## 2 — Frontend on Vercel

1. Vercel → **Add New → Project** → import this repo.
2. **Root Directory**: `frontend`
3. Framework: Next.js (auto-detected). Leave defaults.
4. **Environment Variables**:

   | Key | Value |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | `https://YOUR-RAILWAY-URL` *(no trailing slash)* |
   | `NEXT_PUBLIC_PRIVY_APP_ID` | `cmm1yn38100dm0cldx1mcej4t` *(or your own)* |

5. Click **Deploy**. After the build finishes, copy the production URL.
6. Go back to Railway → backend → Variables → update `ALLOWED_ORIGINS`
   to your Vercel URL, then redeploy the backend (Railway will hot-reload
   on env change).

## 3 — Verify end-to-end

Open the Vercel URL and:

1. Open DevTools → **Network → WS**. You should see
   `wss://YOUR-RAILWAY-URL/price/stream` with status `101 Switching
   Protocols` and the **Messages** tab filling with
   `{eth_price, timestamp, active_trade}` payloads ~once per second.
2. The chart should follow the real ETH/USD price from Avantis Lazer.
3. The race flag on the right edge should track price moves.
4. Click **Connect** (or whatever the Privy login button reads as) —
   Privy modal opens. Sign in via email / Google / wallet. You'll get
   an embedded wallet on Base.
5. **First-time delegation modal** — once after login, Privy asks you
   to approve the app to place trades on your behalf. Approve. From
   here on, jumps fire silently with no further popups.
6. Click **JUMP**. If your embedded wallet has USDC + a tiny bit of
   ETH for gas, a real Avantis position opens (you'll see the pending
   tx in the Railway logs). If your wallet is empty, the funding banner
   should appear telling you what's missing.

## Local development

For local dev you can skip Privy setup entirely with `AUTH_DISABLE=1`
and the legacy single-wallet env (your trades come from one wallet
defined in `.env`). Useful for quickly iterating on game mechanics
without the full multi-user auth flow.

```bash
# Backend
cd backend && pip install -r requirements.txt
cp .env.example .env  # fill in PRIVATE_KEY, TREASURY_ADDRESS, AUTH_DISABLE=1
uvicorn main:app --port 8000

# Frontend (separate terminal)
cd frontend && npm install
cp .env.example .env.local  # set NEXT_PUBLIC_API_URL=http://localhost:8000
npm run dev
```

For local dev WITH Privy auth (closer to prod), drop `AUTH_DISABLE` and
set the Privy vars from step 0 above in `backend/.env`. You'll need to
log in via Privy in the browser to get a JWT and the backend will
verify it just like in prod.

The backend's lifespan is decoupled — even if `init_trader()` fails
(bad/missing key, slow RPC), the price feed still starts, so the chart
will show real ETH prices and `/trade/*` returns 503 with a clear
message until the env is fixed.

## Cost

- Railway: ~$5/mo for the always-on hobby plan
- Vercel: free tier covers this app comfortably
- Base RPC: free with the public endpoint; switch to Alchemy/Infura
  for higher reliability if you start seeing rate-limit errors

## Troubleshooting

**Frontend shows mock walk near $3500** — `NEXT_PUBLIC_API_URL` not set
in Vercel. Add it and redeploy.

**WS connects but no price ticks** — Backend FeedClient failed to start
(check Railway logs for `Failed to start FeedClient`). Most common
cause: the `avantis-trader-sdk` install failed during build.

**WS gets 502 / `connection refused`** — Backend crashed or `ALLOWED_ORIGINS`
is missing your Vercel domain. Check Railway logs and update.

**JUMP doesn't fire any trade** — Open DevTools console. If you see
`[trade] openTrade failed`, the backend is unreachable; the game still
plays in optimistic mode but no on-chain trade executes. Verify the
backend `/health` endpoint with curl.

**On-chain trade fails with insufficient USDC** — fund the trader
wallet with USDC on Base.
