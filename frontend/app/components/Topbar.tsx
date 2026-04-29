"use client";

import { useState, useRef, useEffect } from "react";
import {
  usePrivy,
  useSigners,
  useFundWallet,
} from "@privy-io/react-auth";
import { base } from "viem/chains";
import { sounds } from "@/lib/sounds";
import { getEmbeddedEthereumAddress } from "@/lib/embedded-wallet";

interface TopbarProps {
  balance: number;
  ethBalance: number | null;
  balanceLoading?: boolean;
  onHelpClick: () => void;
  onError?: (msg: string) => void;
}

/* The Privy signerId is generated when the authorization key's public PEM
   is registered in the Privy dashboard. It pairs requests from the
   frontend's addSigners() call with the matching backend's
   PRIVY_AUTH_PRIVATE_KEY so server-side trade execution is authorized. */
const PRIVY_SIGNER_ID = process.env.NEXT_PUBLIC_PRIVY_SIGNER_ID || "";

export default function Topbar({ balance, ethBalance, balanceLoading = false, onHelpClick, onError }: TopbarProps) {
  const { login, logout, authenticated, user, ready, getAccessToken } = usePrivy();
  const { addSigners, removeSigners } = useSigners();
  const { fundWallet } = useFundWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [delegating, setDelegating] = useState(false);
  const [diag, setDiag] = useState<string | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  // Set to true after addSigners returns ok in the same session, in
  // case Privy's user.linkedAccounts hasn't refreshed yet — the
  // wallet's `delegated: boolean` field is the OLD delegateAction
  // signal and may not flip for the new useSigners flow.
  const [locallyDelegated, setLocallyDelegated] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setMuted(sounds.isMuted()); }, []);
  const onMuteClick = () => {
    const m = sounds.toggleMute();
    setMuted(m);
    if (!m) sounds.play("ui-click");
  };

  /* This is the in-game wallet — always the Privy embedded one, never
     a connected external wallet (Rabby/MetaMask/etc). The embedded
     wallet is what addSigners delegates to, so it's the only wallet
     the backend can sign trades on behalf of. The avatar, balance,
     funding flow, and X-Wallet-Address header all key off this. The
     external login wallet (if any) is just for auth identity. */
  const walletAddress = getEmbeddedEthereumAddress(user);
  const truncated = walletAddress
    ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
    : null;
  const initials = walletAddress
    ? walletAddress.slice(2, 4).toUpperCase()
    : "•";

  useEffect(() => {
    setLocallyDelegated(false);
  }, [walletAddress]);

  /* `delegated: true` is the LEGACY delegateAction flag — it's not set
     by the new useSigners session-signer flow on TEE wallets. We treat
     it as one signal among others: a true value here means definitively
     delegated; a false value is inconclusive, so we fall back to the
     locallyDelegated flag set in onDelegate after a successful
     addSigners call. */
  const linkedSaysDelegated = Boolean(
    user?.linkedAccounts?.some(
      (a) =>
        a.type === "wallet" &&
        "address" in a &&
        a.address === walletAddress &&
        "delegated" in a &&
        (a as unknown as { delegated?: boolean }).delegated === true,
    ),
  );
  const isDelegated = linkedSaysDelegated || locallyDelegated;
  const hasGas = ethBalance === null || ethBalance >= 0.0005;

  /* One-time delegation prompt after login. Fires only when:
     - user is authenticated
     - they have an embedded Ethereum wallet
     - delegation hasn't been granted yet
     - a NEXT_PUBLIC_PRIVY_SIGNER_ID is configured (matches a registered
       authorization key in the Privy dashboard)
     The Privy modal handles consent UX; the user can decline and
     try again later via the menu. */
  useEffect(() => {
    if (!ready || !authenticated || !walletAddress) return;
    if (isDelegated) return;
    if (delegating) return;
    if (!PRIVY_SIGNER_ID) {
      console.warn(
        "[delegate] NEXT_PUBLIC_PRIVY_SIGNER_ID not set — backend cannot sign trades on the user's behalf until this is configured",
      );
      return;
    }
    let cancelled = false;
    setDelegating(true);
    addSigners({
      address: walletAddress,
      signers: [{ signerId: PRIVY_SIGNER_ID, policyIds: [] }],
    })
      .then((result) => {
        console.log("[delegate] addSigners ok. signerId we sent:", PRIVY_SIGNER_ID, "result:", result);
        setLocallyDelegated(true);
      })
      .catch((e) => console.warn("[delegate] declined or failed:", e))
      .finally(() => {
        if (!cancelled) setDelegating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, walletAddress, isDelegated, addSigners, delegating]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [menuOpen]);

  const onDelegate = async () => {
    if (!walletAddress) {
      onError?.("Embedded wallet hasn't loaded yet. Wait a sec and retry.");
      return;
    }
    if (!PRIVY_SIGNER_ID) {
      onError?.(
        "Server signer ID not configured. NEXT_PUBLIC_PRIVY_SIGNER_ID is missing on Vercel.",
      );
      return;
    }
    setMenuOpen(false);
    setDelegating(true);
    try {
      // addSigners is headless for TEE wallets — it shouldn't open a
      // popup. If it hangs past 15s, something's wrong (signerId not
      // recognized server-side, wallet proxy not initialized, etc.) —
      // race against a timeout so the UI can't get stuck on "waiting".
      const result = await Promise.race([
        addSigners({
          address: walletAddress,
          // policyIds: [] is explicit per Privy docs — opts out of any
          // mandatory policy enforcement that might otherwise reject
          // the call when the dashboard quorum has none configured.
          signers: [{ signerId: PRIVY_SIGNER_ID, policyIds: [] }],
        }),
        new Promise<never>((_, rej) =>
          setTimeout(
            () => rej(new Error("addSigners timed out after 15s — Privy didn't respond. If your app isn't on TEE execution mode, addSigners needs UI it never opens. Migrate to TEE in Privy dashboard -> Wallets -> Advanced.")),
            15000,
          ),
        ),
      ]);
      // Dump the result so we can verify in DevTools console exactly
      // which signer Privy registered. Pinpoints SIGNER_ID env mismatch
      // vs other failure modes from one click.
      console.log("[delegate] addSigners ok. signerId we sent:", PRIVY_SIGNER_ID, "result:", result);
      setLocallyDelegated(true);
      onError?.(`Trading delegated. Signer: ${PRIVY_SIGNER_ID.slice(0, 8)}…`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[delegate] failed:", e);
      onError?.(`Couldn't enable trading: ${msg}`);
    } finally {
      setDelegating(false);
    }
  };

  const onCheckDelegation = async () => {
    if (!walletAddress) return;
    setDiag(null);
    setDiagLoading(true);
    try {
      const token = await getAccessToken();
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "";
      const r = await fetch(`${apiUrl}/wallet/status`, {
        headers: {
          Authorization: token ? `Bearer ${token}` : "",
          "X-Wallet-Address": walletAddress,
        },
      });
      const j = await r.json();
      // Compact, human-readable summary that fits in the dropdown.
      const lines = [
        `delegated: ${j.delegated}`,
        `owner_quorum: ${j.quorum_id ?? "none"}`,
        `signers attached: ${(j.additional ?? []).length}`,
        `expected: ${j.expected_signer ?? "(env not set)"}`,
      ];
      if (j.error) lines.push(`error: ${j.error}`);
      setDiag(lines.join("\n"));
    } catch (e) {
      setDiag(`request failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDiagLoading(false);
    }
  };

  const copyAddress = async () => {
    if (!walletAddress) return;
    try { await navigator.clipboard.writeText(walletAddress); } catch { /* noop */ }
    setMenuOpen(false);
  };

  const onFundUSDC = () => {
    if (!walletAddress) return;
    setMenuOpen(false);
    fundWallet({
      address: walletAddress,
      options: {
        chain: base,
        asset: "USDC",
        amount: "5",
        card: { preferredProvider: "coinbase" },
      },
    }).catch((e) => console.warn("[fund] USDC fund flow declined:", e));
  };

  const onFundETH = () => {
    if (!walletAddress) return;
    setMenuOpen(false);
    fundWallet({
      address: walletAddress,
      options: {
        chain: base,
        asset: "native-currency",
        amount: "0.001",
        card: { preferredProvider: "coinbase" },
      },
    }).catch((e) => console.warn("[fund] ETH fund flow declined:", e));
  };

  const onRevoke = async () => {
    setMenuOpen(false);
    if (!walletAddress) return;
    try {
      await removeSigners({ address: walletAddress });
      setLocallyDelegated(false);
    } catch (e) {
      console.warn("[delegate] revoke failed:", e);
    }
  };

  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="brand">scalprunner</div>
        <button className="help-btn" onClick={() => { sounds.play("ui-click"); onHelpClick(); }} aria-label="Help">?</button>
        <button className="mute-btn" onClick={onMuteClick} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"}>
          {muted ? "🔇" : "🔊"}
        </button>
      </div>
      <div className="topbar-right">
        {!authenticated ? (
          <button className="deposit-btn" onClick={() => { sounds.play("ui-click"); login(); }}>
            <span>deposit to play</span>
            <span className="deposit-arrow" aria-hidden="true">›</span>
          </button>
        ) : (
          <>
            <div className="balance-pill" title="USDC balance">
              <span className="balance-icon" aria-hidden="true" />
              <span>{balanceLoading ? "syncing…" : `$${balance.toFixed(2)}`}</span>
            </div>
            <div
              className={`gas-pill ${hasGas ? "ok" : "warn"}`}
              title={ethBalance === null ? "ETH gas balance loading" : `${ethBalance.toFixed(6)} ETH on Base for gas`}
            >
              <span className="gas-dot" aria-hidden="true" />
              <span>{ethBalance === null ? "gas…" : hasGas ? "gas ok" : "needs gas"}</span>
            </div>
            <div className="user-wrap" ref={wrapRef}>
              <button
                className="avatar-btn"
                onClick={() => { sounds.play("ui-click"); setMenuOpen((v) => !v); }}
                aria-label="Account"
                aria-expanded={menuOpen}
              >
                {initials}
              </button>
              {menuOpen && (
                <div className="user-menu" role="menu">
                  <div className="user-menu-header">
                    <div className="user-menu-label">wallet</div>
                    <div className="user-menu-addr">{truncated}</div>
                    <div className={`user-menu-tag ${hasGas ? "ok" : "warn"}`}>
                      {ethBalance === null
                        ? "gas checking…"
                        : hasGas
                          ? `${ethBalance.toFixed(5)} ETH gas`
                          : "needs ETH gas"}
                    </div>
                    <div className={`user-menu-tag ${isDelegated ? "ok" : "warn"}`}>
                      {isDelegated ? "trading delegated ✓" : "delegation pending"}
                    </div>
                  </div>
                  {!isDelegated && (
                    <button
                      className="user-menu-item primary"
                      role="menuitem"
                      onClick={() => { sounds.play("ui-click"); onDelegate(); }}
                      disabled={delegating}
                    >
                      {delegating ? "waiting for popup…" : "enable trading"}
                    </button>
                  )}
                  <button className="user-menu-item" role="menuitem" onClick={() => { sounds.play("ui-click"); copyAddress(); }}>
                    copy address
                  </button>
                  <button
                    className="user-menu-item"
                    role="menuitem"
                    onClick={() => { sounds.play("ui-click"); onFundUSDC(); }}
                  >
                    fund USDC (collateral)
                  </button>
                  <button
                    className="user-menu-item"
                    role="menuitem"
                    onClick={() => { sounds.play("ui-click"); onFundETH(); }}
                  >
                    fund ETH (gas)
                  </button>
                  {isDelegated && (
                    <button
                      className="user-menu-item"
                      role="menuitem"
                      onClick={() => { sounds.play("ui-click"); onRevoke(); }}
                    >
                      revoke trading delegation
                    </button>
                  )}
                  <button
                    className="user-menu-item"
                    role="menuitem"
                    onClick={() => { sounds.play("ui-click"); onCheckDelegation(); }}
                    disabled={diagLoading}
                  >
                    {diagLoading ? "checking…" : "check delegation"}
                  </button>
                  {diag && (
                    <pre className="user-menu-diag" aria-live="polite">{diag}</pre>
                  )}
                  <button
                    className="user-menu-item danger"
                    role="menuitem"
                    onClick={() => { sounds.play("ui-click"); setMenuOpen(false); logout(); }}
                  >
                    disconnect
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
