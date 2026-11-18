/**
 * The real /api/chat/stream route, end to end, for a connector read.
 * Doubles: the model upstream (scripted SSE, in-process) and the connector
 * provider (a labeled boundary double). No network, no real account.
 *
 * What the client receives is checked as raw events: the activity statuses the
 * router emits, the order of those and the reply, and that none of the model's
 * raw reasoning is ever in the stream.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
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

const adapterHref = new URL("../src/connectors/composio-adapter.js", import.meta.url).href;
const adapter = await import(adapterHref);
const provider = { respond: async () => ({ data: {} }), calls: [] };
mock.module(adapterHref, {
  namedExports: {
    COMPOSIO_TOOLKITS: adapter.COMPOSIO_TOOLKITS,
    uploadComposioFile: adapter.uploadComposioFile,
    checkComposioFilesAccess: adapter.checkComposioFilesAccess,
    accountBelongsToUser: adapter.accountBelongsToUser,
    accountGrantedToUser: adapter.accountGrantedToUser,
    TOOLKIT_METADATA: adapter.TOOLKIT_METADATA,
    TOOL_SLUG_MAP: adapter.TOOL_SLUG_MAP,
    COMPOSIO_AUTH_TRUSTED_HOSTS: adapter.COMPOSIO_AUTH_TRUSTED_HOSTS,
    isComposioConfigured: adapter.isComposioConfigured,
    computePayloadHash: adapter.computePayloadHash,
    isTrustedComposioRedirectUrl: adapter.isTrustedComposioRedirectUrl,
    listAllComposioConnections: adapter.listAllComposioConnections,
    initiateComposioConnection: adapter.initiateComposioConnection,
    checkComposioAccountStatus: adapter.checkComposioAccountStatus,
    revokeComposioConnection: adapter.revokeComposioConnection,
    sanitizeProviderError: adapter.sanitizeProviderError,
    interpretComposioExecution: adapter.interpretComposioExecution,
    executeComposioTool: async (args) => {
      provider.calls.push({ toolSlug: args.toolSlug, userId: args.userId, boundary: "provider-double" });
      return provider.respond(args);
    },
  },
});

const { config } = await import("../src/config.js");
config.moderationApiKey = "";
config.providerKeys.primaryFree = "";
config.providerKeys.paid = "fixture-key";
// Connector turns need a tool-capable tier, and Lumen runs no tools: they run on Vulcan over the router with the fixture engine, for a
// Pro account. (Nova carried them until it was retired on 2026-11-14.)
config.chatModels.vesper = "fixture-vesper";
config.vesperTransport = "router";
const { connectUserConnector } = await import("../src/connectors/service.js");

const RAW_PLANNING = "RAW-PLANNING-SENTINEL I should call the YouTube tool and then explain";
const RAW_AFTER = "RAW-AFTER-SENTINEL the tool failed so maybe try a search";
const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const sse = (chunks) => new Response(chunks.map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });
const usage = { prompt_tokens: 40, completion_tokens: 12 };
// Raw thinking in the two shapes a router can send it: the string and the details.
const thinking = (text) => ({ choices: [{ delta: { reasoning: text, reasoning_details: [{ type: "reasoning.text", text }] } }] });

const toolTurn = () => sse([
  thinking(RAW_PLANNING),
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "youtube_get_my_channel", arguments: "{}" } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage },
]);
const answerTurn = (text, { withThinking = false } = {}) => sse([
  ...(withThinking ? [thinking(RAW_AFTER)] : []),
  ...text.split(/(?<= )/).map((content) => ({ choices: [{ delta: { content } }] })),
  { choices: [{ delta: {}, finish_reason: "stop" }], usage },
]);

let userCounter = 0;
async function run(t, { connected = true, tool = true, answer, afterToolThinking = false } = {}) {
  const userId = `activity-user-${++userCounter}`;
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
  await client.query("INSERT INTO subscriptions (user_id, tier, status) VALUES ($1, 'pro', 'active') ON CONFLICT DO NOTHING", [userId]);
  if (connected) await connectUserConnector(userId, "youtube", { accessToken: "tok_youtube_test", scopes: [], metadata: { accountId: "acct_fixture_router_activity_events_1" } });
  provider.calls.length = 0;
  const upstream = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith(config.providerBaseUrls.paid)) {
      if (href.includes("/generation")) return new Response("{}", { status: 404 });
      upstream.push(JSON.parse(init.body));
      return tool && upstream.length === 1 ? toolTurn() : answerTurn(answer, { withThinking: afterToolThinking && upstream.length > 1 });
    }
    if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
    throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
  };
  const { default: express } = await import("express");
  const { chatRouter } = await import("../src/chat/router.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/chat", chatRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => { globalThis.fetch = realFetch; return new Promise((resolve) => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "vesper", message: "what's my YouTube channel's name?", selectedConnectors: connected ? ["youtube"] : [] }),
  });
  const raw = await response.text();
  const events = raw.split("\n\n").map((block) => ({ event: block.match(/^event:\s*(.+)$/m)?.[1], data: block.match(/^data:\s*(.+)$/m)?.[1] }))
    .filter((item) => item.event && item.data).map((item) => ({ event: item.event, data: JSON.parse(item.data) }));
  return { events, raw, upstream, userId };
}

const connectorStatuses = (events) => events.filter((e) => e.event === "status" && e.data.phase.startsWith("connector_")).map((e) => ({ phase: e.data.phase, service: e.data.service }));
const indexOfStatus = (events, phase) => events.findIndex((e) => e.event === "status" && e.data.phase === phase);
const firstReplyDelta = (events) => events.findIndex((e) => e.event === "delta" && typeof e.data.text === "string");
const replyOf = (events) => events.find((e) => e.event === "complete")?.data.reply;

function assertNoRawThinking(events, raw) {
  assert.equal(events.find((e) => e.event === "error"), undefined, "the turn did not error");
  assert.doesNotMatch(raw, /RAW-PLANNING-SENTINEL|RAW-AFTER-SENTINEL/, "no raw reasoning anywhere in the client stream");
  assert.equal(events.some((e) => e.event === "delta" && ("reasoning" in e.data || "reasoningReset" in e.data)), false, "no reasoning delta of any kind");
}

test("successful read: reading, then done, then the answer; the channel reached the model; no raw planning streamed", async (t) => {
  provider.respond = async () => ({ data: { items: [{ id: "UC_fixture", snippet: { title: "Fixture Channel" } }] } });
  const { events, raw, upstream, userId } = await run(t, { answer: "Your channel is Fixture Channel.", afterToolThinking: true });
  assertNoRawThinking(events, raw);
  assert.deepEqual(connectorStatuses(events), [
    { phase: "connector_reading", service: "YouTube" },
    { phase: "connector_done", service: "YouTube" },
  ]);
  assert.ok(indexOfStatus(events, "plugin_endpoint") < indexOfStatus(events, "connector_reading"), "reading follows the model's tool request");
  assert.ok(indexOfStatus(events, "connector_reading") < indexOfStatus(events, "connector_done"));
  assert.ok(indexOfStatus(events, "connector_done") < firstReplyDelta(events), "the outcome is reported before the reply streams");
  assert.deepEqual(provider.calls, [{ toolSlug: "youtube_get_my_channel", userId, boundary: "provider-double" }]);
  assert.equal(upstream.length, 2, "one tool request, one answer");
  assert.match(JSON.stringify(upstream[1].messages), /Fixture Channel/, "the provider's channel data was given to the model");
  assert.equal(replyOf(events), "Your channel is Fixture Channel.");
});

test("failed read: reading, then failed, and never done; the model is told the true reason", async (t) => {
  provider.respond = async () => { throw Object.assign(new Error("401 Unauthorized: invalid_grant ya29.SECRETTOKENVALUE private-channel-title"), { logId: "log_z" }); };
  const { events, raw, upstream } = await run(t, { answer: "I could not read your YouTube channel right now.", afterToolThinking: true });
  assertNoRawThinking(events, raw);
  assert.deepEqual(connectorStatuses(events), [
    { phase: "connector_reading", service: "YouTube" },
    { phase: "connector_failed", service: "YouTube" },
  ]);
  assert.equal(indexOfStatus(events, "connector_done"), -1, "no success is ever reported after an error");
  assert.ok(indexOfStatus(events, "connector_failed") < firstReplyDelta(events));
  const toModel = JSON.stringify(upstream[1].messages);
  assert.match(toModel, /sign-in has expired or was revoked/, "the true category reached the model");
  assert.doesNotMatch(toModel, /SECRETTOKEN|private-channel-title|invalid_grant/, "no provider text or secret reached the model");
  assert.doesNotMatch(raw, /SECRETTOKEN|private-channel-title/, "nor the client");
  assert.equal(replyOf(events), "I could not read your YouTube channel right now.");
});

test("a provider timeout is also failed, not done", async (t) => {
  provider.respond = async () => { throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" }); };
  const { events, upstream } = await run(t, { answer: "That took too long." });
  assert.deepEqual(connectorStatuses(events).map((s) => s.phase), ["connector_reading", "connector_failed"]);
  assert.match(JSON.stringify(upstream[1].messages), /did not respond in time/);
});

test("a successful provider call that returns an empty result is done, and says so to the model", async (t) => {
  provider.respond = async () => ({ data: "" });
  const { events, upstream } = await run(t, { answer: "No channel came back." });
  assert.deepEqual(connectorStatuses(events).map((s) => s.phase), ["connector_reading", "connector_done"]);
  assert.match(JSON.stringify(upstream[1].messages), /YouTube returned an empty result/);
});

test("a turn with no tool: no connector activity, raw thinking still hidden, the reply completes", async (t) => {
  const { events, raw, upstream } = await run(t, { tool: false, answer: "Photosynthesis turns light into sugar.", afterToolThinking: true });
  assertNoRawThinking(events, raw);
  assert.deepEqual(connectorStatuses(events), []);
  assert.equal(indexOfStatus(events, "plugin_endpoint"), -1);
  assert.equal(upstream.length, 1);
  assert.equal(replyOf(events), "Photosynthesis turns light into sugar.");
  assert.deepEqual(provider.calls, []);
});

test("the raw thinking streamed on the first chunk of a tool turn never reaches the client, even briefly", async (t) => {
  provider.respond = async () => ({ data: { items: [] } });
  const { events } = await run(t, { answer: "Done." });
  // The upstream's first chunk is raw planning. Nothing before the first status
  // after it, and nothing at all, may carry it.
  for (const [index, e] of events.entries()) {
    assert.doesNotMatch(JSON.stringify(e), /RAW-PLANNING-SENTINEL/, `event ${index} (${e.event}) carries no raw planning`);
  }
});
