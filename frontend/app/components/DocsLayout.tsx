import Link from "next/link";
import Image from "next/image";
import type { ReactNode } from "react";

interface DocsLayoutProps {
  title: string;
  subtitle?: string;
  updated?: string;
  children: ReactNode;
}

/* Shared chrome for the doc pages (/how-it-works, /terms, /privacy).
   Server component — these pages are static content and shouldn't ship
   any client JS beyond the navigation links. The wrap reuses the
   site's dark/cyan/gold palette so the docs feel native to the game
   rather than tacked-on legal pages. */
export default function DocsLayout({
  title,
  subtitle,
  updated,
  children,
}: DocsLayoutProps) {
  return (
    <div className="docs-shell">
      <header className="docs-topbar">
        <Link href="/" className="docs-back">
          <span className="docs-back-arrow" aria-hidden="true">‹</span>
          <span>back to game</span>
        </Link>
        <nav className="docs-nav" aria-label="Docs navigation">
          <Link href="/how-it-works">how it works</Link>
          <Link href="/terms">terms</Link>
          <Link href="/privacy">privacy</Link>
          <a
            href="https://avantisfi.com"
            target="_blank"
            rel="noreferrer"
            aria-label="Avantis"
          >
            avantis ↗
          </a>
        </nav>
      </header>
      <main className="docs-page">
        <div className="docs-card">
          <div className="docs-eyebrow">scalprunner500x</div>
          <h1 className="docs-title">{title}</h1>
          {subtitle && <p className="docs-subtitle">{subtitle}</p>}
          {updated && <p className="docs-updated">last updated {updated}</p>}
          <div className="docs-body">{children}</div>
          <footer className="docs-card-footer">
            <span>powered by</span>
            <a
              href="https://avantisfi.com"
              target="_blank"
              rel="noreferrer"
              className="docs-avantis"
            >
              <Image
                src="/assets/avantis-logo.png"
                alt="Avantis"
                width={120}
                height={40}
                unoptimized
              />
            </a>
          </footer>
        </div>
      </main>
    </div>
  );
}
