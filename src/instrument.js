// Error monitoring, loaded before the app with `node --import ./src/instrument.js`
// so Sentry starts ahead of Express and the HTTP and database modules.
// It runs only when SENTRY_DSN is set, and sends diagnostics only: no
// bodies, cookies, query strings or user identity (see sentry-scrub.js).
import "dotenv/config";
import * as Sentry from "@sentry/node";
import { SENTRY_DATA_COLLECTION, scrubBreadcrumb, scrubEvent } from "../frontend/src/sentry-scrub.js";

export function sentryOptions(env = process.env) {
  return {
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV ?? "development",
    release: env.RAILWAY_GIT_COMMIT_SHA || undefined,
    dataCollection: SENTRY_DATA_COLLECTION,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}

if (process.env.SENTRY_DSN) Sentry.init(sentryOptions());
