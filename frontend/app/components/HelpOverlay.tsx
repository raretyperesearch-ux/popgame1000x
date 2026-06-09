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
        <div className="help-subtitle">leveraged ETH/USD perps, dressed as a runner</div>
        <ol className="help-list" role="list">
          <li>pick fuel (USDC collateral) &amp; boost <b>75&ndash;500&times;</b></li>
          <li>choose long to jump skyward, or short to dive underwater</li>
          <li>each 1% ETH move &times; leverage = % change on net collateral</li>
          <li>pull chute / surface &rarr; exits at market, net PnL settles to USDC</li>
          <li>loss eats collateral &rarr; auto-close (liquidation, forfeit)</li>
          <li>fees: 2.5% house on open &middot; Avantis fee on profit only</li>
        </ol>
        {/* Trust + legal surface lives inside the help overlay — that's
            where new players already look for "how does this work?".
            target=_blank so opening a doc doesn't kick them out of the
            game session they were about to start. */}
        <div className="help-doclinks" aria-label="More info">
          <a href="/how-it-works" target="_blank" rel="noreferrer">
            full docs
          </a>
          <span aria-hidden="true">·</span>
          <a href="/terms" target="_blank" rel="noreferrer">terms</a>
          <span aria-hidden="true">·</span>
          <a href="/privacy" target="_blank" rel="noreferrer">privacy</a>
        </div>
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
