// Thinking effort for the paid tiers, translated to what each model accepts.
//
// The app offers five levels (Normal, Low, High, Extra High, Maximum). The
// paid tiers go through the router, whose reasoning parameter takes an effort
// from a fixed scale, but each model supports only part of it: sending a
// level a model does not list may be mapped or rejected. So each UI level
// becomes a standard effort (Normal is "medium", the balanced level), and
// that is moved to the nearest level the model supports; a tie goes up.
// "Normal" is never left unconfigured.
//
// Supported levels come from the router's model list (GET /api/v1/models,
// reasoning.supported_efforts / mandatory). A model not listed here gets the
// standard effort as is.

export const PROVIDER_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];

const UI_TO_PROVIDER = { low: "low", normal: "medium", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

// efforts: the levels the model accepts, or null for a model whose thinking
// is only on or off. mandatory: thinking cannot be turned off. reasoning:
// false for a model that does not support the parameter at all.
export const MODEL_REASONING = {
  "deepseek/deepseek-v4.1-flash": { efforts: ["low", "high", "max"], mandatory: false },
  "moonshotai/kimi-k2.6": { efforts: null, mandatory: false },
  "x-ai/grok-4.7": { efforts: ["low", "medium", "high", "xhigh"], mandatory: true },
};

function nearestEffort(target, supported) {
  const want = PROVIDER_EFFORTS.indexOf(target);
  let best = null;
  for (const level of supported) {
    const index = PROVIDER_EFFORTS.indexOf(level);
    const distance = Math.abs(index - want);
    const bestDistance = best === null ? Infinity : Math.abs(PROVIDER_EFFORTS.indexOf(best) - want);
    if (distance < bestDistance || (distance === bestDistance && index > PROVIDER_EFFORTS.indexOf(best))) best = level;
  }
  return best;
}

// The reasoning parameter for one request, or undefined to send none.
// level is the app's effort ("normal", "low", "high", "xhigh", "max"), or
// false for a call that must not think (an internal step); null and unknown
// values mean "normal".
export function reasoningParameter(model, level) {
  const capability = MODEL_REASONING[model];
  if (capability?.reasoning === false) return undefined;
  if (level === false) {
    if (!capability?.mandatory) return { enabled: false, exclude: true };
    // Thinking cannot be off here: use the lightest level and keep it hidden.
    const lightest = capability.efforts?.length ? nearestEffort("minimal", capability.efforts) : null;
    return lightest ? { effort: lightest, exclude: true } : { enabled: true, exclude: true };
  }
  const standard = UI_TO_PROVIDER[String(level ?? "normal").toLowerCase()] ?? "medium";
  if (!capability) return { effort: standard };
  if (capability.efforts === null) return { enabled: true };
  return { effort: nearestEffort(standard, capability.efforts) };
}
