/**
 * UI rollout gate for the customer-facing AI allowance surfaces.
 * Defaults to false (native app unchanged).
 * Enabled explicitly via runtime window flag or environment flag.
 * The server keeps its own gate (FEATURE_ALLOWANCE_SUMMARY_API) and session check;
 * this flag only decides whether signed-in surfaces render.
 */
export function isAllowanceUiEnabled() {
  if (typeof window !== "undefined" && window.__VIBHAVGPT_FEATURE_ALLOWANCE_UI !== undefined) {
    return Boolean(window.__VIBHAVGPT_FEATURE_ALLOWANCE_UI);
  }
  return import.meta.env?.VITE_FEATURE_ALLOWANCE_UI === "true";
}
