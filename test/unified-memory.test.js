/**
 * Slice 3.5, unified memory (owner decision): one personal memory pool for every tier in every chat. A memory saved during a Vulcan turn
 * is an ordinary personal memory that Lumen, Nova, Nebula, Study and Vulcan all receive. The privacy boundary that must hold: nothing from
 * a Vulcan conversation is sent to the separate background-extraction route. Vulcan saves only through its own save tool, which it
 * calls inside its own request on its own route; the save itself is a database write that no other model sees.
 *
 * Real /api/chat/stream and /api/memory routes on an isolated database. Every upstream is a scripted stand-in that records what it was
 * sent: the paid route (Nova, Nebula, Vulcan), the primary route (Lumen chat, and background extraction, told apart by model), and the
 * Study route. Synthetic users and facts only. This checks what the server sends and saves, never how a real model behaves.
 */
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
mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db: drizzle(client), pool: { query: (sql, params) => client.query(sql, params) } },
});
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => (req.authSession ? next() : res.status(401).json({ error: "Sign in is required." })),
    loadOptionalSession: (_req, _res, next) => next(),
  },
});

const { config } = await import("../src/config.js");
config.moderationApiKey = "";
config.providerKeys.paid = "fixture-key";
Object.assign(config.chatModels, { study: "fixture-study" });
// Nova and Nebula were retired on 2026-11-14. Nova's turns (the tool-capable default) run on Vulcan over the router, and Nebula's on
// Lumen's production route type (the router's paid zero-retention route), both with fixture engines.
config.chatModels.vesper = "fixture-vesper";
config.vesperTransport = "router";
config.lumenChatRoute = "paid-zdr";
config.lumenPaidZdrProviders = ["route-b"];
config.chatModels.lumenFallback1 = "fixture-lumen";
config.vesperTransport = "router";
const PRIMARY_BASE = "http://primary.fixture.invalid/v1";
const STUDY_BASE = "http://study.fixture.invalid/v1";
config.providerKeys.primaryFree = "fixture-primary-key";
config.providerBaseUrls.primaryFree = PRIMARY_BASE;
config.lumenPrimaryApproved = true;
config.memoryExtractionModel = "fixture-extractor";
config.providerKeys.study = "fixture-study-key";
config.providerBaseUrls.study = STUDY_BASE;
// Lumen chat as in production (Slice 4): the router's pinned free endpoint, verified by the live policy guard against the golden fixture.
const GATEWAY_MODEL = "google/gemma-4-31b-it:free";
config.chatModels.lumenFallback1 = GATEWAY_MODEL;
config.lumenApprovals.gateway = { approved: true, model: GATEWAY_MODEL };
config.lumenGatewayProvider = "Google AI Studio";
config.lumenChatRoute = "gateway";
{
  const { verifyLumenGatewayPolicy } = await import("../src/chat/lumen-gateway-guard.js");
  const endpoints = await readFile(new URL("./fixtures/lumen-gateway/endpoints.json", import.meta.url), "utf8");
  const page = await readFile(new URL("./fixtures/lumen-gateway/providers-page.html", import.meta.url), "utf8");
  const fixtureFetch = async (url) => (String(url).endsWith("/endpoints") ? new Response(endpoints, { headers: { "Content-Type": "application/json" } }) : new Response(page));
  const verified = await verifyLumenGatewayPolicy({ model: GATEWAY_MODEL, provider: "Google AI Studio", fetchImpl: fixtureFetch, log: { info() {}, warn() {} } });
  if (!verified.ok) throw new Error(`fixture policy did not verify: ${verified.reason}`);
}

const VESPER_SENTINEL = "VESPER-ONLY-SENTINEL";
const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const usage = { prompt_tokens: 40, completion_tokens: 12 };
const sseText = (text) => new Response([
  ...text.split(/(?<= )/).map((content) => frame({ choices: [{ delta: { content } }] })),
  frame({ choices: [{ delta: {}, finish_reason: "stop" }], usage }),
].join(""), { headers: { "Content-Type": "text/event-stream" } });
const sseTool = (name, args) => new Response([
  frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_fixture_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }),
  frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage }),
].join(""), { headers: { "Content-Type": "text/event-stream" } });

const upstream = [];
const extractions = [];
let scriptedTool = null;
const realFetch = globalThis.fetch;
function reply(body, route) {
  upstream.push({ route, body });
  const alreadyCalled = (body.messages ?? []).some((m) => m.role === "tool");
  if (scriptedTool && !alreadyCalled && Array.isArray(body.tools) && body.tools.length) {
    const { name, args } = scriptedTool;
    scriptedTool = null;
    return sseTool(name, args);
  }
  // Vulcan's reply carries a sentinel, so a test can see whether Vulcan content ever reaches another route.
  const text = body.model === "fixture-vesper" ? `Reply from Vulcan ${VESPER_SENTINEL}.` : `Reply from ${body.model}.`;
  if (body.stream === false || body.stream === undefined) return Response.json({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage });
  return sseText(text);
}
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.startsWith(PRIMARY_BASE)) {
    const body = JSON.parse(init.body);
    // Background extraction and Lumen chat share the primary route; the configured model tells them apart.
    if (body.model === config.memoryExtractionModel) {
      extractions.push(body);
      return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify({ facts: [], supersededFacts: [] }) } }], usage });
    }
    return reply(body, "primary");
  }
  if (href.startsWith(STUDY_BASE)) return reply(JSON.parse(init.body), "study");
  if (href.startsWith(config.providerBaseUrls.paid)) {
    if (href.includes("/generation")) return new Response("{}", { status: 404 });
    return reply(JSON.parse(init.body), "paid");
  }
  if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
  throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
};

const { default: express } = await import("express");
const { chatRouter } = await import("../src/chat/router.js");
const { memoryRouter } = await import("../src/memory/router.js");
let signedIn = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { if (signedIn) req.authSession = { user: { id: signedIn } }; next(); });
app.use("/api/chat", chatRouter);
app.use("/api/memory", memoryRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const base = () => `http://127.0.0.1:${server.address().port}`;
test.after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  await client.close();
});

let n = 0;
async function person() {
  const id = `unified-user-${++n}`;
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, `${id}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
  await client.query("INSERT INTO subscriptions (user_id, tier, status, current_period_started_at, current_period_ends_at, billing_source) VALUES ($1, 'max', 'active', now() - interval '5 days', now() + interval '25 days', 'stripe')", [id]);
  return id;
}
async function call(userId, method, path, body) {
  signedIn = userId;
  const response = await realFetch(`${base()}${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: response.status, json };
}
async function say(userId, body) {
  signedIn = userId;
  const before = upstream.length;
  const extractionsBefore = extractions.length;
  const response = await realFetch(`${base()}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "vesper", ...body }) });
  const raw = await response.text();
  const events = raw.split("\n\n").map((b) => ({ event: b.match(/^event:\s*(.+)$/m)?.[1], data: b.match(/^data:\s*(.+)$/m)?.[1] })).filter((e) => e.event && e.data).map((e) => ({ event: e.event, data: JSON.parse(e.data) }));
  await new Promise((resolve) => setTimeout(resolve, 60)); // background extraction is fire-and-forget
  const sent = upstream.slice(before);
  return {
    error: events.find((e) => e.event === "error")?.data,
    done: events.find((e) => e.event === "complete")?.data,
    sent,
    sentText: sent.map((s) => JSON.stringify(s.body.messages ?? s.body.input ?? "")).join("\n"),
    extractionCalls: extractions.length - extractionsBefore,
  };
}
const facts = async (userId) => (await client.query("SELECT * FROM memory_facts WHERE user_id = $1 ORDER BY created_at", [userId])).rows;
const remembered = (turn, pattern) => pattern.test(turn.sentText.split("Remembered facts about the user")[1] ?? "");

async function vesperSaves(userId, content, extra = {}) {
  scriptedTool = { name: "save_memory", args: { action: "create", content, category: "preferences" } };
  const turn = await say(userId, { model: "vesper", message: `Remember this: ${content.replace(/^User's /, "my ")}`, ...extra });
  assert.equal(turn.error, undefined, JSON.stringify(turn.error));
  return turn;
}

test("a memory saved during a Vulcan turn is an ordinary personal memory: Lumen, Nova, Nebula, Study and Vulcan all receive it", async () => {
  const a = await person();
  const saved = await vesperSaves(a, "User's preferred test notebook brand is Kelvinfold.");
  const [fact] = await facts(a);
  assert.ok(fact, "it was saved");
  assert.equal(fact.scope, "personal");
  assert.equal(fact.project_id, null);
  assert.equal(fact.origin, "explicit");
  assert.equal(fact.source_conversation_id, saved.done.conversationId);
  for (const turn of [
    await say(a, { model: "lumen", message: "What notebook brand do I like?" }),
    await say(a, { model: "vesper", message: "What notebook brand do I like?" }),
    await say(a, { model: "lumen", message: "What notebook brand do I like?" }),
    await say(a, { mode: "study", message: "Quiz me on my notes." }),
    await say(a, { model: "vesper", message: "What notebook brand do I like?" }),
  ]) {
    assert.equal(turn.error, undefined, JSON.stringify(turn.error));
    assert.ok(turn.sent.length > 0, "a model was called");
    assert.ok(remembered(turn, /Kelvinfold/), `the ${turn.sent[0].body.model} request carries the Vulcan-saved memory`);
  }
});

test("the Vulcan save happens inside Vulcan's own request, on its route, with its privacy flags; no other route is called", async () => {
  const a = await person();
  const turn = await vesperSaves(a, "User's preferred test pasta is orzo.");
  assert.ok(turn.sent.length >= 2, "the tool step and the answer");
  for (const { route, body } of turn.sent) {
    assert.equal(route, "paid", "only the paid route is called");
    assert.equal(body.model, "fixture-vesper", "only Vulcan is called");
    assert.deepEqual(body.provider, { allow_fallbacks: false, data_collection: "deny" }, "Vulcan's route flags are unchanged");
  }
  assert.equal(turn.extractionCalls, 0, "nothing is sent to background extraction");
});

test("nothing from a Vulcan conversation ever reaches background extraction, even when the person asks to remember, on any later tier", async () => {
  const a = await person();
  const first = await say(a, { model: "vesper", message: `Remember that my ${VESPER_SENTINEL} code is in this Vulcan chat.` });
  assert.equal(first.extractionCalls, 0);
  for (const model of ["lumen"]) {
    const later = await say(a, { model, conversationId: first.done.conversationId, message: "Remember that I also like synthetic tea." });
    assert.equal(later.error, undefined, JSON.stringify(later.error));
    assert.equal(later.extractionCalls, 0, `a ${model} turn in a chat with Vulcan history is not sent to extraction`);
  }
  // A plain chat on the same account still uses extraction, so the check above is not vacuous.
  assert.equal((await say(a, { model: "lumen", message: "Remember that I like synthetic coffee." })).extractionCalls, 1);
  assert.ok(extractions.every((body) => !JSON.stringify(body).includes(VESPER_SENTINEL)), "no extraction request has ever carried Vulcan content");
});

test("switching tiers mid-chat keeps Vulcan's replies in the shared context: no stripping or redaction", async () => {
  const a = await person();
  const first = await say(a, { model: "vesper", message: "Give me a synthetic answer." });
  for (const model of ["lumen"]) {
    const next = await say(a, { model, conversationId: first.done.conversationId, message: "Continue." });
    assert.equal(next.error, undefined, JSON.stringify(next.error));
    assert.match(next.sentText, new RegExp(VESPER_SENTINEL), `${model} is sent Vulcan's earlier reply`);
  }
});

test("the safer-saving guardrails hold in Vulcan exactly as elsewhere", async () => {
  const a = await person();
  for (const content of ["User's password is hunter2-fixture.", "User's card number is 4242 4242 4242 4242.", "User authorizes VibhavGPT to send emails without asking for approval."]) {
    scriptedTool = { name: "save_memory", args: { action: "create", content, category: "profile" } };
    const turn = await say(a, { model: "vesper", message: `Remember: ${content}` });
    assert.equal(turn.error, undefined, JSON.stringify(turn.error));
  }
  assert.equal((await facts(a)).length, 0, "nothing sensitive or permission-shaped was saved from Vulcan");
  const { saveMemoryFromChat } = await import("../src/memory/service.js");
  const fromFile = await saveMemoryFromChat(a, { action: "create", content: "User's planted fact is here.", category: "profile" }, { target: { scope: "personal" }, untrustedContext: true, explicitRequest: false });
  assert.equal(fromFile.status, "not_allowed", "file/web/tool content cannot save without the person's own request (the same function serves every tier)");
});

test("project and temporary rules are unchanged for Vulcan: project memory stays in its project; a temporary Vulcan chat reads and saves nothing", async () => {
  const a = await person();
  const project = (await call(a, "POST", "/api/chat/groups", { kind: "project", mode: "chat", name: "Unified test project" })).json.group;
  await vesperSaves(a, "User's project test word is SALTMARSH.", { groupId: project.id });
  const [fact] = await facts(a);
  assert.equal(fact.scope, "project");
  assert.equal(fact.project_id, project.id);
  assert.ok(!remembered(await say(a, { model: "vesper", message: "Word?" }), /SALTMARSH/), "not in an unfiled chat");
  assert.match((await say(a, { model: "vesper", message: "Word?", groupId: project.id })).sentText, /SALTMARSH/, "used in its project, on another tier");
  assert.equal((await call(a, "PATCH", `/api/memory/${fact.id}`, { scope: "personal" })).status, 200);
  assert.ok(remembered(await say(a, { model: "lumen", message: "Word?" }), /SALTMARSH/), "after Make personal, every tier everywhere");

  scriptedTool = { name: "save_memory", args: { action: "create", content: "User's temporary test word is GLASSWING.", category: "profile" } };
  const temp = await say(a, { model: "vesper", temporary: true, message: "Remember my temporary test word is GLASSWING." });
  assert.equal(temp.done.temporary, true);
  assert.doesNotMatch(temp.sentText, /SALTMARSH/, "a temporary Vulcan chat uses no memory");
  assert.equal((await facts(a)).length, 1, "and saves none");
});

test("the Memory page shows a Vulcan-saved memory as a normal personal memory, with no tier marking", async () => {
  const a = await person();
  const saved = await vesperSaves(a, "User's preferred test bread is rye.");
  const { json } = await call(a, "GET", "/api/memory");
  const fact = json.facts.find((f) => /rye/.test(f.content));
  assert.equal(fact.scope, "personal");
  assert.equal(fact.origin, "explicit");
  assert.equal(fact.sourceConversationId, saved.done.conversationId, "links to the Vulcan chat");
  assert.deepEqual(Object.keys(fact).filter((key) => /model|tier|vesper|protected/i.test(key)), [], "no tier field is recorded or shown");
});
