export interface OpenTradeResponse {
  trade_index: number;
  avantis_pair_index: number;
  leverage: number;
  wager_usdc: number;
  house_fee_usdc: number;
  collateral_usdc: number;
  entry_price: number;
  liquidation_price: number;
  opened_at: string;
  tx_hash: string;
}

export interface CloseTradeResponse {
  trade_index: number;
  entry_price: number;
  exit_price: number;
  gross_pnl_usdc: number;
  avantis_win_fee_usdc: number;
  net_pnl_usdc: number;
  was_liquidated: boolean;
  closed_at: string;
  tx_hash: string;
}

export interface ActiveTrade {
  trade_index: number;
  avantis_pair_index: number;
  leverage: number;
  wager_usdc: number;
  collateral_usdc: number;
  entry_price: number;
  current_price: number;
  pnl_usdc: number;
  pnl_pct: number;
  liquidation_price: number;
  opened_at: string;
  /** Rolling borrow fee accrued on the open position, in USDC.
   *  Comes straight from the Avantis SDK (chain-truth). */
  margin_fee_usdc: number;
}

export interface BalanceResponse {
  usdc_balance: number;
  eth_balance: number;
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
  walletAddress?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (getAccessToken) {
    const token = await getAccessToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }
  // Privy users can carry multiple embedded wallets; the topbar/funding
  // flow targets user.wallet.address. Forwarding it pins the backend to
  // the same wallet for balance reads and trade signing.
  if (walletAddress) headers["X-Wallet-Address"] = walletAddress;
  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function openTrade(
  leverage: number,
  wager: number,
  getAccessToken?: () => Promise<string | null>,
  walletAddress?: string,
): Promise<OpenTradeResponse> {
  if (isMock()) {
    const entry_price = 3500;
    // longs liquidate when a 1/lev drop wipes the collateral.
    const liquidation_price = entry_price - entry_price / leverage;
    const opened_at = new Date().toISOString();
    const collateral_usdc = wager * 0.992;
    mockTradeState = {
      trade_index: 0,
      avantis_pair_index: 1,
      leverage,
      wager_usdc: wager,
      collateral_usdc,
      entry_price,
      current_price: entry_price,
      pnl_usdc: 0,
      pnl_pct: 0,
      liquidation_price,
      opened_at,
      margin_fee_usdc: 0,
    };
    return {
      trade_index: 0,
      avantis_pair_index: 1,
      leverage,
      wager_usdc: wager,
      house_fee_usdc: wager * 0.008,
      collateral_usdc,
      entry_price,
      liquidation_price,
      opened_at,
      tx_hash: "0xstub",
    };
  }
  return apiFetch<OpenTradeResponse>(
    "/trade/open",
    {
      method: "POST",
      body: JSON.stringify({ leverage, wager_usdc: wager }),
    },
    getAccessToken,
    walletAddress,
  );
}

export async function closeTrade(
  getAccessToken?: () => Promise<string | null>,
  walletAddress?: string,
): Promise<CloseTradeResponse> {
  if (isMock()) {
    const entry_price = mockTradeState?.entry_price ?? 3500;
    const wager = mockTradeState?.wager_usdc ?? 5;
    const net_pnl_usdc = +((Math.random() - 0.4) * wager * 2).toFixed(4);
    const gross_pnl_usdc = net_pnl_usdc > 0 ? +(net_pnl_usdc / 0.975).toFixed(4) : net_pnl_usdc;
    const avantis_win_fee_usdc = net_pnl_usdc > 0 ? +(gross_pnl_usdc * 0.025).toFixed(4) : 0;
    mockTradeState = null;
    return {
      trade_index: 0,
      entry_price,
      exit_price: entry_price + (net_pnl_usdc / wager) * (entry_price * 0.01),
      gross_pnl_usdc,
      avantis_win_fee_usdc,
      net_pnl_usdc,
      was_liquidated: false,
      closed_at: new Date().toISOString(),
      tx_hash: "0xstub",
    };
  }
  return apiFetch<CloseTradeResponse>(
    "/trade/close",
    { method: "POST" },
    getAccessToken,
    walletAddress,
  );
}

export async function forceCloseTrade(
  getAccessToken?: () => Promise<string | null>,
  walletAddress?: string,
): Promise<CloseTradeResponse> {
  if (isMock()) return closeTrade(getAccessToken, walletAddress);
  return apiFetch<CloseTradeResponse>(
    "/trade/force-close",
    { method: "POST" },
    getAccessToken,
    walletAddress,
  );
}

export async function getActiveTrade(
  getAccessToken?: () => Promise<string | null>,
  walletAddress?: string,
): Promise<ActiveTrade | null> {
  if (isMock()) return mockTradeState;
  return apiFetch<ActiveTrade | null>(
    "/trade/active",
    { method: "GET" },
    getAccessToken,
    walletAddress,
  );
}

export async function getBalance(
  getAccessToken?: () => Promise<string | null>,
  walletAddress?: string,
): Promise<BalanceResponse> {
  if (isMock()) {
    return { usdc_balance: 100, eth_balance: 0.01, wallet_address: "0xstub" };
  }
  return apiFetch<BalanceResponse>(
    "/balance",
    { method: "GET" },
    getAccessToken,
    walletAddress,
  );
}
