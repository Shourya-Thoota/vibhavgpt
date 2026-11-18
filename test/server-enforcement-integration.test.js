import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

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
const { generationRouter } = await import("../src/generation/router.js");

config.moderationApiKey = "";
config.providerKeys.primaryFree = "fixture-key";
config.providerKeys.paid = "fixture-key";
config.chatModels.nova = "fixture/nova-model";
config.chatModels.lumen = "fixture/lumen-model";

const PERIOD_START = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
const PERIOD_END = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);

async function addUser(userId, tier = "free") {
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, `${userId}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
  if (tier !== "free") {
    await db.insert(schema.subscriptions).values({
      userId,
      tier,
      status: "active",
      currentPeriodStartedAt: PERIOD_START,
      currentPeriodEndsAt: PERIOD_END,
    });
  }
}

async function serve(t, userId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/chat", chatRouter);
  app.use("/api/generation", generationRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}` };
}

const parseSseEvents = (text) => text.split("\n\n").map((block) => ({
  event: block.match(/^event:\s*(.+)$/m)?.[1], data: block.match(/^data:\s*(.+)$/m)?.[1],
})).filter((item) => item.event && item.data).map((item) => ({ event: item.event, data: JSON.parse(item.data) }));

test("Server Enforcement: Free tier user out of this week's 2 images gets HTTP 429 image_quota_exhausted", async (t) => {
  await addUser("free-user-1", "free");
  for (let i = 0; i < 2; i++) await db.insert(schema.usageEvents).values({ userId: "free-user-1", model: "__image__", createdAt: new Date() });
  const { base } = await serve(t, "free-user-1");

  const res = await fetch(`${base}/api/generation/image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "A watercolor landscape" }),
  });

  assert.equal(res.status, 429);
  const payload = await res.json();
  assert.equal(payload.code, "image_quota_exhausted");
  assert.equal(payload.error, "You've used your 2 free images this week. More arrive Monday at 12:00 AM UTC.");
});

test("Server Enforcement: Plus user image quota exhaustion triggers HTTP 429 image_quota_exhausted", async (t) => {
  await addUser("plus-exhausted-user", "plus");

  // Seed 100 image usage events for the current billing period
  for (let i = 0; i < 100; i++) {
    await db.insert(schema.usageEvents).values({
      userId: "plus-exhausted-user",
      model: "__image__",
      createdAt: new Date(),
    });
  }

  const { base } = await serve(t, "plus-exhausted-user");

  const res = await fetch(`${base}/api/generation/image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "A sunset painting" }),
  });

  assert.equal(res.status, 429);
  const payload = await res.json();
  assert.equal(payload.code, "image_quota_exhausted");
  assert.match(payload.error, /used all 100 images included with your plan/i);
  assert.match(payload.error, /can't buy extra images/i);
});

test("Server Enforcement: Plus user is strictly forbidden from executing Extra High models (mu > 7.00)", async (t) => {
  await addUser("plus-user-2", "plus");
  const { base } = await serve(t, "plus-user-2");

  // Non-streaming endpoint
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-gpt-6-astra",
      message: "Explain quantum electrodynamics in depth",
    }),
  });

  assert.equal(res.status, 403);
  const payload = await res.json();
  assert.equal(payload.code, "plus_forbidden_extra_high");
  assert.match(payload.error, /Plus tier subscriptions do not include Extra High \(Red Dot\) compute models/);

  // Streaming SSE endpoint
  const sseRes = await fetch(`${base}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-gpt-6-astra",
      message: "Explain quantum electrodynamics in depth",
    }),
  });
  assert.equal(sseRes.status, 200);
  const events = parseSseEvents(await sseRes.text());
  const errorEvent = events.find((e) => e.event === "error");
  assert.ok(errorEvent);
  assert.equal(errorEvent.data.status, 403);
  assert.equal(errorEvent.data.code, "plus_forbidden_extra_high");
});

test("Server Enforcement: Free tier user is restricted entirely to Green Dot models (mu <= 1.00)", async (t) => {
  await addUser("free-user-2", "free");
  const { base } = await serve(t, "free-user-2");

  // Non-streaming endpoint
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-gpt-6.1-terra",
      message: "Help me debug this javascript",
    }),
  });

  assert.equal(res.status, 403);
  const payload = await res.json();
  assert.equal(payload.code, "free_restricted_to_green_dot");
  assert.match(payload.error, /Free tier accounts are restricted entirely to Green Dot \(Low consumption\) models/);

  // Streaming SSE endpoint
  const sseRes = await fetch(`${base}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-gpt-6.1-terra",
      message: "Help me debug this javascript",
    }),
  });
  assert.equal(sseRes.status, 200);
  const events = parseSseEvents(await sseRes.text());
  const errorEvent = events.find((e) => e.event === "error");
  assert.ok(errorEvent);
  assert.equal(errorEvent.data.status, 403);
  assert.equal(errorEvent.data.code, "free_restricted_to_green_dot");
});

test("Server Enforcement: Free tier user in chat is refused a natural language image once the week's 2 are used", async (t) => {
  await addUser("free-user-3", "free");
  for (let i = 0; i < 2; i++) await db.insert(schema.usageEvents).values({ userId: "free-user-3", model: "__image__", createdAt: new Date() });
  const { base } = await serve(t, "free-user-3");

  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "lumen",
      message: "Generate an image of a red cat on a bicycle",
    }),
  });

  assert.equal(res.status, 429);
  const payload = await res.json();
  assert.equal(payload.code, "image_quota_exhausted");
});
