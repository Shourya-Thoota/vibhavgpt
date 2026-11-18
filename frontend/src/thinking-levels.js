// One thinking control for every model (owner request, 2026-11-16): the person chooses Low, Medium or High, whatever the model, and this
// module turns that into what each model actually accepts. It is shared by the app and the server, so the two cannot disagree.
//
//   Low    -> the model's "low" (its lowest level when it has no "low")
//   Medium -> the model's "medium" (the next level above when it has none: GLM's "high")
//   High   -> the model's highest level ("max" for GPT-6, "xhigh" for Gemini 4 Hydrogen, "high" for Gemini 4 Carbon)
//
// Provider-specific levels ("none", "minimal", "xhigh", "max") are never shown, but they stay fully supported underneath: the server
// still accepts an exact provider level from an older client, and a stored one is read as the nearest of the three.

export const UNIFIED_LEVELS = Object.freeze(["low", "medium", "high"]);
export const THINKING_CHOICES = Object.freeze([
  Object.freeze({ value: "low", label: "Low", description: "Fastest replies, with the least thinking first." }),
  Object.freeze({ value: "medium", label: "Medium", description: "A balance of speed and careful reasoning." }),
  Object.freeze({ value: "high", label: "High", description: "The deepest reasoning this model offers; uses more output tokens." }),
]);
export const DEFAULT_UNIFIED_LEVEL = "medium";

const RANK = Object.freeze({ none: 0, minimal: 1, low: 2, medium: 3, normal: 3, high: 4, xhigh: 5, max: 6 });

/** Any stored or provider level, read as one of the three: off/minimal/low -> low; normal/medium -> medium; high/xhigh/max -> high. */
export function toUnified(value) {
  const level = String(value ?? "").trim().toLowerCase();
  if (["none", "off", "minimal", "low"].includes(level)) return "low";
  if (["normal", "medium"].includes(level)) return "medium";
  if (["high", "xhigh", "extra high", "max", "maximum"].includes(level)) return "high";
  return null;
}

export const unifiedLabel = (value) => THINKING_CHOICES.find((choice) => choice.value === toUnified(value))?.label ?? null;

/** The provider level a model receives for a unified level, from the levels that model documents. Null when it has none to adjust. */
export function providerLevelFor(levels, unified) {
  const usable = [...(levels ?? [])].filter((level) => level !== "none" && level !== "minimal" && RANK[level] !== undefined).sort((a, b) => RANK[a] - RANK[b]);
  if (!usable.length) return null;
  const want = toUnified(unified) ?? DEFAULT_UNIFIED_LEVEL;
  if (want === "low") return usable.includes("low") ? "low" : usable[0];
  if (want === "medium") return usable.includes("medium") ? "medium" : usable.find((level) => RANK[level] > RANK.medium) ?? usable.at(-1);
  return usable.at(-1);
}

/**
 * The effort a house model (Vulcan, Zenith) is sent for a unified level. High asks for "max", which the provider layer narrows to the
 * engine's own highest level (reasoning-effort.js nearestEffort), so High is always that engine's deepest setting.
 */
export function houseEffortFor(value) {
  const unified = toUnified(value);
  return unified === "low" ? "low" : unified === "medium" ? "medium" : unified === "high" ? "max" : null;
}
