# pop-game

10–30s leveraged ETH/USD perp game on Avantis Base. Stick figure jumps off a cliff, rises/falls on live PnL, hit water = liquidated.

## Structure

- `backend/` — Python FastAPI service. Wraps Avantis ZFP perps via avantis-trader-sdk, signs trades via Privy delegated signers, persists to Supabase.
- `frontend/` — Next.js 15 + React 19 app (Privy login, embedded wallet, live price feed, full game loop).

## Stack

- **Avantis** (Base mainnet) — perps DEX, ZFP order type
- **Privy** — embedded wallets + scoped delegated signing (key quorum)
- **Supabase** — Postgres (project: ppqbosrweabdqayawhbw) — *not yet wired*
- **Railway** — backend hosting
- **Vercel** — frontend hosting

## Status

Frontend and backend are both live. Trades route end-to-end: login → fund USDC + ETH (gas) → JUMP → backend opens an Avantis ZFP via the user's delegated signer → PnL streamed back over WS → close or liquidate. Paper-mode fallback runs locally without auth.

Outstanding before full prod launch:
- Supabase persistence (trade history, leaderboard) — env stubs in place, no client yet
- Privy quorum setup is a manual operator step. See `AUDIT_PRIVY_TEE_DELEGATION.md` and `backend/scripts/setup_quorum.py`. Mismatched signer IDs silently 401 with no UI surface.
- E2E tests — `backend/_test_audit_fixes.py` covers unit-level math/SDK mocks only.

See `DEPLOY.md` for prod env-var setup, and `backend/.env.example` / `frontend/.env.example` for required values.
