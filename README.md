# pop-game

10–30s leveraged ETH/USD perp game on Avantis Base. Stick figure jumps off a cliff, rises/falls on live PnL, hit water = liquidated.

## Structure

- `backend/` — Python FastAPI service. Wraps Avantis ZFP perps via avantis-trader-sdk, signs trades via Privy delegated signers, persists to Supabase.
- `frontend/` — Next.js 15 + React 19 app (Privy login, embedded wallet, live price feed, full game loop).

## Stack

- **Avantis** (Base mainnet) — perps DEX, ZFP order type
- **Privy** — embedded wallets + scoped delegated signing (key quorum)
- **Supabase** — Postgres (project: ppqbosrweabdqayawhbw) — trade history + leaderboard
- **Railway** — backend hosting
- **Vercel** — frontend hosting

## Status

Frontend and backend are both live. Trades route end-to-end: login → fund USDC + ETH (gas) → JUMP → backend opens an Avantis ZFP via the user's delegated signer → PnL streamed back over WS → close or liquidate. Paper-mode fallback runs locally without auth.

Trade history + leaderboard are persisted to Supabase via the service-role key (best-effort — Supabase outages don't block trades). Apply `backend/migrations/0001_init.sql` once on the project, then set `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` on Railway. Read endpoints: `GET /history/me`, `GET /history/leaderboard`.

Privy quorum alignment is now validated at backend boot — a mismatch between `PRIVY_KEY_QUORUM_ID`, `PRIVY_EXPECTED_SIGNER_ID`, and `NEXT_PUBLIC_PRIVY_SIGNER_ID` (or an auth key not registered on the quorum) prints a loud banner instead of silently 401ing on first trade. The frontend also pings `/wallet/status` after `addSigners` so a backend-side mismatch surfaces in the avatar menu.

Outstanding before full prod launch:
- E2E tests — `backend/_test_audit_fixes.py` covers unit-level math/SDK mocks only.

See `DEPLOY.md` for prod env-var setup, and `backend/.env.example` / `frontend/.env.example` for required values.
