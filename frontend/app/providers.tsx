"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { base } from "viem/chains";

/* The shared Privy app has Solana login enabled (used by another game),
   so users may carry a Solana wallet on their account when they reach
   us. Without a registered Solana connector, Privy's internal wallet
   iteration hands the base58 address to viem's hex parser and the page
   crashes with InvalidAddressError. Registering the connector quiets
   the SDK without forcing us to support Solana flows in this app. */
const solanaConnectors = toSolanaWalletConnectors();

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
          /* This game is EVM-only on Base — don't auto-create a Solana
             embedded wallet for new logins here. Existing users who
             have one from the sister Solana game still arrive with it,
             which is why externalWallets.solana below is wired up. */
          solana: { createOnLogin: "off" },
        },
        externalWallets: {
          solana: { connectors: solanaConnectors },
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
