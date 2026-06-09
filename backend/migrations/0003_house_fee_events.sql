-- 0003 — durable, idempotent house-fee queue for async collection.
--
-- /trade/open inserts one row per successfully opened Avantis trade and
-- returns without waiting for the separate USDC treasury transfer. The
-- unique idempotency_key prevents duplicate collection for the same
-- open/session even if the request or background job is retried.

create table if not exists public.pg_house_fee_events (
    id                 uuid primary key default gen_random_uuid(),
    idempotency_key    text not null unique,
    did                text not null,
    wallet_address     text not null,
    wallet_id          text,
    trade_index        integer,
    session_id         text,
    collateral_usdc    numeric(20, 6) not null,
    fee_usdc           numeric(20, 6) not null,
    treasury_address   text not null,
    status             text not null default 'pending'
        check (status in ('pending', 'processing', 'collected', 'failed')),
    tx_hash            text,
    attempt_count      integer not null default 0,
    last_error         text,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now()
);

create index if not exists pg_house_fee_events_status_created_idx
    on public.pg_house_fee_events (status, created_at);

create index if not exists pg_house_fee_events_wallet_created_idx
    on public.pg_house_fee_events (wallet_address, created_at desc);

create or replace function public.pg_house_fee_events_set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists pg_house_fee_events_set_updated_at on public.pg_house_fee_events;
create trigger pg_house_fee_events_set_updated_at
    before update on public.pg_house_fee_events
    for each row execute function public.pg_house_fee_events_set_updated_at();

create or replace function public.pg_claim_house_fee_event(p_idempotency_key text)
returns setof public.pg_house_fee_events
language sql
security definer
as $$
    update public.pg_house_fee_events
       set status = 'processing',
           attempt_count = attempt_count + 1,
           last_error = null,
           updated_at = now()
     where idempotency_key = p_idempotency_key
       and tx_hash is null
       and (
            status in ('pending', 'failed')
            or (status = 'processing' and updated_at < now() - interval '5 minutes')
       )
     returning *;
$$;

create or replace function public.pg_mark_house_fee_collected(
    p_idempotency_key text,
    p_tx_hash text
)
returns void
language sql
security definer
as $$
    update public.pg_house_fee_events
       set status = 'collected',
           tx_hash = p_tx_hash,
           last_error = null,
           updated_at = now()
     where idempotency_key = p_idempotency_key
       and tx_hash is null;
$$;

create or replace function public.pg_mark_house_fee_failed(
    p_idempotency_key text,
    p_error text
)
returns void
language sql
security definer
as $$
    update public.pg_house_fee_events
       set status = 'failed',
           last_error = p_error,
           updated_at = now()
     where idempotency_key = p_idempotency_key
       and tx_hash is null;
$$;

alter table public.pg_house_fee_events enable row level security;

drop policy if exists "pg_house_fee_events backend only" on public.pg_house_fee_events;
create policy "pg_house_fee_events backend only"
    on public.pg_house_fee_events
    for all
    using (false)
    with check (false);
