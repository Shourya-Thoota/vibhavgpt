import { moderationClassifierKey } from "./moderation.js";
import { lumenPolicySummary, primaryProviderApproved } from "./providers.js";

// Which providers may receive user text, logged once at boot. Names and
// yes/no only: never keys, URLs or model ids. "reason" says why a Lumen
// stage is closed (not-approved, model-not-pinned, pinned-model-mismatch,
// provider-selected-model, not-configured).
export function inferencePolicyReport() {
  const lumenStages = lumenPolicySummary();
  return {
    event: "inference_policy",
    lumenAvailable: lumenStages.some((stage) => stage.configured && stage.approved),
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
