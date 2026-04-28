"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { base } from "viem/chains";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
      config={{
        loginMethods: ["email", "google", "wallet"],
        embeddedWallets: {
          /* Every player needs a Privy-managed embedded wallet so the
             backend can sign trades on their behalf via delegated
             signers. "all-users" guarantees this even when they connect
             an external wallet like MetaMask. */
          ethereum: { createOnLogin: "all-users" },
          /* Explicitly OFF — the game is EVM-only on Base, and a Solana
             wallet on the user object causes viem to throw
             InvalidAddressError when other Privy code paths iterate
             linkedAccounts through hex-only address parsers. */
          solana: { createOnLogin: "off" },
        },
        defaultChain: base,
        supportedChains: [base],
        appearance: { theme: "dark", accentColor: "#f4ecd8" },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
