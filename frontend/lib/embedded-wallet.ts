import type { User } from "@privy-io/react-auth";

/* getEmbeddedConnectedWallet (from @privy-io/react-auth) only sees
   wallets that are *connected* in the browser. The Privy app uses TEE
   embedded wallets, which sign server-side via authorization keys and
   so are never "connected" client-side — they exist purely as entries
   on user.linkedAccounts. Reading the address from there is the only
   reliable way to identify the embedded wallet for funding, balance
   reads, and the X-Wallet-Address header. */
export function getEmbeddedEthereumAddress(
  user: User | null | undefined,
): string | undefined {
  const accounts = user?.linkedAccounts ?? [];
  for (const a of accounts) {
    if (a.type !== "wallet") continue;
    const chainType = (a as { chainType?: string }).chainType;
    if (chainType !== "ethereum") continue;
    const clientType = (a as { walletClientType?: string }).walletClientType;
    if (clientType !== "privy" && clientType !== "privy-v2") continue;
    const address = (a as { address?: string }).address;
    if (address) return address;
  }
  return undefined;
}
