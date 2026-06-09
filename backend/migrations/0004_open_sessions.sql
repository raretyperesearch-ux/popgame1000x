-- 0004 — durable optimistic-open sessions.
--
-- /trade/open can return while Avantis is still exposing the new position.
-- The backend already kept that "opening" state in memory, but a Railway
-- restart during the window lost the session and forced recovery to infer
-- everything from chain. This table makes the tx hash/session durable.

create table if not exists public.pg_open_sessions (
    session_id                text primary key,
    did                       text not null,
    wallet_address            text not null,
    wallet_id                 text not null,
    tx_hash                   text not null,
    status                    text not null default 'opening',
    trade_index               integer,
    pair_index                integer not null,
    leverage                  integer not null,
    wager_usdc                numeric(20, 6) not null,
    house_fee_usdc            numeric(20, 6) not null,
    collateral_usdc           numeric(20, 6) not null,
    treasury_address          text,
    is_long                   boolean not null default true,
    entry_price               numeric(20, 6),
    liquidation_price         numeric(20, 6),
    house_fee_idempotency_key text,
    error                     text,
    opened_at                 timestamptz not null,
    inserted_at               timestamptz not null default now(),
    updated_at                timestamptz not null default now()
);

create index if not exists pg_open_sessions_wallet_status_idx
    on public.pg_open_sessions (wallet_address, status, opened_at desc);

drop trigger if exists pg_open_sessions_set_updated_at on public.pg_open_sessions;
create trigger pg_open_sessions_set_updated_at
    before update on public.pg_open_sessions
    for each row execute function public.pg_trades_set_updated_at();

alter table public.pg_open_sessions enable row level security;

grant select on table public.pg_open_sessions to anon, authenticated;
grant all on table public.pg_open_sessions to service_role;

drop policy if exists "pg_open_sessions read public" on public.pg_open_sessions;
create policy "pg_open_sessions read public"
    on public.pg_open_sessions for select
    to anon, authenticated
    using (true);
