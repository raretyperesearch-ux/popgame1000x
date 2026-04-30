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
        <div className="help-subtitle">leveraged ETH/USD perpetuals, dressed as a jumper</div>
        <div className="help-list" role="list">
          <div role="listitem"><span>leverage</span><strong>75&ndash;500&times; exposure on the ETH/USD perpetual</strong></div>
          <div role="listitem"><span>collateral</span><strong>USDC margin posted &mdash; loss is capped at this amount</strong></div>
          <div role="listitem"><span>open</span><strong>jump places a leveraged long on Avantis (Base)</strong></div>
          <div role="listitem"><span>profit</span><strong>1% ETH move &times; your leverage = % gain on collateral</strong></div>
          <div role="listitem"><span>loss</span><strong>same math the other way &mdash; mirrors ETH downside</strong></div>
          <div role="listitem"><span>liquidation</span><strong>collateral exhausted &rarr; auto-close, wager forfeit</strong></div>
          <div role="listitem"><span>close</span><strong>pull chute exits at market; net PnL settles to USDC</strong></div>
          <div role="listitem"><span>fees</span><strong>2.5% house fee on open &middot; 2.5% Avantis fee on profit only</strong></div>
        </div>
        <button className="help-got-it" onClick={onClose}>
          got it
        </button>
        <div className="help-powered" aria-label="Powered by Avantis">
          <span>powered by</span>
          <Image
            src="/assets/avantis-logo.svg"
            alt="Avantis"
            width={140}
            height={30}
            unoptimized
          />
        </div>
      </div>
    </div>
  );
}
