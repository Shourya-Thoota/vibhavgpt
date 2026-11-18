// Build and VibhavGPT Tecton (owner request, 2026-11-14) through the REAL chat router, over a real Postgres (PGlite). Doubles: the session (a
// header picks the synthetic person) and the model upstream (a scripted fetch that records each request body). Checks: Free and Plus are
// refused before any inference or charge; Pro and Max reach the one pinned host with no fallbacks and no data collection; the request never
// carries tools; the route stays closed until its host's policy is verified; and no vendor name reaches the person.
import test, { mock, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db: drizzle(client), pool: { query: (sql, params) => client.query(sql, params) } },
});
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => (req.authSession ? next() : res.status(401).json({ error: "Sign in is required." })),
    loadOptionalSession: (_req, _res, next) => next(),
  },
});
const { config, TECTON_MODEL } = await import("../src/config.js");
config.moderationApiKey = "";
config.providerKeys.primaryFree = "";
config.providerKeys.paid = "fixture-key";
// The router's own address, as in production: only a route on it can be verified, so the strict gate is the real one here.
config.providerBaseUrls.paid = "https://openrouter.ai/api/v1";
const { resetRoutePolicyStateForTests } = await import("../src/chat/route-policy-guard.js");
const { getModelConfig } = await import("../src/chat/providers.js");
const { chatRouter } = await import("../src/chat/router.js");
const { default: express } = await import("express");

const encoder = new TextEncoder();
const answer = (text) => new Response(new ReadableStream({ start(c) {
  c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
  c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 12 } })}\n\n`));
  c.close();
} }), { headers: { "Content-Type": "text/event-stream" } });
const bodies = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.startsWith(config.providerBaseUrls.paid)) {
    if (href.includes("/generation")) return new Response("{}", { status: 404 });
    bodies.push(JSON.parse(init.body));
    return answer("```html\n<!doctype html><title>Timer</title>\n```\nOpen the file in a browser.");
  }
  if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
  throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
};

const verifyRoute = () => resetRoutePolicyStateForTests("tecton", {
  status: "verified", reason: "verified", model: TECTON_MODEL, hosts: "cloudflare", checkedAt: Date.now(),
  evidence: { endpoint: { provider_name: "Cloudflare", supported_parameters: ["max_tokens", "temperature"] }, dataPolicy: { training: false, retainsPrompts: false, safetyRetention: false } },
  allowedHosts: ["cloudflare"], positiveEvidence: false,
});

const PLANS = { free: null, plus: "plus", pro: "pro", max: "max" };
for (const [user, tier] of Object.entries(PLANS)) {
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [user]);
  if (tier) await client.query("INSERT INTO subscriptions (user_id, subscription_id, tier, status, current_period_ends_at) VALUES ($1, $2, $3, 'active', now() + interval '20 days')", [user, `sub_${user}`, tier]);
}
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authSession = { user: { id: req.get("x-test-user") } }; next(); });
app.use("/api/chat", chatRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function build(user, message = "Build me a small timer page") {
  const response = await realFetch(`${baseUrl}/api/chat/stream`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-test-user": user }, body: JSON.stringify({ message, model: "tecton", mode: "build" }),
  });
  const text = await response.text();
  return text.split("\n\n").map((block) => ({ event: block.match(/^event:\s*(.+)$/m)?.[1], data: block.match(/^data:\s*(.+)$/m)?.[1] })).filter((e) => e.event && e.data).map((e) => ({ event: e.event, data: JSON.parse(e.data) }));
}
const usage = async (user) => (await client.query("SELECT count(*)::int AS n FROM usage_events WHERE user_id = $1", [user])).rows[0].n;

beforeEach(() => { bodies.length = 0; resetRoutePolicyStateForTests(); verifyRoute(); });
after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await client.close();
});

test("Tecton's route is the one coder engine on Cloudflare only: pinned, no fallbacks, no data collection, no tools", () => {
  const [entry] = getModelConfig("tecton").chain;
  assert.equal(entry.model, "qwen/qwen-2.5-coder-32b-instruct");
  assert.deepEqual(entry.providerRouting, { order: ["cloudflare"], only: ["cloudflare"], allow_fallbacks: false, data_collection: "deny" });
  assert.equal(entry.supportsTools, false);
  assert.equal(getModelConfig("tecton").chain.length, 1, "no second route to fall back to");
  assert.equal(getModelConfig("tecton").displayName, "VibhavGPT Tecton");
});

for (const user of ["free", "plus"]) {
  test(`${user}: Build is refused before any inference or charge, and says Pro or Max`, async () => {
    const before = await usage(user);
    const events = await build(user);
    const error = events.find((e) => e.event === "error");
    assert.ok(error, "an error, not a reply");
    assert.equal(error.data.code, "tecton_pro_required");
    assert.match(error.data.error, /Pro or Max/);
    assert.equal(bodies.length, 0, "no inference");
    assert.equal(await usage(user), before, "nothing charged");
  });
}

for (const user of ["pro", "max"]) {
  test(`${user}: Build reaches Tecton's pinned host, the request carries no tools, and no vendor name is shown`, async () => {
    const events = await build(user);
    const complete = events.find((e) => e.event === "complete");
    assert.ok(complete, JSON.stringify(events.filter((e) => e.event === "error")));
    assert.equal(bodies.length, 1);
    const [body] = bodies;
    assert.equal(body.model, "qwen/qwen-2.5-coder-32b-instruct");
    assert.deepEqual(body.provider, { order: ["cloudflare"], only: ["cloudflare"], allow_fallbacks: false, data_collection: "deny" });
    assert.equal("tools" in body, false, "no tools");
    assert.equal("tool_choice" in body, false, "no tool_choice");
    assert.equal(complete.data.model, "VibhavGPT Tecton");
    assert.doesNotMatch(JSON.stringify(complete.data), /qwen|cloudflare|openrouter/i, "no vendor name reaches the person");
  });
}

test("the route stays closed until its host's policy is verified: nothing is sent", async () => {
  resetRoutePolicyStateForTests();
  const events = await build("max");
  assert.equal(events.some((e) => e.event === "complete"), false);
  assert.equal(bodies.length, 0, "an unverified host is never called");
});

test("a long Build conversation: instructions and the latest request are sent whole, older turns are summarized, and the reply says so", async () => {
  const { rows: [conversation] } = await client.query("INSERT INTO conversations (user_id, title, model, mode) VALUES ('max', 'Big project', 'tecton', 'build') RETURNING id");
  // An early requirement, then far more history than the context holds.
  const filler = "Here is a long block of earlier discussion about layout, colours and data. ".repeat(160);
  await client.query("INSERT INTO messages (conversation_id, role, content, created_at) VALUES ($1, 'user', 'Requirement: the app must work offline.', now() - interval '2 hours')", [conversation.id]);
  for (let i = 0; i < 12; i += 1) {
    await client.query("INSERT INTO messages (conversation_id, role, content, created_at) VALUES ($1, $2, $3, now() - interval '1 hour' + ($4 || ' seconds')::interval)", [conversation.id, i % 2 ? "assistant" : "user", `${filler} (${i})`, String(i * 10)]);
  }
  const response = await realFetch(`${baseUrl}/api/chat/stream`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-test-user": "max" },
    body: JSON.stringify({ message: "Now add a settings screen.", model: "tecton", mode: "build", conversationId: conversation.id }),
  });
  const text = await response.text();
  const complete = text.split("\n\n").find((block) => /^event: complete$/m.test(block));
  assert.ok(complete, text.slice(0, 400));
  assert.equal(JSON.parse(complete.match(/^data: (.+)$/m)[1]).contextReduced, true, "the person is told");
  const [body] = bodies;
  assert.equal(body.messages.at(-1).role, "user");
  assert.match(body.messages.at(-1).content, /Now add a settings screen\./, "the latest request, whole");
  assert.equal(body.messages[0].role, "system", "instructions first");
  assert.ok(Math.ceil(Buffer.byteLength(JSON.stringify(body.messages)) / 3) <= 32_768, "fits the engine's window");
  assert.ok(body.max_tokens >= 256, "room left for the reply");
});

test("a complimentary account (no subscription row, listed by email) can use Build", async () => {
  const { parseCompPlanAccounts } = await import("../src/config.js");
  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL)`);
  await client.query(`INSERT INTO "user" (id, email) VALUES ('comp', 'comp-owner@example.com') ON CONFLICT DO NOTHING`);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ('comp', false) ON CONFLICT DO NOTHING");
  const before = config.compPlanAccounts;
  config.compPlanAccounts = parseCompPlanAccounts("comp-owner@example.com");
  try {
    const events = await build("comp");
    assert.ok(events.some((e) => e.event === "complete"), JSON.stringify(events.filter((e) => e.event === "error")));
    assert.equal(bodies.length, 1);
  } finally {
    config.compPlanAccounts = before;
  }
});

test("when the host fails, nothing falls back: every try is the same engine on the same pinned host, and the person gets an error", async () => {
  const previous = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith(config.providerBaseUrls.paid) && !href.includes("/generation")) {
      seen.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), { status: 503, headers: { "Content-Type": "application/json" } });
    }
    return previous(url, init);
  };
  try {
    const events = await build("pro");
    assert.equal(events.some((e) => e.event === "complete"), false);
    assert.ok(events.some((e) => e.event === "error"), "the failure is reported");
    assert.ok(seen.length >= 1);
    for (const body of seen) {
      assert.equal(body.model, "qwen/qwen-2.5-coder-32b-instruct", "no other engine");
      assert.deepEqual(body.provider, { order: ["cloudflare"], only: ["cloudflare"], allow_fallbacks: false, data_collection: "deny" }, "no other host");
      assert.equal("tools" in body, false);
    }
  } finally {
    globalThis.fetch = previous;
  }
});

// Build conversations have their own stored mode (drizzle/0051), so Build history is kept apart by what is stored.
const errorCode = async (response) => {
  const block = (await response.text()).split("\n\n").find((b) => /^event: error$/m.test(b));
  return block ? JSON.parse(block.match(/^data: (.+)$/m)[1]).code : null;
};
const post = (user, body) => realFetch(`${baseUrl}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json", "x-test-user": user }, body: JSON.stringify(body) });

test("Tecton answers only in Build, and a Build conversation is answered only by Tecton", async () => {
  assert.equal(await errorCode(await post("max", { message: "Build me a page", model: "tecton", mode: "chat" })), "tecton_requires_build");
  const { rows: [build] } = await client.query("INSERT INTO conversations (user_id, title, model, mode) VALUES ('max', 'A build', 'tecton', 'build') RETURNING id");
  assert.equal(await errorCode(await post("max", { message: "Hello", model: "lumen", mode: "chat", conversationId: build.id })), "build_requires_tecton", "the stored mode wins over the request");
  assert.equal(bodies.length, 0, "neither reached the engine");
});

test("a new Build conversation is stored as a build, with Tecton as its model", async () => {
  const events = await build("pro", "Make a landing page");
  const saved = events.find((e) => e.event === "complete")?.data?.conversationId ?? events.find((e) => e.event === "conversation")?.data?.conversationId;
  assert.ok(saved, JSON.stringify(events.filter((e) => e.event === "error")));
  const { rows: [row] } = await client.query("SELECT mode, model FROM conversations WHERE id = $1", [saved]);
  assert.deepEqual(row, { mode: "build", model: "tecton" });
});

test("after a downgrade the build stays readable by its owner only, and continuing it is refused before any inference", async () => {
  const { rows: [build] } = await client.query("INSERT INTO conversations (user_id, title, model, mode) VALUES ('plus', 'Old build', 'tecton', 'build') RETURNING id");
  await client.query("INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'Make a page'), ($1, 'assistant', 'Here it is.')", [build.id]);
  const read = await realFetch(`${baseUrl}/api/chat/conversations/${build.id}`, { headers: { "x-test-user": "plus" } });
  assert.equal(read.status, 200, "the owner can still read it");
  assert.equal((await read.json()).history.length, 2);
  const stranger = await realFetch(`${baseUrl}/api/chat/conversations/${build.id}`, { headers: { "x-test-user": "pro" } });
  assert.equal(stranger.status, 404, "nobody else can");
  assert.equal(await errorCode(await post("plus", { message: "Add a footer", model: "tecton", mode: "build", conversationId: build.id })), "tecton_pro_required");
  assert.equal(bodies.length, 0);
});

test("the migration moves only chat-mode Tecton conversations to Build, and nothing else", async () => {
  const sql = await readFile(new URL("../drizzle/0051_build_conversations.sql", import.meta.url), "utf8");
  assert.match(sql, /UPDATE "conversations" SET "mode" = 'build' WHERE "mode" = 'chat' AND lower\(btrim\("model"\)\) = 'tecton';/);
  assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /\b(DELETE|DROP|TRUNCATE|INSERT)\b/i);
  const scratch = new PGlite();
  for (const entry of journal.entries.filter((e) => e.tag < "0051")) await scratch.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  await scratch.query("INSERT INTO conversations (user_id, title, model, mode) VALUES ('u', 'build', 'tecton', 'chat'), ('u', 'chat', 'lumen', 'chat'), ('u', 'study', 'study', 'study'), ('u', 'spaced', ' Tecton ', 'chat')");
  await scratch.exec(sql);
  const { rows } = await scratch.query("SELECT title, mode FROM conversations ORDER BY title");
  assert.deepEqual(rows, [{ title: "build", mode: "build" }, { title: "chat", mode: "chat" }, { title: "spaced", mode: "build" }, { title: "study", mode: "study" }]);
  await scratch.close();
});

test("a Build request that names a file type goes to Tecton and its project, never to the document or image shortcut", async () => {
  verifyRoute();
  for (const message of [
    "Build a tiny counter page: a heading \"Live test\", a number starting at 0, and a button that adds 1. Plain HTML, CSS and JS, under 40 lines in total.",
    "Create a landing page and export it as an HTML file",
    "Make an image gallery page with a picture of a sunset placeholder",
  ]) {
    bodies.length = 0;
    const response = await realFetch(`${baseUrl}/api/chat/stream`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-test-user": "max" },
      body: JSON.stringify({ message, model: "tecton", mode: "build" }),
    });
    const text = await response.text();
    const complete = text.split("\n\n").find((block) => /^event: complete$/m.test(block));
    assert.ok(complete, text.slice(0, 300));
    const done = JSON.parse(complete.match(/^data: (.+)$/m)[1]);
    assert.equal(bodies.length, 1, `${message}: one Tecton request`);
    assert.equal(bodies[0].model, TECTON_MODEL, "Tecton wrote it");
    assert.equal(done.modelKey, "tecton", "the reply is Tecton's");
    assert.equal(done.attachment ?? null, null, "not a generated document or image");
  }
});
