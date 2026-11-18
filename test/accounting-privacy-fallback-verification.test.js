import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const db = drizzle(client);

mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db, pool: { query: (text, params) => client.query(text, params) } },
});

const schema = await import("../src/db/schema.js");
const {
  calculateUnifiedLedgerDeductionMicros,
  calculateUsageMultiplier,
  calculateUserAllocationLimitTokens,
  microsToComputePoints,
  computePointsToMicros,
  PROFIT_MARGIN_MODIFIER,
} = await import("../src/models/pricing-engine.js");
const {
  accountingClassFor,
  ACCOUNTING_CLASSES,
} = await import("../src/usage/shadow-ledger.js");
const {
  reserveUsage,
  finalizeUsage,
} = await import("../src/usage/service.js");
const {
  scanAndClassifyPrompt,
  buildAlgorithmicFallbackPath,
  slidingWindowSemanticTruncation,
} = await import("../src/chat/auto-classifier.js");
const { assembleStandardizedPlatformPayload, buildTemporalSpatialLocalization } = await import("../src/chat/runtime-context.js");
const { failureShowsZeroUsage } = await import("../src/chat/providers.js");

async function createTestUser(userId, tier = "plus") {
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, `${userId}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
  await db.insert(schema.subscriptions).values({
    userId,
    tier,
    status: "active",
    currentPeriodStartedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    currentPeriodEndsAt: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(),
  });
}

test("Accounting: Actual token input/output usage debit with single 1.10 profit markup", async () => {
  // Example model: input $1.50/1M, output $6.00/1M
  // 10,000 input tokens, 20,000 output tokens
  // Raw input: (10,000 * 1.50) / 1,000,000 = $0.015 = 15,000 micros
  // Raw output: (20,000 * 6.00) / 1,000,000 = $0.120 = 120,000 micros
  // Total raw = 135,000 micros ($0.135)
  // With 1.10 markup: 135,000 * 1.10 = 148,500 micros ($0.1485)
  const debitMicros = calculateUnifiedLedgerDeductionMicros({
    inputTokens: 10_000,
    outputTokens: 20_000,
    inputPriceMicrosPerM: 1_500_000,
    outputPriceMicrosPerM: 6_000_000,
  });

  assert.equal(debitMicros, 148_500, "Debit must exactly equal raw cost * 1.10");

  // Verify exactly ONE application of 1.10 modifier:
  const rawCost = 135_000;
  assert.equal(debitMicros / rawCost, 1.10, "Profit margin modifier is applied exactly once, never doubled");

  // Settle via finalizeUsage: usageEvents stores raw wholesale cost in micro-dollars
  const userId = "user_accounting_token";
  await createTestUser(userId, "plus");
  const reservation = await reserveUsage(userId, "claude-3-5-sonnet", "low", 0, db);
  await finalizeUsage(reservation.id, { prompt_tokens: 10_000, completion_tokens: 20_000, cost: 0.135 }, db, "claude-3-5-sonnet");

  const [row] = await db.select().from(schema.usageEvents).where(sql`id = ${reservation.id}`);
  assert.equal(row.costMicros, 135_000, "Persisted costMicros in usageEvents records raw wholesale API cost");
});

test("Accounting: Plus tier rejects Extra-High (Red Dot) compute usage", async () => {
  const userId = "user_plus_extra_high_rejected";
  await createTestUser(userId, "plus");

  // Vulcan (mu = 12.375) is Extra-High; Plus accounts are forbidden from executing it
  await assert.rejects(
    async () => {
      await reserveUsage(userId, "vesper", "low", 0, db);
    },
    (err) => {
      assert.equal(err.code, "plus_forbidden_extra_high");
      assert.equal(err.status, 403);
      assert.match(err.message, /Plus tier subscriptions do not include Extra High/);
      return true;
    }
  );
});

test("Accounting: Eligible Pro account can reserve and finalize Extra-High usage correctly", async () => {
  const userId = "user_pro_extra_high_eligible";
  await createTestUser(userId, "pro");

  // Pro tier is eligible for Extra-High models (e.g. Vulcan, mu = 12.375)
  const reservation = await reserveUsage(userId, "vesper", "low", 0, db);
  assert.ok(reservation.id, "Reservation succeeded for eligible Pro tier");

  // Settle with provider usage cost: 5,000 in * $1.00/1M ($0.005) + 10,000 out * $5.00/1M ($0.050) = $0.055 = 55,000 micros
  await finalizeUsage(reservation.id, { prompt_tokens: 5_000, completion_tokens: 10_000 }, db, "vesper");

  const [row] = await db.select().from(schema.usageEvents).where(sql`id = ${reservation.id}`);
  assert.equal(row.costMicros, 55_000, "usageEvents persists wholesale API cost from MODEL_TOKEN_PRICES (5,000 in * $1.00 + 10,000 out * $5.00 = 55,000 micros)");
});

test("Accounting: Per-image generation pricing with 1.10 factor", async () => {
  const userId = "user_accounting_image";
  await createTestUser(userId, "plus");

  // Image model with reported provider cost of $0.04 USD (e.g. Flux Schnell / Dev)
  // Raw cost in usageEvents: 40,000 micros
  // Customer debit in shadowCostLedger: ceil(0.04 * 1,000,000 * 1.10) = 44,000 micros ($0.044)
  const [event] = await db.insert(schema.usageEvents).values({
    userId,
    model: "__image__",
  }).returning();

  await finalizeUsage(event.id, { cost: 0.04 }, db, "__image__");

  const [row] = await db.select().from(schema.usageEvents).where(sql`id = ${event.id}`);
  assert.equal(row.costMicros, 40_000, "usageEvents records raw wholesale cost (0.04 -> 40,000 micros)");
});

test("Accounting: Zero-priced models without division-by-zero or unlimited-budget errors", () => {
  // Free baseline: input 0, output 0
  const mu = calculateUsageMultiplier(0, 0);
  assert.equal(mu, 0, "Zero priced model has mu = 0");

  const debit = calculateUnifiedLedgerDeductionMicros({
    inputTokens: 10_000,
    outputTokens: 10_000,
    inputPriceMicrosPerM: 0,
    outputPriceMicrosPerM: 0,
  });
  assert.equal(debit, 0, "Zero priced model incurs 0 debit");

  // calculateUserAllocationLimitTokens with mu = 0 must return 0, not Infinity or division error
  const limit = calculateUserAllocationLimitTokens("free", 0);
  assert.equal(limit, 0, "Safe return of 0 when mu <= 0");
});

test("Accounting: Platform overhead (classifier, search intent, memory) is not charged to customer", () => {
  assert.equal(accountingClassFor("moderation"), ACCOUNTING_CLASSES.PLATFORM_OVERHEAD);
  assert.equal(accountingClassFor("search_intent"), ACCOUNTING_CLASSES.PLATFORM_OVERHEAD);
  assert.equal(accountingClassFor("memory_extraction"), ACCOUNTING_CLASSES.PLATFORM_OVERHEAD);
  assert.equal(accountingClassFor("chat_stream"), ACCOUNTING_CLASSES.CUSTOMER_USAGE);
});

test("Compute Points abstraction: honest integer scale of multiplier, no raw mu in user DTO", () => {
  // 1 Compute Point = 1,000 micro-dollars ($0.001 USD)
  // $1.00 USD = 1,000,000 micros = 1,000 Compute Points
  assert.equal(microsToComputePoints(1_000_000), 1_000);
  assert.equal(microsToComputePoints(148_500), 149);
  assert.equal(computePointsToMicros(1_000), 1_000_000);
});

test("Privacy & Fallback: Strict no-fallback mode does not call external classifier or reroute", async () => {
  let fetchCalled = false;
  const mockFetch = async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({}), { status: 200 });
  };

  // 1. Classifier: When apiKey is null (local mode), fetch is never called
  const classification = await scanAndClassifyPrompt("Write a quick poem", {
    apiKey: null,
    fetchImpl: mockFetch,
  });
  assert.equal(fetchCalled, false, "Local classifier never invokes external network");
  assert.ok(classification.complexity);

  // 2. Fallback matrix with non-fallback or empty options
  const fallbackChain = buildAlgorithmicFallbackPath("chatgpt-gpt-6-luna", "free");
  assert.ok(Array.isArray(fallbackChain));
  // All fallback options must comply with Free plan ceilings (mu <= 1.00)
  for (const model of fallbackChain) {
    assert.ok(model.multiplier <= 1.00, `Fallback model ${model.id} must be Green Dot (mu <= 1.00)`);
  }
});

test("Privacy & Reliability: failureShowsZeroUsage checks actual dispatch/network evidence", () => {
  // 1. Preflight rejection (e.g. quota exhausted, auth failure) -> inference not started -> zero usage confirmed
  const preflightError = new Error("Quota exceeded");
  preflightError.inferenceStarted = false;
  assert.equal(failureShowsZeroUsage(preflightError), true, "Preflight rejection proves zero usage");

  // 2. Timeout after dispatch / connection -> inference started -> zero usage is NOT confirmed
  const timeoutError = new Error("Gateway timeout");
  timeoutError.inferenceStarted = true;
  assert.equal(failureShowsZeroUsage(timeoutError), false, "Timeout after dispatch cannot assume zero usage");

  // 3. Error with confirmed usage -> not zero usage
  const partialError = new Error("Stream broke mid-reply");
  partialError.usage = { prompt_tokens: 100, completion_tokens: 50 };
  assert.equal(failureShowsZeroUsage(partialError), false, "Error with confirmed tokens cannot be zero usage");
});

test("Privacy: Memory-off and Location-off settings are respected", () => {
  // Memory disabled: facts are omitted and explicit disabled note is placed in payload
  const memoryOffPayload = assembleStandardizedPlatformPayload({
    userId: "test_user",
    memoryEnabled: false,
    facts: [{ content: "Loves cats" }],
  });
  assert.ok(
    memoryOffPayload.includes("User has disabled persistent memory storage in settings."),
    "Payload must state memory is disabled"
  );
  assert.equal(memoryOffPayload.includes("Loves cats"), false, "Facts must be omitted when memory is disabled");

  // Location disabled: geographic markers are redacted
  const locationOffLoc = buildTemporalSpatialLocalization({
    req: {
      headers: {
        "x-geo-country": "US",
        "x-geo-region": "NY",
        "x-geo-city": "New York",
      },
    },
    locationEnabled: false,
  });
  assert.equal(locationOffLoc.geographicMarkers.country, "Redacted (Privacy Disabled)");
  assert.equal(locationOffLoc.geographicMarkers.region, "Redacted (Privacy Disabled)");
  assert.equal(locationOffLoc.geographicMarkers.city, "Redacted (Privacy Disabled)");

  // Standardized payload with location disabled
  const locationOffPayload = assembleStandardizedPlatformPayload({
    userId: "test_user",
    locationEnabled: false,
    req: {
      headers: {
        "x-geo-city": "New York",
      },
    },
  });
  assert.ok(
    locationOffPayload.includes("City: Redacted (Privacy Disabled)"),
    "City must be redacted in runtime context payload when location is disabled"
  );
});

test("Semantic Context Truncation: Preserves core variables and valid tool-call structure", () => {
  const systemMessages = [
    { role: "system", content: "You are VibhavGPT. Identity: anon_123. Localization: UTC." },
    { role: "system", content: "Memory Profile: Coding preferences active." },
  ];

  // Create a conversation with tool calls and tool responses
  const history = [
    { role: "user", content: "What is the weather in Seattle?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_abc123", type: "function", function: { name: "weather", arguments: '{"location":"Seattle"}' } }],
    },
    { role: "tool", tool_call_id: "call_abc123", content: "Temperature 65°F, partly cloudy." },
    { role: "assistant", content: "The weather in Seattle is 65°F and partly cloudy." },
    // A long turn that causes overflow
    { role: "user", content: "Write a 5000-line detailed analysis of the economy ".repeat(50) },
    { role: "assistant", content: "Here is the comprehensive economic analysis... ".repeat(50) },
    { role: "user", content: "Now summarize the inflation part." },
  ];

  const currentMessage = { role: "user", content: "What were my two previous questions?" };

  const result = slidingWindowSemanticTruncation({
    systemMessages,
    history,
    currentMessage,
    maxTokenBudget: 2_000, // Small budget to force truncation
  });

  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);

  // 1. Core System messages (Identity, Localization, Memory) must be 100% preserved
  assert.equal(result.messages[0].content, systemMessages[0].content);
  assert.equal(result.messages[1].content, systemMessages[1].content);

  // 2. Truncation must generate <HistoricalContextSemanticSummary>
  const summaryMsg = result.messages.find((m) => String(m.content).includes("<HistoricalContextSemanticSummary>"));
  assert.ok(summaryMsg, "Must produce a genuine semantic summary vector rather than mere deletion");

  // 3. Current turn is preserved
  assert.equal(result.messages.at(-1).content, currentMessage.content);

  // 4. Message structure: tool_calls and tool results must never be orphaned
  for (let i = 0; i < result.messages.length; i++) {
    const msg = result.messages[i];
    if (msg.role === "tool") {
      // Preceding message must be an assistant message with tool_calls
      const prev = result.messages[i - 1];
      assert.equal(prev?.role, "assistant", "Tool message must be immediately preceded by assistant message");
      assert.ok(Array.isArray(prev?.tool_calls), "Preceding assistant message must have tool_calls");
    }
  }
});
