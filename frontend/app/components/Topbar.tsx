"use client";

import { useState, useRef, useEffect } from "react";
import { usePrivy } from "@privy-io/react-auth";

interface TopbarProps {
  balance: number;
  onHelpClick: () => void;
}

export default function Topbar({ balance, onHelpClick }: TopbarProps) {
  const { login, logout, authenticated, user } = usePrivy();
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const walletAddress = user?.wallet?.address;
  const truncated = walletAddress
    ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
    : null;
  const initials = walletAddress
    ? walletAddress.slice(2, 4).toUpperCase()
    : "•";

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

  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="brand">game</div>
        <button className="help-btn" onClick={onHelpClick} aria-label="Help">?</button>
      </div>
      <div className="topbar-right">
        {!authenticated ? (
          <button className="deposit-btn" onClick={() => login()}>
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
                onClick={() => setMenuOpen((v) => !v)}
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
                  </div>
                  <button className="user-menu-item" role="menuitem" onClick={copyAddress}>
                    copy address
                  </button>
                  <button
                    className="user-menu-item"
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); login(); }}
                  >
                    deposit / fund
                  </button>
                  <button
                    className="user-menu-item danger"
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); logout(); }}
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
