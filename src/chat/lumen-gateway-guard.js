/**
 * Lumen's gateway guard: the shared route guard (route-policy-guard.js) for the one route Lumen chat uses, a single pinned host that
 * must stay free and must not train. Kept as its own small API, and its own log line ("lumen_gateway_policy"), so the boot evidence and
 * the existing callers stay as they were. There is one implementation: everything here delegates to the shared guard.
 */
import {
  GUARD_INTERVAL_MS,
  GUARD_MAX_AGE_MS,
  evaluateRoutePolicy,
  policiesFromProvidersPage,
  resetRoutePolicyStateForTests,
  routePolicyState,
  startRouteGuards,
  stopRouteGuards,
  verifyRoutePolicy,
} from "./route-policy-guard.js";

export { GUARD_INTERVAL_MS, GUARD_MAX_AGE_MS, policiesFromProvidersPage };

export const LUMEN_ROUTE = "lumen";
const lumenRoute = ({ model, provider }) => ({ route: LUMEN_ROUTE, model, mode: "pinned", hosts: provider ? [provider] : [], requireFree: true, event: "lumen_gateway_policy" });

export function lumenGatewayPolicyState({ model, provider, now = Date.now() } = {}) {
  const state = routePolicyState(LUMEN_ROUTE, { model, hosts: provider ? [provider] : [], now });
  return state.verified ? { verified: true, reason: "verified", evidence: state.evidence } : { verified: false, reason: state.reason };
}

/** Pure decision from the two fetched documents. Returns { ok, reason, evidence }. */
export function evaluateLumenGatewayPolicy({ endpointsJson, providersHtml, model, provider }) {
  const { ok, reason, evidence } = evaluateRoutePolicy({ endpointsJson, providersHtml, model, mode: "pinned", hosts: [provider], requireFree: true });
  return { ok, reason, evidence };
}

export function verifyLumenGatewayPolicy({ model, provider, ...options } = {}) {
  return verifyRoutePolicy({ ...options, ...lumenRoute({ model, provider }) });
}

/** Boot: check once, then hourly. Returns the first result. */
export async function startLumenGatewayGuard({ model, provider, ...options } = {}) {
  const results = await startRouteGuards([lumenRoute({ model, provider })], options);
  return results[LUMEN_ROUTE];
}

export function stopLumenGatewayGuard() {
  stopRouteGuards();
}

/** For tests only. */
export function resetLumenGatewayGuardForTests(next = null) {
  resetRoutePolicyStateForTests(LUMEN_ROUTE, next ? { ...next, hosts: next.provider ? next.provider : next.hosts } : null);
}
