// Sentry is started in src/instrument.js, before the app loads. This module
// only re-exports it, plus the two ways the app reports errors.
import * as Sentry from "@sentry/node";

const safeCode = (value) => (/^[a-z0-9_.-]{1,60}$/i.test(String(value ?? "")) ? String(value) : "unclassified");

// A server error worth an alert: only 5xx. Client errors (validation,
// expected 4xx) are answered to the user and not reported. Returns whether
// it was reported.
export function reportServerError(error, { status = 500, requestId = null, route = null } = {}) {
  if (!(status >= 500)) return false;
  Sentry.withScope((scope) => {
    if (requestId) scope.setTag("requestId", requestId);
    if (route) scope.setTag("route", route);
    scope.setTag("status", String(status));
    scope.setTag("code", safeCode(error?.code));
    Sentry.captureException(error);
  });
  return true;
}

// A chat reply that failed. The report carries the reference id, the error
// code and where it happened, and the original stack frames, but never the
// original message text, so nothing from the conversation can reach it.
export function reportChatReplyFailure(error, { requestId = null, phase = null } = {}) {
  const code = safeCode(error?.code);
  const name = String(error?.name ?? "Error").slice(0, 60);
  const failure = new Error(`Chat reply failed: ${code}`);
  failure.name = name;
  const frames = String(error?.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line));
  if (frames.length) failure.stack = [`${name}: Chat reply failed: ${code}`, ...frames].join("\n");
  Sentry.withScope((scope) => {
    if (requestId) scope.setTag("requestId", requestId);
    if (phase) scope.setTag("phase", String(phase).slice(0, 40));
    scope.setTag("code", code);
    if (Number.isInteger(error?.status)) scope.setTag("status", String(error.status));
    if (error?.stageCode) scope.setTag("stageCode", safeCode(error.stageCode));
    Sentry.captureException(failure);
  });
}

export { Sentry };
