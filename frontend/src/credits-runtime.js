// Which credits wording the screen shows right now.
//
// The static pages are prerendered, so the build decides what they say before JavaScript runs
// (VITE_CREDITS_PUBLIC_COPY, see credits-copy.js). The server decides what is enforced. This
// store makes the running page follow the server: it starts from the build's mode, so the first
// paint matches the prerendered HTML, and once GET /api/usage/policy answers it switches to what
// the server reports. A server-only rollback (or activation) therefore changes the wording on
// every open page without a frontend deployment, and a page can never keep advertising a policy
// the server is not enforcing. If the server cannot be reached the build's mode stands.

import { useSyncExternalStore } from "react";
import { normalizeCarryMode } from "./credits-policy.js";
import { PUBLIC_CREDITS_MODE } from "./credits-copy.js";

let serverMode; // undefined: not heard from the server yet; null: credits off; "expiry" | "carry"
const listeners = new Set();

/** The mode being shown: the server's once known, otherwise the one this build was made with. */
export function currentCreditsMode() {
  return serverMode === undefined ? PUBLIC_CREDITS_MODE : serverMode;
}

/** Record what the server reports (the body of GET /api/usage/policy). Returns the mode now shown. */
export function applyServerCreditsPolicy(policy) {
  const next = policy?.active ? normalizeCarryMode(policy.carryMode) : null;
  if (next !== serverMode) {
    serverMode = next;
    listeners.forEach((listener) => listener());
  }
  return currentCreditsMode();
}

export function subscribeCreditsMode(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests: forget what the server said. */
export function resetCreditsRuntime() {
  serverMode = undefined;
  listeners.forEach((listener) => listener());
}

/** React hook: re-renders when the server's policy changes the wording. Server rendering uses the build's mode. */
export function useCreditsMode() {
  return useSyncExternalStore(subscribeCreditsMode, currentCreditsMode, () => PUBLIC_CREDITS_MODE);
}
