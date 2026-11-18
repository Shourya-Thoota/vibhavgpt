import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzePromptLayout,
  brokerAutoModel,
  buildAlgorithmicFallbackPath,
  isInterceptableFallbackError,
  slidingWindowSemanticTruncation,
  CLASSIFICATION_COMPLEXITY,
} from "../src/chat/auto-classifier.js";
import { SEED_MODEL_REFERENCE_MATRIX } from "../src/models/seed-catalog.js";

test("Auto Classifier: Prompt layout and intent analysis", () => {
  // Coding layout
  const codeAnalysis = analyzePromptLayout("Can you refactor this function?\n```javascript\nfunction add(a, b) { return a + b; }\n```");
  assert.equal(codeAnalysis.complexity, CLASSIFICATION_COMPLEXITY.CODING);
  assert.equal(codeAnalysis.intent, "software_engineering");

  // STEM / Deep reasoning layout
  const reasoningAnalysis = analyzePromptLayout("Step-by-step mathematical proof: prove that the square root of 2 is irrational.");
  assert.equal(reasoningAnalysis.complexity, CLASSIFICATION_COMPLEXITY.REASONING);

  // Lightweight layout
  const greetingAnalysis = analyzePromptLayout("Hi! How are you doing today?");
  assert.equal(greetingAnalysis.complexity, CLASSIFICATION_COMPLEXITY.LIGHTWEIGHT);

  // General layout
  const generalAnalysis = analyzePromptLayout("Could you write a brief summary of the history of coffee cultivation in South America?");
  assert.equal(generalAnalysis.complexity, CLASSIFICATION_COMPLEXITY.GENERAL);
});

test("Auto Brokerage: Subscription-aware filtering and Strict Plus Tier Restriction", () => {
  // Free tier: Must ALWAYS be Green Dot (mu <= 1.00)
  const freeCodingModel = brokerAutoModel({
    complexity: CLASSIFICATION_COMPLEXITY.CODING,
    plan: "free",
    catalog: SEED_MODEL_REFERENCE_MATRIX,
  });
  assert.ok(freeCodingModel.multiplier <= 1.00);
  assert.equal(freeCodingModel.uiDot, "Green");

  // Plus tier: Reasoning task should pick High compute (Orange Dot, mu <= 7.00)
  // Must STRICTLY drop Extra High (mu > 7.00)
  const plusReasoningModel = brokerAutoModel({
    complexity: CLASSIFICATION_COMPLEXITY.REASONING,
    plan: "plus",
    catalog: SEED_MODEL_REFERENCE_MATRIX,
  });
  assert.ok(plusReasoningModel.multiplier <= 7.00);
  assert.notEqual(plusReasoningModel.uiDot, "Red");
  assert.notEqual(plusReasoningModel.id, "chatgpt-gpt-6-astra"); // Extra High forbidden!

  // Pro tier: Reasoning task CAN pick Extra High (Red Dot, mu > 7.00)
  const proReasoningModel = brokerAutoModel({
    complexity: CLASSIFICATION_COMPLEXITY.REASONING,
    plan: "pro",
    catalog: SEED_MODEL_REFERENCE_MATRIX,
  });
  assert.ok(proReasoningModel.multiplier > 7.00);
  assert.equal(proReasoningModel.uiDot, "Red");
});

test("Auto Fallback Matrix: Algorithmic fallback chain complies with plan limits", () => {
  // If GPT-4o fails on Plus tier
  const plusFallbacks = buildAlgorithmicFallbackPath(
    "gpt-4o",
    "plus",
    SEED_MODEL_REFERENCE_MATRIX
  );
  assert.ok(plusFallbacks.length > 0);

  // NO model in Plus fallback chain may exceed mu = 7.00
  for (const fallback of plusFallbacks) {
    assert.ok(fallback.multiplier <= 7.00, `Fallback ${fallback.modelName} exceeds Plus ceiling: ${fallback.multiplier}`);
    assert.notEqual(fallback.uiDot, "Red");
  }

  // If o1 fails on Pro tier
  const proFallbacks = buildAlgorithmicFallbackPath(
    "o1",
    "pro",
    SEED_MODEL_REFERENCE_MATRIX
  );
  assert.ok(proFallbacks.length > 0);
  // Alternative flagship reasoning model should be near top of alternatives
  assert.equal(proFallbacks[0].id, "claude-3-7-sonnet");
});

test("Auto Fallback Matrix: Error interception rules (429, 500, Context Exhaustion)", () => {
  // HTTP 429
  assert.equal(isInterceptableFallbackError({ status: 429 }), true);
  // HTTP 500
  assert.equal(isInterceptableFallbackError({ status: 500 }), true);
  // HTTP 503
  assert.equal(isInterceptableFallbackError({ status: 503 }), true);
  // Context Exhaustion
  assert.equal(
    isInterceptableFallbackError({ message: "context_window_exceeded: maximum context length is 8192" }),
    true
  );
  // Non-interceptable client error (e.g. 400 Bad Request, 401 Unauthorized)
  assert.equal(isInterceptableFallbackError({ status: 400 }), false);
  assert.equal(isInterceptableFallbackError({ status: 401 }), false);
});

test("Live Session Context Truncation: Sliding window semantic summary preserving core variables", () => {
  const systemMessages = [
    { role: "system", content: "<PlatformRuntimePayload>Core Identity & Localization</PlatformRuntimePayload>" },
    { role: "system", content: "You are VibhavGPT Nova." },
  ];

  // Create a long history of 30 messages
  const history = [];
  for (let i = 1; i <= 30; i++) {
    history.push({ role: "user", content: `Question ${i}: tell me more about quantum entanglement details and mathematics.` });
    history.push({ role: "assistant", content: `Answer ${i}: Quantum entanglement demonstrates state correlations across space.` });
  }

  const currentMessage = { role: "user", content: "Now explain Bell inequalities." };

  const truncationResult = slidingWindowSemanticTruncation({
    systemMessages,
    history,
    currentMessage,
    maxTokenBudget: 1500, // Constrained budget to trigger truncation
  });

  assert.equal(truncationResult.ok, true);
  assert.equal(truncationResult.truncated, true);
  assert.ok(truncationResult.summarizedCount > 0);

  // Verify that Core Variables (Identity, Localization, Memory in systemMessages) are 100% PRESERVED
  assert.equal(truncationResult.messages[0].content, systemMessages[0].content);
  assert.equal(truncationResult.messages[1].content, systemMessages[1].content);

  // Verify that an abridged semantic vector message is inserted
  const summaryMsg = truncationResult.messages.find((m) =>
    typeof m.content === "string" && m.content.includes("<HistoricalContextSemanticSummary>")
  );
  assert.ok(summaryMsg, "Expected semantic summary vector message in prompt array");

  // Verify that current user message is at the end of the prompt array
  assert.equal(truncationResult.messages.at(-1).content, currentMessage.content);
});
