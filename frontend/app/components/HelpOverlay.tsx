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
        <div className="help-title">how it works</div>
        <div className="help-subtitle">ETH/USD perp trading with arcade controls</div>
        <div className="help-flow" role="list">
          <section className="help-step-card" role="listitem">
            <span className="help-step-num">1</span>
            <div>
              <b>Fuel is your USDC collateral.</b>
              <p>Pick the amount you want at risk, then choose a boost from 75&times; to 500&times;.</p>
            </div>
          </section>
          <section className="help-step-card" role="listitem">
            <span className="help-step-num">2</span>
            <div>
              <b>Jump means long. Dive means short.</b>
              <p>The runner moves with ETH price while the top PnL panel shows an estimate.</p>
            </div>
          </section>
          <section className="help-step-card" role="listitem">
            <span className="help-step-num">3</span>
            <div>
              <b>Pull chute closes at market.</b>
              <p>Closed trade PnL settles back to USDC. If losses use the collateral first, the trade can liquidate.</p>
            </div>
          </section>
        </div>
        <div className="help-fee-note">
          fees: 2.5% house on open · Avantis fee on profit only
        </div>
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
