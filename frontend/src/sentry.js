import * as Sentry from "@sentry/react";
import { SENTRY_DATA_COLLECTION, scrubBreadcrumb, scrubEvent } from "./sentry-scrub.js";

// Error monitoring for the app, only when VITE_SENTRY_DSN is set. It sends
// diagnostics only: no request bodies (a prompt, an upload), query strings,
// cookies or user identity, and no session replay is ever added.
export function sentryOptions(dsn, mode) {
  return {
    dsn,
    environment: mode,
    dataCollection: SENTRY_DATA_COLLECTION,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}

const dsn = import.meta.env.VITE_SENTRY_DSN;
if (dsn) Sentry.init(sentryOptions(dsn, import.meta.env.MODE));

export default Sentry;
