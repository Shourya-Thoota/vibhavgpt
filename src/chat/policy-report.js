import { moderationClassifierKey } from "./moderation.js";
import { config } from "../config.js";
import { lumenActiveRouteState, lumenPolicySummary, primaryProviderApproved } from "./providers.js";

// Which providers may receive user text, logged once at boot. Names and
// yes/no only: never keys, URLs or model ids. "reason" says why a Lumen
// stage is closed (not-approved, model-not-pinned, pinned-model-mismatch,
// provider-selected-model, not-configured).
export function inferencePolicyReport() {
  const lumenStages = lumenPolicySummary();
  // Whether Lumen can serve on the route it is actually on (gateway, staged or paid-zdr), from that route's own guard.
  const lumenActiveRoute = lumenActiveRouteState();
  return {
    event: "inference_policy",
    lumenAvailable: lumenActiveRoute.configured && lumenActiveRoute.approved,
    lumenChatRoute: config.lumenChatRoute,
    lumenActiveRoute,
    lumenStages,
    // Search intent and memory extraction run on the primary provider.
    primaryProviderTasks: primaryProviderApproved(),
    moderationClassifier: Boolean(moderationClassifierKey()),
  };
}

export function logInferencePolicy(log = console) {
  const report = inferencePolicyReport();
  (report.lumenAvailable ? log.info : log.warn).call(log, JSON.stringify(report));
  return report;
}
