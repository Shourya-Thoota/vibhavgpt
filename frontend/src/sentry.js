import { captureMessage, ErrorBoundary, init } from "@sentry/react";
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

// Only what the app calls (App.jsx captureMessage, main.jsx ErrorBoundary). Re-exporting the whole namespace kept the session-replay
// and feedback-widget code in the first download (about 190 KB) although neither is ever added (2026-11-17).
const Sentry = Object.freeze({ captureMessage, ErrorBoundary, init });

const dsn = import.meta.env.VITE_SENTRY_DSN;
if (dsn) Sentry.init(sentryOptions(dsn, import.meta.env.MODE));

export default Sentry;
