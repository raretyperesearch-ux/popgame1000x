-- Track current margin independently from original/open collateral.
--
-- collateral_usdc remains the opening collateral and is used to recover
-- original notional. current_collateral_usdc moves when the player adds fuel,
-- so stale Avantis-empty reconciliations can record the real amount at risk.

alter table public.pg_trades
    add column if not exists current_collateral_usdc numeric(20, 6);

update public.pg_trades
set current_collateral_usdc = collateral_usdc
where current_collateral_usdc is null;
