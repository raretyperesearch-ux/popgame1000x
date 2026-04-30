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
        <div className="help-list" role="list">
          <div role="listitem"><span>boost</span><strong>75&ndash;500&times; leverage on ETH/USD</strong></div>
          <div role="listitem"><span>wager</span><strong>USDC at stake &mdash; your max loss</strong></div>
          <div role="listitem"><span>jump</span><strong>opens a leveraged long on Avantis</strong></div>
          <div role="listitem"><span>rise</span><strong>price up &times; boost = PnL up</strong></div>
          <div role="listitem"><span>fall</span><strong>price down &times; boost = PnL down</strong></div>
          <div role="listitem"><span>crash line</span><strong>liquidation &mdash; touch it, wager gone</strong></div>
          <div role="listitem"><span>pull chute</span><strong>close the position, keep your PnL</strong></div>
          <div role="listitem"><span>fees</span><strong>0.8% house on open &middot; 2.5% Avantis on profit</strong></div>
        </div>
        <button className="help-got-it" onClick={onClose}>
          got it
        </button>
      </div>
    </div>
  );
}
