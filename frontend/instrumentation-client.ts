// Client-side Sentry init. Next.js 15 picks this up automatically
// (instrumentation-client.ts is the convention). Inert without
// NEXT_PUBLIC_SENTRY_DSN.

import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: Number(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.1",
    ),
    // Browser-only — automatic captureUnhandledRejections is the default.
    // No user PII is sent; identity is the wallet address only when we
    // explicitly tag it via Sentry.setUser elsewhere.
  });
}
