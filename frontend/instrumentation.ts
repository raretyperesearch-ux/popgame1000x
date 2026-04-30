// Next.js 15 instrumentation hook — runs once per runtime (server, edge,
// client). Inert when NEXT_PUBLIC_SENTRY_DSN is unset, so this file
// adds nothing to the build when Sentry isn't configured.
//
// Source-map upload + the next.config wrapper aren't wired here on
// purpose — they need API tokens and a build step that can fail. Once
// the team is comfortable with manual unminified stack traces in the
// Sentry UI, the official `withSentryConfig` wrapper is the upgrade.

export async function register() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return;

  if (process.env.NEXT_RUNTIME === "nodejs") {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    });
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    });
  }
}
