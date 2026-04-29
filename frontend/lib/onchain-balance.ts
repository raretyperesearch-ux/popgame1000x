import { createPublicClient, http, formatUnits, type Address } from "viem";
import { base } from "viem/chains";

/* Reads USDC + ETH for the user's embedded wallet directly from Base.
   This is independent of the backend's /balance endpoint — when
   NEXT_PUBLIC_API_URL is unset (mock mode) or the backend is down, the
   on-chain read still gives the user their real wallet balance instead
   of the mock $100 fallback baked into lib/api.ts. */

const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const RPC_URL =
  process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org";

const client = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

export async function readOnchainBalances(address: Address): Promise<{
  usdcBalance: number;
  ethBalance: number;
}> {
  const [usdcRaw, ethRaw] = await Promise.all([
    client.readContract({
      address: USDC_BASE,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [address],
    }),
    client.getBalance({ address }),
  ]);
  return {
    usdcBalance: Number(formatUnits(usdcRaw, 6)),
    ethBalance: Number(formatUnits(ethRaw, 18)),
  };
}
