export interface OpenTradeResponse {
  trade_index: number;
  entry_price: number;
  leverage: number;
  wager_usdc: number;
  house_fee_usdc: number;
  collateral_usdc: number;
  opened_at: string;
  tx_hash: string;
  avantis_pair_index: number;
}

export interface CloseTradeResponse {
  trade_index: number;
  exit_price: number;
  pnl_usdc: number;
  closed_at: string;
  tx_hash: string;
}

export interface ActiveTrade {
  trade_index: number;
  entry_price: number;
  leverage: number;
  wager_usdc: number;
  collateral_usdc: number;
  opened_at: string;
}

export interface BalanceResponse {
  usdc_balance: number;
  wallet_address: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

function isMock(): boolean {
  return !API_URL;
}

let mockTradeState: ActiveTrade | null = null;

async function apiFetch<T>(
  path: string,
  options?: RequestInit,
  getAccessToken?: () => Promise<string | null>,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (getAccessToken) {
    const token = await getAccessToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function openTrade(
  leverage: number,
  wager: number,
  getAccessToken?: () => Promise<string | null>,
): Promise<OpenTradeResponse> {
  if (isMock()) {
    const mock: OpenTradeResponse = {
      trade_index: 0,
      entry_price: 3500,
      leverage,
      wager_usdc: wager,
      house_fee_usdc: wager * 0.008,
      collateral_usdc: wager * 0.992,
      opened_at: new Date().toISOString(),
      tx_hash: "0xstub",
      avantis_pair_index: 1,
    };
    mockTradeState = {
      trade_index: 0,
      entry_price: 3500,
      leverage,
      wager_usdc: wager,
      collateral_usdc: wager * 0.992,
      opened_at: mock.opened_at,
    };
    return mock;
  }
  return apiFetch<OpenTradeResponse>(
    "/trade/open",
    {
      method: "POST",
      body: JSON.stringify({ leverage, wager_usdc: wager }),
    },
    getAccessToken,
  );
}

export async function closeTrade(
  getAccessToken?: () => Promise<string | null>,
): Promise<CloseTradeResponse> {
  if (isMock()) {
    const pnl = (Math.random() - 0.4) * 10;
    mockTradeState = null;
    return {
      trade_index: 0,
      exit_price: 3500 + pnl * 10,
      pnl_usdc: pnl,
      closed_at: new Date().toISOString(),
      tx_hash: "0xstub",
    };
  }
  return apiFetch<CloseTradeResponse>(
    "/trade/close",
    { method: "POST" },
    getAccessToken,
  );
}

export async function forceCloseTrade(
  getAccessToken?: () => Promise<string | null>,
): Promise<CloseTradeResponse> {
  if (isMock()) return closeTrade(getAccessToken);
  return apiFetch<CloseTradeResponse>(
    "/trade/force-close",
    { method: "POST" },
    getAccessToken,
  );
}

export async function getActiveTrade(
  getAccessToken?: () => Promise<string | null>,
): Promise<ActiveTrade | null> {
  if (isMock()) return mockTradeState;
  return apiFetch<ActiveTrade | null>(
    "/trade/active",
    { method: "GET" },
    getAccessToken,
  );
}

export async function getBalance(
  getAccessToken?: () => Promise<string | null>,
): Promise<BalanceResponse> {
  if (isMock()) {
    return { usdc_balance: 100, wallet_address: "0xstub" };
  }
  return apiFetch<BalanceResponse>(
    "/balance",
    { method: "GET" },
    getAccessToken,
  );
}
