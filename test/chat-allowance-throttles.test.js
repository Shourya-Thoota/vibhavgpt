// Nova was this suite's enforced tier; it was retired on 2026-11-14, so the suite runs on Vulcan (Pro and up), the router-served paid
// tier that remains enforceable. The behaviour under test is unchanged.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { approveLumenStages } from "./lumen-approvals.js";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) {
  await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
}
const db = drizzle(client);

mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db, pool: { query: (text, params) => client.query(text, params) } },
});
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => (req.authSession ? next() : res.status(401).json({ error: "Sign in is required." })),
    loadOptionalSession: (_req, _res, next) => next(),
  },
});

const { config } = await import("../src/config.js");
const schema = await import("../src/db/schema.js");
const { default: express } = await import("express");
const { chatRouter } = await import("../src/chat/router.js");
const { clearAllHeartbeatTimers } = await import("../src/models/execution-coordinator.js");

config.moderationApiKey = "";
config.providerKeys.primaryFree = "fixture-key";
config.providerKeys.paid = "fixture-key";
config.providerKeys.direct = "fixture-key";
config.providerBaseUrls.paid = "https://router.test/api/v1";
config.providerBaseUrls.direct = "https://direct.test/v1";
config.providerBaseUrls.primaryFree = "https://primary.test/v1";
config.chatModels.nova = "fixture/nova-model"; // the retired tier's registry seed (history only)
config.chatModels.lumen = "fixture/lumen-model";
config.chatModels.vesper = "fixture/vesper-model";
config.chatModels.vesperDirect = "gpt-6.1-terra";
config.vesperDataPolicyVerified = true;
config.vesperTransport = "direct";
approveLumenStages(config);

const PERIOD_START = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
const PERIOD_END = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
const REPLY = "Here is your answer.";
const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;

async function seedRegistry() {
  const [novaFamily] = await db.insert(schema.modelFamilies).values({ slug: "vibhavgpt/nova", displayName: "VibhavGPT Nova", familyGroup: "native", sortOrder: 20 }).returning();
  const [novaVersion] = await db.insert(schema.modelVersions).values({
    familyId: novaFamily.id, versionTag: "fixture/nova-model", aliases: ["nova"], planEligibility: "paid", lifecycleState: "active",
    capabilitiesDocumented: { vision: true, tools: true, streaming: true, structuredOutputs: true },
  }).returning();
  const [novaEndpoint] = await db.insert(schema.modelEndpoints).values({
    versionId: novaVersion.id, providerName: "paid", transportType: "router", adapterType: "chat_completions",
    endpointUrl: "https://router.test/api/v1", endpointState: "active", sortPriority: 1,
    capabilitiesVerified: { vision: true, tools: true, streaming: true },
    privacyReview: { privacyApproved: true, scope: "default", zeroDataRetention: true, trainingPolicy: "denied" },
  }).returning();
  await db.insert(schema.modelPricingSnapshots).values({
    endpointId: novaEndpoint.id, pricingVersionId: "fixture_nova_v1", effectiveFrom: new Date("2026-01-01"),
    inputPriceMicrosPerM: 174_000, outputPriceMicrosPerM: 586_000, cachedReadPriceMicrosPerM: 18_000,
    consumptionCategory: "low", pricingConfidence: "verified", provenance: "test_fixture",
  });

  const [vesperFamily] = await db.insert(schema.modelFamilies).values({ slug: "vibhavgpt/vesper", displayName: "VibhavGPT Vulcan", familyGroup: "native", sortOrder: 30 }).returning();
  const [vesperVersion] = await db.insert(schema.modelVersions).values({
    familyId: vesperFamily.id, versionTag: "fixture/vesper-model", aliases: ["vesper"], planEligibility: "paid", lifecycleState: "active",
    capabilitiesDocumented: { vision: true, tools: true, streaming: true, structuredOutputs: true },
  }).returning();
  const [vesperEndpoint] = await db.insert(schema.modelEndpoints).values({
    versionId: vesperVersion.id, providerName: "direct", transportType: "direct", adapterType: "responses",
    endpointUrl: "https://direct.test/v1", endpointState: "active", sortPriority: 1,
    capabilitiesVerified: { vision: true, tools: true, streaming: true },
    privacyReview: { privacyApproved: true, scope: "default", zeroDataRetention: true, trainingPolicy: "denied" },
  }).returning();
  await db.insert(schema.modelPricingSnapshots).values({
    endpointId: vesperEndpoint.id, pricingVersionId: "fixture_vesper_v1", effectiveFrom: new Date("2026-01-01"),
    inputPriceMicrosPerM: 1_000_000, outputPriceMicrosPerM: 5_000_000, cachedReadPriceMicrosPerM: 50_000,
    consumptionCategory: "extra_high", pricingConfidence: "verified", provenance: "test_fixture",
  });

  const [lumenFamily] = await db.insert(schema.modelFamilies).values({ slug: "vibhavgpt/lumen", displayName: "VibhavGPT Lumen", familyGroup: "native", sortOrder: 10 }).returning();
  const [lumenVersion] = await db.insert(schema.modelVersions).values({
    familyId: lumenFamily.id, versionTag: "fixture/lumen-model", aliases: ["lumen"], planEligibility: "free", lifecycleState: "active",
    capabilitiesDocumented: { vision: false, tools: true, streaming: true },
  }).returning();
  const [lumenEndpoint] = await db.insert(schema.modelEndpoints).values({
    versionId: lumenVersion.id, providerName: "primaryFree", transportType: "primaryFree", adapterType: "chat_completions",
    endpointUrl: "https://primary.test/v1", endpointState: "active", sortPriority: 1,
    capabilitiesVerified: { tools: true, streaming: true },
    privacyReview: { privacyApproved: true, scope: "default", zeroDataRetention: true, trainingPolicy: "denied" },
  }).returning();
  await db.insert(schema.modelPricingSnapshots).values({
    endpointId: lumenEndpoint.id, pricingVersionId: "fixture_lumen_v1", effectiveFrom: new Date("2026-01-01"),
    inputPriceMicrosPerM: 0, outputPriceMicrosPerM: 0, cachedReadPriceMicrosPerM: 0,
    consumptionCategory: "low", pricingConfidence: "verified", provenance: "test_fixture",
  });
}
await seedRegistry();

async function addUser(userId, tier = "pro") { // Vulcan (the enforced tier here) is Pro and up
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, `${userId}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
  if (tier !== "free") {
    await db.insert(schema.subscriptions).values({
      userId,
      tier,
      status: "active",
      currentPeriodStartedAt: PERIOD_START,
      currentPeriodEndsAt: PERIOD_END,
      updatedAt: new Date(),
    });
  }
}

async function seedUsageEvents(userId, model, count, createdAt = new Date()) {
  for (let i = 0; i < count; i++) {
    await db.insert(schema.usageEvents).values({
      userId,
      model,
      thinkingEffort: "none",
      reservedTokens: 0,
      costMicros: 0,
      createdAt,
    });
  }
}

function fakeFetch(realFetch) {
  return async (url, init) => {
    const href = String(url);
    if (href.startsWith(config.providerBaseUrls.paid) || href.startsWith(config.providerBaseUrls.direct)) {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body.stream) {
        return new Response(
          [
            { id: "gen_test", choices: [{ delta: { content: REPLY } }] },
            { id: "gen_test", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0001 } },
          ].map(frame).join(""),
          { headers: { "Content-Type": "text/event-stream" } }
        );
      }
      return new Response(
        JSON.stringify({
          id: "gen_test",
          choices: [{ message: { content: REPLY } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0001 },
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    if (href.startsWith(config.providerBaseUrls.primaryFree)) {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body.stream) {
        return new Response(
          [
            { id: "gen_lumen", choices: [{ delta: { content: REPLY } }] },
            { id: "gen_lumen", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50 } },
          ].map(frame).join(""),
          { headers: { "Content-Type": "text/event-stream" } }
        );
      }
      return new Response(
        JSON.stringify({
          id: "gen_lumen",
          choices: [{ message: { content: REPLY } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
    throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
  };
}

async function serve(userId, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(realFetch);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/chat", chatRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    globalThis.fetch = realFetch;
    clearAllHeartbeatTimers();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runWithGateway({ on = true, tiers = ["vesper"] } = {}, fn) {
  const original = [
    config.featureChatAllowanceEnforcement,
    config.chatAllowanceActivatedAt,
    config.chatAllowanceEnforcedTiers,
  ];
  config.featureChatAllowanceEnforcement = on;
  config.chatAllowanceActivatedAt = on ? new Date("2026-01-01T00:00:00Z") : null;
  config.chatAllowanceEnforcedTiers = tiers;
  try {
    await fn();
  } finally {
    [
      config.featureChatAllowanceEnforcement,
      config.chatAllowanceActivatedAt,
      config.chatAllowanceEnforcedTiers,
    ] = original;
  }
}

// --------------------------------------------------------------------------
// SUITE: STRICTLY SERIAL EXECUTION
// --------------------------------------------------------------------------

test("Allowance Gateway Throttles & Accounting Verification Suite", async (suite) => {

  await suite.test("GATEWAY ACTIVE: Free tier 15 prompts/24h throttle enforced at HTTP level", async () => {
    await runWithGateway({ on: true }, async () => {
      const userId = "test_user_free_gateway_active";
      await addUser(userId, "free");
      await serve(userId, async (base) => {
        await seedUsageEvents(userId, "lumen", 14, new Date());

        const res15 = await fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Fifteenth prompt", model: "lumen" }),
        });
        assert.equal(res15.status, 200);

        const res16 = await fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Sixteenth prompt", model: "lumen" }),
        });
        assert.equal(res16.status, 429);
        const body16 = await res16.json();
        assert.equal(body16.code, "free_daily_prompts_exceeded");
      });
    });
  });

  await suite.test("GATEWAY ACTIVE: Plus has no high-compute house tier; asking for one is refused before any throttle or accounting", async () => {
    await runWithGateway({ on: true, tiers: ["vesper"] }, async () => {
      const userId = "test_user_plus_gateway_active";
      await addUser(userId, "plus");
      await serve(userId, async (base) => {
        // Vulcan is Pro and up.
        const vesper = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Hello", model: "vesper" }) });
        assert.equal(vesper.status, 403);
        assert.equal((await vesper.json()).code, "plus_forbidden_extra_high");
        // Nova, which Plus could use before, is retired: refused by name, never moved to another tier.
        const nova = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Hello", model: "nova" }) });
        assert.equal(nova.status, 400);
        assert.equal((await nova.json()).code, "model_retired");
        // Neither refusal held or charged anything.
        const usage = (await client.query(`SELECT COUNT(*)::int AS n FROM usage_events WHERE user_id = $1`, [userId])).rows[0].n;
        assert.equal(usage, 0);
      });
    });
  });

  await suite.test("GATEWAY ACTIVE: Pro on Vulcan (Red) is not counted against the 5-hour Yellow/Orange throttle, whose house tiers were retired", async () => {
    await runWithGateway({ on: true, tiers: ["vesper"] }, async () => {
      const userId = "test_user_pro_gateway_active";
      await addUser(userId, "pro");
      await serve(userId, async (base) => {
        await seedUsageEvents(userId, "vesper", 119, new Date());
        for (const message of ["One hundred twentieth prompt", "One hundred twenty-first prompt"]) {
          const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, model: "vesper" }) });
          assert.equal(res.status, 200, message);
        }
      });
    });
  });

  await suite.test("GATEWAY ACTIVE: Max tier 400 Red prompts/5h throttle enforced at HTTP level", async () => {
    await runWithGateway({ on: true, tiers: ["vesper"] }, async () => {
      const userId = "test_user_max_gateway_active";
      await addUser(userId, "max");
      await serve(userId, async (base) => {
        await seedUsageEvents(userId, "vesper", 399, new Date());

        const res400 = await fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "400th prompt", model: "vesper" }),
        });
        assert.equal(res400.status, 200);

        const res401 = await fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "401st prompt", model: "vesper" }),
        });
        assert.equal(res401.status, 429);
        const body401 = await res401.json();
        assert.equal(body401.code, "max_extra_high_throttled");
      });
    });
  });

  await suite.test("GATEWAY ACTIVE: Model eligibility remains enforced and debits are single-accounted", async () => {
    await runWithGateway({ on: true, tiers: ["vesper"] }, async () => {
      const plusUser = "test_user_plus_eligibility_active";
      await addUser(plusUser, "plus");
      await serve(plusUser, async (plusBase) => {
        // Plus user requesting Red model (vesper, mu > 7.00) is forbidden (403)
        const resForbidden = await fetch(`${plusBase}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Requesting vesper", model: "vesper" }),
        });
        assert.equal(resForbidden.status, 403);
        const forbiddenBody = await resForbidden.json();
        assert.equal(forbiddenBody.code, "plus_forbidden_extra_high");

      });
      // An eligible request (a Pro account on Vulcan; Nova, Plus's eligible tier before, is retired) succeeds with SINGLE accounting.
      const proUser = `${plusUser}_pro`;
      await addUser(proUser, "pro");
      await serve(proUser, async (proBase) => {
        const resOk = await fetch(`${proBase}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Requesting vesper", model: "vesper" }),
        });
        assert.equal(resOk.status, 200);
        const plusUserForLedger = proUser;

        // Verify single accounting: exactly 1 settled entry in shadow_cost_ledger
        const ledgerRows = (await client.query(
          `SELECT request_id, status, settled_cost_micros FROM shadow_cost_ledger WHERE user_id = $1 AND request_id NOT LIKE 'seed_%'`,
          [plusUserForLedger]
        )).rows;
        assert.equal(ledgerRows.length, 1);
        assert.equal(ledgerRows[0].status, "settled");
        assert.equal(Number(ledgerRows[0].settled_cost_micros), 350, "the Vulcan fixture's provider-reported cost, settled once");

        // Verify usage_events has no duplicate hold or debit (legacy token accounting not applied on top)
        const usageRows = (await client.query(
          `SELECT reserved_tokens, cost_micros FROM usage_events WHERE user_id = $1`,
          [plusUserForLedger]
        )).rows;
        assert.equal(usageRows.length, 0);
      });
    });
  });

  await suite.test("GATEWAY INACTIVE: Free tier 15 prompts/24h throttle enforced at HTTP level", async () => {
    await runWithGateway({ on: false }, async () => {
      const userId = "test_user_free_gateway_inactive";
      await addUser(userId, "free");
      await serve(userId, async (base) => {
        await seedUsageEvents(userId, "lumen", 14, new Date());

        const res15 = await fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Fifteenth prompt", model: "lumen" }),
        });
        assert.equal(res15.status, 200);

        const res16 = await fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Sixteenth prompt", model: "lumen" }),
        });
        assert.equal(res16.status, 429);
        const body16 = await res16.json();
        assert.equal(body16.code, "free_daily_prompts_exceeded");
      });
    });
  });

  await suite.test("GATEWAY INACTIVE: Plus has no high-compute house tier; asking for one is refused before any throttle or accounting", async () => {
    await runWithGateway({ on: false }, async () => {
      const userId = "test_user_plus_gateway_inactive";
      await addUser(userId, "plus");
      await serve(userId, async (base) => {
        // Vulcan is Pro and up.
        const vesper = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Hello", model: "vesper" }) });
        assert.equal(vesper.status, 403);
        assert.equal((await vesper.json()).code, "plus_forbidden_extra_high");
        // Nova, which Plus could use before, is retired: refused by name, never moved to another tier.
        const nova = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Hello", model: "nova" }) });
        assert.equal(nova.status, 400);
        assert.equal((await nova.json()).code, "model_retired");
        // Neither refusal held or charged anything.
        const usage = (await client.query(`SELECT COUNT(*)::int AS n FROM usage_events WHERE user_id = $1`, [userId])).rows[0].n;
        assert.equal(usage, 0);
      });
    });
  });

  await suite.test("GATEWAY INACTIVE: Pro on Vulcan (Red) is not counted against the 5-hour Yellow/Orange throttle, whose house tiers were retired", async () => {
    await runWithGateway({ on: false }, async () => {
      const userId = "test_user_pro_gateway_inactive";
      await addUser(userId, "pro");
      await serve(userId, async (base) => {
        await seedUsageEvents(userId, "vesper", 119, new Date());
        for (const message of ["One hundred twentieth prompt", "One hundred twenty-first prompt"]) {
          const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, model: "vesper" }) });
          assert.equal(res.status, 200, message);
        }
      });
    });
  });

  await suite.test("GATEWAY INACTIVE: Max tier 400 Red prompts/5h throttle enforced at HTTP level", async () => {
    await runWithGateway({ on: false }, async () => {
      const userId = "test_user_max_gateway_inactive";
      await addUser(userId, "max");
      await serve(userId, async (base) => {
        await seedUsageEvents(userId, "vesper", 399, new Date());

        const res400 = await fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "400th prompt", model: "vesper" }),
        });
        assert.equal(res400.status, 200);

        const res401 = await fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "401st prompt", model: "vesper" }),
        });
        assert.equal(res401.status, 429);
        const body401 = await res401.json();
        assert.equal(body401.code, "max_extra_high_throttled");
      });
    });
  });

  await suite.test("GATEWAY INACTIVE: Model eligibility remains enforced and shadow ledger is untouched", async () => {
    await runWithGateway({ on: false }, async () => {
      const plusUser = "test_user_plus_eligibility_inactive";
      await addUser(plusUser, "plus");
      await serve(plusUser, async (plusBase) => {
        // Plus user requesting Red model is forbidden (403)
        const resForbidden = await fetch(`${plusBase}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Requesting vesper", model: "vesper" }),
        });
        assert.equal(resForbidden.status, 403);
        const forbiddenBody = await resForbidden.json();
        assert.equal(forbiddenBody.code, "plus_forbidden_extra_high");

      });
      // An eligible request (a Pro account on Vulcan; Nova, Plus's eligible tier before, is retired) succeeds.
      const proUser = `${plusUser}_pro`;
      await addUser(proUser, "pro");
      await serve(proUser, async (proBase) => {
        const resOk = await fetch(`${proBase}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Requesting vesper", model: "vesper" }),
        });
        assert.equal(resOk.status, 200);

        // Shadow ledger remains completely untouched when gateway is inactive
        const ledgerRows = (await client.query(
          `SELECT count(*)::int AS n FROM shadow_cost_ledger WHERE user_id = $1 AND request_id NOT LIKE 'seed_%'`,
          [proUser]
        )).rows[0].n;
        assert.equal(ledgerRows, 0);
      });
    });
  });

});
