"use client";

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
        <div className="help-title">how this works</div>
        <ul className="help-list">
          <li>pick leverage (75&ndash;250&times;) and wager</li>
          <li>tap jump &rarr; opens a long on eth</li>
          <li>price up &rarr; flames fire, you rise</li>
          <li>price down &rarr; no flames, you fall</li>
          <li>hit water &rarr; liquidated, wager gone</li>
          <li>tap stop anytime &rarr; locks in your pnl</li>
          <li>house fee: 0.8% of wager. wins pay 2.5% to avantis</li>
        </ul>
        <button className="help-got-it" onClick={onClose}>
          got it
        </button>
      </div>
    </div>
  );
}
