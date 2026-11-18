import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) {
  await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
}
const db = drizzle(client);

mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db, pool: { query: (sql, params) => client.query(sql, params) } },
});

let currentSessionUser = { id: "test-user-model-contract", email: "user@test.local" };
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, _res, next) => {
      req.authSession = { user: currentSessionUser };
      next();
    },
    loadOptionalSession: (req, _res, next) => {
      req.authSession = { user: currentSessionUser };
      next();
    },
  },
});

const { config } = await import("../src/config.js");
config.moderationApiKey = "";
config.providerKeys.primaryFree = "fixture-primary-key";
config.providerKeys.paid = "fixture-paid-key";
config.providerKeys.direct = "fixture-direct-key";
config.providerBaseUrls.primaryFree = "https://primary.test/v1";
config.providerBaseUrls.paid = "https://paid.test/v1";
config.providerBaseUrls.direct = "https://direct.test/v1";
config.chatModels.lumen = "fixture-lumen";
config.chatModels.nova = "fixture-nova";
config.chatModels.nebula = "fixture-nebula";
config.chatModels.vesper = "fixture-vesper";
config.chatModels.vesperDirect = "fixture-vesper-direct";
config.lumenPrimaryApproved = true;
config.routeProviders.nova = ["fixture-provider"];
config.routeProviders.nebula = ["fixture-provider"];
config.nebulaDataPolicyVerified = true;
config.vesperDataPolicyVerified = true;
config.vesperTransport = "router";

const { default: express } = await import("express");
const { profileRouter, isValidModelSelection } = await import("../src/profile/router.js");
const { chatRouter } = await import("../src/chat/router.js");
const { canonicalModelKey } = await import("../frontend/src/token-quotas.js");
const { normalizeModelKey, isKnownCatalogModel } = await import("../src/chat/model-keys.js");

function parseSSEEvents(text) {
  return text
    .split("\n\n")
    .map((block) => ({
      event: block.match(/^event:\s*(.+)$/m)?.[1],
      data: block.match(/^data:\s*(.+)$/m)?.[1],
    }))
    .filter((item) => item.event && item.data)
    .map((item) => ({ event: item.event, data: JSON.parse(item.data) }));
}

async function startTestServer(t) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith("http://127.0.0.1")) {
      return realFetch(url, init);
    }
    // Upstream inference stub for all models
    const streamBody = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello from " } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "VibhavGPT inference!" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 15, completion_tokens: 8 } })}\n\n`,
    ].join("");
    return new Response(streamBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const app = express();
  app.use(express.json());
  app.use("/api/profile", profileRouter);
  app.use("/api/chat", chatRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });

  t.after(() => {
    globalThis.fetch = realFetch;
    return new Promise((resolve) => server.close(resolve));
  });

  return `http://127.0.0.1:${server.address().port}`;
}

test("1. Model Normalization Contract: canonical keys, casing, and aliases", () => {
  // Core native models
  assert.equal(canonicalModelKey("nova"), "nova");
  assert.equal(canonicalModelKey("NOVA"), "nova");
  assert.equal(canonicalModelKey("  Nova  "), "nova");
  assert.equal(canonicalModelKey("lumen"), "lumen");
  assert.equal(canonicalModelKey("nebula"), "nebula");
  assert.equal(canonicalModelKey("vesper"), "vesper");

  // Aliases (legacy public names only — no speculative vendor route aliases)
  assert.equal(canonicalModelKey("spark"), "lumen");
  assert.equal(canonicalModelKey("ultra"), "nebula");

  // Speculative candidate names are not remapped into customer tiers
  assert.equal(canonicalModelKey("terra"), "terra");
  assert.equal(normalizeModelKey("terra"), "lumen");
  // A marketplace model's own id is that marketplace model (shown under its maker's name, billed per turn), never a house tier: the
  // name a house tier happens to run on never selects the house tier.
  assert.equal(normalizeModelKey("gpt-6.1-terra"), "gpt-6.1-terra");
  assert.notEqual(normalizeModelKey("gpt-6.1-terra"), "vesper");

  // Chat model keys mapping
  assert.equal(normalizeModelKey("nova"), "nova");
  assert.equal(normalizeModelKey("Nova"), "nova");
  assert.equal(normalizeModelKey("spark"), "lumen");
  assert.equal(normalizeModelKey("claude-3-5-sonnet"), "claude-3-5-sonnet");
  assert.equal(isKnownCatalogModel("claude-3-5-sonnet"), true);
  assert.equal(isKnownCatalogModel("gpt-4o"), true);

  // Validation function
  assert.equal(isValidModelSelection("nova"), false, "retired on 2026-11-14: not selectable");
  assert.equal(isValidModelSelection("lumen"), true);
  assert.equal(isValidModelSelection("nebula"), false, "retired on 2026-11-14: not selectable");
  assert.equal(isValidModelSelection("vesper"), true);
  assert.equal(isValidModelSelection("claude-3-5-sonnet"), false);
  assert.equal(isValidModelSelection("unknown-random-model"), false);
});

test("2. Profile Preferences: Selecting Lumen and Vulcan (Nova and Nebula are retired) never throws 'Choose a valid model.'", async (t) => {
  const base = await startTestServer(t);
  const userId = "test-user-model-contract";
  currentSessionUser = { id: userId, email: "user@test.local" };

  // Setup user and pro subscription in database
  await client.query("DELETE FROM user_profiles WHERE user_id = $1", [userId]);
  await client.query("DELETE FROM subscriptions WHERE user_id = $1", [userId]);
  await client.query(
    "INSERT INTO subscriptions (user_id, customer_id, subscription_id, tier, status, current_period_ends_at) VALUES ($1, 'cus_1', 'sub_1', 'pro', 'active', NOW() + INTERVAL '30 days')",
    [userId]
  );

  // PATCH lastUsedModel to nova
  const resNova = await fetch(`${base}/api/profile/last-used-model`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lastUsedModel: "vesper" }),
  });
  assert.equal(resNova.status, 200);
  const jsonNova = await resNova.json();
  assert.equal(jsonNova.lastUsedModel, "vesper");

  // PATCH preferences switching to Nova with full payload
  const resPrefNova = await fetch(`${base}/api/profile/preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lastUsedModel: "vesper", responseStyle: "balanced", thinkingEffort: "normal" }),
  });
  assert.equal(resPrefNova.status, 200);
  const jsonPrefNova = await resPrefNova.json();
  assert.equal(jsonPrefNova.lastUsedModel, "vesper");

  // Switch to Lumen
  const resLumen = await fetch(`${base}/api/profile/preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lastUsedModel: "lumen" }),
  });
  assert.equal(resLumen.status, 200);

  // Switch to Nebula
  const resNebula = await fetch(`${base}/api/profile/preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lastUsedModel: "lumen" }),
  });
  assert.equal(resNebula.status, 200);

  // Switch to Vulcan
  const resVesper = await fetch(`${base}/api/profile/preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lastUsedModel: "vesper" }),
  });
  assert.equal(resVesper.status, 200);

  // Switch back to Nova
  const resNovaBack = await fetch(`${base}/api/profile/preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lastUsedModel: "vesper" }),
  });
  assert.equal(resNovaBack.status, 200);
  const jsonBack = await resNovaBack.json();
  assert.equal(jsonBack.lastUsedModel, "vesper");

  // Retired third-party catalog models are refused for new preferences
  const resCatalog = await fetch(`${base}/api/profile/preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lastUsedModel: "claude-3-5-sonnet" }),
  });
  assert.equal(resCatalog.status, 400);

  // Unknown model is properly refused
  const resBad = await fetch(`${base}/api/profile/preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lastUsedModel: "not-a-valid-model" }),
  });
  assert.equal(resBad.status, 400);
  const jsonBad = await resBad.json();
  assert.equal(jsonBad.error, "Choose a valid model.");
});

test("3. Stale Database Values: Corrupt or retired values in DB do not block preference saves", async (t) => {
  const base = await startTestServer(t);
  const userId = "test-user-stale-fix";
  currentSessionUser = { id: userId, email: "stale@test.local" };

  // Insert a stale preference directly into database
  await client.query("DELETE FROM user_profiles WHERE user_id = $1", [userId]);
  await client.query(
    "INSERT INTO user_profiles (user_id, preferred_model, last_used_model, response_style) VALUES ($1, 'retired-legacy-model', 'unknown-model-xyz', 'balanced')",
    [userId]
  );

  // GET preferences returns null for invalid stored model
  const resGet = await fetch(`${base}/api/profile/preferences`);
  assert.equal(resGet.status, 200);
  const jsonGet = await resGet.json();
  assert.equal(jsonGet.preferredModel, null);
  assert.equal(jsonGet.lastUsedModel, null);

  // Saving a valid model (Vulcan) succeeds without 400
  const resPatch = await fetch(`${base}/api/profile/preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lastUsedModel: "vesper" }),
  });
  assert.equal(resPatch.status, 200);
  const jsonPatch = await resPatch.json();
  assert.equal(jsonPatch.lastUsedModel, "vesper");

  // A saved retired tier is not returned as a selection, and is named so the app asks for a model (nothing stored is rewritten).
  await client.query("UPDATE user_profiles SET preferred_model = 'nova' WHERE user_id = $1", [userId]);
  const retired = await (await fetch(`${base}/api/profile/preferences`)).json();
  assert.equal(retired.preferredModel, null);
  assert.equal(retired.retiredModel, "nova");
  assert.equal((await client.query("SELECT preferred_model FROM user_profiles WHERE user_id = $1", [userId])).rows[0].preferred_model, "nova");
});

test("4. Real Chat Execution: Streaming responses across Vulcan and Lumen (Nova and Nebula are retired) with tier switching", async (t) => {
  const base = await startTestServer(t);
  const userId = "test-user-chat-exec";
  currentSessionUser = { id: userId, email: "chatter@test.local" };

  await client.query("DELETE FROM user_profiles WHERE user_id = $1", [userId]);
  await client.query("DELETE FROM subscriptions WHERE user_id = $1", [userId]);
  await client.query(
    "INSERT INTO subscriptions (user_id, customer_id, subscription_id, tier, status, current_period_ends_at) VALUES ($1, 'cus_exec', 'sub_exec', 'pro', 'active', NOW() + INTERVAL '30 days')",
    [userId]
  );

  let conversationId = null;

  // Turn 1: Nova chat streaming
  const res1 = await fetch(`${base}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Hello Vulcan!", model: "vesper" }),
  });
  assert.equal(res1.status, 200);
  const events1 = parseSSEEvents(await res1.text());
  const errorEvents1 = events1.filter((e) => e.event === "error");
  assert.deepEqual(errorEvents1, [], "No error events during Nova stream");

  const complete1 = events1.find((e) => e.event === "complete")?.data;
  assert.ok(complete1, "Nova stream emitted complete event");
  assert.equal(complete1.reply, "Hello from VibhavGPT inference!");
  assert.equal(complete1.model, "VibhavGPT Vulcan");
  conversationId = complete1.conversationId;
  assert.ok(conversationId, "Conversation ID returned");

  // Turn 2: Follow-up on Lumen
  const res2 = await fetch(`${base}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, message: "What is your speed, Lumen?", model: "lumen" }),
  });
  assert.equal(res2.status, 200);
  const events2 = parseSSEEvents(await res2.text());
  assert.deepEqual(events2.filter((e) => e.event === "error"), []);
  const complete2 = events2.find((e) => e.event === "complete")?.data;
  assert.ok(complete2);
  assert.equal(complete2.model, "VibhavGPT Lumen");

  // Turn 3: Follow-up tier-switch to Nebula (with reasoning effort)
  const res3 = await fetch(`${base}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, message: "Think deep on this, Nebula.", model: "lumen", thinkingEffort: "high" }),
  });
  assert.equal(res3.status, 200);
  const events3 = parseSSEEvents(await res3.text());
  assert.deepEqual(events3.filter((e) => e.event === "error"), []);
  const complete3 = events3.find((e) => e.event === "complete")?.data;
  assert.ok(complete3);
  assert.equal(complete3.model, "VibhavGPT Lumen");

  // Turn 4: Follow-up tier-switch to Vulcan (Flagship reasoning)
  const res4 = await fetch(`${base}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, message: "Frontier problem for Vulcan.", model: "vesper", thinkingEffort: "high" }),
  });
  assert.equal(res4.status, 200);
  const events4 = parseSSEEvents(await res4.text());
  assert.deepEqual(events4.filter((e) => e.event === "error"), []);
  const complete4 = events4.find((e) => e.event === "complete")?.data;
  assert.ok(complete4);
  assert.equal(complete4.model, "VibhavGPT Vulcan");

  // Verify conversation persistence
  const resConv = await fetch(`${base}/api/chat/conversations/${conversationId}`);
  assert.equal(resConv.status, 200);
  const convData = await resConv.json();
  assert.equal(convData.history.length, 8); // 4 user + 4 assistant
});
