# pop-game

10-30s leveraged ETH/USD perp game on Avantis Base. Stick figure jumps off a cliff, rises/falls on live PnL, hit water = liquidated.

## Structure

- `backend/` — Python FastAPI service. Wraps Avantis ZFP perps via avantis-trader-sdk, signs trades via Privy delegated signers (P3+), persists to Supabase.
- `frontend/` — Next.js app (Phase 4, not yet built).

## Stack

- **Avantis** (Base mainnet) — perps DEX, ZFP order type
- **Privy** — embedded wallets + scoped delegated signing
- **Supabase** — Postgres (project: ppqbosrweabdqayawhbw)
- **Railway** — backend hosting
- **Vercel** — frontend hosting

## Status

Phase 2 — backend has live Avantis SDK integration. See `backend/main.py` for the FastAPI entry point and `backend/.env.example` for required env vars.
