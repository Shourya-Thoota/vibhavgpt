import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
const { config } = await import("../src/config.js");
const { shadowCostLedger } = await import("../src/db/schema.js");
const {
  ACTIVE_PRICING_VERSION_ID,
  calculateImageCost,
  calculateInferenceCost,
  getShadowLedgerSummary,
  reconcileShadowCostEvent,
  recordShadowCostEvent,
  resolvePricingContract,
} = await import("../src/usage/shadow-ledger.js");
const { createUsageTracker } = await import("../src/usage/service.js");

async function createDatabase(t) {
  const client = new PGlite();
  t.after(() => client.close());
  // Stand-in for auth "user" table created before migrations so FK constraint binds
  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) {
    const migrationSql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
    await client.exec(migrationSql);
  }
  return { client, db: drizzle(client) };
}

test("exact integer money arithmetic and 10% markup rounding with exact pico-dollar representation", () => {
  // 1,000 uncached in @ $0.10/1M + 1,000 out @ $0.50/1M (Nova)
  // Raw cost: (1000 * 0.10 / 1M) + (1000 * 0.50 / 1M) = $0.000100 + $0.000500 = $0.000600 (600 micro-dollars)
  // Marked up (1.10x): $0.000600 * 1.10 = $0.000660 (660 micro-dollars)
  const novaResult = calculateInferenceCost({
    modelKey: "nova",
    usage: { prompt_tokens: 1000, completion_tokens: 1000 },
  });
  assert.equal(novaResult.status, "measured");
  assert.equal(novaResult.rawCostMicros, 600);
  assert.equal(novaResult.shadowDeductionMicros, 660);
  assert.equal(novaResult.rawCostPico, "600000000"); // 600 micro-dollars = 600,000,000 pico-dollars
  assert.equal(novaResult.shadowDeductionPico, "660000000");

  // Ceil boundary check: tiny request that produces a fraction of a micro-dollar
  // 1 token @ $0.10 / 1M = $0.0000001 = 0.1 micro-dollars.
  // Ceil boundary must round up to 1 micro-dollar at ledger boundary
  const tinyResult = calculateInferenceCost({
    modelKey: "nova",
    usage: { prompt_tokens: 1, completion_tokens: 0 },
  });
  assert.equal(tinyResult.rawCostMicros, 1);
  assert.equal(tinyResult.shadowDeductionMicros, 1);
  assert.equal(tinyResult.rawCostPico, "100000"); // 1 token * 100,000 pico = 100,000 pico ($10^-7 USD)

  // Zero tokens yields exact 0
  const zeroResult = calculateInferenceCost({
    modelKey: "nova",
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  });
  assert.equal(zeroResult.rawCostMicros, 0);
  assert.equal(zeroResult.shadowDeductionMicros, 0);
  assert.equal(zeroResult.rawCostPico, "0");
  assert.equal(zeroResult.shadowDeductionPico, "0");
});

test("pricing identity binds model, provider, transport and guards against model change reuse", () => {
  // Router Vulcan contract: OpenRouter with x-ai/grok-4.7 or openai/gpt-6.1-terra
  const routerVesper = resolvePricingContract({
    tier: "vesper",
    transport: "router",
    provider: "paid",
    modelIdentifier: "x-ai/grok-4.7",
  });
  assert.ok(routerVesper);
  assert.equal(routerVesper.contractId, "vesper_router_v1");
  assert.equal(routerVesper.provider, "paid");
  assert.equal(routerVesper.provenance, "repository_configuration_estimate");
  assert.equal(routerVesper.pricingConfidence, "unverified");

  const routerVesperOpenAI = resolvePricingContract({
    tier: "vesper",
    transport: "router",
    provider: "paid",
    modelIdentifier: "openai/gpt-6.1-terra",
  });
  assert.ok(routerVesperOpenAI);
  assert.equal(routerVesperOpenAI.contractId, "vesper_router_v1");

  // Direct Vulcan contract: Direct OpenAI with gpt-6.1-terra
  const directVesper = resolvePricingContract({
    tier: "vesper",
    transport: "direct",
    provider: "direct",
    modelIdentifier: "gpt-6.1-terra",
  });
  assert.ok(directVesper);
  assert.equal(directVesper.contractId, "vesper_direct_v1");
  assert.equal(directVesper.provider, "direct");

  // Router Vulcan CANNOT reuse direct Vulcan contract
  const routerCross = resolvePricingContract({
    tier: "vesper",
    transport: "router",
    provider: "paid",
    modelIdentifier: "gpt-6.1-terra", // Missing openai/ prefix required by router
  });
  assert.equal(routerCross, null);

  // Direct Vulcan CANNOT reuse router Vulcan contract
  const directCross = resolvePricingContract({
    tier: "vesper",
    transport: "direct",
    provider: "direct",
    modelIdentifier: "x-ai/grok-4.7", // Router-only model
  });
  assert.equal(directCross, null);

  // Broad regex guard: unreviewed future versions (e.g., gpt-6.2-terra) MUST evaluate to null
  const unreviewedVesper = resolvePricingContract({
    tier: "vesper",
    transport: "direct",
    provider: "direct",
    modelIdentifier: "gpt-6.2-terra",
  });
  assert.equal(unreviewedVesper, null);

  const unreviewedCost = calculateInferenceCost({
    modelKey: "vesper",
    modelIdentifier: "gpt-6.2-terra",
    transport: "direct",
    provider: "direct",
    usage: { prompt_tokens: 1000, completion_tokens: 500 },
  });
  assert.equal(unreviewedCost.status, "unpriced");
  assert.equal(unreviewedCost.usageConfidence, "measured");
  assert.equal(unreviewedCost.pricingConfidence, "unknown");
  assert.equal(unreviewedCost.rawCostMicros, null);
  assert.equal(unreviewedCost.shadowDeductionMicros, null);
});

test("changing configured model after an execution does not change pricing contract or rates assigned to past event", () => {
  // Capture past execution with gpt-6.1-terra under direct Vulcan
  const pastExecution = calculateInferenceCost({
    modelKey: "vesper",
    modelIdentifier: "gpt-6.1-terra",
    transport: "direct",
    provider: "direct",
    usage: { prompt_tokens: 10_000, completion_tokens: 2_000 },
  });
  assert.equal(pastExecution.status, "measured");
  assert.equal(pastExecution.pricingContract, "vesper_direct_v1");
  const pastCostMicros = pastExecution.rawCostMicros;
  assert.ok(pastCostMicros > 0);

  // Ambient config changes to a new unreviewed model or transport
  const originalModel = config.chatModels.vesperDirect;
  const originalTransport = config.vesperTransport;
  try {
    config.chatModels.vesperDirect = "gpt-6.2-terra";
    config.vesperTransport = "router";

    // Past execution remains completely unaffected:
    assert.equal(pastExecution.pricingContract, "vesper_direct_v1");
    assert.equal(pastExecution.rawCostMicros, pastCostMicros);

    // New execution with unreviewed model fails closed (unpriced):
    const newExecution = calculateInferenceCost({
      modelKey: "vesper",
      modelIdentifier: "gpt-6.2-terra",
      transport: "direct",
      provider: "direct",
      usage: { prompt_tokens: 10_000, completion_tokens: 2_000 },
    });
    assert.equal(newExecution.status, "unpriced");
    assert.equal(newExecution.rawCostMicros, null);
  } finally {
    config.chatModels.vesperDirect = originalModel;
    config.vesperTransport = originalTransport;
  }
});

test("cached inputs and reasoning tokens are handled without double counting", () => {
  // Vulcan Router ($1.00 in, $5.00 out, $0.05 cacheRead per 1M)
  // Input: 10,000 total tokens with 8,000 cached read -> 2,000 uncached in, 8,000 cached in
  // Output: 4,000 tokens (including 2,500 reasoning tokens)
  // Total raw cost:
  // Uncached in: 2,000 * $1.00 / 1M = $0.002000 (2,000 micros)
  // Cached in: 8,000 * $0.05 / 1M = $0.000400 (400 micros)
  // Output: 4,000 * $5.00 / 1M = $0.020000 (20,000 micros)
  // Total raw: $0.022400 = 22,400 micro-dollars
  // Marked-up: 22,400 * 1.10 = 24,640 micro-dollars
  const vesperResult = calculateInferenceCost({
    modelKey: "vesper",
    modelIdentifier: "openai/gpt-6.1-terra",
    transport: "router",
    provider: "paid",
    usage: {
      prompt_tokens: 10_000,
      completion_tokens: 4_000,
      prompt_tokens_details: { cached_tokens: 8_000 },
      completion_tokens_details: { reasoning_tokens: 2_500 },
    },
  });

  assert.equal(vesperResult.rawCostMicros, 22_400);
  assert.equal(vesperResult.shadowDeductionMicros, 24_640);
  assert.equal(vesperResult.cachedInputTokens, 8_000);
  assert.equal(vesperResult.reasoningTokens, 2_500);
});

test("generic __image__ pricing evaluates to unknown unless provider-confirmed cost is present", () => {
  // Generic __image__ without provider-reported cost or documented settings is UNKNOWN
  const genericImage = calculateImageCost({ modelKey: "__image__", imagesCount: 1 });
  assert.equal(genericImage.status, "unknown");
  assert.equal(genericImage.pricingConfidence, "unknown");
  assert.equal(genericImage.rawCostMicros, null);
  assert.equal(genericImage.shadowDeductionMicros, null);

  // Provider-reported confirmed cost: $0.04 -> 40,000 micros raw, 44,000 micros marked up
  const customCostImage = calculateImageCost({ costUsd: 0.04 });
  assert.equal(customCostImage.status, "measured");
  assert.equal(customCostImage.pricingConfidence, "provider_reported_item_cost");
  assert.equal(customCostImage.rawCostMicros, 40_000);
  assert.equal(customCostImage.shadowDeductionMicros, 44_000);
  assert.equal(customCostImage.rawCostPico, "40000000000");
  assert.equal(customCostImage.shadowDeductionPico, "44000000000");
});

test("disabled feature flag performs zero I/O and creates no database writes", async (t) => {
  const { db } = await createDatabase(t);
  const initialSetting = config.featureAllowanceLedgerShadow;
  config.featureAllowanceLedgerShadow = false;
  t.after(() => { config.featureAllowanceLedgerShadow = initialSetting; });

  const result = await recordShadowCostEvent({
    userId: "test-user-1",
    requestId: "req-disabled-1",
    modelKey: "nova",
    usage: { prompt_tokens: 1000, completion_tokens: 500 },
  }, db);

  assert.equal(result, null);
  const rows = await db.select().from(shadowCostLedger);
  assert.equal(rows.length, 0, "No rows written when feature flag is false");
});

test("enabled feature flag records durable, privacy-safe shadow ledger rows", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.query(`INSERT INTO "user" (id, email) VALUES ('user-alpha', 'alpha@test.com')`);

  const initialSetting = config.featureAllowanceLedgerShadow;
  config.featureAllowanceLedgerShadow = true;
  t.after(() => { config.featureAllowanceLedgerShadow = initialSetting; });

  const record = await recordShadowCostEvent({
    userId: "user-alpha",
    requestId: "req-chat-101",
    attemptNumber: 1,
    operation: "chat_stream",
    modelKey: "nebula",
    provider: "paid",
    usage: { prompt_tokens: 2000, completion_tokens: 800, prompt_tokens_details: { cached_tokens: 500 } },
    metadata: { clientVersion: "2.1.0" },
  }, db);

  assert.ok(record.id);
  assert.equal(record.userId, "user-alpha");
  assert.equal(record.requestId, "req-chat-101");
  assert.equal(record.operation, "chat_stream");
  assert.equal(record.modelKey, "nebula");
  assert.equal(record.provider, "paid");
  assert.equal(record.status, "measured");
  assert.equal(record.inputTokens, 2000);
  assert.equal(record.outputTokens, 800);
  assert.equal(record.cachedInputTokens, 500);
  assert.equal(record.rawCostMicros, 4163);
  assert.equal(record.shadowDeductionMicros, 4579);

  // Exact pico values in metadata
  assert.ok(record.metadata.exactRawCostPico);
  assert.ok(record.metadata.exactShadowDeductionPico);
  assert.equal(record.metadata.billingUnit, "usd_per_1m_tokens");
  assert.equal(record.metadata.currency, "USD");

  // Privacy verification: verify that no prompt or completion text is stored
  const [persisted] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.id, record.id));
  assert.equal(persisted.metadata.prompt, undefined);
  assert.equal(persisted.metadata.content, undefined);
  assert.equal(persisted.metadata.reply, undefined);
});

test("tool loops record distinct sequential billable attempts without collision", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.query(`INSERT INTO "user" (id, email) VALUES ('user-tools', 'tools@test.com')`);

  const initialSetting = config.featureAllowanceLedgerShadow;
  config.featureAllowanceLedgerShadow = true;
  t.after(() => { config.featureAllowanceLedgerShadow = initialSetting; });

  const tracker = createUsageTracker("user-tools", "nova", "none", db, {
    requestId: "req-tool-loop-99",
    operation: "chat_stream",
  });

  // Call 1: initial model response (e.g. calls weather tool)
  await tracker.beforeCall([], [], 1000);
  await tracker.record({ prompt_tokens: 500, completion_tokens: 50 });

  // Call 2: tool loop step 0 response
  await tracker.beforeCall([], [], 1000);
  await tracker.record({ prompt_tokens: 600, completion_tokens: 150 });

  // Call 3: tool loop step 1 response (final reply)
  await tracker.beforeCall([], [], 1000);
  await tracker.record({ prompt_tokens: 800, completion_tokens: 200 });

  // Allow event loop to drain fire-and-forget promise
  await new Promise((resolve) => setTimeout(resolve, 50));

  const rows = await db.select().from(shadowCostLedger)
    .where(eq(shadowCostLedger.requestId, "req-tool-loop-99"))
    .orderBy(shadowCostLedger.attemptNumber);

  assert.equal(rows.length, 3, "All 3 distinct tool loop steps recorded");
  assert.equal(rows[0].attemptNumber, 1);
  assert.equal(rows[1].attemptNumber, 2);
  assert.equal(rows[2].attemptNumber, 3);
  assert.notEqual(rows[0].idempotencyKey, rows[1].idempotencyKey);
  assert.notEqual(rows[1].idempotencyKey, rows[2].idempotencyKey);
});

test("atomic idempotency and reconciliation: late estimated arrival cannot overwrite measured data", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.query(`INSERT INTO "user" (id, email) VALUES ('user-concurrency', 'conc@test.com')`);

  const initialSetting = config.featureAllowanceLedgerShadow;
  config.featureAllowanceLedgerShadow = true;
  t.after(() => { config.featureAllowanceLedgerShadow = initialSetting; });

  const idempotencyKey = "race_event_key_abc";

  // Event 1: Arrives and is recorded as measured
  const measured = await recordShadowCostEvent({
    userId: "user-concurrency",
    requestId: "req-race-1",
    attemptNumber: 1,
    operation: "chat_stream",
    modelKey: "study",
    idempotencyKey,
    isEstimated: false,
    usage: { prompt_tokens: 1000, completion_tokens: 400 },
  }, db);
  assert.equal(measured.status, "measured");

  // Event 2: A delayed estimated event tries to reconcile or insert with the same key
  // An insert with the same key does nothing
  const lateInsert = await recordShadowCostEvent({
    userId: "user-concurrency",
    requestId: "req-race-1",
    attemptNumber: 1,
    operation: "chat_stream",
    modelKey: "study",
    idempotencyKey,
    isEstimated: true,
    usage: { prompt_tokens: 500, completion_tokens: 100, estimated: true },
  }, db);
  assert.equal(lateInsert.status, "duplicate");

  // Reconcile targeting an already measured row returns null (only estimated rows can be reconciled)
  const lateReconcile = await reconcileShadowCostEvent({
    idempotencyKey,
    userId: "user-concurrency",
    modelKey: "study",
    usage: { prompt_tokens: 500, completion_tokens: 100 },
  }, db);
  assert.equal(lateReconcile, null, "Measured row cannot be downgraded or overwritten");

  const [finalRow] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.idempotencyKey, idempotencyKey));
  assert.equal(finalRow.status, "measured");
  assert.equal(finalRow.inputTokens, 1000);
  assert.equal(finalRow.outputTokens, 400);
});

test("tenant identity cannot be mutated through reconciliation", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.query(`INSERT INTO "user" (id, email) VALUES ('user-victim', 'victim@test.com')`);
  await client.query(`INSERT INTO "user" (id, email) VALUES ('user-attacker', 'attacker@test.com')`);

  const initialSetting = config.featureAllowanceLedgerShadow;
  config.featureAllowanceLedgerShadow = true;
  t.after(() => { config.featureAllowanceLedgerShadow = initialSetting; });

  const idempotencyKey = "tenant_isolation_key_1";

  // Estimated event owned by user-victim
  await recordShadowCostEvent({
    userId: "user-victim",
    requestId: "req-victim-1",
    operation: "chat_stream",
    modelKey: "nova",
    idempotencyKey,
    isEstimated: true,
    usage: { prompt_tokens: 1000, completion_tokens: 200, estimated: true },
  }, db);

  // Attacker tries to reconcile victim's event passing their own userId
  const attackerAttempt = await reconcileShadowCostEvent({
    idempotencyKey,
    userId: "user-attacker", // Wrong user!
    modelKey: "nova",
    usage: { prompt_tokens: 2000, completion_tokens: 500 },
  }, db);
  assert.equal(attackerAttempt, null, "Cross-tenant reconciliation blocked");

  // Verify the row's owner remains user-victim
  const [row] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.idempotencyKey, idempotencyKey));
  assert.equal(row.userId, "user-victim");
});

test("account deletion race protection: ordering A - deletion commits before insert runs", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.query(`INSERT INTO "user" (id, email) VALUES ('user-departing', 'departing@test.com')`);

  const initialSetting = config.featureAllowanceLedgerShadow;
  config.featureAllowanceLedgerShadow = true;
  t.after(() => { config.featureAllowanceLedgerShadow = initialSetting; });

  // Simulate account deletion committing first
  await client.query(`DELETE FROM "user" WHERE id = 'user-departing'`);

  // An in-flight delayed shadow recording finishes AFTER the account was deleted
  const result = await recordShadowCostEvent({
    userId: "user-departing",
    requestId: "req-delayed-after-delete",
    modelKey: "nova",
    usage: { prompt_tokens: 500, completion_tokens: 200 },
  }, db);

  assert.equal(result.status, "user_deleted");

  // Verify no orphan or ghost row was created
  const rows = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.userId, "user-departing"));
  assert.equal(rows.length, 0, "No user-linked rows resurrected after deletion");
});

test("account deletion race protection: ordering B - writer passes preliminary check, deletion commits, database boundary blocks insert", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.query(`INSERT INTO "user" (id, email) VALUES ('user-racing', 'racing@test.com')`);

  const initialSetting = config.featureAllowanceLedgerShadow;
  config.featureAllowanceLedgerShadow = true;
  t.after(() => { config.featureAllowanceLedgerShadow = initialSetting; });

  let preliminaryCheckTriggered = false;

  // Intercept db so that immediately when the application-level user-check runs,
  // the account deletion commits before the insert reaches the database.
  const proxiedDb = {
    ...db,
    async execute(query) {
      const result = await db.execute(query);
      const queryStr = JSON.stringify(query);
      if (queryStr.includes("SELECT 1 FROM") && !preliminaryCheckTriggered) {
        preliminaryCheckTriggered = true;
        // Account deletion transaction commits in the race window:
        await client.query(`DELETE FROM "user" WHERE id = 'user-racing'`);
      }
      return result;
    },
    insert(...args) {
      return db.insert(...args);
    },
    select(...args) {
      return db.select(...args);
    },
  };

  const result = await recordShadowCostEvent({
    userId: "user-racing",
    requestId: "req-racing-deletion",
    modelKey: "nova",
    usage: { prompt_tokens: 600, completion_tokens: 300 },
  }, proxiedDb);

  assert.equal(preliminaryCheckTriggered, true, "Preliminary check passed before deletion committed");
  assert.equal(result.status, "user_deleted", "Foreign key constraint failure handled cleanly");

  // Verify no row was inserted with user-racing, and no anonymous row was created
  const userRows = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.userId, "user-racing"));
  assert.equal(userRows.length, 0, "No user-linked rows written");

  const anonRows = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, "req-racing-deletion"));
  assert.equal(anonRows.length, 0, "Insert was dropped cleanly and never converted to an anonymous event");
});

test("account deletion: foreign key ON DELETE CASCADE purges existing shadow records", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.query(`INSERT INTO "user" (id, email) VALUES ('user-cascade', 'cascade@test.com')`);

  const initialSetting = config.featureAllowanceLedgerShadow;
  config.featureAllowanceLedgerShadow = true;
  t.after(() => { config.featureAllowanceLedgerShadow = initialSetting; });

  // Record a legitimate shadow record while user exists
  const rec = await recordShadowCostEvent({
    userId: "user-cascade",
    requestId: "req-before-delete",
    modelKey: "nova",
    usage: { prompt_tokens: 400, completion_tokens: 100 },
  }, db);
  assert.equal(rec.userId, "user-cascade");

  const beforeDelete = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.userId, "user-cascade"));
  assert.equal(beforeDelete.length, 1);

  // User account is deleted directly at the database level
  await client.query(`DELETE FROM "user" WHERE id = 'user-cascade'`);

  // Foreign key ON DELETE CASCADE must have purged the shadow records automatically
  const afterDelete = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.userId, "user-cascade"));
  assert.equal(afterDelete.length, 0, "Shadow cost ledger rows were purged via ON DELETE CASCADE");
});

test("database migrations: fresh database, preceding migration, and repeated execution", async () => {
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  const migration33Sql = await readFile(new URL("../drizzle/0033_shadow_cost_ledger.sql", import.meta.url), "utf8");

  // Scenario 1: Fresh database applying all migrations
  const freshClient = new PGlite();
  for (const entry of journal.entries) {
    const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
    await freshClient.exec(sql);
  }
  const freshTableCheck = await freshClient.query("SELECT to_regclass('shadow_cost_ledger') AS name");
  assert.equal(freshTableCheck.rows[0].name, "shadow_cost_ledger");
  await freshClient.close();

  // Scenario 2: Existing database at preceding migration (0..31), then applying 32 (0033)
  const existingClient = new PGlite();
  for (const entry of journal.entries.slice(0, 32)) {
    const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
    await existingClient.exec(sql);
  }
  const before33 = await existingClient.query("SELECT to_regclass('shadow_cost_ledger') AS name");
  assert.equal(before33.rows[0].name, null, "Table does not exist before migration 0033");

  // Apply migration 0033
  await existingClient.exec(migration33Sql);
  const after33 = await existingClient.query("SELECT to_regclass('shadow_cost_ledger') AS name");
  assert.equal(after33.rows[0].name, "shadow_cost_ledger");

  // Scenario 3: Repeated migration runner execution (idempotency)
  await existingClient.exec(migration33Sql);
  const repeatedCheck = await existingClient.query("SELECT to_regclass('shadow_cost_ledger') AS name");
  assert.equal(repeatedCheck.rows[0].name, "shadow_cost_ledger", "Migration 0033 is strictly idempotent");
  await existingClient.close();
});

test("missing pricing or missing usage evaluates to unknown rather than zero", () => {
  // Unpriced model: must remain unpriced/unknown and null, never fabricated as 0
  const unpricedResult = calculateInferenceCost({
    modelKey: "unregistered_custom_model_v9",
    usage: { prompt_tokens: 1000, completion_tokens: 1000 },
  });
  assert.equal(unpricedResult.status, "unpriced");
  assert.equal(unpricedResult.rawCostMicros, null);
  assert.equal(unpricedResult.shadowDeductionMicros, null);

  // Missing or corrupted token counts: must remain unknown
  const missingTokensResult = calculateInferenceCost({
    modelKey: "nova",
    usage: { prompt_tokens: null, completion_tokens: undefined },
  });
  assert.equal(missingTokensResult.status, "unknown");
  assert.equal(missingTokensResult.rawCostMicros, null);
  assert.equal(missingTokensResult.shadowDeductionMicros, null);

  const invalidTokensResult = calculateInferenceCost({
    modelKey: "nova",
    usage: { prompt_tokens: -5, completion_tokens: "corrupt" },
  });
  assert.equal(invalidTokensResult.status, "unknown");
  assert.equal(invalidTokensResult.rawCostMicros, null);
  assert.equal(invalidTokensResult.shadowDeductionMicros, null);
});

test("distinct billable retry attempts are preserved with unique attempt numbers", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.query(`INSERT INTO "user" (id, email) VALUES ('user-gamma', 'gamma@test.com')`);

  const initialSetting = config.featureAllowanceLedgerShadow;
  config.featureAllowanceLedgerShadow = true;
  t.after(() => { config.featureAllowanceLedgerShadow = initialSetting; });

  const requestId = "req-retry-flow-77";

  // Attempt 1: failed with partial tokens
  const attempt1 = await recordShadowCostEvent({
    userId: "user-gamma",
    requestId,
    attemptNumber: 1,
    operation: "chat_stream",
    modelKey: "vesper",
    provider: "paid",
    usage: { prompt_tokens: 500, completion_tokens: 100 },
  }, db);

  // Attempt 2: retry on secondary stage succeeded
  const attempt2 = await recordShadowCostEvent({
    userId: "user-gamma",
    requestId,
    attemptNumber: 2,
    operation: "chat_stream",
    modelKey: "vesper",
    provider: "direct",
    usage: { prompt_tokens: 500, completion_tokens: 800 },
  }, db);

  assert.ok(attempt1.id);
  assert.ok(attempt2.id);
  assert.notEqual(attempt1.id, attempt2.id);

  const rows = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, requestId));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].attemptNumber, 1);
  assert.equal(rows[1].attemptNumber, 2);
});

test("tenant summary aggregates only the target user's records", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.query(`INSERT INTO "user" (id, email) VALUES ('tenant-A', 'ta@test.com')`);
  await client.query(`INSERT INTO "user" (id, email) VALUES ('tenant-B', 'tb@test.com')`);

  const initialSetting = config.featureAllowanceLedgerShadow;
  config.featureAllowanceLedgerShadow = true;
  t.after(() => { config.featureAllowanceLedgerShadow = initialSetting; });

  // User A events: Nova ($0.10 in, $0.50 out / 1M)
  // 1,000 in, 1,000 out -> 600 raw, 660 deduction
  await recordShadowCostEvent({
    userId: "tenant-A",
    requestId: "req-a1",
    modelKey: "nova",
    usage: { prompt_tokens: 1000, completion_tokens: 1000 },
  }, db);
  await recordShadowCostEvent({
    userId: "tenant-A",
    requestId: "req-a2",
    modelKey: "nova",
    usage: { prompt_tokens: 1000, completion_tokens: 1000 },
  }, db);

  // User B event
  await recordShadowCostEvent({
    userId: "tenant-B",
    requestId: "req-b1",
    modelKey: "vesper",
    usage: { prompt_tokens: 10_000, completion_tokens: 5000 },
  }, db);

  const summaryA = await getShadowLedgerSummary("tenant-A", {}, db);
  assert.equal(summaryA.eventCount, 2);
  assert.equal(summaryA.totalRawCostMicros, 1200);
  assert.equal(summaryA.totalShadowDeductionMicros, 1320);

  const summaryB = await getShadowLedgerSummary("tenant-B", {}, db);
  assert.equal(summaryB.eventCount, 1);
  assert.notEqual(summaryB.totalRawCostMicros, 1200);
});

test("shadow ledger database errors are caught and do not throw to caller", async (t) => {
  const initialSetting = config.featureAllowanceLedgerShadow;
  config.featureAllowanceLedgerShadow = true;
  t.after(() => { config.featureAllowanceLedgerShadow = initialSetting; });

  // Mock executor that throws an error
  const brokenDb = {
    execute() {
      throw new Error("Simulated database failure");
    },
    insert() {
      throw new Error("Simulated database failure");
    },
  };

  const result = await recordShadowCostEvent({
    userId: "user-alpha",
    requestId: "req-fail-1",
    modelKey: "nova",
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  }, brokenDb);

  assert.equal(result.success, false);
  assert.equal(result.error, "Simulated database failure");
});

