import type { Metadata } from "next";
import DocsLayout from "../components/DocsLayout";

export const metadata: Metadata = {
  title: "Privacy Policy — ScalpRunner500x",
  description:
    "Privacy practices for ScalpRunner500x: what we collect, where it lives, your rights.",
};

/* DRAFT — placeholder language for review by counsel before public
   launch. Adapted from /legal/PRIVACY.md in the repo. The data
   inventory accurately reflects the product as it ships today; the
   GDPR/CCPA rights section is a placeholder. */
export default function PrivacyPage() {
  return (
    <DocsLayout title="privacy policy" updated="May 2026">
      <div className="docs-callout">
        <b>Draft.</b> This describes our actual data practices today.
        Counsel review is in progress to add jurisdiction-specific rights
        language (GDPR/CCPA). The data inventory and processor list below
        are accurate.
      </div>

      <section>
        <h2>what we collect</h2>
        <ul>
          <li>
            <b>Wallet address.</b> Public, on-chain. Tied to your Privy
            account.
          </li>
          <li>
            <b>Privy account identifier (DID).</b> Used to authenticate API
            calls and join your identity across our games (Swallow Me,
            Holy Liquid, ScalpRunner) on the unified leaderboard.
          </li>
          <li>
            <b>Trade history.</b> Open/close prices, leverage, wager, PnL,
            liquidation outcome, transaction hashes. Stored in Supabase.
          </li>
          <li>
            <b>Username</b> if you pick one for the leaderboard.
          </li>
          <li>
            <b>Email or social login</b> if you log in via those methods.
            That identity sits with Privy under their privacy policy. We
            see only the wallet address and the DID.
          </li>
          <li>
            <b>IP address and request metadata.</b> Standard server logs.
            Used for abuse prevention.
          </li>
          <li>
            <b>Browser error reports.</b> Unhandled errors and stack
            traces. PII is not intentionally collected; the wallet address
            may be tagged on the error if available.
          </li>
        </ul>
      </section>

      <section>
        <h2>what we do NOT collect</h2>
        <ul>
          <li>We do not custody funds or private keys.</li>
          <li>We do not require KYC for gameplay.</li>
          <li>We do not sell user data.</li>
        </ul>
      </section>

      <section>
        <h2>where it lives</h2>
        <ul>
          <li>
            <b>Supabase</b> (US-East). Trade rows + cross-game player
            identity table.
          </li>
          <li>
            <b>Privy</b> (US). Embedded wallet provisioning + auth.
          </li>
          <li>
            <b>Railway</b> (US). Application logs.
          </li>
          <li>
            <b>Vercel</b> (Global edge). Frontend hosting.
          </li>
          <li>
            <b>Base &amp; Avantis</b> (public chain). All trade
            transactions are public on{" "}
            <a href="https://basescan.org" target="_blank" rel="noreferrer">
              basescan.org
            </a>
            .
          </li>
        </ul>
      </section>

      <section>
        <h2>retention</h2>
        <ul>
          <li>
            <b>Trade history:</b> indefinite. Powers the leaderboard and
            your stats across games.
          </li>
          <li>
            <b>Server logs:</b> ~30 days.
          </li>
          <li>
            <b>Error reports:</b> ~90 days.
          </li>
          <li>
            <b>On-chain transactions:</b> immutable; we cannot delete them.
          </li>
        </ul>
      </section>

      <section>
        <h2>your rights</h2>
        <ul>
          <li>
            <b>Data deletion:</b> ask in the{" "}
            <a
              href="https://discord.gg/DjGgNUKhZ"
              target="_blank"
              rel="noreferrer"
            >
              Hiscore Discord
            </a>
            . We can purge your trade rows and identity from our database;
            we cannot delete your on-chain history (it&rsquo;s public on
            Base).
          </li>
          <li>
            <b>Data export:</b> same channel; we&rsquo;ll send a CSV of
            your trade history.
          </li>
          <li>
            <b>EU/CA users:</b> jurisdiction-specific rights are being
            added in the canonical post-review version of this policy.
            Reach out via Discord if you need to exercise a specific right
            in the meantime.
          </li>
        </ul>
      </section>

      <section>
        <h2>cookies</h2>
        <p>
          We use first-party cookies for authentication (Privy session). No
          third-party advertising or tracking cookies.
        </p>
      </section>

      <section>
        <h2>children</h2>
        <p>The Service is not for users under 18.</p>
      </section>

      <section>
        <h2>changes</h2>
        <p>
          We will update this policy as practices change. Continued use
          after an update is acceptance.
        </p>
      </section>

      <section>
        <h2>contact</h2>
        <p>
          <a
            href="https://discord.gg/DjGgNUKhZ"
            target="_blank"
            rel="noreferrer"
          >
            Hiscore Discord
          </a>
          .
        </p>
      </section>
    </DocsLayout>
  );
}
