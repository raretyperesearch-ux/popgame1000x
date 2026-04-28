"use client";

import { useState, useRef, useEffect } from "react";
import {
  usePrivy,
  useSigners,
  useFundWallet,
} from "@privy-io/react-auth";
import { base } from "viem/chains";
import { sounds } from "@/lib/sounds";

interface TopbarProps {
  balance: number;
  onHelpClick: () => void;
}

/* The Privy signerId is generated when the authorization key's public PEM
   is registered in the Privy dashboard. It pairs requests from the
   frontend's addSigners() call with the matching backend's
   PRIVY_AUTH_PRIVATE_KEY so server-side trade execution is authorized. */
const PRIVY_SIGNER_ID = process.env.NEXT_PUBLIC_PRIVY_SIGNER_ID || "";

export default function Topbar({ balance, onHelpClick }: TopbarProps) {
  const { login, logout, authenticated, user, ready } = usePrivy();
  const { addSigners, removeSigners } = useSigners();
  const { fundWallet } = useFundWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [delegating, setDelegating] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setMuted(sounds.isMuted()); }, []);
  const onMuteClick = () => {
    const m = sounds.toggleMute();
    setMuted(m);
    if (!m) sounds.play("ui-click");
  };

  const walletAddress = user?.wallet?.address;
  const truncated = walletAddress
    ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
    : null;
  const initials = walletAddress
    ? walletAddress.slice(2, 4).toUpperCase()
    : "•";

  /* `delegated: true` lives on the linked-account wallet entry once the
     user has approved the addSigners / delegateWallet flow. We use this
     to know whether the backend can sign trades on their behalf. */
  const isDelegated = Boolean(
    user?.linkedAccounts?.some(
      (a) =>
        a.type === "wallet" &&
        "address" in a &&
        a.address === walletAddress &&
        "delegated" in a &&
        (a as unknown as { delegated?: boolean }).delegated === true,
    ),
  );

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
      signers: [{ signerId: PRIVY_SIGNER_ID }],
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
        defaultFundingMethod: "card",
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
        defaultFundingMethod: "card",
        card: { preferredProvider: "coinbase" },
      },
    }).catch((e) => console.warn("[fund] ETH fund flow declined:", e));
  };

  const onRevoke = async () => {
    setMenuOpen(false);
    if (!walletAddress) return;
    try {
      await removeSigners({ address: walletAddress });
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
              <span>${balance.toFixed(2)}</span>
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
                    <div className={`user-menu-tag ${isDelegated ? "ok" : "warn"}`}>
                      {isDelegated ? "trading delegated ✓" : "delegation pending"}
                    </div>
                  </div>
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
