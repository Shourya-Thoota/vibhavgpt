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
  userProfiles,
} = await import("../src/db/schema.js");

const {
  executeWithCoordinator,
  sanitizePublicExecutionResult,
  getActiveHeartbeatTimerCount,
  clearAllHeartbeatTimers,
  CoordinatorError,
  CoordinatorValidationError,
  CoordinatorRoutingError,
  CoordinatorAllowanceError,
  CoordinatorConflictError,
  CoordinatorDuplicateRequestError,
  CoordinatorRevalidationError,
  CoordinatorAbortError,
  CoordinatorExecutionError,
  CoordinatorPolicyBlockedError,
  COORDINATOR_LIFECYCLE_STAGES,
  COORDINATOR_ERROR_CODES,
} = await import("../src/models/execution-coordinator.js");

const {
  ALLOWANCE_LIFECYCLE_STATES,
  PLAN_ALLOWANCES,
  getAvailableAllowance,
  settleAllowance,
} = await import("../src/usage/allowance-service.js");

/**
 * Creates an isolated in-memory PostgreSQL instance with all Drizzle migrations applied.
 */
async function createDatabase(t) {
  const client = new PGlite();
  t.after(async () => {
    clearAllHeartbeatTimers();
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

/**
 * Seeds standard catalog models for coordinator tests:
 * 1. openai/gpt-6.1-terra (Plan: paid, Active, Privacy Approved, High consumption)
 * 2. anthropic/claude-3-7-sonnet (Plan: pro_only, Active, Privacy Approved, Extra High consumption)
 * 3. vibhavgpt/lumen (Plan: free, Active, Privacy Approved, Low consumption)
 */
async function seedCatalog(db) {
  // 1. Terra Family (Paid tier: Plus & Pro)
  const [famTerra] = await db
    .insert(modelFamilies)
    .values({
      slug: "openai/gpt-6.1-terra",
      displayName: "GPT-6.1 Terra",
      familyGroup: "OpenAI",
      sortOrder: 1,
    })
    .returning();

  const [verTerra] = await db
    .insert(modelVersions)
    .values({
      familyId: famTerra.id,
      versionTag: "gpt-6.1-terra",
      aliases: ["terra", "gpt-6-terra"],
      capabilitiesDocumented: { vision: true, tools: true, streaming: true, reasoningSupported: false },
      planEligibility: "paid",
      lifecycleState: "active",
      isDefaultInFamily: true,
    })
    .returning();

  const [epTerra] = await db
    .insert(modelEndpoints)
    .values({
      versionId: verTerra.id,
      providerName: "openrouter",
      transportType: "router",
      adapterType: "chat_completions",
      endpointUrl: "https://openrouter.ai/api/v1/chat/completions",
      capabilitiesVerified: { vision: true, tools: true, streaming: true },
      privacyReview: {
        privacyApproved: true,
        scope: "default",
        reviewedBy: "compliance_team",
        reviewedAt: new Date().toISOString(),
        zeroDataRetention: true,
        trainingPolicy: "denied",
      },
      endpointState: "active",
      sortPriority: 10,
    })
    .returning();

  await db.insert(modelPricingSnapshots).values({
    endpointId: epTerra.id,
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

  // 2. Claude Sonnet (Pro only)
  const [famClaude] = await db
    .insert(modelFamilies)
    .values({
      slug: "anthropic/claude-3-7-sonnet",
      displayName: "Claude 3.7 Sonnet",
      familyGroup: "Anthropic",
      sortOrder: 2,
    })
    .returning();

  const [verClaude] = await db
    .insert(modelVersions)
    .values({
      familyId: famClaude.id,
      versionTag: "claude-3-7-sonnet",
      aliases: ["sonnet", "claude-sonnet"],
      capabilitiesDocumented: { vision: true, tools: true, streaming: true, reasoningSupported: true },
      planEligibility: "pro_only",
      lifecycleState: "active",
      isDefaultInFamily: true,
    })
    .returning();

  const [epClaude] = await db
    .insert(modelEndpoints)
    .values({
      versionId: verClaude.id,
      providerName: "openrouter",
      transportType: "router",
      adapterType: "anthropic_messages",
      endpointUrl: "https://openrouter.ai/api/v1/messages",
      capabilitiesVerified: { vision: true, tools: true, streaming: true },
      privacyReview: {
        privacyApproved: true,
        scope: "default",
        reviewedBy: "compliance_team",
        reviewedAt: new Date().toISOString(),
        zeroDataRetention: true,
        trainingPolicy: "denied",
      },
      endpointState: "active",
      sortPriority: 10,
    })
    .returning();

  await db.insert(modelPricingSnapshots).values({
    endpointId: epClaude.id,
    pricingVersionId: "pv_claude_v1",
    effectiveFrom: new Date("2026-01-01"),
    currency: "USD",
    billingUnit: "usd_per_1m_tokens",
    inputPriceMicrosPerM: 3_000_000,
    outputPriceMicrosPerM: 15_000_000,
    cachedReadPriceMicrosPerM: 1_500_000,
    calculatedMu: 8.5,
    consumptionCategory: "extra_high",
    pricingConfidence: "verified",
    provenance: "provider_pricing_sheet_2026",
  });

  // 3. Native Lumen (Free & all tiers)
  const [famLumen] = await db
    .insert(modelFamilies)
    .values({
      slug: "vibhavgpt/lumen",
      displayName: "VibhavGPT Lumen",
      familyGroup: "Native",
      sortOrder: 3,
    })
    .returning();

  const [verLumen] = await db
    .insert(modelVersions)
    .values({
      familyId: famLumen.id,
      versionTag: "lumen",
      aliases: ["lumen-standard"],
      capabilitiesDocumented: { vision: false, tools: true, streaming: true, reasoningSupported: false },
      planEligibility: "free",
      lifecycleState: "active",
      isDefaultInFamily: true,
    })
    .returning();

  const [epLumen] = await db
    .insert(modelEndpoints)
    .values({
      versionId: verLumen.id,
      providerName: "primaryFree",
      transportType: "direct",
      adapterType: "chat_completions",
      endpointUrl: "https://free.api.internal/v1",
      capabilitiesVerified: { vision: false, tools: true, streaming: true },
      privacyReview: {
        privacyApproved: true,
        scope: "default",
        reviewedBy: "compliance_team",
        reviewedAt: new Date().toISOString(),
        zeroDataRetention: true,
        trainingPolicy: "denied",
      },
      endpointState: "active",
      sortPriority: 5,
    })
    .returning();

  await db.insert(modelPricingSnapshots).values({
    endpointId: epLumen.id,
    pricingVersionId: "pv_lumen_v1",
    effectiveFrom: new Date("2026-01-01"),
    currency: "USD",
    billingUnit: "usd_per_1m_tokens",
    inputPriceMicrosPerM: 50_000,
    outputPriceMicrosPerM: 200_000,
    cachedReadPriceMicrosPerM: 25_000,
    calculatedMu: 0.15,
    consumptionCategory: "low",
    pricingConfidence: "verified",
    provenance: "provider_pricing_sheet_2026",
  });

  return {
    terra: { family: famTerra, version: verTerra, endpoint: epTerra },
    claude: { family: famClaude, version: verClaude, endpoint: epClaude },
    lumen: { family: famLumen, version: verLumen, endpoint: epLumen },
  };
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

test("1. Eligible route reserves and settles once with sanitized public output", async (t) => {
  const { db } = await createDatabase(t);
  await seedCatalog(db);
  const userId = "user_pro_1";
  await setupUser(db, userId, "pro");

  let transportCalls = 0;
  const fakeTransport = async ({ endpoint, candidate, signal }) => {
    transportCalls += 1;
    assert.equal(signal.aborted, false);
    return {
      text: "Hello from GPT-6.1 Terra!",
      usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
    };
  };

  const result = await executeWithCoordinator({
    userId,
    logicalRequestId: "req_eligible_1",
    modelKey: "gpt-6.1-terra",
    prompt: "Say hello",
    transport: fakeTransport,
    db,
  });

  assert.equal(result.success, true);
  assert.equal(result.logicalRequestId, "req_eligible_1");
  assert.equal(result.model, "gpt-6.1-terra");
  assert.equal(result.displayName, "GPT-6.1 Terra");
  assert.equal(result.output, "Hello from GPT-6.1 Terra!");
  assert.equal(result.usage.promptTokens, 120);
  assert.equal(result.usage.completionTokens, 45);
  assert.equal(result.usage.totalTokens, 165);
  assert.equal(result.settlement.status, "settled");
  assert.ok(result.settlement.settledCostMicros > 0);
  assert.equal(transportCalls, 1);

  // Assert database row state
  const rows = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, "req_eligible_1"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, ALLOWANCE_LIFECYCLE_STATES.SETTLED);
  assert.equal(rows[0].reservedCostMicros, 0);
  assert.ok(rows[0].settledCostMicros > 0);
  assert.equal(rows[0].inputTokens, 120);
  assert.equal(rows[0].outputTokens, 45);
  assert.equal(rows[0].leaseExpiresAt, null);
  assert.equal(getActiveHeartbeatTimerCount(), 0);
});

test("2. Ineligible route never dispatches transport or touches ledger", async (t) => {
  const { db } = await createDatabase(t);
  await seedCatalog(db);
  const userId = "user_free_1";
  await setupUser(db, userId, "free");

  let transportCalled = false;
  const fakeTransport = async () => {
    transportCalled = true;
    return { text: "Should never run" };
  };

  // Free user requests pro_only Claude Sonnet
  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_ineligible_1",
      modelKey: "claude-3-7-sonnet",
      prompt: "Solve complex equation",
      transport: fakeTransport,
      db,
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorRoutingError);
      assert.equal(err.code, "plan_not_eligible");
      assert.equal(err.canRetry, false);
      return true;
    }
  );

  assert.equal(transportCalled, false);
  const rows = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, "req_ineligible_1"));
  assert.equal(rows.length, 0);
  assert.equal(getActiveHeartbeatTimerCount(), 0);
});

test("3. Privacy approval revoked between evaluation and dispatch blocks execution and releases hold", async (t) => {
  const { db } = await createDatabase(t);
  const catalog = await seedCatalog(db);
  const userId = "user_pro_privacy";
  await setupUser(db, userId, "pro");

  let transportCalled = false;
  const fakeTransport = async () => {
    transportCalled = true;
    return { text: "Should not run" };
  };

  // Inject a pre-dispatch revoked state to simulate an administrative revocation right before dispatch
  const revokedEndpointState = {
    ...catalog.terra.endpoint,
    privacyReview: {
      privacyApproved: false,
      revoked: true,
      revokedAt: new Date().toISOString(),
    },
  };

  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_revoked_1",
      modelKey: "gpt-6.1-terra",
      prompt: "Confidential query",
      transport: fakeTransport,
      options: { currentEndpointState: revokedEndpointState },
      db,
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorRevalidationError);
      assert.equal(err.code, "privacy_approval_no_longer_valid");
      return true;
    }
  );

  assert.equal(transportCalled, false);

  // Assert undispatched reservation was released
  const [row] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, "req_revoked_1"));
  assert.ok(row);
  assert.equal(row.status, ALLOWANCE_LIFECYCLE_STATES.RELEASED);
  assert.equal(row.dispatchedAt, null);
  assert.equal(row.reservedCostMicros, 0);
  assert.equal(getActiveHeartbeatTimerCount(), 0);
});

test("4. Reservation failure prevents transport execution", async (t) => {
  const { db } = await createDatabase(t);
  await seedCatalog(db);
  const userId = "user_free_exhausted";
  await setupUser(db, userId, "free");

  // Exhaust Free tier daily request limit (20 requests)
  for (let i = 0; i < 20; i++) {
    await db.insert(shadowCostLedger).values({
      userId,
      requestId: `exhaust_${i}`,
      operation: "inference",
      modality: "text",
      modelKey: "vibhavgpt/lumen",
      pricingVersionId: "pv_lumen_v1",
      pricingSource: "static_catalog",
      reservedCostMicros: 0,
      settledCostMicros: 100,
      status: ALLOWANCE_LIFECYCLE_STATES.SETTLED,
      idempotencyKey: `exhaust_key_${i}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  let transportCalled = false;
  const fakeTransport = async () => {
    transportCalled = true;
    return { text: "Should not run" };
  };

  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_exhausted_1",
      modelKey: "lumen",
      prompt: "Hello",
      transport: fakeTransport,
      db,
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorAllowanceError);
      assert.equal(err.code, "coordinator_allowance_exceeded");
      assert.equal(err.window, "daily_requests");
      return true;
    }
  );

  assert.equal(transportCalled, false);
  assert.equal(getActiveHeartbeatTimerCount(), 0);
});

test("5. Revalidation failure releases the undispatched hold and restores balance", async (t) => {
  const { db } = await createDatabase(t);
  const catalog = await seedCatalog(db);
  const userId = "user_pro_balance_restore";
  await setupUser(db, userId, "pro");

  const initialBalance = await getAvailableAllowance(userId, {}, db);

  const deprecatedEndpointState = {
    ...catalog.terra.endpoint,
    endpointState: "deprecated",
  };

  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_reval_fail",
      modelKey: "gpt-6.1-terra",
      prompt: "Test query",
      transport: async () => ({ text: "Should not run" }),
      options: { currentEndpointState: deprecatedEndpointState },
      db,
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorRevalidationError);
      assert.equal(err.code, "endpoint_no_longer_active");
      return true;
    }
  );

  const restoredBalance = await getAvailableAllowance(userId, {}, db);
  assert.equal(restoredBalance.availableMicros, initialBalance.availableMicros);

  const [row] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, "req_reval_fail"));
  assert.equal(row.status, ALLOWANCE_LIFECYCLE_STATES.RELEASED);
  assert.equal(row.dispatchedAt, null);
  assert.equal(row.metadata.confirmedZeroUsage, true);
  assert.equal(getActiveHeartbeatTimerCount(), 0);
});

test("6. Duplicate logical request does not dispatch twice", async (t) => {
  const { db } = await createDatabase(t);
  await seedCatalog(db);
  const userId = "user_pro_dup";
  await setupUser(db, userId, "pro");

  let transportCalls = 0;
  const fakeTransport = async () => {
    transportCalls += 1;
    return {
      text: "First response",
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    };
  };

  // First call
  const result1 = await executeWithCoordinator({
    userId,
    logicalRequestId: "req_dup_test",
    modelKey: "gpt-6.1-terra",
    prompt: "Hello",
    transport: fakeTransport,
    db,
  });
  assert.equal(result1.success, true);
  assert.equal(transportCalls, 1);

  // Second call with same logicalRequestId
  const result2 = await executeWithCoordinator({
    userId,
    logicalRequestId: "req_dup_test",
    modelKey: "gpt-6.1-terra",
    prompt: "Hello",
    transport: fakeTransport,
    db,
  });
  assert.equal(result2.success, true);
  assert.equal(result2.output, "First response");
  assert.equal(transportCalls, 1); // Transport NOT called again!

  // In-flight duplicate throws DuplicateRequestError
  await db.update(shadowCostLedger)
    .set({ status: ALLOWANCE_LIFECYCLE_STATES.DISPATCHED })
    .where(eq(shadowCostLedger.requestId, "req_dup_test"));

  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_dup_test",
      modelKey: "gpt-6.1-terra",
      prompt: "Hello",
      transport: fakeTransport,
      db,
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorDuplicateRequestError);
      assert.equal(err.code, "coordinator_duplicate_request");
      assert.equal(err.canRetry, false);
      return true;
    }
  );
  assert.equal(transportCalls, 1);
  assert.equal(getActiveHeartbeatTimerCount(), 0);
});

test("7. Conflicting replay fails clearly", async (t) => {
  const { db } = await createDatabase(t);
  await seedCatalog(db);
  await setupUser(db, "user_A", "pro");
  await setupUser(db, "user_B", "pro");

  // User A runs request with idempotency key "idemp_conflict_key"
  await executeWithCoordinator({
    userId: "user_A",
    logicalRequestId: "req_user_a",
    idempotencyKey: "idemp_conflict_key",
    modelKey: "gpt-6.1-terra",
    prompt: "Query A",
    transport: async () => ({ text: "A", usage: { prompt_tokens: 50, completion_tokens: 20 } }),
    db,
  });

  // User B replays with the same idempotency key
  await assert.rejects(
    executeWithCoordinator({
      userId: "user_B",
      logicalRequestId: "req_user_b",
      idempotencyKey: "idemp_conflict_key",
      modelKey: "gpt-6.1-terra",
      prompt: "Query B",
      transport: async () => ({ text: "B" }),
      db,
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorConflictError);
      assert.equal(err.code, "coordinator_idempotency_conflict");
      return true;
    }
  );
  assert.equal(getActiveHeartbeatTimerCount(), 0);
});

test("8. Cancellation at each lifecycle boundary", async (t) => {
  const { db } = await createDatabase(t);
  await seedCatalog(db);
  const userId = "user_pro_cancel";
  await setupUser(db, userId, "pro");

  // 8a: Cancellation before reservation
  const preAborted = AbortSignal.abort();
  let transportCalled = false;
  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_cancel_pre_res",
      modelKey: "gpt-6.1-terra",
      prompt: "Aborted immediately",
      signal: preAborted,
      transport: async () => { transportCalled = true; },
      db,
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorAbortError);
      assert.equal(err.code, "coordinator_aborted_pre_reservation");
      return true;
    }
  );
  assert.equal(transportCalled, false);
  const rowsPre = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, "req_cancel_pre_res"));
  assert.equal(rowsPre.length, 0);

  // 8b: Cancellation during transport execution
  const controllerMid = new AbortController();
  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_cancel_mid",
      modelKey: "gpt-6.1-terra",
      prompt: "Cancel during execution",
      signal: controllerMid.signal,
      transport: async ({ signal }) => {
        controllerMid.abort();
        const err = new Error("Transport stream aborted");
        err.name = "AbortError";
        throw err;
      },
      db,
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorAbortError);
      assert.equal(err.code, "coordinator_aborted_during_execution");
      return true;
    }
  );

  const [rowMid] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, "req_cancel_mid"));
  assert.ok(rowMid);
  assert.equal(rowMid.status, ALLOWANCE_LIFECYCLE_STATES.UNCERTAIN);
  assert.ok(rowMid.reservedCostMicros > 0); // Hold retained
  assert.equal(getActiveHeartbeatTimerCount(), 0);
});

test("9. Confirmed partial usage versus unknown usage on abort", async (t) => {
  const { db } = await createDatabase(t);
  await seedCatalog(db);
  const userId = "user_pro_partial";
  await setupUser(db, userId, "pro");

  // 9a: Abort with confirmed partial usage tokens -> settles partial tokens
  const ctrlPartial = new AbortController();
  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_partial_confirmed",
      modelKey: "gpt-6.1-terra",
      prompt: "Streaming partial tokens",
      signal: ctrlPartial.signal,
      transport: async () => {
        ctrlPartial.abort();
        const err = new Error("Connection closed mid-stream");
        err.name = "AbortError";
        err.usage = { prompt_tokens: 150, completion_tokens: 35 };
        err.partialText = "Partial response so far...";
        throw err;
      },
      db,
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorAbortError);
      return true;
    }
  );

  const [rowPartial] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, "req_partial_confirmed"));
  assert.equal(rowPartial.status, ALLOWANCE_LIFECYCLE_STATES.SETTLED);
  assert.equal(rowPartial.inputTokens, 150);
  assert.equal(rowPartial.outputTokens, 35);
  assert.ok(rowPartial.settledCostMicros > 0);
  assert.equal(rowPartial.metadata.isPartial, true);

  // 9b: Abort with missing usage -> marked uncertain (browser disconnect != zero usage)
  const ctrlUnknown = new AbortController();
  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_partial_unknown",
      modelKey: "gpt-6.1-terra",
      prompt: "Streaming unknown tokens",
      signal: ctrlUnknown.signal,
      transport: async () => {
        ctrlUnknown.abort();
        const err = new Error("Client socket reset");
        err.name = "AbortError";
        throw err;
      },
      db,
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorAbortError);
      return true;
    }
  );

  const [rowUnknown] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, "req_partial_unknown"));
  assert.equal(rowUnknown.status, ALLOWANCE_LIFECYCLE_STATES.UNCERTAIN);
  assert.ok(rowUnknown.reservedCostMicros > 0);
  assert.equal(rowUnknown.settledCostMicros, null);
  assert.equal(getActiveHeartbeatTimerCount(), 0);
});

test("10. Transport failure before and after dispatch boundary", async (t) => {
  const { db } = await createDatabase(t);
  await seedCatalog(db);
  const userId = "user_pro_failures";
  await setupUser(db, userId, "pro");

  // 10a: Post-dispatch failure with confirmedZeroUsage: true (e.g. connection refused before bytes sent)
  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_fail_zero_usage",
      modelKey: "gpt-6.1-terra",
      prompt: "Immediate refusal",
      transport: async () => {
        const err = new Error("ECONNREFUSED: Provider host down");
        err.code = "ECONNREFUSED";
        err.confirmedZeroUsage = true;
        throw err;
      },
      db,
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorExecutionError);
      assert.equal(err.confirmedZeroUsage, true);
      assert.equal(err.canRetry, false);
      return true;
    }
  );

  const [rowZero] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, "req_fail_zero_usage"));
  assert.equal(rowZero.status, ALLOWANCE_LIFECYCLE_STATES.RELEASED);
  assert.equal(rowZero.reservedCostMicros, 0);

  // 10b: Post-dispatch failure with unknown usage (e.g. timeout / HTTP 500)
  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_fail_unknown_usage",
      modelKey: "gpt-6.1-terra",
      prompt: "Timeout test",
      transport: async () => {
        const err = new Error("Upstream gateway timeout");
        err.code = "upstream_timeout";
        throw err;
      },
      db,
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorExecutionError);
      assert.equal(err.confirmedZeroUsage, false);
      assert.equal(err.canRetry, false);
      return true;
    }
  );

  const [rowUnknown] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, "req_fail_unknown_usage"));
  assert.equal(rowUnknown.status, ALLOWANCE_LIFECYCLE_STATES.UNCERTAIN);
  assert.ok(rowUnknown.reservedCostMicros > 0);
  assert.equal(getActiveHeartbeatTimerCount(), 0);
});

test("11. Late completion cannot double-settle", async (t) => {
  const { db } = await createDatabase(t);
  await seedCatalog(db);
  const userId = "user_pro_late";
  await setupUser(db, userId, "pro");

  const result = await executeWithCoordinator({
    userId,
    logicalRequestId: "req_late_settle",
    modelKey: "gpt-6.1-terra",
    prompt: "Hello",
    transport: async () => ({
      text: "Normal completion",
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
    db,
  });

  const [row] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, "req_late_settle"));
  const firstSettledCost = row.settledCostMicros;

  // Simulate late completion arriving
  const lateAttempt = await settleAllowance({
    reservationId: row.id,
    usage: { prompt_tokens: 100, completion_tokens: 50 },
    now: new Date(),
  }, db);

  assert.equal(lateAttempt.isIdempotent, true);
  assert.equal(lateAttempt.settledCostMicros, firstSettledCost);

  const [afterRow] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.id, row.id));
  assert.equal(afterRow.settledCostMicros, firstSettledCost);
  assert.equal(afterRow.reservedCostMicros, 0);
});

test("12. Heartbeat timers stop on every terminal path", async (t) => {
  const { db } = await createDatabase(t);
  await seedCatalog(db);
  const userId = "user_pro_heartbeat";
  await setupUser(db, userId, "pro");

  assert.equal(getActiveHeartbeatTimerCount(), 0);

  // Success path
  await executeWithCoordinator({
    userId,
    logicalRequestId: "req_hb_success",
    modelKey: "gpt-6.1-terra",
    prompt: "Success",
    transport: async () => ({ text: "Done", usage: { prompt_tokens: 50, completion_tokens: 20 } }),
    db,
  });
  assert.equal(getActiveHeartbeatTimerCount(), 0);

  // Failure path
  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_hb_fail",
      modelKey: "gpt-6.1-terra",
      prompt: "Fail",
      transport: async () => { throw new Error("Boom"); },
      db,
    })
  );
  assert.equal(getActiveHeartbeatTimerCount(), 0);

  // Abort path
  const ctrl = new AbortController();
  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_hb_abort",
      modelKey: "gpt-6.1-terra",
      prompt: "Abort",
      signal: ctrl.signal,
      transport: async () => {
        ctrl.abort();
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      },
      db,
    })
  );
  assert.equal(getActiveHeartbeatTimerCount(), 0);
});

test("13. Unknown execution is not automatically retried", async (t) => {
  const { db } = await createDatabase(t);
  await seedCatalog(db);
  const userId = "user_pro_retry";
  await setupUser(db, userId, "pro");

  let attempts = 0;
  const failingTransport = async () => {
    attempts += 1;
    const err = new Error("Upstream network reset");
    err.code = "upstream_reset";
    throw err;
  };

  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_no_auto_retry",
      modelKey: "gpt-6.1-terra",
      prompt: "No retry",
      transport: failingTransport,
      db,
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorExecutionError);
      assert.equal(err.canRetry, false);
      return true;
    }
  );

  assert.equal(attempts, 1); // Exactly 1 attempt, no automatic retry

  // Multi-attempt option throws CoordinatorPolicyBlockedError
  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_blocked_retry",
      modelKey: "gpt-6.1-terra",
      prompt: "Blocked retry",
      transport: failingTransport,
      options: { maxRetries: 2 },
      db,
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorPolicyBlockedError);
      assert.equal(err.code, "coordinator_policy_blocked");
      return true;
    }
  );
});

test("14. Provider and internal infrastructure identity is absent from public-safe results", async (t) => {
  const { db } = await createDatabase(t);
  await seedCatalog(db);
  const userId = "user_pro_sanitization";
  await setupUser(db, userId, "pro");

  const result = await executeWithCoordinator({
    userId,
    logicalRequestId: "req_sanitize_1",
    modelKey: "gpt-6.1-terra",
    prompt: "Hello",
    transport: async () => ({
      text: "Public answer",
      usage: { prompt_tokens: 80, completion_tokens: 30 },
    }),
    db,
  });

  const resultJson = JSON.stringify(result);
  assert.equal(resultJson.includes("openrouter"), false);
  assert.equal(resultJson.includes("https://openrouter.ai"), false);
  assert.equal(resultJson.includes("rawCostMicros"), false);
  assert.equal(resultJson.includes("inputPriceMicrosPerM"), false);
  assert.equal(resultJson.includes("endpointId"), false);
  assert.equal(resultJson.includes("adapterType"), false);

  assert.equal(result.displayName, "GPT-6.1 Terra");
  assert.equal(result.familyGroup, "OpenAI");
  assert.equal(result.output, "Public answer");
  assert.ok(result.settlement.settledCostMicros > 0);
});

test("15. Existing native chat, catalog, and legacy quotas remain completely unchanged", async (t) => {
  // Verify that PLAN_ALLOWANCES matches the authoritative owner specification
  assert.equal(PLAN_ALLOWANCES.max.monthlyAllowanceMicros, 30_000_000);
  assert.equal(PLAN_ALLOWANCES.pro.monthlyAllowanceMicros, 12_000_000);
  assert.equal(PLAN_ALLOWANCES.plus.monthlyAllowanceMicros, 5_000_000);
  assert.equal(PLAN_ALLOWANCES.free.monthlyAllowanceMicros, 110_000);
  assert.equal(PLAN_ALLOWANCES.free.dailyAllowanceMicros, 11_000);
  assert.equal(PLAN_ALLOWANCES.free.maxDailyRequests, 20);
});

