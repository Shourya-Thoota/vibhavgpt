import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";

const {
  modelFamilies,
  modelVersions,
  modelEndpoints,
  modelPricingSnapshots,
  shadowCostLedger,
  subscriptions,
} = await import("../src/db/schema.js");

const {
  executeWithCoordinator,
  checkActivationReadiness,
  assertActivationReadiness,
  ACTIVATION_BLOCKER_CODES,
  recordEndpointOverrun,
  checkEndpointOverrunStatus,
  resetEndpointOverrunTracker,
  clearAllHeartbeatTimers,
  CoordinatorOverrunCircuitError,
  ActivationBlockedError,
  CoordinatorPolicyBlockedError,
  COORDINATOR_ERROR_CODES,
} = await import("../src/models/execution-coordinator.js");

const {
  ALLOWANCE_LIFECYCLE_STATES,
  settleAllowance,
  getAvailableAllowance,
  reserveAllowance,
} = await import("../src/usage/allowance-service.js");

async function createDatabase(t) {
  const client = new PGlite();
  t.after(async () => {
    clearAllHeartbeatTimers();
    resetEndpointOverrunTracker();
    await client.close();
  });

  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) {
    const migrationSql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
    await client.exec(migrationSql);
  }
  return { client, db: drizzle(client) };
}

async function seedTestCatalog(db) {
  const [fam] = await db.insert(modelFamilies).values({
    slug: "openai/gpt-6.1-terra",
    displayName: "GPT-6.1 Terra",
    familyGroup: "OpenAI",
    sortOrder: 1,
  }).returning();

  const [ver] = await db.insert(modelVersions).values({
    familyId: fam.id,
    versionTag: "gpt-6.1-terra",
    aliases: ["terra"],
    capabilitiesDocumented: { vision: true, tools: true, streaming: true },
    planEligibility: "paid",
    lifecycleState: "active",
    isDefaultInFamily: true,
  }).returning();

  const [ep] = await db.insert(modelEndpoints).values({
    versionId: ver.id,
    providerName: "openrouter",
    transportType: "router",
    adapterType: "chat_completions",
    endpointUrl: "https://openrouter.ai/api/v1/chat/completions",
    capabilitiesVerified: { vision: true, tools: true, streaming: true },
    privacyReview: {
      privacyApproved: true,
      scope: "default",
      zeroDataRetention: true,
      trainingPolicy: "denied",
    },
    endpointState: "active",
    sortPriority: 10,
  }).returning();

  await db.insert(modelPricingSnapshots).values({
    endpointId: ep.id,
    pricingVersionId: "pv_terra_v1",
    effectiveFrom: new Date("2026-01-01"),
    currency: "USD",
    billingUnit: "usd_per_1m_tokens",
    inputPriceMicrosPerM: 1_000_000, // $1.00 / 1M
    outputPriceMicrosPerM: 4_000_000, // $4.00 / 1M
    cachedReadPriceMicrosPerM: 500_000,
    calculatedMu: 2.5,
    consumptionCategory: "high",
    pricingConfidence: "verified",
    provenance: "provider_pricing_sheet_2026",
  });

  return { family: fam, version: ver, endpoint: ep };
}

async function setupUser(db, userId, plan = "pro") {
  await db.execute(sql`INSERT INTO "user" (id, email) VALUES (${userId}, ${userId + "@example.com"}) ON CONFLICT (id) DO NOTHING;`);
  if (plan !== "free") {
    await db.insert(subscriptions).values({
      userId,
      tier: plan,
      status: "active",
      currentPeriodStartedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      currentPeriodEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
  }
}

test("profit-protection 1: Reservation and output-limit consistency bounds transport execution", async (t) => {
  const { db } = await createDatabase(t);
  await seedTestCatalog(db);
  const userId = "u_output_limit_1";
  await setupUser(db, userId, "plus");

  let receivedMaxTokens = null;
  let receivedAuthorizedTokens = null;

  const fakeTransport = async ({ maxOutputTokens, authorizedMaxOutputTokens }) => {
    receivedMaxTokens = maxOutputTokens;
    receivedAuthorizedTokens = authorizedMaxOutputTokens;
    return {
      text: "Bounded output",
      usage: { prompt_tokens: 100, completion_tokens: 200 },
    };
  };

  await executeWithCoordinator({
    userId,
    logicalRequestId: "req_bound_test",
    modelKey: "gpt-6.1-terra",
    prompt: "Short prompt",
    context: { maxOutputTokens: 2048 },
    transport: fakeTransport,
    db,
  });

  assert.ok(receivedMaxTokens != null);
  assert.equal(receivedMaxTokens, receivedAuthorizedTokens);
  assert.ok(receivedMaxTokens <= 2048);

  const [row] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, "req_bound_test"));
  assert.equal(row.metadata.authorizedMaxOutputTokens, receivedAuthorizedTokens);
});

test("profit-protection 2: Full internal vendor expense is captured while customer deduction is capped at authorized hold", async (t) => {
  const { db } = await createDatabase(t);
  await seedTestCatalog(db);
  const userId = "u_overrun_cap_1";
  await setupUser(db, userId, "pro");

  // Initial reservation with modest authorized max output tokens (e.g. 500 tokens)
  // Input: 100 tokens, Output: 500 tokens.
  // Pinned rates: $1.00 in, $4.00 out.
  // Pre-dispatch hold: ceil(1.10 * (100 * 1 + 500 * 4)) / 1M = ceil(1.10 * (100 + 2000)) = ceil(2310) = 2310 micro-dollars.
  let transportRun = false;
  const overrunTransport = async () => {
    transportRun = true;
    // Upstream overruns significantly: returns 2,500 completion tokens!
    return {
      text: "Very long unexpected response that exceeds authorized bounds",
      usage: { prompt_tokens: 100, completion_tokens: 2500 },
    };
  };

  const result = await executeWithCoordinator({
    userId,
    logicalRequestId: "req_overrun_test",
    modelKey: "gpt-6.1-terra",
    prompt: "Prompt",
    context: { estimatedInputTokens: 100, maxOutputTokens: 500 },
    transport: overrunTransport,
    db,
  });

  assert.equal(transportRun, true);
  assert.equal(result.success, true);

  const [row] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, "req_overrun_test"));
  assert.equal(row.status, ALLOWANCE_LIFECYCLE_STATES.SETTLED);

  // 1. Customer deduction is capped at authorized hold (cannot exceed pre-flight hold)
  assert.ok(row.metadata.authorizedReservedCostMicros > 0);
  assert.equal(row.settledCostMicros, row.metadata.authorizedReservedCostMicros);
  assert.equal(result.settlement.settledCostMicros, row.metadata.authorizedReservedCostMicros);

  // 2. Full internal vendor cost is recorded without truncation in rawCostMicros
  // Raw cost for 100 in ($1/1M) + 2500 out ($4/1M) = $0.000100 + $0.010000 = $0.010100 = 10,100 micro-dollars.
  assert.ok(row.rawCostMicros >= 10_000);
  assert.ok(row.rawCostMicros > row.settledCostMicros);

  // 3. Excess overrun is captured as platform-absorbed
  assert.ok(row.metadata.overrunMicros > 0);
  assert.equal(row.metadata.platformAbsorbedOverrun, true);
  assert.equal(row.metadata.uncappedSettledCostMicros, row.settledCostMicros + row.metadata.overrunMicros);

  // 4. Customer balance check: user balance was deducted only by the capped hold, never negative
  const balance = await getAvailableAllowance(userId, {}, db);
  assert.ok(balance.availableMicros >= 0);
});

test("profit-protection 3: Repeated endpoint-overrun detection trips circuit breaker after threshold", async (t) => {
  const { db } = await createDatabase(t);
  const catalog = await seedTestCatalog(db);
  const userId = "u_endpoint_overrun_user";
  await setupUser(db, userId, "pro");

  resetEndpointOverrunTracker();

  // Simulate 3 consecutive overrun executions on this endpoint
  const epId = catalog.endpoint.id;
  for (let i = 1; i <= 3; i++) {
    recordEndpointOverrun({
      endpointId: epId,
      modelKey: "gpt-6.1-terra",
      overrunMicros: 5000,
      outputTokens: 2500,
      authorizedMaxTokens: 500,
    });
  }

  // Verify overrun circuit is tripped
  const status = checkEndpointOverrunStatus(epId);
  assert.equal(status.tripped, true);
  assert.equal(status.consecutiveOverruns, 3);
  assert.equal(status.cumulativeOverrunMicros, 15000);

  // Next dispatch attempt must be blocked by the circuit breaker before transport execution
  let transportCalled = false;
  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_circuit_tripped",
      modelKey: "gpt-6.1-terra",
      prompt: "Query",
      transport: async () => { transportCalled = true; },
      db,
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorOverrunCircuitError);
      assert.equal(err.code, COORDINATOR_ERROR_CODES.ENDPOINT_OVERRUN_CIRCUIT_TRIPPED);
      assert.equal(err.canRetry, false);
      return true;
    }
  );

  assert.equal(transportCalled, false);

  // Ensure undispatched reservation was safely released
  const [row] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, "req_circuit_tripped"));
  assert.equal(row.status, ALLOWANCE_LIFECYCLE_STATES.RELEASED);
  assert.equal(row.dispatchedAt, null);
  assert.equal(row.reservedCostMicros, 0);
});

test("profit-protection 4: Owner approval and live gating prerequisites control activation readiness", () => {
  // 1. Missing owner approval and live execution disconnected blocks activation
  const check1 = checkActivationReadiness({ config: {} });
  assert.equal(check1.ready, false);
  assert.ok(check1.blockers.includes(ACTIVATION_BLOCKER_CODES.OWNER_APPROVAL_MISSING));
  assert.ok(check1.blockers.includes(ACTIVATION_BLOCKER_CODES.LIVE_EXECUTION_DISCONNECTED));

  // 2. Owner approval present but live execution disconnected
  const check2 = checkActivationReadiness({ config: { ownerActivationApproved: true } });
  assert.equal(check2.ready, false);
  assert.ok(check2.blockers.includes(ACTIVATION_BLOCKER_CODES.LIVE_EXECUTION_DISCONNECTED));

  // 3. Assert throws ActivationBlockedError
  assert.throws(
    () => assertActivationReadiness({ config: {} }),
    (err) => {
      assert.ok(err instanceof ActivationBlockedError);
      assert.ok(err.blockers.includes(ACTIVATION_BLOCKER_CODES.OWNER_APPROVAL_MISSING));
      return true;
    }
  );

  // 4. Fully configured activation prerequisites pass
  const validCheck = checkActivationReadiness({
    config: {
      ownerActivationApproved: true,
      liveExecutionEnabled: true,
    },
  });
  assert.equal(validCheck.ready, true);
  assert.equal(validCheck.blockers.length, 0);
});

test("profit-protection 5: No automatic paid redispatch for uncertain execution", async (t) => {
  const { db } = await createDatabase(t);
  await seedTestCatalog(db);
  const userId = "u_no_redispatch_user";
  await setupUser(db, userId, "pro");

  // Step 1: Create an uncertain reservation
  await db.insert(shadowCostLedger).values({
    userId,
    requestId: "req_uncertain_lead",
    attemptNumber: 1,
    operation: "inference",
    modality: "text",
    modelKey: "openai/gpt-6.1-terra",
    pricingVersionId: "pv_terra_v1",
    pricingSource: "static_catalog",
    reservedCostMicros: 5000,
    settledCostMicros: null,
    status: ALLOWANCE_LIFECYCLE_STATES.UNCERTAIN,
    idempotencyKey: "req_req_uncertain_lead",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Step 2: Attempting to call coordinator on that uncertain logical request is blocked from redispatching
  let transportCalled = false;
  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_uncertain_lead",
      modelKey: "gpt-6.1-terra",
      prompt: "Redispatch attempt",
      transport: async () => { transportCalled = true; },
      db,
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorPolicyBlockedError);
      assert.equal(err.code, COORDINATOR_ERROR_CODES.REDISPATCH_UNCERTAIN_PROHIBITED);
      assert.equal(err.canRetry, false);
      return true;
    }
  );

  assert.equal(transportCalled, false);

  // Step 3: Explicit options.allowPaidRedispatch is blocked by policy
  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_redispatch_opt",
      modelKey: "gpt-6.1-terra",
      prompt: "Policy blocked",
      transport: async () => { transportCalled = true; },
      options: { allowPaidRedispatch: true },
      db,
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorPolicyBlockedError);
      assert.equal(err.code, COORDINATOR_ERROR_CODES.REDISPATCH_UNCERTAIN_PROHIBITED);
      return true;
    }
  );
  assert.equal(transportCalled, false);
});

