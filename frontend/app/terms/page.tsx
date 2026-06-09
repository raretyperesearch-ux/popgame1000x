import type { Metadata } from "next";
import DocsLayout from "../components/DocsLayout";

export const metadata: Metadata = {
  title: "Terms of Service — ScalpRunner500x",
  description:
    "Terms of Service for ScalpRunner500x. Leveraged perps on Avantis (Base). Non-custodial.",
};

/* DRAFT — placeholder language for review by counsel before public
   launch. Adapted from /legal/TERMS.md in the repo. The risk and fee
   sections accurately reflect the product as it ships today; the
   jurisdiction and arbitration sections are placeholders. */
export default function TermsPage() {
  return (
    <DocsLayout title="terms of service" updated="May 2026">
      <div className="docs-callout">
        <b>Draft.</b> These terms describe how the product works and the
        risks involved. The legal language is being reviewed by counsel
        before the formal go-live. By using the service today you accept
        the spirit of these terms; the canonical version will replace
        this page after review.
      </div>

      <section>
        <h2>1. acceptance</h2>
        <p>
          By accessing or using ScalpRunner500x (the &ldquo;Service&rdquo;),
          you agree to these Terms. If you do not agree, do not use the
          Service.
        </p>
      </section>

      <section>
        <h2>2. what the service is</h2>
        <p>
          The Service is an interface to perpetual futures contracts on{" "}
          <a href="https://avantisfi.com" target="_blank" rel="noreferrer">
            Avantis
          </a>{" "}
          (deployed on Base). When you &ldquo;jump,&rdquo; the Service
          submits a transaction that opens a leveraged ETH/USD long
          position on Avantis on your behalf. When you &ldquo;pull
          chute&rdquo; or are liquidated, the position closes and PnL
          settles to your wallet.
        </p>
        <p>
          The Service does not custody your funds. Your USDC and ETH live
          in your embedded wallet (provisioned via Privy). The Service
          holds a delegated session signer scoped only to executing
          trades you initiate; you can revoke this from your Privy
          account at any time.
        </p>
      </section>

      <section>
        <h2>3. eligibility</h2>
        <p>You represent that:</p>
        <ul>
          <li>
            You are at least 18 (or the age of majority in your
            jurisdiction).
          </li>
          <li>
            You are not a resident or citizen of, or located in, any
            jurisdiction in which use of the Service is prohibited
            (typically including jurisdictions subject to comprehensive
            U.S. or international sanctions).
          </li>
          <li>
            You are not a Specially Designated National or otherwise on a
            sanctions list.
          </li>
          <li>
            You are not using the Service on behalf of any person who
            fails any of the above.
          </li>
        </ul>
      </section>

      <section>
        <h2>4. risks (read carefully)</h2>
        <ul>
          <li>
            <b>Leverage amplifies losses.</b> At 500&times; leverage, a
            0.2% adverse move in the ETH price liquidates your position
            and you lose your entire wager.
          </li>
          <li>
            <b>You may lose all funds wagered.</b> This is not a savings
            product, an investment, or a yield product.
          </li>
          <li>
            <b>Smart contract risk.</b> Avantis, Base, USDC, and all
            underlying protocols carry smart contract risk. Bugs,
            exploits, or governance actions can result in partial or
            total loss of funds.
          </li>
          <li>
            <b>Oracle risk.</b> Prices are sourced from Pyth via Avantis.
            Oracle outages or manipulation can cause unexpected
            liquidations or PnL swings.
          </li>
          <li>
            <b>No advice.</b> Nothing on the Service is investment,
            financial, legal, or tax advice. Decisions to wager are
            solely yours.
          </li>
        </ul>
      </section>

      <section>
        <h2>5. fees</h2>
        <ul>
          <li>
            <b>Open fee:</b> 2.5% of each wager, deducted at open and
            transferred to the operator&rsquo;s treasury wallet.
          </li>
          <li>
            <b>Avantis profit fee:</b> 2.5% of profits on positions that
            close in profit, paid to Avantis (not the operator).
          </li>
          <li>
            <b>Gas:</b> You pay Base network gas in ETH for every
            transaction.
          </li>
        </ul>
        <p>
          Fee changes will be announced in advance via the topbar
          notice.
        </p>
      </section>

      <section>
        <h2>6. non-custodial wallet</h2>
        <p>
          The operator does not custody your funds. Your USDC and ETH
          live in your embedded wallet (provisioned by Privy). The
          operator has limited delegated signing authority that you grant
          when you first enable trading; that authority is scoped to
          executing trades on Avantis and collecting the open fee. You
          can revoke it via Privy at any time. Withdrawals are sent
          directly from your embedded wallet to the destination you
          specify; the operator is not in the path.
        </p>
      </section>

      <section>
        <h2>7. operator discretion</h2>
        <p>The operator may:</p>
        <ul>
          <li>Restrict access from certain jurisdictions or addresses.</li>
          <li>
            Pause the Service for maintenance, security, or compliance.
          </li>
          <li>
            Update these Terms; continued use after an update is
            acceptance.
          </li>
        </ul>
      </section>

      <section>
        <h2>8. disclaimers</h2>
        <p>
          The Service is provided &ldquo;AS IS&rdquo; without warranties
          of any kind. The operator does not warrant uptime, accuracy of
          price feeds, or the performance of any underlying protocol
          (including Avantis, Base, USDC, Privy, or Pyth).
        </p>
      </section>

      <section>
        <h2>9. limitation of liability</h2>
        <p>
          To the fullest extent permitted by law, the operator&rsquo;s
          aggregate liability is limited to fees actually collected from
          you in the 30 days preceding the claim.
        </p>
      </section>

      <section>
        <h2>10. indemnification</h2>
        <p>
          You agree to indemnify the operator for any third-party claim
          arising from your use of the Service or violation of these
          Terms.
        </p>
      </section>

      <section>
        <h2>11. dispute resolution</h2>
        <p>
          Disputes are resolved by binding arbitration on an individual
          basis. Class actions are waived. Governing law: to be specified
          in the canonical post-review version.
        </p>
      </section>

      <section>
        <h2>12. contact</h2>
        <p>
          Reach the operator on the{" "}
          <a
            href="https://discord.gg/5aM9AVnBNH"
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
