// The chat slot the current reply holds, for code deep in the model call (providers.js) that has no access to the request. Only
// counters are passed through: the upstream status a call met, so the slot's release line can say whether the bottleneck was the
// upstream host, our own limit, or a slow model. No database access here, so it is safe to import anywhere.
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage();

/** Run one chat request with a slot holder that acquireChatCapacity fills in. */
export function runWithCapacityScope(fn) {
  return scope.run({ lease: null }, fn);
}

export function currentCapacityScope() {
  return scope.getStore() ?? null;
}

/** Called by the model call on every upstream failure status (429, 5xx). */
export function noteUpstreamStatus(status) {
  const lease = scope.getStore()?.lease;
  if (lease && Number.isInteger(status)) lease.noteUpstream(status);
}

/** Called once the reply's first visible text has been sent. */
export function noteFirstVisibleToken() {
  scope.getStore()?.lease?.markFirstToken();
}
