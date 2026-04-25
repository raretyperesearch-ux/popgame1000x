"use client";

import { usePrivy } from "@privy-io/react-auth";

interface TopbarProps {
  balance: number;
  onHelpClick: () => void;
}

export default function Topbar({ balance, onHelpClick }: TopbarProps) {
  const { login, authenticated, user } = usePrivy();

  const walletAddress = user?.wallet?.address;
  const truncated = walletAddress
    ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
    : null;

  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="brand">game</div>
        <button className="help-btn" onClick={onHelpClick}>
          ?
        </button>
      </div>
      <div className="topbar-right">
        <button
          className="connect-btn"
          onClick={() => {
            if (!authenticated) login();
          }}
        >
          {authenticated ? truncated : "connect"}
        </button>
        <div className="balance">
          <span className="lab">bal</span>
          <span>${balance.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}
