# Privacy Policy — DRAFT / NOT LEGAL ADVICE

> **DRAFT.** Reviewed by no attorney. Do NOT publish without legal
> review. Topics are correct; language is placeholder. GDPR/CCPA
> specifics need attention if you have EU/CA users.

_Last updated: [DATE]_

## What we collect

- **Wallet address.** Public, on-chain. Tied to your Privy account.
- **Privy account identifier (DID).** Used to authenticate API calls.
- **Trade history.** Open/close prices, leverage, wager, PnL,
  liquidation outcome, transaction hashes. Stored in Supabase.
- **Email or social login.** If you log in via Privy with email or
  social, that identity sits with Privy under their privacy policy.
  We see only the wallet address and the DID.
- **IP address and request metadata.** Standard server logs (Railway).
  Used for abuse prevention.
- **Browser error reports.** Sentry collects unhandled errors and
  stack traces. PII is not intentionally collected; the wallet
  address may be tagged on the error if available.

## What we do NOT collect

- We do not custody funds or private keys.
- We do not require KYC for gameplay.
- We do not sell user data.

## Where it lives

- **Supabase** (US-East). Trade rows.
- **Privy** (US). Embedded wallet provisioning + auth.
- **Railway** (US). Application logs.
- **Sentry** (US). Error reports.
- **Vercel** (Global edge). Frontend hosting.
- **Base / Avantis** (public chain). All transactions are public on
  basescan.org.

## Retention

- Trade history: indefinite (powering the leaderboard and your stats).
- Server logs: ~30 days (Railway default).
- Sentry: 90 days (default).

## Your rights

- Data deletion: email [contact@yourdomain]. We can purge your trade
  rows from our database; we cannot delete your on-chain history.
- Data export: email same address; we'll send a CSV.
- For EU/CA users specifically: [GDPR/CCPA-specific rights — get this
  drafted].

## Cookies

We use first-party cookies for authentication (Privy session). No
third-party advertising or tracking cookies.

## Children

The Service is not for users under 18.

## Changes

We will update this policy as practices change. Continued use after
an update is acceptance.

## Contact

[contact@yourdomain]
