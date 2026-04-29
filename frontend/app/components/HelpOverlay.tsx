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
          <li>pick boost (75&ndash;250&times;) and wager</li>
          <li>tap jump &rarr; launch the run</li>
          <li>price up &rarr; flames fire, you rise</li>
          <li>price down &rarr; no flames, you fall</li>
          <li>hit the crash line &rarr; run over</li>
          <li>tap pull chute anytime &rarr; bank the run</li>
          <li>run fee: 0.8% of wager. clean runs pay 2.5% to avantis</li>
        </ul>
        <button className="help-got-it" onClick={onClose}>
          got it
        </button>
      </div>
    </div>
  );
}
