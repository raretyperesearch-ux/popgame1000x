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
          src="/assets/hiscore-loader-mark.png"
          alt=""
          width={720}
          height={463}
          priority
        />
      </div>
    </div>
  );
}
