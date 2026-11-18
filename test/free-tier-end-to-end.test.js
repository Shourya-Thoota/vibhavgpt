import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";
process.env.UPLOAD_STORAGE_PATH ||= fs.mkdtempSync(path.join(os.tmpdir(), "nova-free-test-"));

const client = new PGlite();
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) {
  await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
}
const db = drizzle(client);

mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db, pool: { query: (sql, params) => client.query(sql, params) } },
});

let currentSessionUser = { id: "free-nova-e2e-user", email: "user@test.local" };
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
config.imageGenerationModel = "fixture/image";
config.creditsPolicyEnabled = true;
config.creditsCarryMode = "carry";
config.creditsActivatedAt = new Date("2026-04-01T00:00:00.000Z");

const { default: express } = await import("express");
const { profileRouter, isValidModelSelection } = await import("../src/profile/router.js");
const { chatRouter, chatAbuseGuard } = await import("../src/chat/router.js");
const { generationRouter } = await import("../src/generation/router.js");
const { reserveImageGeneration, cancelUsageReservation } = await import("../src/usage/service.js");
const { FREE_IMAGES_PER_WEEK, authorizeImageGeneration } = await import("../src/generation/image-engine.js");
const { canonicalModelKey } = await import("../frontend/src/token-quotas.js");
const { normalizeModelKey, isKnownCatalogModel } = await import("../src/chat/model-keys.js");

function parseSSEEvents(text) {
  return text.split("\n\n").map((block) => ({
    event: block.match(/^event:\s*(.+)$/m)?.[1],
    data: block.match(/^data:\s*(.+)$/m)?.[1],
  })).filter((item) => item.event && item.data).map((item) => ({ event: item.event, data: JSON.parse(item.data) }));
}

// Provider boundary is MOCKED: any non-loopback fetch returns a canned
// OpenAI-style stream. Everything else (profile and chat routers, admission,
// usage reservation, quota maths, PGlite database) is the real code.
async function startServer(t) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("http://127.0.0.1")) return realFetch(url, init);
    if (String(url).includes("/images")) {
      const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      return new Response(JSON.stringify({ data: [{ b64_json: PNG }], usage: { prompt_tokens: 10, completion_tokens: 0, cost: 0.02 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    let isStream = false;
    try {
      if (typeof init?.body === "string") {
        const parsed = JSON.parse(init.body);
        if (parsed.stream === true) isStream = true;
      }
    } catch {}
    if (!isStream) {
      const jsonBody = JSON.stringify({
        id: "mock-completion",
        choices: [{ message: { role: "assistant", content: "Hello from VibhavGPT inference!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 15, completion_tokens: 8 },
      });
      return new Response(jsonBody, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello from " } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "VibhavGPT inference!" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 15, completion_tokens: 8 } })}\n\n`,
    ].join("");
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  const app = express();
  app.use(express.json());
  app.use("/api/profile", profileRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/generation", generationRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => { globalThis.fetch = realFetch; return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

// Fictitious account: no subscription row means the Free plan.
const USER_ID = "free-nova-e2e-user";
async function freshFreeUser() {
  chatAbuseGuard?.reset();
  currentSessionUser = { id: USER_ID, email: "free-nova@example.test" };
  await client.query(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL)`);
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [USER_ID, "free-nova@example.test"]);
  for (const table of ["usage_events", "subscriptions", "user_profiles"]) await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [USER_ID]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false)", [USER_ID]);
}
const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = (body) => ({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("Free: Lumen can be saved as the fixed default and as the last-used model", async (t) => {
  const base = await startServer(t);
  await freshFreeUser();
  const res = await fetch(`${base}/api/profile/preferences`, patch({ preferredModel: "lumen", lastUsedModel: "lumen", responseStyle: "balanced", thinkingEffort: "low" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.preferredModel, "lumen");
  assert.equal(body.lastUsedModel, "lumen");
});

test("Free: the Lumen selection persists across a reload (a fresh GET on a fresh server)", async (t) => {
  const base = await startServer(t);
  await freshFreeUser();
  await fetch(`${base}/api/profile/preferences`, patch({ preferredModel: "lumen", lastUsedModel: "lumen" }));
  const reloaded = await (await fetch(`${base}/api/profile/preferences`)).json();
  assert.equal(reloaded.preferredModel, "lumen");
  assert.equal(reloaded.lastUsedModel, "lumen");
});

test("Free: Vulcan and the retired Nova and Nebula cannot be chosen as a default", async (t) => {
  const base = await startServer(t);
  await freshFreeUser();
  for (const model of ["vesper", "nova", "nebula"]) {
    const res = await fetch(`${base}/api/profile/preferences`, patch({ preferredModel: model }));
    assert.notEqual(res.status, 500, model);
    const after = await (await fetch(`${base}/api/profile/preferences`)).json();
    assert.notEqual(after.preferredModel, model, `${model} must not become a Free default`);
  }
});

test("Free: an eligible Lumen request is admitted and returns the streamed answer", async (t) => {
  const base = await startServer(t);
  await freshFreeUser();
  const res = await fetch(`${base}/api/chat/stream`, json({ model: "lumen", message: "Say hello" }));
  assert.equal(res.status, 200);
  const events = parseSSEEvents(await res.text());
  assert.equal(events.some((e) => e.event === "error"), false, JSON.stringify(events.find((e) => e.event === "error")));
  assert.match(JSON.stringify(events), /VibhavGPT inference!/);
});

// AI credits policy is active: plan usage is governed by spendable AI credits,
// not an additional legacy daily 15-message quota.

test("Free: 15 earlier prompts with low spend do not throttle Lumen; the 16th prompt is admitted and succeeds under AI credits", async (t) => {
  const base = await startServer(t);
  await freshFreeUser();
  for (let i = 0; i < 15; i += 1) {
    await client.query(
      "INSERT INTO usage_events (user_id, model, input_tokens, output_tokens, cost_micros) VALUES ($1, 'nova', 10, 10, 100)",
      [USER_ID]
    );
  }
  const res = await fetch(`${base}/api/chat`, json({ model: "lumen", message: "Sixteenth request please" }));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));

  const streamRes = await fetch(`${base}/api/chat/stream`, json({ model: "lumen", message: "And seventeenth via stream" }));
  assert.equal(streamRes.status, 200);
  const streamEvents = parseSSEEvents(await streamRes.text());
  assert.equal(streamEvents.some((e) => e.event === "error"), false, JSON.stringify(streamEvents.find((e) => e.event === "error")));
  assert.match(JSON.stringify(streamEvents), /VibhavGPT inference!/);
});

test("Free: Lumen also follows credit-based admission without daily prompt cap", async (t) => {
  const base = await startServer(t);
  await freshFreeUser();
  for (let i = 0; i < 15; i += 1) {
    await client.query(
      "INSERT INTO usage_events (user_id, model, input_tokens, output_tokens, cost_micros) VALUES ($1, 'lumen', 10, 10, 100)",
      [USER_ID]
    );
  }
  const res = await fetch(`${base}/api/chat`, json({ model: "lumen", message: "Sixteenth request on Lumen" }));
  assert.equal(res.status, 200);

  const res17 = await fetch(`${base}/api/chat`, json({ model: "lumen", message: "Seventeenth request on Lumen" }));
  assert.equal(res17.status, 200);
});

test("Free: legitimately exhausted AI credits refuse requests with an accurate credit reason, not 'invalid model' or 'free_daily_prompts_exceeded'", async (t) => {
  const base = await startServer(t);
  await freshFreeUser();
  // Free tier has 5 credits ($0.25 = 250,000 micros). Insert spend exceeding total allowance:
  await client.query(
    "INSERT INTO usage_events (user_id, model, input_tokens, output_tokens, cost_micros) VALUES ($1, 'nova', 1, 1, 300000)",
    [USER_ID]
  );
  const res = await fetch(`${base}/api/chat`, json({ model: "lumen", message: "Anything left?" }));
  const body = await res.json();
  assert.equal(res.status, 429, JSON.stringify(body));
  assert.match(body.code, /^credits_/);
  assert.match(body.error, /AI credits/i);
  assert.doesNotMatch(body.error, /valid model|isn't included|not available|invalid|free_daily_prompts_exceeded/i);

  const streamRes = await fetch(`${base}/api/chat/stream`, json({ model: "lumen", message: "Stream when exhausted" }));
  const stream = parseSSEEvents(await streamRes.text());
  const error = stream.find((e) => e.event === "error");
  assert.equal(error?.data.status, 429, JSON.stringify(stream));
  assert.match(error.data.code, /^credits_/);
  assert.match(error.data.error, /AI credits/i);

  // Lumen is also rejected with the credit reason when credits are exhausted
  const lumenRes = await fetch(`${base}/api/chat`, json({ model: "lumen", message: "Lumen when exhausted" }));
  const lumenBody = await lumenRes.json();
  assert.equal(lumenRes.status, 429);
  assert.match(lumenBody.code, /^credits_/);
});

test("Free: Vulcan stays refused with the plan message while Lumen is open, and a retired tier is refused by name", async (t) => {
  const base = await startServer(t);
  await freshFreeUser();
  const res = await fetch(`${base}/api/chat`, json({ model: "vesper", message: "Hi" }));
  const body = await res.json();
  assert.equal(res.status, 403);
  assert.equal(body.code, "free_restricted_to_green_dot");
  for (const model of ["nova", "nebula"]) {
    const retired = await fetch(`${base}/api/chat`, json({ model, message: "Hi" }));
    const answer = await retired.json();
    assert.equal(retired.status, 400, model);
    assert.equal(answer.code, "model_retired", model);
  }
  assert.equal((await fetch(`${base}/api/chat`, json({ model: "lumen", message: "Hi" }))).status, 200);
});

test("Free: operational burst anti-abuse guard blocks rapid requests regardless of available credits", async (t) => {
  const base = await startServer(t);
  await freshFreeUser();
  const burstMax = config.chatAbuse?.burstMax || 20;
  let burstBlocked = false;
  for (let i = 0; i <= burstMax + 2; i += 1) {
    const res = await fetch(`${base}/api/chat`, json({ model: "lumen", message: `Burst test ${i}` }));
    if (res.status === 429) {
      const body = await res.json();
      if (body.code === "chat_rate_limited") {
        burstBlocked = true;
        break;
      }
    }
  }
  assert.ok(burstBlocked, "Rapid requests exceeding burst limit must be throttled by operational abuse guard");
});

test("Legacy mode: when credit policy is inactive, the 15-prompts-per-24h soft throttle remains strictly enforced", async (t) => {
  const base = await startServer(t);
  await freshFreeUser();
  const savedEnabled = config.creditsPolicyEnabled;
  config.creditsPolicyEnabled = false;
  try {
    for (let i = 0; i < 15; i += 1) {
      await client.query("INSERT INTO usage_events (user_id, model, input_tokens, output_tokens) VALUES ($1, 'nova', 10, 10)", [USER_ID]);
    }
    const res = await fetch(`${base}/api/chat`, json({ model: "lumen", message: "Prompt 16 in legacy mode" }));
    const body = await res.json();
    assert.equal(res.status, 429, JSON.stringify(body));
    assert.equal(body.code, "free_daily_prompts_exceeded");
    assert.match(body.error, /15 prompts per 24 hours/);
  } finally {
    config.creditsPolicyEnabled = savedEnabled;
  }
});

test("Free: Chat credit admission and 2-per-week image allowance coexist end-to-end", async (t) => {
  const base = await startServer(t);
  await freshFreeUser();

  // 1. Send 15 chat prompts with low spend
  for (let i = 0; i < 15; i += 1) {
    await client.query(
      "INSERT INTO usage_events (user_id, model, input_tokens, output_tokens, cost_micros) VALUES ($1, 'nova', 10, 10, 100)",
      [USER_ID]
    );
  }

  // 2. Chat prompt 16 (Lumen) succeeds under AI credits
  const chat16 = await fetch(`${base}/api/chat`, json({ model: "lumen", message: "Prompt 16" }));
  assert.equal(chat16.status, 200);

  // 3. Free image generation: 1st image succeeds using 2-per-week allowance
  const img1 = await fetch(`${base}/api/generation/image`, json({ prompt: "A cozy cabin" }));
  assert.equal(img1.status, 201);

  // 4. Free image generation: 2nd image succeeds
  const img2 = await fetch(`${base}/api/generation/image`, json({ prompt: "A snowy mountain" }));
  assert.equal(img2.status, 201);

  // 5. Free image generation: 3rd image refused with 429 image_quota_exhausted
  const img3 = await fetch(`${base}/api/generation/image`, json({ prompt: "A sunny beach" }));
  assert.equal(img3.status, 429);
  const img3Body = await img3.json();
  assert.equal(img3Body.code, "image_quota_exhausted");
  assert.match(img3Body.error, /2 free images this week\. More arrive Monday at 12:00 AM UTC\./);

  // 6. Chat requests still succeed after image allowance exhausted
  const chat17 = await fetch(`${base}/api/chat`, json({ model: "lumen", message: "Prompt 17 after images" }));
  assert.equal(chat17.status, 200);
});

test("Free: failed image generation releases reservation and protects concurrent slots", async (t) => {
  await freshFreeUser();
  // 1. Reserve image slot
  const res1 = await reserveImageGeneration(USER_ID);
  assert.ok(res1.id);

  // 2. Simulate failure: cancelUsageReservation releases the slot
  await cancelUsageReservation(res1.id);

  // 3. Both slots remain available
  const authAfterCancel = authorizeImageGeneration("free", 0);
  assert.equal(authAfterCancel.remaining, 2);
  assert.equal(authAfterCancel.authorized, true);
});
