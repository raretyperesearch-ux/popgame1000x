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
          <div role="listitem"><span>pick boost</span><strong>75&ndash;500&times;</strong></div>
          <div role="listitem"><span>set wager</span><strong>choose your run</strong></div>
          <div role="listitem"><span>tap jump</span><strong>enter</strong></div>
          <div role="listitem"><span>price up</span><strong>flames fire, you rise</strong></div>
          <div role="listitem"><span>price down</span><strong>no flames, you fall</strong></div>
          <div role="listitem"><span>crash line</span><strong>run over</strong></div>
          <div role="listitem"><span>pull chute</span><strong>bank anytime</strong></div>
        </div>
        <button className="help-got-it" onClick={onClose}>
          got it
        </button>
      </div>
    </div>
  );
}
