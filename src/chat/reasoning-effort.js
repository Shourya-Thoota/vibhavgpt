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

export const PROVIDER_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const UI_TO_PROVIDER = { low: "low", normal: "medium", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

// efforts: the levels the model accepts, or null for a model whose thinking
// is only on or off. mandatory: thinking cannot be turned off. reasoning:
// false for a model that does not support the parameter at all.
// Owner-approved behavior: Extra High and Maximum map to upstream 'high' for Nebula
// (google/gemini-3.8-flash) because the model supports up to 'high'; internal
// thinking-off steps use hidden low ({ effort: 'low', exclude: true }) because
// thinking is mandatory for this model. Preserves stored selections and UI controls.
export const MODEL_REASONING = {
  // Speculative mappings preserved for legacy tests
  "anthropic/claude-haiku-5.5": { efforts: ["none", "low", "medium", "high", "xhigh", "max"], mandatory: false },
  "google/gemini-3.8-flash": { efforts: ["low", "medium", "high"], mandatory: true },
  "gpt-6.1-terra": { efforts: ["none", "low", "medium", "high", "xhigh", "max"], mandatory: false },
  "openai/gpt-6.1-terra": { efforts: ["minimal", "low", "medium", "high", "xhigh"], mandatory: false },
  "deepseek/deepseek-v4.1-flash": { efforts: ["low", "high", "max"], mandatory: false },
  "moonshotai/kimi-k2.6": { efforts: null, mandatory: false },
  "x-ai/grok-4.7": { efforts: ["low", "medium", "high", "xhigh"], mandatory: true },

  // Genuine Multi-Model Catalog Reasoning Mappings
  // Anthropic Claude
  "claude-3-7-sonnet": { efforts: ["none", "low", "medium", "high"], mandatory: false },
  "anthropic/claude-3.7-sonnet": { efforts: ["none", "low", "medium", "high"], mandatory: false },
  "claude-3-5-sonnet": { efforts: ["none", "low", "medium", "high"], mandatory: false },
  "anthropic/claude-3.5-sonnet": { efforts: ["none", "low", "medium", "high"], mandatory: false },

  // OpenAI
  "o1": { efforts: ["low", "medium", "high"], mandatory: true },
  "openai/o1": { efforts: ["low", "medium", "high"], mandatory: true },

  // Google Gemini
  "gemini-2-0-flash-thinking": { efforts: ["low", "medium", "high"], mandatory: true },
  "google/gemini-2.0-flash-thinking-exp:free": { efforts: ["low", "medium", "high"], mandatory: true },
  "gemini-1-5-pro": { efforts: null, mandatory: false },
  "google/gemini-1.5-pro": { efforts: null, mandatory: false },

  // xAI Grok
  "grok-2-vision": { efforts: ["low", "medium", "high"], mandatory: false },
  "x-ai/grok-2-vision-1212": { efforts: ["low", "medium", "high"], mandatory: false },

  // Alibaba Qwen
  "qwen-qwq-32b-preview": { efforts: ["low", "medium", "high"], mandatory: true },
  "qwen/qwq-32b-preview": { efforts: ["low", "medium", "high"], mandatory: true },

  // Moonshot Kimi
  "kimi-128k": { efforts: null, mandatory: false },
  "moonshotai/moonshot-v1-128k": { efforts: null, mandatory: false },

  // NVIDIA
  "llama-3-1-nemotron-70b": { efforts: null, mandatory: false },
  "nvidia/llama-3.1-nemotron-70b-instruct": { efforts: null, mandatory: false },
  "nemotron-4-340b": { efforts: null, mandatory: false },
  "nvidia/nemotron-4-340b-instruct": { efforts: null, mandatory: false },

  // Z.AI
  "glm-4-plus": { efforts: null, mandatory: false },
  "zhipu/glm-4-plus": { efforts: null, mandatory: false },

  // Xiaomi MiMo
  "mimo-frontier": { efforts: null, mandatory: false },
  "xiaomi/mimo-frontier": { efforts: null, mandatory: false },

  // VibhavGPT Native
  "nova": { efforts: ["low", "medium"], mandatory: false },
  "nebula": { efforts: ["low", "medium", "high"], mandatory: true },
  "vesper": { efforts: ["low", "medium", "high", "xhigh", "max"], mandatory: true },
  // Zenith (Slice 7): its route accepts a reasoning effort of low, medium or high; higher app levels map to high.
  "zenith": { efforts: ["low", "medium", "high"], mandatory: false },
  // Zenith's engine, by the id requests are sent with (the row above, keyed "zenith", was never matched: reasoningParameter is given the
  // engine id). Mistral Large 4 accepts low, medium and high only (Mistral reasoning docs); higher app levels map to high, Normal to medium.
  "mistralai/mistral-large-4-0": { efforts: ["low", "medium", "high"], mandatory: false },
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
  // A validated, model-specific effort (a marketplace model's thinking level): sent exactly as given, never remapped. exclude asks the
  // router not to return the reasoning text, so private reasoning is never requested back.
  if (level && typeof level === "object" && level.exact) return level.exclude ? { effort: level.effort, exclude: true } : { effort: level.effort };
  const capability = MODEL_REASONING[model];
  if (capability?.reasoning === false) return undefined;
  if (level === false) {
    if (!capability?.mandatory) {
      if (capability?.efforts?.includes("none")) return { effort: "none" };
      return { enabled: false, exclude: true };
    }
    // Thinking cannot be off here: use the lightest level and keep it hidden.
    const lightest = capability.efforts?.length ? nearestEffort("minimal", capability.efforts) : null;
    return lightest ? { effort: lightest, exclude: true } : { enabled: true, exclude: true };
  }
  const standard = UI_TO_PROVIDER[String(level ?? "normal").toLowerCase()] ?? "medium";
  if (!capability) return { effort: standard };
  // A model whose thinking is only on or off: "Low" answers directly (owner decision, 2026-11-09: every level used to switch thinking on,
  // so the default Low made each reply think silently for many seconds before any text); every other level thinks.
  if (capability.efforts === null) return standard === "low" ? { enabled: false, exclude: true } : { enabled: true };
  return { effort: nearestEffort(standard, capability.efforts) };
}
