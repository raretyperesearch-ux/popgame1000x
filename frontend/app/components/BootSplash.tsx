"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

export default function BootSplash() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const done = window.setTimeout(() => setVisible(false), 2000);
    return () => window.clearTimeout(done);
  }, []);

  if (!visible) return null;

  return (
    <div className="sr-boot-splash" aria-hidden="true">
      <div className="sr-boot-mark">
        <Image
          src="/assets/scalprunner-logo.png"
          alt=""
          width={900}
          height={409}
          priority
        />
      </div>
      <style jsx>{`
        .sr-boot-splash {
          position: fixed;
          inset: 0;
          z-index: 9999;
          display: grid;
          place-items: center;
          background:
            radial-gradient(circle at 50% 48%, rgba(78, 219, 255, 0.12), transparent 26%),
            linear-gradient(180deg, #07101a 0%, #020407 100%);
          animation: srBootExit 2s cubic-bezier(.22, 1, .36, 1) forwards;
          pointer-events: none;
        }

        .sr-boot-mark {
          position: relative;
          width: clamp(132px, 22vw, 240px);
          display: grid;
          place-items: center;
          filter: drop-shadow(0 0 14px rgba(78, 219, 255, .28));
          animation: srBootPulse 2s cubic-bezier(.2, .78, .24, 1) forwards;
        }

        .sr-boot-mark :global(img) {
          width: 100%;
          height: auto;
          display: block;
        }

        .sr-boot-mark::after {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(105deg, transparent 22%, rgba(255,255,255,.68) 48%, transparent 68%);
          mask-image: url("/assets/scalprunner-logo.png");
          mask-repeat: no-repeat;
          mask-size: contain;
          mask-position: center;
          -webkit-mask-image: url("/assets/scalprunner-logo.png");
          -webkit-mask-repeat: no-repeat;
          -webkit-mask-size: contain;
          -webkit-mask-position: center;
          transform: translateX(-78%);
          animation: srBootGlint 1.28s ease-out .26s forwards;
          opacity: .72;
          pointer-events: none;
        }

        @keyframes srBootPulse {
          0% { opacity: 0; transform: translateY(5px) scale(.98); filter: brightness(.86); }
          16% { opacity: 1; transform: translateY(0) scale(1); filter: brightness(1.12); }
          72% { opacity: 1; transform: translateY(0) scale(1); filter: brightness(1.05); }
          100% { opacity: 0; transform: translateY(-2px) scale(1.006); filter: brightness(.95); }
        }

        @keyframes srBootGlint {
          from { transform: translateX(-78%); opacity: 0; }
          28% { opacity: .68; }
          to { transform: translateX(78%); opacity: 0; }
        }

        @keyframes srBootExit {
          0%, 82% { opacity: 1; }
          100% { opacity: 0; visibility: hidden; }
        }

        @media (prefers-reduced-motion: reduce) {
          .sr-boot-splash,
          .sr-boot-mark,
          .sr-boot-mark::after {
            animation-duration: .45s;
          }
        }
      `}</style>
    </div>
  );
}
