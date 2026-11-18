/**
 * UI rollout gate for authenticated model catalog browsing.
 * Defaults to false (native app unchanged).
 * Enabled explicitly via runtime window flag or environment flag.
 */
export function isCatalogUiEnabled() {
  if (typeof window !== "undefined" && window.__VIBHAVGPT_FEATURE_MODEL_CATALOG_UI !== undefined) {
    return Boolean(window.__VIBHAVGPT_FEATURE_MODEL_CATALOG_UI);
  }
  if (typeof process !== "undefined" && process.env?.VITE_FEATURE_MODEL_CATALOG_UI !== undefined) {
    return process.env.VITE_FEATURE_MODEL_CATALOG_UI === "true";
  }
  if (typeof import.meta !== "undefined" && import.meta.env?.VITE_FEATURE_MODEL_CATALOG_UI !== undefined) {
    return import.meta.env.VITE_FEATURE_MODEL_CATALOG_UI === "true";
  }
  return false;
}
