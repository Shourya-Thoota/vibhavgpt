/**
 * "Auto" Intelligence Engine Orchestration, Brokerage & Algorithmic Fallback Matrix.
 * Section 3.4.4 and Section 7 of VibhavGPT Specification.
 *
 * Implements:
 * 1. Orchestration Scan & Intent/Complexity Classification
 * 2. Subscription-Aware Brokerage Filtering (Strict Plus Tier drop mu > 7.00)
 * 3. Algorithmic Fallback Matrix & Deterministic Exception Interception (429, 500, Context Exhaustion)
 * 4. Live Session Context Truncation Strategy (sliding window semantic vector preserving core variables)
 */

import { SEED_MODEL_REFERENCE_MATRIX } from "../models/seed-catalog.js";
import { isModelEligibleForPlan } from "../usage/plan-throttle-policy.js";
import { estimateChatPromptTokens, estimateChatMessageTokens } from "./context-window.js";
import { logUpstreamFailure } from "./upstream-telemetry.js";
import { AUTO_CLASSIFIER_MODEL, routeAllowed } from "./route-inventory.js";

export const CLASSIFICATION_COMPLEXITY = Object.freeze({
  LIGHTWEIGHT: "lightweight",
  GENERAL: "general",
  HIGH_COMPUTE: "high_compute",
  REASONING: "reasoning",
  CODING: "coding",
});

/**
 * Heuristic analyzer for prompt layout, syntax, and task complexity.
 * Serves as high-speed, 100% reliable baseline and fallback for the orchestration scanner.
 */
export function analyzePromptLayout(promptText = "") {
  const text = String(promptText || "").trim();
  const len = text.length;
  const lower = text.toLowerCase();

  // 1. Code / Programming Layout Detection
  const codeMarkers = [
    "```", "function ", "class ", "def ", "import ", "const ", "let ", "return ",
    "public static void", "<script", "select * from", "dockerfile", "npm install",
    "regex", "async function", "refactor", "debug this", "unit test", "stack trace",
  ];
  const hasCodeMarkers = codeMarkers.some((marker) => lower.includes(marker));
  if (hasCodeMarkers) {
    return {
      complexity: CLASSIFICATION_COMPLEXITY.CODING,
      intent: "software_engineering",
      confidence: 0.95,
      reason: "Detected code syntax blocks, programming constructs, or debugging keywords.",
    };
  }

  // 2. STEM / High-Compute Reasoning Layout Detection
  const reasoningMarkers = [
    "prove that", "derive the", "calculate the derivative", "step-by-step mathematical proof",
    "stochastic", "differential equation", "quantum", "bayes theorem", "optimization theorem",
    "deep analysis", "compare and contrast in detail", "multi-step logic", "architectural specification",
    "system architecture", "formal proof", "algorithmic complexity",
  ];
  const hasReasoningMarkers = reasoningMarkers.some((marker) => lower.includes(marker));
  if (hasReasoningMarkers || (len > 1200 && lower.includes("step"))) {
    return {
      complexity: CLASSIFICATION_COMPLEXITY.REASONING,
      intent: "stem_deep_reasoning",
      confidence: 0.90,
      reason: "Detected formal mathematical, logical proof, or multi-step reasoning markers.",
    };
  }

  // 3. Lightweight Conversational Layout Detection
  const lightweightPatterns = [
    /^(hi|hello|hey|good\s+(morning|afternoon|evening)|howdy)\b/i,
    /^(thanks|thank you|cool|okay|got it|sounds good)\b/i,
    /^(what is the capital of|who was|define|translate|spelling of|how do you pronounce)\b/i,
  ];
  const isLightweight = (len < 100 && lightweightPatterns.some((pattern) => pattern.test(lower))) || len < 40;
  if (isLightweight) {
    return {
      complexity: CLASSIFICATION_COMPLEXITY.LIGHTWEIGHT,
      intent: "quick_lookup_or_greeting",
      confidence: 0.95,
      reason: "Short conversational exchange or basic lookup query.",
    };
  }

  // 4. Default: General Conversational / Synthesis
  return {
    complexity: CLASSIFICATION_COMPLEXITY.GENERAL,
    intent: "general_synthesis",
    confidence: 0.85,
    reason: "Standard informational, writing, or analysis task.",
  };
}

/**
 * Step 1 & 2: Orchestration Scan & Intent/Complexity Classification.
 * Attempts low-latency classifier `openrouter/google/gemini-2.5-flash:free` if reachable;
 * falls back cleanly to deterministic local layout analysis.
 */
export async function scanAndClassifyPrompt(
  promptText,
  { apiKey = null, fetchImpl = fetch, timeoutMs = 1500 } = {}
) {
  const localAnalysis = analyzePromptLayout(promptText);

  // If no external key or testing offline, return local classification immediately
  // The prompt is only sent while the classifier's route may receive text (route-inventory.js); otherwise the local analysis decides.
  if (!apiKey || !routeAllowed("auto-classifier")) {
    return localAnalysis;
  }

  // Attempt upstream OpenRouter ultra-low-latency classifier
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: AUTO_CLASSIFIER_MODEL,
        messages: [
          {
            role: "system",
            content:
              'Classify prompt complexity as JSON: {"complexity":"lightweight"|"general"|"reasoning"|"coding"}. Reply with JSON only.',
          },
          { role: "user", content: String(promptText).slice(0, 500) },
        ],
        max_tokens: 25,
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!res.ok) await logUpstreamFailure({ route: "auto_classifier", model: "auto-classifier", response: res, requestBody: { messages: [{ content: String(promptText ?? "") }] } });
    if (res.ok) {
      const json = await res.json();
      const rawText = json?.choices?.[0]?.message?.content || "";
      const parsed = JSON.parse(rawText.match(/\{[\s\S]*\}/)?.[0] || "{}");
      if (parsed.complexity && Object.values(CLASSIFICATION_COMPLEXITY).includes(parsed.complexity)) {
        return {
          complexity: parsed.complexity,
          intent: `upstream_${parsed.complexity}`,
          confidence: 0.98,
          classifierModel: "openrouter/google/gemini-2.5-flash:free",
        };
      }
    }
  } catch {
    // Graceful fallback to deterministic local classification
  }

  return localAnalysis;
}

/**
 * Step 3: Subscription-Aware Brokerage Filtering.
 *
 * Matches classified complexity against the user's active billing tier.
 * Strict Plus Tier Restriction:
 * The routing engine must explicitly filter out and drop all Extra High tier models (mu > 7.00).
 *
 * @param {Object} params
 * @param {string} params.complexity - Task complexity from classifier
 * @param {string} params.plan - User plan ("free" | "plus" | "pro" | "max")
 * @param {Array} params.catalog - Available models catalog
 * @returns {Object} Target brokered model
 */
export function brokerAutoModel({
  complexity = CLASSIFICATION_COMPLEXITY.GENERAL,
  plan = "free",
  catalog = SEED_MODEL_REFERENCE_MATRIX,
} = {}) {
  const normPlan = String(plan || "free").toLowerCase();

  // 1. Filter out system placeholders (auto, free) and models requiring scheduled future launch
  const now = new Date();
  const eligibleCandidates = catalog.filter((m) => {
    if (m.isSystem) return false;
    if (m.scheduledEffectiveDate && new Date(m.scheduledEffectiveDate) > now) return false;

    // Check plan eligibility & Strict Plus Tier Restriction (mu <= 7.00 for Plus)
    const eligibility = isModelEligibleForPlan(normPlan, {
      calculatedMu: m.multiplier,
      consumptionCategory: m.uiDot?.toLowerCase(),
    });
    return eligibility.eligible;
  });

  if (!eligibleCandidates.length) {
    // Ultimate fallback to baseline entry model
    return catalog.find((m) => m.id === "chatgpt-gpt-6-luna") || catalog[0];
  }

  // 2. Select optimal target model based on complexity and plan scope
  if (normPlan === "free") {
    // Free is strictly restricted to Green Dot models
    const greenModels = eligibleCandidates.filter((m) => m.multiplier <= 1.00);
    if (complexity === CLASSIFICATION_COMPLEXITY.CODING || complexity === CLASSIFICATION_COMPLEXITY.REASONING) {
      // Pick highest capability Green Dot model (e.g. Qwen 3.7 Plus or Gemini 3.8 Flash)
      return greenModels.find((m) => m.id === "qwen-3.7-plus") || greenModels[0];
    }
    // Default lightweight/general
    return greenModels.find((m) => m.id === "chatgpt-gpt-6-luna") || greenModels[0];
  }

  if (normPlan === "plus") {
    // Plus: Low, Medium, and High compute (mu <= 7.00). Strict drop of mu > 7.00!
    if (complexity === CLASSIFICATION_COMPLEXITY.REASONING) {
      // High compute (Orange Dot, mu between 2.0 and 7.0)
      const highCompute = eligibleCandidates.filter((m) => m.multiplier > 2.0 && m.multiplier <= 7.0);
      return highCompute.find((m) => m.id === "chatgpt-gpt-6.1-sol") ||
             highCompute.find((m) => m.id === "anthropic-claude-sonnet-5.5") ||
             highCompute[0] || eligibleCandidates[0];
    }
    if (complexity === CLASSIFICATION_COMPLEXITY.CODING) {
      // Medium compute (Yellow Dot, e.g. GPT-6.1 Terra or DeepSeek V4 Pro)
      const yellowModels = eligibleCandidates.filter((m) => m.multiplier > 1.0 && m.multiplier <= 2.0);
      return yellowModels.find((m) => m.id === "chatgpt-gpt-6.1-terra") ||
             yellowModels.find((m) => m.id === "deepseek-v4-pro") ||
             yellowModels[0] || eligibleCandidates[0];
    }
    // Lightweight or General
    const greenOrYellow = eligibleCandidates.filter((m) => m.multiplier <= 2.0);
    return greenOrYellow.find((m) => m.id === "chatgpt-gpt-6-luna") || greenOrYellow[0];
  }

  // Pro and Max: Can access Extra High (mu > 7.00, Red Dot) for complex reasoning
  if (normPlan === "pro" || normPlan === "max") {
    if (complexity === CLASSIFICATION_COMPLEXITY.REASONING) {
      // Flagship Extra High model (Red Dot)
      const extraHigh = eligibleCandidates.filter((m) => m.multiplier > 7.0);
      if (extraHigh.length) {
        return extraHigh.find((m) => m.id === "chatgpt-gpt-6-astra") ||
               extraHigh.find((m) => m.id === "anthropic-claude-sonnet-5.1") ||
               extraHigh[0];
      }
    }
    if (complexity === CLASSIFICATION_COMPLEXITY.CODING) {
      // High compute reasoning model
      const highCompute = eligibleCandidates.filter((m) => m.multiplier > 2.0 && m.multiplier <= 7.0);
      return highCompute.find((m) => m.id === "anthropic-claude-sonnet-5.5") ||
             highCompute.find((m) => m.id === "chatgpt-gpt-6.1-sol") ||
             highCompute[0] || eligibleCandidates[0];
    }
    // General / Lightweight
    return eligibleCandidates.find((m) => m.id === "chatgpt-gpt-6.1-terra") || eligibleCandidates[0];
  }

  return eligibleCandidates[0];
}

/**
 * Algorithmic Fallback Matrix & Exception Interception Layer.
 *
 * Section 3.4.4:
 * "In the event of a failure (HTTP 429, 500, Context Exhaustion), the system will automatically
 * reroute the active execution track down an explicit fallback path to the next best available
 * alternative model that strictly complies with the user's active plan ceilings."
 *
 * @param {string} failedModelId
 * @param {string} plan
 * @param {Array} catalog
 * @returns {Array<Object>} Ordered chain of alternative fallback models
 */
export function buildAlgorithmicFallbackPath(
  failedModelId,
  plan = "free",
  catalog = SEED_MODEL_REFERENCE_MATRIX
) {
  const normPlan = String(plan || "free").toLowerCase();

  // Find candidate models eligible for this plan, excluding the failed model
  const eligible = catalog.filter((m) => {
    if (m.isSystem) return false;
    if (m.id === failedModelId) return false;
    const check = isModelEligibleForPlan(normPlan, {
      calculatedMu: m.multiplier,
      consumptionCategory: m.uiDot?.toLowerCase(),
    });
    return check.eligible;
  });

  const failedModel = catalog.find((m) => m.id === failedModelId);
  const targetMu = failedModel?.multiplier ?? 1.0;

  // Sort alternatives by proximity in compute multiplier, preserving similar capability tier
  return eligible.sort((a, b) => {
    const diffA = Math.abs((a.multiplier ?? 0) - targetMu);
    const diffB = Math.abs((b.multiplier ?? 0) - targetMu);
    return diffA - diffB;
  });
}

/**
 * Determines whether an error is interceptable by the Algorithmic Fallback Matrix.
 */
export function isInterceptableFallbackError(error) {
  if (!error) return false;
  const status = Number(error.status || error.statusCode || error.response?.status);
  const msg = String(error.message || "").toLowerCase();

  // HTTP 429 (Rate Limit), HTTP 500, 502, 503, 504 (Provider outages)
  if (status === 429 || (status >= 500 && status <= 504)) return true;

  // Context Exhaustion / Window Overflow
  if (
    msg.includes("context") && (msg.includes("exhaust") || msg.includes("overflow") || msg.includes("too large") || msg.includes("maximum context length"))
  ) {
    return true;
  }
  if (msg.includes("rate limit") || msg.includes("overloaded") || msg.includes("service unavailable")) {
    return true;
  }

  return false;
}

/**
 * Live Session Context Truncation Strategy.
 *
 * Section 3.4.4:
 * "When a high-compute conversation thread encounters the physical maximum context window allocation,
 * the system must invoke an automated window sliding truncation algorithm rather than failing,
 * dynamically aggregating the oldest historical message blocks into an absolute summarized semantic vector
 * while preserving core variables (Identity, Localization, Memory profiles)."
 *
 * @param {Object} params
 * @param {Array} params.systemMessages - Protected core system messages (Identity, Localization, Memory)
 * @param {Array} params.history - Conversational message history
 * @param {Object} params.currentMessage - Active user message turn
 * @param {Array} params.referenceMessages - Reference documents / search results
 * @param {number} params.maxTokenBudget - Maximum allowable prompt token budget
 * @returns {Object} { ok: boolean, truncated: boolean, messages: Array }
 */
export function slidingWindowSemanticTruncation({
  systemMessages = [],
  history = [],
  currentMessage,
  referenceMessages = [],
  maxTokenBudget = 24_000,
} = {}) {
  // 1. Core Variables Preservation (Identity, Localization, Memory)
  // Protected system messages MUST NOT be dropped
  const protectedSystem = [...systemMessages];
  const systemTokens = estimateChatPromptTokens(protectedSystem);
  const currentTokens = currentMessage ? estimateChatMessageTokens(currentMessage) : 0;

  const baselineTokens = systemTokens + currentTokens;
  if (baselineTokens > maxTokenBudget) {
    // If system + current message alone exceed budget, reduce references and return
    return {
      ok: false,
      truncated: false,
      messages: [...protectedSystem, ...(currentMessage ? [currentMessage] : [])],
      reason: "baseline_exceeds_budget",
    };
  }

  let availableForHistory = maxTokenBudget - baselineTokens;

  // Include reference messages if room permits
  let keptReferences = [];
  for (const ref of referenceMessages) {
    const cost = estimateChatMessageTokens(ref);
    if (availableForHistory - cost > 2000) {
      keptReferences.push(ref);
      availableForHistory -= cost;
    }
  }

  // 2. Sliding window over history with atomic tool exchange grouping
  const historyList = Array.isArray(history) ? history : [];
  if (historyList.length === 0) {
    return {
      ok: true,
      truncated: false,
      messages: [...protectedSystem, ...keptReferences, ...(currentMessage ? [currentMessage] : [])],
    };
  }

  // Group history messages into atomic turn blocks so tool call and tool result pairs are never severed
  const atomicBlocks = [];
  let currentBlock = [];
  for (let i = 0; i < historyList.length; i++) {
    const msg = historyList[i];
    if (msg.role === "user") {
      if (currentBlock.length) {
        atomicBlocks.push(currentBlock);
        currentBlock = [];
      }
      currentBlock.push(msg);
    } else if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      if (currentBlock.length && currentBlock[0].role !== "user") {
        atomicBlocks.push(currentBlock);
        currentBlock = [];
      }
      currentBlock.push(msg);
    } else if (msg.role === "tool") {
      currentBlock.push(msg);
    } else {
      currentBlock.push(msg);
      atomicBlocks.push(currentBlock);
      currentBlock = [];
    }
  }
  if (currentBlock.length) {
    atomicBlocks.push(currentBlock);
  }

  const recentBlocks = [];
  let olderBlocksToSummarize = [];
  let consumedTokens = 0;

  for (let i = atomicBlocks.length - 1; i >= 0; i--) {
    const block = atomicBlocks[i];
    const blockCost = estimateChatPromptTokens(block);
    if (consumedTokens + blockCost <= availableForHistory - 500) {
      recentBlocks.unshift(block);
      consumedTokens += blockCost;
    } else {
      olderBlocksToSummarize = atomicBlocks.slice(0, i + 1);
      break;
    }
  }

  const recentHistory = recentBlocks.flat();

  // 3. Dynamic Aggregation of oldest historical message blocks into summarized semantic vector
  let semanticSummaryMessage = null;
  const olderMessages = olderBlocksToSummarize.flat();
  if (olderMessages.length > 0) {
    const summaryLines = [];
    for (const msg of olderMessages.slice(-12)) {
      if (msg.role === "tool") {
        const cleanContent = String(msg.content || "").replace(/\s+/g, " ").trim().slice(0, 150);
        summaryLines.push(`Tool Output [${msg.tool_call_id || "call"}]: ${cleanContent}`);
      } else if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const toolNames = msg.tool_calls.map((c) => c.function?.name || c.name || "tool").join(", ");
        summaryLines.push(`VibhavGPT: [Called tools: ${toolNames}]`);
      } else {
        const roleName = msg.role === "user" ? "User" : "VibhavGPT";
        const cleanContent = String(msg.content || "").replace(/\s+/g, " ").trim().slice(0, 150);
        if (cleanContent) summaryLines.push(`${roleName}: ${cleanContent}`);
      }
    }

    if (summaryLines.length) {
      semanticSummaryMessage = {
        role: "user",
        content: `<HistoricalContextSemanticSummary>\nEarlier conversation turns summarized to fit model context:\n${summaryLines.join("\n")}\n</HistoricalContextSemanticSummary>`,
      };
    }
  }

  const finalMessages = [
    ...protectedSystem,
    ...(semanticSummaryMessage ? [semanticSummaryMessage] : []),
    ...keptReferences,
    ...recentHistory,
    ...(currentMessage ? [currentMessage] : []),
  ];

  return {
    ok: true,
    truncated: olderMessages.length > 0,
    summarizedCount: olderMessages.length,
    messages: finalMessages,
  };
}
