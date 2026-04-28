# Deploy

End-to-end deploy guide. ~15 minutes once you have the accounts.

```
                ┌─────────────────────┐
                │ Vercel (frontend)   │
                │ Next.js auto-build  │
                │ NEXT_PUBLIC_API_URL │
                └──────────┬──────────┘
                           │  WSS / HTTPS
                           ▼
                ┌─────────────────────┐
                │ Railway (backend)   │
                │ FastAPI + uvicorn   │
                │ Avantis SDK + Lazer │
                └──────────┬──────────┘
                           │
                           ▼
                  Avantis Lazer (Pyth)
                  + Base RPC (mainnet)
```

## Prerequisites

- GitHub account with this repo
- Railway account (https://railway.app) — sign in with GitHub
- Vercel account (https://vercel.com) — sign in with GitHub
- A Base mainnet wallet with USDC for the trader (only required for real
  trade execution; price feed alone needs no wallet)

## 1 — Backend on Railway

1. Railway → **New Project** → **Deploy from GitHub repo** → pick this repo.
2. After the project lands, open **Settings → Service**:
   - **Root Directory**: `backend`
   - Builder: `Dockerfile` (auto-detected from `backend/railway.json`)
3. Open **Variables** and add:

   | Key | Value | Notes |
   |---|---|---|
   | `PRIVATE_KEY` | `0x…` | Hex private key for the trader wallet |
   | `TREASURY_ADDRESS` | `0x…` | House-fee recipient address |
   | `BASE_RPC_URL` | `https://mainnet.base.org` | Or your own Alchemy/Infura RPC |
   | `ALLOWED_ORIGINS` | `https://YOUR-VERCEL-URL.vercel.app` | Comma-sep if multiple. Set after the Vercel deploy. |
   | `ETH_LAZER_FEED_ID` | `2` | Optional; only set if Avantis re-numbers |
   | `PRICE_FEED_DISABLE` | (unset) | Set to `1` to skip the FeedClient (testing only) |

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
4. Click **JUMP** — the character runs and lifts off. If your wallet
   has USDC, a real Avantis position opens (you'll see a pending tx in
   the Railway logs). If not, the catch falls through to optimistic
   mode and the game still plays for that round (warning logged in the
   browser console).

## Local development

You don't need any of the above for local dev. See the backend
`.env.example` and `frontend/.env.example`. Quick start:

```bash
# Backend
cd backend && pip install -r requirements.txt
cp .env.example .env  # fill in PRIVATE_KEY, TREASURY_ADDRESS
uvicorn main:app --port 8000

# Frontend (separate terminal)
cd frontend && npm install
cp .env.example .env.local  # set NEXT_PUBLIC_API_URL=http://localhost:8000
npm run dev
```

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
