import type { Metadata } from "next";
import DocsLayout from "../components/DocsLayout";

export const metadata: Metadata = {
  title: "How ScalpRunner500x works — Playable Markets",
  description:
    "ScalpRunner500x is a playable markets game: every jump is a real leveraged ETH perp on Avantis. Non-custodial, on-chain, no house edge.",
};

/* Static content page. Server-rendered, no client JS. Shipped at
   /how-it-works as a place to point new players who ask "is this a
   scam?" — explains the playable-markets framing, the Avantis stack,
   the fee model, and the non-custodial flow in plain language. */
export default function HowItWorksPage() {
  return (
    <DocsLayout
      title="how it works"
      subtitle="leveraged ETH/USD perps, dressed as a jumper"
      updated="May 2026"
    >
      <section>
        <h2>tl;dr</h2>
        <p>
          ScalpRunner500x is a <b>playable markets</b> game. There is no
          house. Every jump opens a real leveraged ETH/USD perpetual long
          on <a href="https://avantisfi.com" target="_blank" rel="noreferrer">Avantis</a>{" "}
          (a perps protocol on Base). When you pull the chute or get
          liquidated, the position settles on-chain and PnL lands in
          your wallet.
        </p>
        <ul>
          <li>
            <b>Non-custodial.</b> Your USDC sits in your own embedded
            wallet (provisioned by Privy). You can withdraw any amount
            to any address, anytime. We never touch your principal.
          </li>
          <li>
            <b>No house edge.</b> Payouts come from Avantis&rsquo;s LP
            pool, not from us. The only thing we charge is a 2.5% open
            fee on the wager.
          </li>
          <li>
            <b>On-chain, verifiable.</b> Every open and close is a real
            transaction on Base. You can audit your full history on{" "}
            <a href="https://basescan.org" target="_blank" rel="noreferrer">
              basescan.org
            </a>
            .
          </li>
        </ul>
      </section>

      <section>
        <h2>what is a playable market?</h2>
        <p>
          A &ldquo;playable market&rdquo; means the underlying instrument is a
          real, liquid market &mdash; not a simulated random number generator
          or a casino-style RNG. ScalpRunner500x wraps a perpetual futures
          contract on ETH/USD inside arcade controls. The price you see in
          the game is the real ETH price feed Avantis uses (sourced from
          Pyth). Your &ldquo;wager&rdquo; is collateral. Your &ldquo;leverage&rdquo;
          is the position multiplier. Your PnL is the actual realized PnL of
          the perp at your exit price.
        </p>
        <p>
          You aren&rsquo;t betting against the operator. You&rsquo;re trading
          a leveraged position whose payout comes from a public liquidity
          pool that does ten-figure monthly volume. That&rsquo;s the
          difference between a casino game and a playable market &mdash;
          and it&rsquo;s why your size doesn&rsquo;t spook us. Wager what
          you want.
        </p>
      </section>

      <section>
        <h2>the round, step by step</h2>
        <ol>
          <li>
            <b>Pick wager &amp; leverage.</b> Wager is the USDC you risk on
            this round. Leverage is 75&times;&ndash;500&times;.
          </li>
          <li>
            <b>Jump.</b> The game opens a long ETH/USD perp on Avantis
            sized at <code>wager &times; leverage</code>. The runner takes
            off; the boost meter shows your unrealized PnL in real time.
          </li>
          <li>
            <b>Pull chute</b> to close at market &mdash; profit or loss
            settles to your wallet in USDC. <b>Or get liquidated:</b> if
            the price moves enough against you to wipe your collateral, the
            position auto-closes and you forfeit the wager. At 500&times;
            that&rsquo;s a ~0.2% adverse move. At 100&times; it&rsquo;s
            ~1%. You can see the liquidation price in the game.
          </li>
          <li>
            <b>Repeat.</b> Open another round whenever you want. Your
            history (last 5) is on the strip; full history is on the
            unified leaderboard at hiscore.me.
          </li>
        </ol>
      </section>

      <section>
        <h2>fees</h2>
        <ul>
          <li>
            <b>2.5% open fee</b> on the wager &mdash; goes to the operator
            treasury. This is the only fee we charge.
          </li>
          <li>
            <b>2.5% Avantis profit fee</b> &mdash; charged by Avantis on
            profitable closes only. This is the protocol fee, not ours.
          </li>
          <li>
            <b>Gas</b> &mdash; you pay Base network gas in ETH for every
            open + close. That&rsquo;s why the wallet menu prompts you to
            keep ~0.0005 ETH on hand.
          </li>
        </ul>
        <p>
          Losses do not pay anything to us beyond the open fee. There is
          no &ldquo;house wins more than it loses&rdquo; mechanic baked
          in &mdash; a losing trade pays Avantis&rsquo;s LPs, not us.
        </p>
      </section>

      <section>
        <h2>your wallet, your keys</h2>
        <p>
          When you log in, Privy provisions an embedded EVM wallet for
          your account. The keys live in a TEE (trusted execution
          environment) on Privy&rsquo;s infrastructure &mdash; we never
          see them. You grant the backend a scoped session signer so it
          can submit your trade transactions to Avantis on your behalf.
          You can revoke this at any time from your Privy account.
        </p>
        <p>
          To withdraw: open the wallet pill in the topbar &rarr; pick
          USDC or ETH &rarr; paste a destination address &rarr; sign. The
          transaction is sent directly from your embedded wallet to your
          target address on Base. We are not in the path. There is no
          minimum, no waiting period, no manual review.
        </p>
      </section>

      <section>
        <h2>built on</h2>
        <ul>
          <li>
            <b>Avantis</b> &mdash; the perps protocol. Every position you
            open is an Avantis trade; every settlement is Avantis
            settling its book.{" "}
            <a href="https://avantisfi.com" target="_blank" rel="noreferrer">
              avantisfi.com
            </a>
          </li>
          <li>
            <b>Base</b> &mdash; the L2. Cheap, fast, EVM-compatible.
          </li>
          <li>
            <b>Pyth</b> &mdash; the price oracle Avantis reads from for
            ETH/USD.
          </li>
          <li>
            <b>Privy</b> &mdash; embedded wallet provisioning + auth.
          </li>
          <li>
            <b>Hiscore</b> &mdash; the unified player identity + leaderboard
            across our games (Swallow Me, Holy Liquid, ScalpRunner).
          </li>
        </ul>
      </section>

      <section>
        <h2>risks (read this)</h2>
        <ul>
          <li>
            <b>Leverage amplifies losses.</b> At 500&times;, a 0.2% adverse
            move liquidates you. You can lose your entire wager on a single
            round.
          </li>
          <li>
            <b>This is a perps product.</b> Not a savings product, not
            yield, not investment advice. Wager only what you can afford
            to lose.
          </li>
          <li>
            <b>Smart contract risk.</b> Avantis, USDC, Base, and the
            underlying contracts can have bugs or be exploited. Pyth oracle
            outages can cause unexpected liquidations.
          </li>
        </ul>
      </section>

      <section>
        <h2>more</h2>
        <p>
          Read the <a href="/terms">Terms of Service</a> and{" "}
          <a href="/privacy">Privacy Policy</a>. Questions?{" "}
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
