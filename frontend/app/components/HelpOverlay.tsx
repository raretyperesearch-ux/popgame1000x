"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";

interface HelpOverlayProps {
  show: boolean;
  onClose: () => void;
}

export default function HelpOverlay({ show, onClose }: HelpOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (e.target === overlayRef.current) onClose();
    }
    const el = overlayRef.current;
    el?.addEventListener("click", handleClick);
    return () => el?.removeEventListener("click", handleClick);
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      className={`help-overlay${show ? " show" : ""}`}
    >
      <div className="help-card">
        <div className="help-art" aria-hidden="true">
          <Image
            src="/assets/help-runner-art.png"
            alt=""
            width={560}
            height={285}
            priority
          />
        </div>
        <div className="help-title">how this works</div>
        <div className="help-subtitle">leveraged ETH/USD perps, dressed as a jumper</div>
        <ol className="help-list" role="list">
          <li>pick wager (USDC) &amp; leverage <b>75&ndash;500&times;</b></li>
          <li>jump &rarr; opens a leveraged ETH/USD long on Avantis (Base)</li>
          <li>each 1% ETH move &times; leverage = % change on wager</li>
          <li>pull chute &rarr; exits at market, PnL settles to USDC</li>
          <li>loss eats wager &rarr; auto-close (liquidation, forfeit)</li>
          <li>fees: 2.5% on open &middot; 2.5% Avantis fee on profit only</li>
        </ol>
        <button className="help-got-it" onClick={onClose}>
          got it
        </button>
        <div className="help-powered" aria-label="Powered by Avantis">
          <span>powered by</span>
          <Image
            src="/assets/avantis-logo.png"
            alt="Avantis"
            width={644}
            height={215}
            unoptimized
          />
        </div>
      </div>
    </div>
  );
}
