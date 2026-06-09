export type TradeDirection = "long" | "short";

export type TradeOpenStatus = "opening" | "live" | "open" | "closing" | "pending_confirmation" | "failed_open" | "closed";

export interface OpenTradeResponse {
  status?: TradeOpenStatus;
  session_id?: string | null;
  trade_index: number | null;
  avantis_pair_index: number;
  leverage: number;
  wager_usdc: number;
  house_fee_usdc: number;
  collateral_usdc: number;
  entry_price: number | null;
  liquidation_price: number | null;
  opened_at: string;
  tx_hash: string;
  is_long: boolean;
}

export interface TradeStatusResponse {
  status: TradeOpenStatus;
  session_id: string;
  tx_hash: string;
  trade_index: number | null;
  entry_price: number | null;
  liq_price: number | null;
  liquidation_price: number | null;
  error: string | null;
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

export interface AddMarginResponse {
  trade_index: number;
  avantis_pair_index: number;
  amount_usdc: number;
  collateral_usdc: number;
  liquidation_price: number | null;
  tx_hash: string;
  updated_at: string;
}

export interface ActiveTrade {
  trade_index: number;
  avantis_pair_index: number;
  leverage: number;
  wager_usdc: number;
  collateral_usdc: number;
  open_collateral_usdc?: number | null;
  notional_usd?: number | null;
  entry_price: number;
  current_price: number;
  pnl_usdc: number;
  pnl_pct: number;
  liquidation_price: number;
  opened_at: string;
  is_long: boolean;
}

export interface ActiveTradeResponse {
  exists: boolean;
  status: TradeOpenStatus | null;
  wallet: string | null;
  session_id: string | null;
  open_tx_hash: string | null;
  tx_hash: string | null;
  trade_index: number | null;
  avantis_pair_index: number | null;
  leverage: number | null;
  wager_usdc: number | null;
  collateral_usdc: number | null;
  open_collateral_usdc: number | null;
  notional_usd: number | null;
  house_fee_usdc: number | null;
  entry_price: number | null;
  current_price: number | null;
  pnl_usdc: number | null;
  pnl_pct: number | null;
  liq_price: number | null;
  liquidation_price: number | null;
  opened_at: string | null;
  is_long: boolean | null;
  error: string | null;
}

export interface BalanceResponse {
  usdc_balance: number;
  eth_balance: number;
  wallet_address: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";
const MOCK_LIQUIDATION_BUFFER_MULT = 8;

function isMock(): boolean {
  return !API_URL;
}

let mockTradeState: ActiveTrade | null = null;

function mockLiquidationPriceAfterMargin(trade: ActiveTrade, nextCollateral: number): number {
  if (nextCollateral <= 0 || trade.collateral_usdc <= 0) return trade.liquidation_price;
  const fixedNotional = trade.notional_usd ?? (trade.collateral_usdc * trade.leverage);
  const effectiveLeverage = fixedNotional / nextCollateral;
  if (!Number.isFinite(effectiveLeverage) || effectiveLeverage <= 0) return trade.liquidation_price;
  const move = (trade.entry_price / effectiveLeverage) * MOCK_LIQUIDATION_BUFFER_MULT;
  return trade.is_long ? trade.entry_price - move : trade.entry_price + move;
}

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
  direction: TradeDirection = "long",
  getAccessToken?: () => Promise<string | null>,
  walletAddress?: string,
): Promise<OpenTradeResponse> {
  if (isMock()) {
    const entry_price = 3500;
    const is_long = direction === "long";
    const mockLiqMove = (entry_price / leverage) * MOCK_LIQUIDATION_BUFFER_MULT;
    const liquidation_price = is_long
      ? entry_price - mockLiqMove
      : entry_price + mockLiqMove;
    const opened_at = new Date().toISOString();
    const collateral_usdc = wager * 0.975;
    mockTradeState = {
      trade_index: 0,
      avantis_pair_index: 1,
      leverage,
      wager_usdc: wager,
      collateral_usdc,
      open_collateral_usdc: collateral_usdc,
      notional_usd: collateral_usdc * leverage,
      entry_price,
      current_price: entry_price,
      pnl_usdc: 0,
      pnl_pct: 0,
      liquidation_price,
      opened_at,
      is_long,
    };
    return {
      status: "live",
      session_id: "0xstub",
      trade_index: 0,
      avantis_pair_index: 1,
      leverage,
      wager_usdc: wager,
      house_fee_usdc: wager * 0.025,
      collateral_usdc,
      entry_price,
      liquidation_price,
      opened_at,
      tx_hash: "0xstub",
      is_long,
    };
  }
  return apiFetch<OpenTradeResponse>(
    "/trade/open",
    {
      method: "POST",
      body: JSON.stringify({ leverage, wager_usdc: wager, is_long: direction === "long" }),
    },
    getAccessToken,
    walletAddress,
  );
}

export async function getTradeStatus(
  sessionId: string,
  getAccessToken?: () => Promise<string | null>,
  walletAddress?: string,
): Promise<TradeStatusResponse> {
  if (isMock()) {
    return {
      status: mockTradeState ? "live" : "closed",
      session_id: sessionId,
      tx_hash: sessionId,
      trade_index: mockTradeState?.trade_index ?? null,
      entry_price: mockTradeState?.entry_price ?? null,
      liq_price: mockTradeState?.liquidation_price ?? null,
      liquidation_price: mockTradeState?.liquidation_price ?? null,
      error: null,
    };
  }
  return apiFetch<TradeStatusResponse>(
    `/trade/session/${encodeURIComponent(sessionId)}`,
    { method: "GET" },
    getAccessToken,
    walletAddress,
  );
}

export async function closeTrade(
  getAccessToken?: () => Promise<string | null>,
  walletAddress?: string,
  mockExitPrice?: number,
): Promise<CloseTradeResponse> {
  if (isMock()) {
    const entry_price = mockTradeState?.entry_price ?? 3500;
    const wager = mockTradeState?.wager_usdc ?? 5;
    const collateral = mockTradeState?.collateral_usdc ?? wager * 0.975;
    const leverage = mockTradeState?.leverage ?? 100;
    const notional = mockTradeState?.notional_usd ?? (collateral * leverage);
    const exit_price = mockExitPrice && mockExitPrice > 0
      ? mockExitPrice
      : mockTradeState?.current_price ?? entry_price;
    const isLong = mockTradeState?.is_long ?? true;
    const move = isLong ? (exit_price - entry_price) / entry_price : (entry_price - exit_price) / entry_price;
    const gross_pnl_usdc = +((move * notional).toFixed(4));
    const avantis_win_fee_usdc = gross_pnl_usdc > 0 ? +(gross_pnl_usdc * 0.025).toFixed(4) : 0;
    const net_pnl_usdc = gross_pnl_usdc > 0
      ? +(gross_pnl_usdc - avantis_win_fee_usdc).toFixed(4)
      : gross_pnl_usdc;
    mockTradeState = null;
    return {
      trade_index: 0,
      entry_price,
      exit_price,
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
  mockExitPrice?: number,
): Promise<CloseTradeResponse> {
  if (isMock()) {
    const entry_price = mockTradeState?.entry_price ?? 3500;
    const wager = mockTradeState?.wager_usdc ?? 5;
    const collateral = mockTradeState?.collateral_usdc ?? wager * 0.975;
    const exit_price = mockExitPrice && mockExitPrice > 0
      ? mockExitPrice
      : mockTradeState?.liquidation_price ?? entry_price;
    mockTradeState = null;
    return {
      trade_index: 0,
      entry_price,
      exit_price,
      gross_pnl_usdc: -collateral,
      avantis_win_fee_usdc: 0,
      net_pnl_usdc: -collateral,
      was_liquidated: true,
      closed_at: new Date().toISOString(),
      tx_hash: "0xstub",
    };
  }
  return apiFetch<CloseTradeResponse>(
    "/trade/force-close",
    { method: "POST" },
    getAccessToken,
    walletAddress,
  );
}

export async function addTradeMargin(
  amount: number,
  getAccessToken?: () => Promise<string | null>,
  walletAddress?: string,
): Promise<AddMarginResponse> {
  if (isMock()) {
    if (!mockTradeState) throw new Error("no open trade");
    const amount_usdc = Math.max(0, amount);
    const collateral_usdc = mockTradeState.collateral_usdc + amount_usdc;
    const liquidation_price = mockLiquidationPriceAfterMargin(mockTradeState, collateral_usdc);
    mockTradeState = {
      ...mockTradeState,
      wager_usdc: mockTradeState.wager_usdc + amount_usdc,
      collateral_usdc,
      liquidation_price,
    };
    return {
      trade_index: mockTradeState.trade_index,
      avantis_pair_index: mockTradeState.avantis_pair_index,
      amount_usdc,
      collateral_usdc: mockTradeState.collateral_usdc,
      liquidation_price,
      tx_hash: "0xstub-margin",
      updated_at: new Date().toISOString(),
    };
  }
  return apiFetch<AddMarginResponse>(
    "/trade/add-margin",
    {
      method: "POST",
      body: JSON.stringify({ amount_usdc: amount }),
    },
    getAccessToken,
    walletAddress,
  );
}

const NO_ACTIVE_TRADE: ActiveTradeResponse = {
  exists: false,
  status: null,
  wallet: null,
  session_id: null,
  open_tx_hash: null,
  tx_hash: null,
  trade_index: null,
  avantis_pair_index: null,
  leverage: null,
  wager_usdc: null,
  collateral_usdc: null,
  open_collateral_usdc: null,
  notional_usd: null,
  house_fee_usdc: null,
  entry_price: null,
  current_price: null,
  pnl_usdc: null,
  pnl_pct: null,
  liq_price: null,
  liquidation_price: null,
  opened_at: null,
  is_long: null,
  error: null,
};

export async function getActiveTrade(
  getAccessToken?: () => Promise<string | null>,
  walletAddress?: string,
): Promise<ActiveTradeResponse> {
  if (isMock()) {
    if (!mockTradeState) return NO_ACTIVE_TRADE;
    return {
      exists: true,
      status: "live",
      wallet: walletAddress ?? "0xstub",
      session_id: "0xstub",
      open_tx_hash: "0xstub",
      tx_hash: "0xstub",
      trade_index: mockTradeState.trade_index,
      avantis_pair_index: mockTradeState.avantis_pair_index,
      leverage: mockTradeState.leverage,
      wager_usdc: mockTradeState.wager_usdc,
      collateral_usdc: mockTradeState.collateral_usdc,
      open_collateral_usdc: mockTradeState.open_collateral_usdc ?? mockTradeState.collateral_usdc,
      notional_usd: mockTradeState.notional_usd ?? (mockTradeState.collateral_usdc * mockTradeState.leverage),
      house_fee_usdc: mockTradeState.wager_usdc * 0.025,
      entry_price: mockTradeState.entry_price,
      current_price: mockTradeState.current_price,
      pnl_usdc: mockTradeState.pnl_usdc,
      pnl_pct: mockTradeState.pnl_pct,
      liq_price: mockTradeState.liquidation_price,
      liquidation_price: mockTradeState.liquidation_price,
      opened_at: mockTradeState.opened_at,
      is_long: mockTradeState.is_long,
      error: null,
    };
  }
  return apiFetch<ActiveTradeResponse>(
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
    return { usdc_balance: 1000, eth_balance: 0.01, wallet_address: "0xstub" };
  }
  return apiFetch<BalanceResponse>(
    "/balance",
    { method: "GET" },
    getAccessToken,
    walletAddress,
  );
}

export interface HistoryTrade {
  id: string;
  wallet_address: string;
  trade_index: number;
  pair_index: number;
  leverage: number;
  wager_usdc: number;
  collateral_usdc: number;
  entry_price: number;
  liquidation_price: number;
  opened_at: string;
  open_tx_hash: string;
  exit_price: number | null;
  gross_pnl_usdc: number | null;
  avantis_win_fee_usdc: number | null;
  net_pnl_usdc: number | null;
  was_liquidated: boolean | null;
  closed_at: string | null;
  close_tx_hash: string | null;
}

export interface HistoryResponse {
  enabled: boolean;
  wallet_address: string;
  trades: HistoryTrade[];
}

/* Persisted trade history for the calling user. Returns most-recent
   first. Empty list when persistence is disabled on the backend
   (SUPABASE_URL/SERVICE_ROLE_KEY unset) or when the wallet has no
   recorded trades — both cases reach the frontend as an empty array
   from the /history/me handler, so callers don't have to distinguish. */
export async function getHistory(
  limit: number = 5,
  getAccessToken?: () => Promise<string | null>,
  walletAddress?: string,
): Promise<HistoryResponse> {
  if (isMock()) {
    return { enabled: false, wallet_address: walletAddress ?? "", trades: [] };
  }
  return apiFetch<HistoryResponse>(
    `/history/me?limit=${encodeURIComponent(limit)}`,
    { method: "GET" },
    getAccessToken,
    walletAddress,
  );
}

export interface LeaderboardRow {
  wallet_address: string;
  net_pnl_usdc: number;
  trade_count: number;
  liquidations: number;
  last_closed_at: string | null;
}

export interface LeaderboardResponse {
  enabled: boolean;
  rows: LeaderboardRow[];
}

/* Top traders by realized net PnL across closed trades. Backed by the
   pg_trade_leaderboard view in 0001_init.sql. Empty list when
   persistence is disabled (no Supabase env on the backend) or when no
   one has closed a trade yet. */
export async function getLeaderboard(
  limit: number = 20,
  getAccessToken?: () => Promise<string | null>,
  walletAddress?: string,
): Promise<LeaderboardResponse> {
  if (isMock()) {
    return { enabled: false, rows: [] };
  }
  return apiFetch<LeaderboardResponse>(
    `/history/leaderboard?limit=${encodeURIComponent(limit)}`,
    { method: "GET" },
    getAccessToken,
    walletAddress,
  );
}

export interface BmPlayer {
  privy_id: string | null;
  evm_wallet_address: string | null;
  wallet_address: string | null;
  username: string | null;
  created_at?: string | null;
  last_active_at?: string | null;
}

/* Cross-game Hiscore identity. Idempotent — safe to call on every
   login. The backend upserts (privy_id, evm_wallet_address) into the
   shared bm_players table; subsequent calls just bump last_active_at.

   Never throws on transport failures — registration is a best-effort
   side-effect of login, not a gate to playing. The backend will return
   503 if Supabase isn't configured (e.g. local dev), in which case we
   silently no-op. Real errors are logged for debugging. */
export async function registerUser(
  getAccessToken?: () => Promise<string | null>,
  walletAddress?: string,
): Promise<BmPlayer | null> {
  if (isMock()) return null;
  try {
    const res = await apiFetch<{ player: BmPlayer | null }>(
      "/user/register",
      { method: "POST" },
      getAccessToken,
      walletAddress,
    );
    return res.player ?? null;
  } catch (e) {
    console.warn("[user] register failed:", e);
    return null;
  }
}

export async function getMe(
  getAccessToken?: () => Promise<string | null>,
  walletAddress?: string,
): Promise<BmPlayer | null> {
  if (isMock()) return null;
  try {
    const res = await apiFetch<{ player: BmPlayer | null }>(
      "/user/me",
      { method: "GET" },
      getAccessToken,
      walletAddress,
    );
    return res.player ?? null;
  } catch (e) {
    console.warn("[user] /me failed:", e);
    return null;
  }
}

export interface SetUsernameResult {
  ok: boolean;
  player: BmPlayer | null;
  error?: string;
  status?: number;
}

/* Set the player's display name. The username unique constraint spans
   ALL Hiscore games (Swallow Me, Holy Liquid, Scalp Runner), so callers
   need to surface the "taken" case distinctly from generic failure —
   that's what the status field is for. 409 = taken, 400 = validation. */
export async function setUsername(
  username: string,
  getAccessToken?: () => Promise<string | null>,
  walletAddress?: string,
): Promise<SetUsernameResult> {
  if (isMock()) {
    return { ok: true, player: { privy_id: null, evm_wallet_address: null, wallet_address: null, username } };
  }
  try {
    const res = await apiFetch<{ player: BmPlayer | null }>(
      "/user/set-username",
      { method: "POST", body: JSON.stringify({ username }) },
      getAccessToken,
      walletAddress,
    );
    return { ok: true, player: res.player ?? null };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // Parse "API <status>: <body>" without the /s regex flag — tsconfig
    // targets ES2017 and dotAll isn't available there. Split manually
    // so the body can still contain newlines.
    let status = 0;
    let detail = raw;
    const apiMatch = /^API (\d+):/.exec(raw);
    if (apiMatch) {
      status = Number(apiMatch[1]);
      detail = raw.slice(apiMatch[0].length).trimStart();
    }
    const jsonMatch = detail.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as { detail?: string };
        if (parsed.detail) detail = parsed.detail;
      } catch { /* fall through */ }
    }
    return { ok: false, player: null, error: detail, status };
  }
}

export interface WalletStatus {
  address: string;
  delegated: boolean;
  quorum_id: string | null;
  additional: string[];
  expected_signer: string | null;
  error?: string;
}

/* Backend's view of the user's Privy delegation: does this wallet have
   a signer matching PRIVY_EXPECTED_SIGNER_ID? Used after addSigners()
   to confirm the backend would actually be able to sign trades — the
   frontend's own `delegated` flag is the legacy delegateAction signal
   and doesn't flip for the new useSigners flow. */
export async function getWalletStatus(
  getAccessToken?: () => Promise<string | null>,
  walletAddress?: string,
): Promise<WalletStatus | null> {
  if (isMock()) return null;
  return apiFetch<WalletStatus>(
    "/wallet/status",
    { method: "GET" },
    getAccessToken,
    walletAddress,
  );
}
