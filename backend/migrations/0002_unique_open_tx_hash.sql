-- 0002 — fix the open-overwrite bug.
--
-- THE BUG
-- Avantis recycles trade_index per wallet on close, so the original
-- (wallet_address, trade_index) unique index from 0001 caused every
-- reopen of a recycled index to silently overwrite the previous row
-- via the upsert in record_open(). Result in prod (May 2025): an
-- active scalper with 4+ closed trades ended up with only the most
-- recent surviving in pg_trades.
--
-- THE FIX
-- open_tx_hash is globally unique on-chain and is the natural conflict
-- key. After this migration, record_open's upsert keys on it and each
-- real trade gets its own row.
--
-- Belt-and-suspenders: a partial unique on (wallet_address,
-- trade_index) WHERE closed_at IS NULL preserves the "at most one
-- open per (wallet, index) at a time" invariant that record_close
-- relies on for its `closed_at IS NULL` match.
--
-- DEPLOY ORDER (READ THIS BEFORE APPLYING)
-- The old (wallet_address, trade_index) unique index MUST be dropped
-- here, not in a follow-up. If it stayed, the new code's upsert with
-- on_conflict="open_tx_hash" would still hit 23505 against the old
-- index whenever a recycled trade_index collided — failing every
-- record_open in exactly the scenario this fix is for.
--
-- Side effect: there is a brief deploy window where one of these will
-- happen:
--   (a) old pod runs after migration  → upsert 42P10s ("no unique
--       constraint matching ON CONFLICT spec for
--       wallet_address,trade_index"); record_open fails silently.
--   (b) new pod runs before migration → upsert 42P10s ("no unique
--       constraint matching ON CONFLICT spec for open_tx_hash");
--       record_open fails silently.
--
-- Both are tolerable: persistence.record_open() catches and logs
-- without re-raising, so trades still execute on-chain. Recommended
-- procedure to minimize the window:
--   1. Apply this migration on the project.
--   2. Immediately deploy the matching backend code.
-- Total miss window: ~30-90s of trade history on Railway redeploy.
--
-- Idempotent: re-runs are safe.

drop index if exists public.pg_trades_wallet_idx_uniq;

create unique index if not exists pg_trades_open_tx_hash_uniq
    on public.pg_trades (open_tx_hash);

create unique index if not exists pg_trades_one_open_per_index
    on public.pg_trades (wallet_address, trade_index)
    where closed_at is null;
