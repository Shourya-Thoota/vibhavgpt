// Keeps the page's credits wording in step with the server, and records whether the static pages
// agree.
//
// Three values are written on the document root (read by an operator or a test; no screen uses them):
//   data-credits-copy    what this build's static pages were made to say (VITE_CREDITS_PUBLIC_COPY)
//   data-credits-server  what the server says it is enforcing (GET /api/usage/policy)
//   data-credits-shown   what this page is showing now (the server's, once it has answered)
// `copy` and `server` differing means the prerendered snapshot is stale for a visitor without
// JavaScript or a crawler; `shown` follows `server`, so a person using the site sees the right words.
// Nothing here names a provider or carries account data.

import { API_BASE } from "./api.js";
import { PUBLIC_CREDITS_MODE } from "./credits-copy.js";
import { applyServerCreditsPolicy, currentCreditsMode } from "./credits-runtime.js";

export function describeCreditsMatch(buildMode, serverPolicy) {
  const server = serverPolicy?.active ? serverPolicy.carryMode : null;
  return { build: buildMode ?? null, server, match: (buildMode ?? null) === server, serverVersion: serverPolicy?.version ?? null };
}

export async function checkCreditsCopyMatchesServer({ fetchImpl = globalThis.fetch, root = globalThis.document?.documentElement } = {}) {
  try {
    const response = await fetchImpl(`${API_BASE}/api/usage/policy`, { credentials: "include", headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return null;
    const policy = await response.json();
    applyServerCreditsPolicy(policy);
    const result = describeCreditsMatch(PUBLIC_CREDITS_MODE, policy);
    if (root) {
      root.dataset.creditsCopy = result.build ?? "off";
      root.dataset.creditsServer = result.server ?? "off";
      root.dataset.creditsShown = currentCreditsMode() ?? "off";
      if (result.serverVersion) root.dataset.creditsPolicy = result.serverVersion;
    }
    if (!result.match) console.warn("[credits] The static pages were built for credits mode \"%s\" but the server is enforcing \"%s\". This page shows the server's.", result.build ?? "off", result.server ?? "off");
    return result;
  } catch {
    return null;
  }
}

/** Ask now, again whenever the tab regains focus, and every few minutes, so an open page follows a rollback. */
export function startCreditsPolicySync({ intervalMs = 5 * 60_000, target = globalThis.window } = {}) {
  if (!target) return () => {};
  const refresh = () => { void checkCreditsCopyMatchesServer(); };
  refresh();
  target.addEventListener("focus", refresh);
  const timer = setInterval(refresh, intervalMs);
  return () => { target.removeEventListener("focus", refresh); clearInterval(timer); };
}
