-- popgame1000x — initial Supabase schema for trade history + leaderboard.
--
-- Apply once on the project (Supabase SQL editor or `supabase db push`).
-- Idempotent: re-runs are safe.
--
-- All objects are prefixed `pg_*` so this can land in a shared Supabase
-- project (e.g. BuyMoney's, which already uses bm_* / sm_*) without
-- colliding with other apps.
--
-- The backend writes via the SERVICE_ROLE_KEY which bypasses RLS — these
-- policies only matter if you ever expose the table to the anon key
-- (e.g. a public leaderboard page calling Supabase directly).

create extension if not exists pgcrypto;

create table if not exists public.pg_trades (
    id                       uuid primary key default gen_random_uuid(),
    -- Privy DID of the trader (`did:privy:...`). Always set, even for
    -- the legacy single-wallet local-dev path (`local-dev`).
    did                      text        not null,
    -- Lowercased Ethereum address of the embedded wallet that opened
    -- the trade. Lowercased so leaderboard de-duplication is exact.
    wallet_address           text        not null,
    -- Avantis on-chain trade index (recycled per wallet on close).
    trade_index              integer     not null,
    pair_index               integer     not null,
    leverage                 integer     not null,
    wager_usdc               numeric(20, 6) not null,
    house_fee_usdc           numeric(20, 6) not null,
    collateral_usdc          numeric(20, 6) not null,
    entry_price              numeric(20, 6) not null,
    liquidation_price        numeric(20, 6) not null,
    opened_at                timestamptz not null,
    open_tx_hash             text        not null,
    -- Set on close. Nullable so an open row can sit while the trade is
    -- still in flight. closed_at is the SERVER timestamp of the close
    -- response, not the on-chain block time.
    exit_price               numeric(20, 6),
    gross_pnl_usdc           numeric(20, 6),
    avantis_win_fee_usdc     numeric(20, 6),
    net_pnl_usdc             numeric(20, 6),
    was_liquidated           boolean,
    closed_at                timestamptz,
    close_tx_hash            text,
    inserted_at              timestamptz not null default now(),
    updated_at               timestamptz not null default now()
);

-- A given wallet only has one open trade at a time, but Avantis recycles
-- trade indices on close, so (wallet_address, trade_index) is the
-- natural unique upsert key. The backend's record_open() targets this.
create unique index if not exists pg_trades_wallet_idx_uniq
    on public.pg_trades (wallet_address, trade_index);

create index if not exists pg_trades_did_opened_at_idx
    on public.pg_trades (did, opened_at desc);

create index if not exists pg_trades_wallet_opened_at_idx
    on public.pg_trades (wallet_address, opened_at desc);

-- Auto-bump updated_at on close patches.
create or replace function public.pg_trades_set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists pg_trades_set_updated_at on public.pg_trades;
create trigger pg_trades_set_updated_at
    before update on public.pg_trades
    for each row execute function public.pg_trades_set_updated_at();

-- Leaderboard view: sum realized net PnL per wallet over CLOSED trades.
-- The backend reads this for /history/leaderboard. Keeping the
-- aggregation in SQL avoids hauling the full table over the wire on
-- every leaderboard hit.
create or replace view public.pg_trade_leaderboard as
    select
        wallet_address,
        sum(net_pnl_usdc)::numeric(20, 6)            as net_pnl_usdc,
        count(*)::integer                            as trade_count,
        sum(case when was_liquidated then 1 else 0 end)::integer
                                                      as liquidations,
        max(closed_at)                               as last_closed_at
    from public.pg_trades
    where closed_at is not null and net_pnl_usdc is not null
    group by wallet_address;

-- RLS: enable, but write nothing for the anon key. The backend uses the
-- SERVICE_ROLE_KEY which bypasses RLS, so these policies only matter
-- if you ever expose the anon key to a frontend that reads directly.
alter table public.pg_trades enable row level security;

drop policy if exists "pg_trades read public" on public.pg_trades;
create policy "pg_trades read public"
    on public.pg_trades for select
    to anon, authenticated
    using (true);
