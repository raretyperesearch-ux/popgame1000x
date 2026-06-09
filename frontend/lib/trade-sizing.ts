export const HOUSE_FEE_RATE = 0.025;

const configuredMinNotional = Number(
  process.env.NEXT_PUBLIC_AVANTIS_MIN_POSITION_USD
    ?? process.env.NEXT_PUBLIC_MIN_TRADE_NOTIONAL_USD
    ?? 125,
);

export const MIN_TRADE_NOTIONAL_USD = Number.isFinite(configuredMinNotional) && configuredMinNotional > 0
  ? configuredMinNotional
  : 125;

export function houseFeeForWager(wager: number): number {
  return Math.round(wager * HOUSE_FEE_RATE * 10_000) / 10_000;
}

export function effectiveCollateralForWager(wager: number): number {
  return Math.round((wager - houseFeeForWager(wager)) * 10_000) / 10_000;
}

export function liveNotionalFor(wager: number, leverage: number): number {
  return effectiveCollateralForWager(wager) * leverage;
}

export function minWagerForLeverage(leverage: number): number {
  const raw = (MIN_TRADE_NOTIONAL_USD / Math.max(leverage, 1)) / (1 - HOUSE_FEE_RATE);
  return Math.ceil(raw * 100) / 100;
}

export function minLeverageForWager(wager: number): number {
  const collateral = effectiveCollateralForWager(wager);
  if (collateral <= 0) return Number.POSITIVE_INFINITY;
  return Math.ceil(MIN_TRADE_NOTIONAL_USD / collateral);
}

export function isBelowMinPosition(wager: number, leverage: number): boolean {
  return liveNotionalFor(wager, leverage) + 1e-9 < MIN_TRADE_NOTIONAL_USD;
}

export function minPositionHint(wager: number, leverage: number): string {
  const neededLeverage = minLeverageForWager(wager);
  if (neededLeverage <= 500) {
    return `min live ~$${MIN_TRADE_NOTIONAL_USD.toFixed(0)} · use ${neededLeverage}x+ or raise fuel`;
  }
  return `min live ~$${MIN_TRADE_NOTIONAL_USD.toFixed(0)} · fuel $${minWagerForLeverage(leverage).toFixed(2)}+`;
}
