/**
 * Seed Model Reference Matrix & Automatic Replacement Logic.
 * Section 3.3 and Section 4 of VibhavGPT Specification.
 *
 * Reference models from nine third-party providers (internal aliases provider-a to provider-i) plus VibhavGPT native.
 * Labels are neutral: no other company's name appears in brand, developer, familyGroup, modelName or notes. Only the routing
 * keys (id, routerModelId) keep the upstream identifiers they need; they are server-side and never served to the browser.
 */

import { calculateUsageMultiplier, mapMultiplierToTier } from "./pricing-engine.js";

/**
 * Seed Model Reference Matrix (Section 4).
 * Raw input/output costs are quoted in USD per 1M tokens.
 */
export const SEED_MODEL_REFERENCE_MATRIX = Object.freeze([
  // System Routers
  {
    id: "auto",
    brand: "NONE",
    modelName: "Auto",
    routerModelId: "auto",
    developer: "VibhavGPT",
    familyGroup: "system",
    performanceCategory: "balanced",
    rawInput: null,
    rawOutput: null,
    multiplier: null,
    uiDot: "Dynamic",
    plans: "Paid",
    notes: "System Router",
    capabilities: { vision: true, tools: true, streaming: true, structuredOutputs: true, reasoning: true },
    isSystem: true,
  },
  {
    id: "free",
    brand: "NONE",
    modelName: "Free",
    routerModelId: "free",
    developer: "VibhavGPT",
    familyGroup: "system",
    performanceCategory: "fast",
    rawInput: 0.00,
    rawOutput: 0.00,
    multiplier: 0.000,
    uiDot: "None",
    plans: "All",
    notes: "Baseline. Prompts capped.",
    capabilities: { vision: false, tools: true, streaming: true, structuredOutputs: true, reasoning: false },
    isSystem: true,
  },

  // 1. Provider A
  {
    id: "claude-3-5-haiku",
    brand: "Provider A",
    modelName: "Fast model A1",
    routerModelId: "anthropic/claude-3.5-haiku",
    developer: "Provider A",
    familyGroup: "provider-a",
    performanceCategory: "fast",
    rawInput: 0.80,
    rawOutput: 4.00,
    multiplier: 0.990,
    uiDot: "Green",
    plans: "All",
    notes: "Fast, highly efficient lightweight model for rapid responses.",
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: false,
      contextWindowTokens: 200000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "claude-3-5-sonnet",
    brand: "Provider A",
    modelName: "Balanced model A2",
    routerModelId: "anthropic/claude-3.5-sonnet",
    developer: "Provider A",
    familyGroup: "provider-a",
    performanceCategory: "balanced",
    rawInput: 3.00,
    rawOutput: 15.00,
    multiplier: 3.713,
    uiDot: "Orange",
    plans: "Paid",
    notes: "Industry-leading intelligence with exceptional coding and vision reasoning.",
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningModes: ["low", "normal", "high"],
      contextWindowTokens: 200000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "claude-3-7-sonnet",
    brand: "Provider A",
    modelName: "Advanced model A3",
    routerModelId: "anthropic/claude-3.7-sonnet",
    developer: "Provider A",
    familyGroup: "provider-a",
    performanceCategory: "best_intelligence",
    rawInput: 15.00,
    rawOutput: 75.00,
    multiplier: 18.563,
    uiDot: "Red",
    plans: "Pro",
    notes: "Hybrid reasoning model capable of instant output and extended fine-grained thinking.",
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningModes: ["low", "normal", "high"],
      contextWindowTokens: 200000,
      maxOutputTokens: 64000,
    },
  },

  // 2. Provider B
  {
    id: "gpt-4o-mini",
    brand: "Provider B",
    modelName: "Fast model B1",
    routerModelId: "openai/gpt-4o-mini",
    developer: "Provider B",
    familyGroup: "provider-b",
    performanceCategory: "fast",
    rawInput: 0.15,
    rawOutput: 0.60,
    multiplier: 0.165,
    uiDot: "Green",
    plans: "All",
    notes: "Fast, cost-efficient small model for everyday multimodal queries.",
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: false,
      contextWindowTokens: 128000,
      maxOutputTokens: 16384,
    },
  },
  {
    id: "gpt-4o",
    brand: "Provider B",
    modelName: "Balanced model B2",
    routerModelId: "openai/gpt-4o",
    developer: "Provider B",
    familyGroup: "provider-b",
    performanceCategory: "balanced",
    rawInput: 2.50,
    rawOutput: 10.00,
    multiplier: 2.750,
    uiDot: "Orange",
    plans: "Paid",
    notes: "Versatile flagship multimodal model with strong multilingual and coding acumen.",
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: false,
      contextWindowTokens: 128000,
      maxOutputTokens: 16384,
    },
  },
  {
    id: "o1",
    brand: "Provider B",
    modelName: "Advanced model B3",
    routerModelId: "openai/o1",
    developer: "Provider B",
    familyGroup: "provider-b",
    performanceCategory: "best_intelligence",
    rawInput: 15.00,
    rawOutput: 60.00,
    multiplier: 16.500,
    uiDot: "Red",
    plans: "Pro",
    notes: "Frontier reasoning model built to spend deliberate compute on STEM and code.",
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningModes: ["low", "normal", "high"],
      contextWindowTokens: 200000,
      maxOutputTokens: 100000,
    },
  },

  // 3. Provider C
  {
    id: "gemini-2-0-flash",
    brand: "Provider C",
    modelName: "Fast model C1",
    routerModelId: "google/gemini-2.0-flash-001",
    developer: "Provider C",
    familyGroup: "provider-c",
    performanceCategory: "fast",
    rawInput: 0.10,
    rawOutput: 0.40,
    multiplier: 0.110,
    uiDot: "Green",
    plans: "All",
    notes: "Next-gen ultra-low latency model with huge 1M context.",
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: false,
      contextWindowTokens: 1048576,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "gemini-1-5-pro",
    brand: "Provider C",
    modelName: "Balanced model C2",
    routerModelId: "google/gemini-1.5-pro",
    developer: "Provider C",
    familyGroup: "provider-c",
    performanceCategory: "balanced",
    rawInput: 1.25,
    rawOutput: 5.00,
    multiplier: 1.375,
    uiDot: "Yellow",
    plans: "Paid",
    notes: "Massive 2M token context window model with deep multimodal comprehension.",
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningModes: ["low", "normal"],
      contextWindowTokens: 2097152,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "gemini-2-0-flash-thinking",
    brand: "Provider C",
    modelName: "Advanced model C3",
    routerModelId: "google/gemini-2.0-flash-thinking-exp:free",
    developer: "Provider C",
    familyGroup: "provider-c",
    performanceCategory: "best_intelligence",
    rawInput: 2.50,
    rawOutput: 10.00,
    multiplier: 2.750,
    uiDot: "Orange",
    plans: "Pro",
    notes: "Frontier reasoning model with transparent thought chains.",
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningModes: ["low", "normal", "high"],
      contextWindowTokens: 1048576,
      maxOutputTokens: 65536,
    },
  },

  // 4. Provider D
  {
    id: "grok-2-mini",
    brand: "Provider D",
    modelName: "Fast model D1",
    routerModelId: "x-ai/grok-2-mini",
    developer: "Provider D",
    familyGroup: "provider-d",
    performanceCategory: "fast",
    rawInput: 0.20,
    rawOutput: 1.00,
    multiplier: 0.248,
    uiDot: "Green",
    plans: "All",
    notes: "Compact, efficient model with sharp intelligence and low latency.",
    capabilities: {
      vision: false,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: false,
      contextWindowTokens: 128000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "grok-2",
    brand: "Provider D",
    modelName: "Balanced model D2",
    routerModelId: "x-ai/grok-2-1212",
    developer: "Provider D",
    familyGroup: "provider-d",
    performanceCategory: "balanced",
    rawInput: 2.00,
    rawOutput: 10.00,
    multiplier: 2.475,
    uiDot: "Orange",
    plans: "Paid",
    notes: "State-of-the-art general language understanding.",
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: false,
      contextWindowTokens: 128000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "grok-2-vision",
    brand: "Provider D",
    modelName: "Advanced model D3",
    routerModelId: "x-ai/grok-2-vision-1212",
    developer: "Provider D",
    familyGroup: "provider-d",
    performanceCategory: "best_intelligence",
    rawInput: 2.00,
    rawOutput: 10.00,
    multiplier: 2.475,
    uiDot: "Orange",
    plans: "Pro",
    notes: "Advanced multimodal reasoning with image comprehension and document analysis.",
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningModes: ["low", "normal"],
      contextWindowTokens: 128000,
      maxOutputTokens: 16384,
    },
  },

  // 5. Provider E
  {
    id: "qwen-2-5-7b-instruct",
    brand: "Provider E",
    modelName: "Fast model E1",
    routerModelId: "qwen/qwen-2.5-7b-instruct",
    developer: "Provider E",
    familyGroup: "provider-e",
    performanceCategory: "fast",
    rawInput: 0.20,
    rawOutput: 0.60,
    multiplier: 0.193,
    uiDot: "Green",
    plans: "All",
    notes: "Ultra-fast open model with strong bilingual and coding proficiency.",
    capabilities: {
      vision: false,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: false,
      contextWindowTokens: 128000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "qwen-2-5-72b-instruct",
    brand: "Provider E",
    modelName: "Balanced model E2",
    routerModelId: "qwen/qwen-2.5-72b-instruct",
    developer: "Provider E",
    familyGroup: "provider-e",
    performanceCategory: "balanced",
    rawInput: 0.80,
    rawOutput: 2.00,
    multiplier: 0.715,
    uiDot: "Green",
    plans: "Paid",
    notes: "Flagship open model rivaling leading commercial models.",
    capabilities: {
      vision: false,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: false,
      contextWindowTokens: 128000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "qwen-qwq-32b-preview",
    brand: "Provider E",
    modelName: "Advanced model E3",
    routerModelId: "qwen/qwq-32b-preview",
    developer: "Provider E",
    familyGroup: "provider-e",
    performanceCategory: "best_intelligence",
    rawInput: 2.00,
    rawOutput: 6.00,
    multiplier: 1.925,
    uiDot: "Yellow",
    plans: "Pro",
    notes: "Deep thinking reasoning model specialized for mathematical and logical proofs.",
    capabilities: {
      vision: false,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningModes: ["low", "normal", "high"],
      contextWindowTokens: 32768,
      maxOutputTokens: 8192,
    },
  },

  // 6. Provider F
  {
    id: "kimi-8k",
    brand: "Provider F",
    modelName: "Fast model F1",
    routerModelId: "moonshotai/moonshot-v1-8k",
    developer: "Provider F",
    familyGroup: "provider-f",
    performanceCategory: "fast",
    rawInput: 0.20,
    rawOutput: 0.80,
    multiplier: 0.220,
    uiDot: "Green",
    plans: "All",
    notes: "Fast conversational intelligence for everyday assistance.",
    capabilities: {
      vision: false,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: false,
      contextWindowTokens: 8192,
      maxOutputTokens: 4096,
    },
  },
  {
    id: "kimi-32k",
    brand: "Provider F",
    modelName: "Balanced model F2",
    routerModelId: "moonshotai/moonshot-v1-32k",
    developer: "Provider F",
    familyGroup: "provider-f",
    performanceCategory: "balanced",
    rawInput: 1.00,
    rawOutput: 3.00,
    multiplier: 0.963,
    uiDot: "Green",
    plans: "Paid",
    notes: "Extended conversational context for complex documents and summaries.",
    capabilities: {
      vision: false,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: false,
      contextWindowTokens: 32768,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "kimi-128k",
    brand: "Provider F",
    modelName: "Advanced model F3",
    routerModelId: "moonshotai/moonshot-v1-128k",
    developer: "Provider F",
    familyGroup: "provider-f",
    performanceCategory: "best_intelligence",
    rawInput: 2.00,
    rawOutput: 8.00,
    multiplier: 2.200,
    uiDot: "Orange",
    plans: "Pro",
    notes: "Massive long-context retention capable of whole-book processing.",
    capabilities: {
      vision: false,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningModes: ["low", "normal"],
      contextWindowTokens: 131072,
      maxOutputTokens: 8192,
    },
  },

  // 7. Provider G
  {
    id: "nemotron-mini-4b",
    brand: "Provider G",
    modelName: "Fast model G1",
    routerModelId: "nvidia/nemotron-mini-4b-instruct",
    developer: "Provider G",
    familyGroup: "provider-g",
    performanceCategory: "fast",
    rawInput: 0.10,
    rawOutput: 0.30,
    multiplier: 0.096,
    uiDot: "Green",
    plans: "All",
    notes: "Ultra-compact model optimized for low-latency reasoning and edge inference.",
    capabilities: {
      vision: false,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: false,
      contextWindowTokens: 4096,
      maxOutputTokens: 2048,
    },
  },
  {
    id: "llama-3-1-nemotron-70b",
    brand: "Provider G",
    modelName: "Balanced model G2",
    routerModelId: "nvidia/llama-3.1-nemotron-70b-instruct",
    developer: "Provider G",
    familyGroup: "provider-g",
    performanceCategory: "balanced",
    rawInput: 0.90,
    rawOutput: 2.50,
    multiplier: 0.839,
    uiDot: "Green",
    plans: "Paid",
    notes: "Tuned 70B model with exceptional instruction following and math capability.",
    capabilities: {
      vision: false,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningModes: ["low", "normal"],
      contextWindowTokens: 128000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "nemotron-4-340b",
    brand: "Provider G",
    modelName: "Advanced model G3",
    routerModelId: "nvidia/nemotron-4-340b-instruct",
    developer: "Provider G",
    familyGroup: "provider-g",
    performanceCategory: "best_intelligence",
    rawInput: 6.00,
    rawOutput: 20.00,
    multiplier: 6.050,
    uiDot: "Orange",
    plans: "Pro",
    notes: "Massive 340B parameter powerhouse for deep synthetic reasoning and complex tasks.",
    capabilities: {
      vision: false,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningModes: ["low", "normal", "high"],
      contextWindowTokens: 128000,
      maxOutputTokens: 8192,
    },
  },

  // 8. Provider H
  {
    id: "glm-4-flash",
    brand: "Provider H",
    modelName: "Fast model H1",
    routerModelId: "zhipu/glm-4-flash",
    developer: "Provider H",
    familyGroup: "provider-h",
    performanceCategory: "fast",
    rawInput: 0.10,
    rawOutput: 0.10,
    multiplier: 0.069,
    uiDot: "Green",
    plans: "All",
    notes: "Ultra-fast response model optimized for high-throughput queries.",
    capabilities: {
      vision: false,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: false,
      contextWindowTokens: 128000,
      maxOutputTokens: 4096,
    },
  },
  {
    id: "glm-4-air",
    brand: "Provider H",
    modelName: "Balanced model H2",
    routerModelId: "zhipu/glm-4-air",
    developer: "Provider H",
    familyGroup: "provider-h",
    performanceCategory: "balanced",
    rawInput: 0.50,
    rawOutput: 1.50,
    multiplier: 0.481,
    uiDot: "Green",
    plans: "Paid",
    notes: "Cost-effective, highly balanced general-purpose model with strong multilingual skills.",
    capabilities: {
      vision: false,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: false,
      contextWindowTokens: 128000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "glm-4-plus",
    brand: "Provider H",
    modelName: "Advanced model H3",
    routerModelId: "zhipu/glm-4-plus",
    developer: "Provider H",
    familyGroup: "provider-h",
    performanceCategory: "best_intelligence",
    rawInput: 2.50,
    rawOutput: 10.00,
    multiplier: 2.750,
    uiDot: "Orange",
    plans: "Pro",
    notes: "Flagship frontier model with multimodal vision, complex reasoning, and long text.",
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningModes: ["low", "normal", "high"],
      contextWindowTokens: 128000,
      maxOutputTokens: 8192,
    },
  },

  // 9. Provider I
  {
    id: "mimo-7b",
    brand: "Provider I",
    modelName: "Fast model I1",
    routerModelId: "xiaomi/mimo-7b",
    developer: "Provider I",
    familyGroup: "provider-i",
    performanceCategory: "fast",
    rawInput: 0.15,
    rawOutput: 0.50,
    multiplier: 0.151,
    uiDot: "Green",
    plans: "All",
    notes: "Efficient, responsive model for everyday Q&A and edge interaction.",
    capabilities: {
      vision: false,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: false,
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
    },
  },
  {
    id: "mimo-1-5",
    brand: "Provider I",
    modelName: "Balanced model I2",
    routerModelId: "xiaomi/mimo-1.5",
    developer: "Provider I",
    familyGroup: "provider-i",
    performanceCategory: "balanced",
    rawInput: 1.00,
    rawOutput: 3.50,
    multiplier: 1.031,
    uiDot: "Yellow",
    plans: "Paid",
    notes: "Balanced multimodal intelligence for general tasks and visual understanding.",
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: false,
      contextWindowTokens: 64000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "mimo-frontier",
    brand: "Provider I",
    modelName: "Advanced model I3",
    routerModelId: "xiaomi/mimo-frontier",
    developer: "Provider I",
    familyGroup: "provider-i",
    performanceCategory: "best_intelligence",
    rawInput: 3.00,
    rawOutput: 12.00,
    multiplier: 3.300,
    uiDot: "Orange",
    plans: "Pro",
    notes: "Frontier research model with advanced multimodal perception and reasoning.",
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningModes: ["low", "normal", "high"],
      contextWindowTokens: 128000,
      maxOutputTokens: 16384,
    },
  },

  // 10. Native VibhavGPT Models
  {
    id: "lumen",
    brand: "VibhavGPT",
    modelName: "Lumen",
    routerModelId: "lumen",
    developer: "VibhavGPT",
    familyGroup: "vibhavgpt",
    performanceCategory: "fast",
    rawInput: 0.10,
    rawOutput: 0.50,
    multiplier: 0.124,
    uiDot: "Green",
    plans: "All",
    notes: "Fast everyday answers with minimal latency.",
    capabilities: {
      vision: false,
      tools: false,
      streaming: true,
      structuredOutputs: true,
      reasoning: false,
      contextWindowTokens: 131072,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "nova",
    brand: "VibhavGPT",
    modelName: "Nova",
    routerModelId: "nova",
    developer: "VibhavGPT",
    familyGroup: "vibhavgpt",
    performanceCategory: "balanced",
    rawInput: 1.00,
    rawOutput: 4.00,
    multiplier: 1.100,
    uiDot: "Yellow",
    plans: "All",
    notes: "General-purpose with balanced reasoning and vision capacity. Included with Free.",
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningModes: ["low", "normal"],
      contextWindowTokens: 1048576,
      maxOutputTokens: 65536,
    },
  },
  {
    id: "nebula",
    brand: "VibhavGPT",
    modelName: "Nebula",
    routerModelId: "nebula",
    developer: "VibhavGPT",
    familyGroup: "vibhavgpt",
    performanceCategory: "balanced",
    rawInput: 2.00,
    rawOutput: 10.00,
    multiplier: 2.475,
    uiDot: "Orange",
    plans: "Paid",
    notes: "Demanding, high-complexity reasoning and analytical work.",
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningModes: ["low", "normal", "high"],
      contextWindowTokens: 200000,
      maxOutputTokens: 64000,
    },
  },
  {
    id: "vesper",
    brand: "VibhavGPT",
    modelName: "Vulcan",
    routerModelId: "vesper",
    developer: "VibhavGPT",
    familyGroup: "vibhavgpt",
    performanceCategory: "best_intelligence",
    rawInput: 10.00,
    rawOutput: 50.00,
    multiplier: 12.375,
    uiDot: "Red",
    plans: "Pro",
    notes: "Flagship assistant with highest reasoning capacity for complex problems.",
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningModes: ["low", "normal", "high"],
      contextWindowTokens: 1000000,
      maxOutputTokens: 64000,
    },
  },
]);

/**
 * Normalizes model catalog list into brand containers for UI rendering.
 */
export function findSeedModelByKey(key) {
  if (!key) return null;
  const normKey = String(key).toLowerCase().trim();
  // 1. Exact match by id, modelName, or routerModelId
  const exact = SEED_MODEL_REFERENCE_MATRIX.find(
    (m) =>
      m.id?.toLowerCase() === normKey ||
      m.modelName?.toLowerCase() === normKey ||
      m.routerModelId?.toLowerCase() === normKey
  );
  if (exact) return exact;

  // 2. Substring fallback matching longest id first to avoid prefix shadowing
  const candidates = SEED_MODEL_REFERENCE_MATRIX.filter(
    (m) => m.id && normKey.includes(m.id.toLowerCase())
  );
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.id.length - a.id.length);
    return candidates[0];
  }

  return null;
}

export function groupModelsByBrand(models = SEED_MODEL_REFERENCE_MATRIX, brandOrder = []) {
  const groups = new Map();

  for (const model of models) {
    if (model.isSystem) continue;
    const brand = model.brand || "Other";
    if (!groups.has(brand)) {
      groups.set(brand, []);
    }
    groups.get(brand).push(model);
  }

  // Sort models within each brand: Flagship-First (highest mu first)
  for (const [, brandModels] of groups.entries()) {
    brandModels.sort((a, b) => {
      const muA = a.multiplier ?? 0;
      const muB = b.multiplier ?? 0;
      return muB - muA; // Highest multiplier first
    });
  }

  // Sort brand containers according to custom brandOrder, then alphabetically
  const orderedBrandEntries = [...groups.entries()].sort(([brandA], [brandB]) => {
    const idxA = brandOrder.indexOf(brandA);
    const idxB = brandOrder.indexOf(brandB);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return brandA.localeCompare(brandB);
  });

  return orderedBrandEntries.map(([brand, items]) => ({
    brand,
    models: items,
  }));
}

/**
 * Automatic Replacement Logic.
 */
export function triggerModelReplacement({
  oldModelId,
  newModel,
  catalog = [...SEED_MODEL_REFERENCE_MATRIX],
  userPreferences = {},
  isSessionLive = false,
}) {
  if (!oldModelId || !newModel || typeof newModel !== "object") {
    throw new Error("Invalid parameters: oldModelId and newModel are required");
  }

  if (isSessionLive) {
    return {
      success: false,
      blocked: true,
      reason: "live_session_hot_swap_prevented",
      message: "Automatic replacement routines switch and activate exclusively on client browser reload or runtime config fetch.",
    };
  }

  const existingIndex = catalog.findIndex((m) => m.id === oldModelId);
  if (existingIndex === -1) {
    return {
      success: false,
      blocked: false,
      reason: "model_not_found",
      message: `Model '${oldModelId}' not found in reference catalog.`,
    };
  }

  const oldModel = catalog[existingIndex];
  const rawInput = Number(newModel.rawInput ?? oldModel.rawInput);
  const rawOutput = Number(newModel.rawOutput ?? oldModel.rawOutput);
  const calculatedMu = calculateUsageMultiplier(rawInput, rawOutput);
  const tier = mapMultiplierToTier(calculatedMu);
  const uiDot = tier.uiRepresentation.split(" ")[0];

  const updatedModel = {
    ...oldModel,
    ...newModel,
    rawInput,
    rawOutput,
    multiplier: calculatedMu,
    uiDot,
  };

  const updatedCatalog = [...catalog];
  updatedCatalog[existingIndex] = updatedModel;

  const updatedPreferences = JSON.parse(JSON.stringify(userPreferences));
  if (Array.isArray(updatedPreferences.favoriteModelIds)) {
    const favIdx = updatedPreferences.favoriteModelIds.indexOf(oldModelId);
    if (favIdx !== -1) {
      updatedPreferences.favoriteModelIds[favIdx] = updatedModel.id;
    }
  }

  if (updatedPreferences.preferredModel === oldModelId) {
    updatedPreferences.preferredModel = updatedModel.id;
  }

  if (updatedPreferences.modelCategoryFlags?.[oldModelId]) {
    updatedPreferences.modelCategoryFlags[updatedModel.id] = {
      ...updatedPreferences.modelCategoryFlags[oldModelId],
    };
    delete updatedPreferences.modelCategoryFlags[oldModelId];
  }

  return {
    success: true,
    blocked: false,
    updatedCatalog,
    updatedPreferences,
    activationState: "pending_browser_reload",
  };
}
