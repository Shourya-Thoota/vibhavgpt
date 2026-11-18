/**
 * Independent chat abuse protection: a per-user request-burst limit and a per-user
 * concurrent-request limit, both separate from the credit balance.
 *
 * Three layers are tested:
 *   1. the guard itself, with an injected clock (no server, no database);
 *   2. its configuration (defaults, overrides, invalid values, 0 = off);
 *   3. the real chat router over HTTP with a scripted upstream: simultaneous requests,
 *      a client that disconnects, a tool turn that makes two model calls, the non-streaming
 *      route, and independence from the credit balance.
 */
import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const db = drizzle(client);
mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db, pool: { query: (sql, params) => client.query(sql, params) } },
});
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => (req.authSession ? next() : res.status(401).json({ error: "Sign in is required." })),
    loadOptionalSession: (_req, _res, next) => next(),
  },
});

// The connector provider is a labeled boundary double, as in router-activity-events.
const adapterHref = new URL("../src/connectors/composio-adapter.js", import.meta.url).href;
const adapter = await import(adapterHref);
const provider = { respond: async () => ({ data: { items: [{ id: "UC_fixture", snippet: { title: "Fixture Channel" } }] } }) };
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
    executeComposioTool: async (args) => provider.respond(args),
  },
});

const { config, limitFromEnv } = await import("../src/config.js");
config.moderationApiKey = "";
config.providerKeys.primaryFree = "";
config.providerKeys.paid = "fixture-key";
// The free tier these requests use: Lumen on its production route type (the router's paid zero-retention route), at the fixture
// key and upstream. (Nova, which these tests used before, is retired.)
config.lumenChatRoute = "paid-zdr";
config.lumenPaidZdrProviders = ["fixture-host"];
config.chatModels.lumenFallback1 = "fixture-lumen"; // lumenPaidZdrModel derives from it
const schema = await import("../src/db/schema.js");
const { createChatAbuseGuard, CHAT_ABUSE_CODES } = await import("../src/chat/abuse-guard.js");
const { chatRouter, chatAbuseGuard } = await import("../src/chat/router.js");
const { connectUserConnector } = await import("../src/connectors/service.js");
const { default: express } = await import("express");

const SECOND = 1000;

// ---------------------------------------------------------------------------------------------
// 1. The guard, with an injected clock
// ---------------------------------------------------------------------------------------------

function makeGuard(limits, start = 1_000_000) {
  let t = start;
  const lines = [];
  const guard = createChatAbuseGuard({ settings: () => limits, now: () => t, log: (line) => lines.push(line), sweepMs: 3_600_000 });
  return { guard, lines, tick: (ms) => { t += ms; }, at: () => t };
}

test("burst: the first N requests in the window are admitted, the next is refused with how long to wait", () => {
  const { guard, tick } = makeGuard({ burstMax: 3, burstWindowMs: 60 * SECOND, maxConcurrent: 0 });
  try {
    const admitted = [];
    for (let i = 0; i < 3; i += 1) { admitted.push(guard.admit("u1")); tick(SECOND); }
    assert.ok(admitted.every((decision) => decision.ok));
    const refused = guard.admit("u1");
    assert.equal(refused.ok, false);
    assert.equal(refused.code, CHAT_ABUSE_CODES.BURST);
    assert.equal(refused.limit, 3);
    // The first request was 3 s ago, so it leaves the window in 57 s.
    assert.equal(refused.retryAfterMs, 57 * SECOND);
    assert.equal(refused.retryAfterSeconds, 57);
  } finally { guard.stop(); }
});

test("burst: a refused attempt does not count, so it never extends its own lockout", () => {
  const { guard, tick } = makeGuard({ burstMax: 2, burstWindowMs: 60 * SECOND, maxConcurrent: 0 });
  try {
    guard.admit("u1"); tick(10 * SECOND); guard.admit("u1");
    for (let i = 0; i < 25; i += 1) { tick(SECOND); assert.equal(guard.admit("u1").ok, false); }
    assert.deepEqual(guard.snapshot("u1"), { active: 2, inWindow: 2 }, "25 refusals added nothing");
    // 35 s after the first admitted request is 25 s of refusals + 10 s: still inside its window.
    tick(24 * SECOND); // 59 s after the first
    assert.equal(guard.admit("u1").ok, false);
    tick(SECOND); // exactly 60 s after the first: it has left the window
    assert.equal(guard.admit("u1").ok, true, "the first request ages out at exactly the window length");
  } finally { guard.stop(); }
});

test("burst: the window slides; it is not a fixed bucket that resets all at once", () => {
  const { guard, tick } = makeGuard({ burstMax: 2, burstWindowMs: 60 * SECOND, maxConcurrent: 0 });
  try {
    assert.ok(guard.admit("u1").ok);   // t = 0
    tick(30 * SECOND);
    assert.ok(guard.admit("u1").ok);   // t = 30
    tick(29 * SECOND);                 // t = 59: both still inside (t-60, t]
    assert.equal(guard.admit("u1").ok, false);
    tick(SECOND);                      // t = 60: the first has left, the second has not
    assert.ok(guard.admit("u1").ok, "one slot opened as the oldest request aged out");
    assert.equal(guard.admit("u1").ok, false, "but only one: a fixed bucket would have opened two");
    assert.equal(guard.snapshot("u1").inWindow, 2);
  } finally { guard.stop(); }
});

test("burst: accounts are independent of one another", () => {
  const { guard } = makeGuard({ burstMax: 1, burstWindowMs: 60 * SECOND, maxConcurrent: 0 });
  try {
    assert.ok(guard.admit("a").ok);
    assert.equal(guard.admit("a").ok, false);
    assert.ok(guard.admit("b").ok, "another account is unaffected");
  } finally { guard.stop(); }
});

test("concurrency: at most N in flight; a finished request frees exactly one slot, even if released twice", () => {
  const { guard } = makeGuard({ burstMax: 0, burstWindowMs: 60 * SECOND, maxConcurrent: 2 });
  try {
    const first = guard.admit("u1");
    const second = guard.admit("u1");
    assert.ok(first.ok && second.ok);
    const third = guard.admit("u1");
    assert.equal(third.ok, false);
    assert.equal(third.code, CHAT_ABUSE_CODES.BUSY);
    assert.equal(third.retryAfterSeconds, null, "there is no honest time to wait for a reply in progress");
    first.release();
    first.release(); // a response that both finishes and closes
    first.release();
    assert.equal(guard.snapshot("u1").active, 1, "released once, not three times");
    assert.ok(guard.admit("u1").ok, "one slot is free again");
    assert.equal(guard.admit("u1").ok, false, "and only one");
  } finally { guard.stop(); }
});

test("concurrency: another account's replies in progress are not counted against this one", () => {
  const { guard } = makeGuard({ burstMax: 0, burstWindowMs: 60 * SECOND, maxConcurrent: 1 });
  try {
    assert.ok(guard.admit("a").ok);
    assert.ok(guard.admit("b").ok);
    assert.equal(guard.admit("a").ok, false);
  } finally { guard.stop(); }
});

test("the burst limit is decided before the concurrency limit, and each refusal says which it was", () => {
  const { guard } = makeGuard({ burstMax: 2, burstWindowMs: 60 * SECOND, maxConcurrent: 2 });
  try {
    guard.admit("u1"); guard.admit("u1");
    assert.equal(guard.admit("u1").code, CHAT_ABUSE_CODES.BURST, "both limits are hit: the one with a time to wait is reported");
    const { guard: g2 } = makeGuard({ burstMax: 10, burstWindowMs: 60 * SECOND, maxConcurrent: 1 });
    try { g2.admit("u1"); assert.equal(g2.admit("u1").code, CHAT_ABUSE_CODES.BUSY); } finally { g2.stop(); }
  } finally { guard.stop(); }
});

test("0 switches a limit off, independently, and both off admits everything", () => {
  const noBurst = makeGuard({ burstMax: 0, burstWindowMs: 60 * SECOND, maxConcurrent: 1 });
  const noConcurrency = makeGuard({ burstMax: 2, burstWindowMs: 60 * SECOND, maxConcurrent: 0 });
  const neither = makeGuard({ burstMax: 0, burstWindowMs: 0, maxConcurrent: 0 });
  try {
    for (let i = 0; i < 50; i += 1) { const d = noBurst.guard.admit("u"); assert.ok(d.ok); d.release(); }
    assert.ok(noConcurrency.guard.admit("u").ok);
    assert.ok(noConcurrency.guard.admit("u").ok);
    assert.equal(noConcurrency.guard.admit("u").code, CHAT_ABUSE_CODES.BURST);
    for (let i = 0; i < 200; i += 1) assert.ok(neither.guard.admit("u").ok);
    assert.equal(neither.guard.snapshot("u").inWindow, 0, "nothing is remembered about a limit that is off");
  } finally { noBurst.guard.stop(); noConcurrency.guard.stop(); neither.guard.stop(); }
});

test("idle accounts are forgotten; accounts with a reply in progress or a request in the window are kept", () => {
  const { guard, tick } = makeGuard({ burstMax: 5, burstWindowMs: 60 * SECOND, maxConcurrent: 2 });
  try {
    const held = guard.admit("busy");
    const done = guard.admit("done"); done.release();
    assert.equal(guard.size(), 2);
    guard.sweep();
    assert.equal(guard.size(), 2, "still inside the window");
    tick(61 * SECOND);
    guard.sweep();
    assert.equal(guard.size(), 1, "the finished, aged-out account is gone");
    assert.equal(guard.snapshot("busy").active, 1, "the one in progress is kept");
    held.release();
    guard.sweep();
    assert.equal(guard.size(), 0);
  } finally { guard.stop(); }
});

test("a refusal is a 429 in the shape the app reads, logs only the code and the limit, and carries Retry-After for a burst", () => {
  const { guard, lines, tick } = makeGuard({ burstMax: 1, burstWindowMs: 60 * SECOND, maxConcurrent: 1 });
  try {
    const sent = { headers: {}, status: null, body: null };
    const res = {
      set(name, value) { sent.headers[String(name).toLowerCase()] = value; return res; },
      status(code) { sent.status = code; return res; },
      json(body) { sent.body = body; return res; },
      once() {},
    };
    const req = { authSession: { user: { id: "secret-account-id" } } };
    let nextCalls = 0;
    guard.middleware(req, res, () => { nextCalls += 1; });
    assert.equal(nextCalls, 1, "the first request goes on to the handler");
    tick(5 * SECOND);
    guard.middleware(req, res, () => { nextCalls += 1; });
    assert.equal(nextCalls, 1, "the second never reaches the handler");
    assert.equal(sent.status, 429);
    assert.equal(sent.headers["retry-after"], "55");
    assert.equal(sent.headers["cache-control"], "no-store");
    assert.equal(sent.body.code, "chat_rate_limited");
    assert.equal(sent.body.access.reason, "rate");
    assert.equal(sent.body.access.feature, "Chat");
    assert.equal(sent.body.access.detail.kind, "burst");
    assert.equal(sent.body.access.resetAt, new Date(1_000_000 + 60 * SECOND).toISOString(), "the time the oldest request leaves the window");
    assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ event: "chat_abuse_limited", code: "chat_rate_limited", limit: 1 }]);
    assert.doesNotMatch(lines.join("\n"), /secret-account-id/, "the log carries no account id");
  } finally { guard.stop(); }
});

test("an anonymous request is left to the session guard rather than counted", () => {
  const { guard } = makeGuard({ burstMax: 1, burstWindowMs: 60 * SECOND, maxConcurrent: 1 });
  try {
    let passed = 0;
    for (let i = 0; i < 5; i += 1) guard.middleware({}, {}, () => { passed += 1; });
    assert.equal(passed, 5);
    assert.equal(guard.size(), 0);
  } finally { guard.stop(); }
});

// ---------------------------------------------------------------------------------------------
// 2. Configuration
// ---------------------------------------------------------------------------------------------

test("limits are whole non-negative numbers; unset, blank and invalid values fall back to the default and 0 is deliberate", () => {
  assert.equal(limitFromEnv("X", 20, {}), 20);
  assert.equal(limitFromEnv("X", 20, { X: "" }), 20);
  assert.equal(limitFromEnv("X", 20, { X: "   " }), 20);
  assert.equal(limitFromEnv("X", 20, { X: "45" }), 45);
  assert.equal(limitFromEnv("X", 20, { X: " 45 " }), 45);
  assert.equal(limitFromEnv("X", 20, { X: "0" }), 0, "0 turns the limit off, and is not mistaken for unset");
  for (const bad of ["abc", "-1", "2.5", "1e3x", "NaN", "Infinity", "20 requests"]) {
    assert.equal(limitFromEnv("X", 20, { X: bad }), 20, `${JSON.stringify(bad)} is not a limit`);
  }
});

function configIn(env) {
  const script = "import('./src/config.js').then(({config})=>{console.log(JSON.stringify({chatAbuse:config.chatAbuse,at:config.creditsActivatedAt&&config.creditsActivatedAt.toISOString()}))})";
  const clean = { ...process.env };
  for (const key of ["CHAT_BURST_MAX_REQUESTS", "CHAT_BURST_WINDOW_SECONDS", "CHAT_MAX_CONCURRENT_REQUESTS", "CREDITS_ACTIVATED_AT"]) delete clean[key];
  const out = execFileSync(process.execPath, ["--import", "./test/setup-env.js", "-e", script], { cwd: new URL("..", import.meta.url), env: { ...clean, ...env }, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").at(-1));
}

test("configuration: defaults are 20 requests per 60 s and 3 at once; the environment overrides each; 0 turns one off", () => {
  assert.deepEqual(configIn({}).chatAbuse, { burstMax: 20, burstWindowMs: 60_000, maxConcurrent: 3 });
  assert.deepEqual(configIn({ CHAT_BURST_MAX_REQUESTS: "8", CHAT_BURST_WINDOW_SECONDS: "30", CHAT_MAX_CONCURRENT_REQUESTS: "2" }).chatAbuse, { burstMax: 8, burstWindowMs: 30_000, maxConcurrent: 2 });
  assert.deepEqual(configIn({ CHAT_BURST_MAX_REQUESTS: "0", CHAT_MAX_CONCURRENT_REQUESTS: "0" }).chatAbuse, { burstMax: 0, burstWindowMs: 60_000, maxConcurrent: 0 });
  assert.deepEqual(configIn({ CHAT_BURST_MAX_REQUESTS: "lots", CHAT_BURST_WINDOW_SECONDS: "-5", CHAT_MAX_CONCURRENT_REQUESTS: "1.5" }).chatAbuse, { burstMax: 20, burstWindowMs: 60_000, maxConcurrent: 3 }, "invalid values never become 0");
});

test("configuration: the credits activation instant is null unless it is a valid time", () => {
  assert.equal(configIn({}).at, null);
  assert.equal(configIn({ CREDITS_ACTIVATED_AT: "not a date" }).at, null);
  assert.equal(configIn({ CREDITS_ACTIVATED_AT: "2026-12-01T00:00:00Z" }).at, "2026-12-01T00:00:00.000Z");
});

test("this protection adds no daily or five-hour product allowance", async () => {
  const source = await readFile(new URL("../src/chat/abuse-guard.js", import.meta.url), "utf8");
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /24\s*\*\s*60|86[_,]?400|DAY|HOURS?\b|5\s*\*\s*60\s*\*\s*60|18[_,]?000[_,]?000|fiveHour|five_hour|daily/i, "no daily or five-hour window in the guard");
  const defaults = configIn({}).chatAbuse;
  assert.ok(defaults.burstWindowMs <= 5 * 60_000, "the default window is minutes, not hours");
});

// ---------------------------------------------------------------------------------------------
// 3. The real chat router
// ---------------------------------------------------------------------------------------------

const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const sse = (chunks) => new Response(chunks.map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });
const usage = { prompt_tokens: 40, completion_tokens: 12 };
const answerTurn = (text) => sse([
  ...text.split(/(?<= )/).map((content) => ({ choices: [{ delta: { content } }] })),
  { choices: [{ delta: {}, finish_reason: "stop" }], usage },
]);
const toolTurn = () => sse([
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "youtube_get_my_channel", arguments: "{}" } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage },
]);

// The scripted upstream. `gate` holds every model call open until it is released.
// A streamed request gets server-sent events; a plain request gets one JSON completion.
const plainAnswer = (text) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }), { headers: { "Content-Type": "application/json" } });
const defaultScript = (_n, body) => (body.stream ? answerTurn("Fine.") : plainAnswer("Fine."));
const upstream = { calls: [], gate: null, script: defaultScript };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.startsWith(config.providerBaseUrls.paid)) {
    if (href.includes("/generation")) return new Response("{}", { status: 404 });
    upstream.calls.push(JSON.parse(init.body));
    if (upstream.gate) await upstream.gate.promise;
    return upstream.script(upstream.calls.length, upstream.calls.at(-1));
  }
  if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
  throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => { const id = req.get("x-test-user"); if (id) req.authSession = { user: { id } }; next(); });
app.use("/api/chat", chatRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { globalThis.fetch = realFetch; chatAbuseGuard.stop(); return new Promise((resolve) => server.close(resolve)); });

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function until(check, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let counter = 0;
async function newUser() {
  const id = `abuse-user-${++counter}`;
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [id]);
  return id;
}
function send(userId, { path = "/stream", message = "hello", signal, extra = {} } = {}) {
  return fetch(`${base}/api/chat${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-user": userId },
    body: JSON.stringify({ model: "lumen", message, ...extra }),
    signal,
  });
}
async function withLimits(limits, fn) {
  const before = { ...config.chatAbuse };
  Object.assign(config.chatAbuse, limits);
  chatAbuseGuard.reset();
  upstream.calls.length = 0;
  upstream.gate = null;
  upstream.script = defaultScript;
  try { return await fn(); } finally {
    Object.assign(config.chatAbuse, before);
    if (upstream.gate) upstream.gate.resolve();
    chatAbuseGuard.reset();
  }
}
const eventsOf = (raw) => raw.split("\n\n").map((block) => ({ event: block.match(/^event:\s*(.+)$/m)?.[1], data: block.match(/^data:\s*(.+)$/m)?.[1] }))
  .filter((item) => item.event && item.data).map((item) => ({ event: item.event, data: JSON.parse(item.data) }));

test("simultaneous requests: only the configured number are in flight, the rest are refused at once without reaching the model", async () => {
  await withLimits({ burstMax: 100, burstWindowMs: 60_000, maxConcurrent: 2 }, async () => {
    const userId = await newUser();
    upstream.gate = deferred();
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => send(userId, { message: `simultaneous ${i}` })));
    const refused = responses.filter((response) => response.status === 429);
    const admitted = responses.filter((response) => response.status === 200);
    assert.equal(admitted.length, 2, "exactly the concurrency limit was admitted");
    assert.equal(refused.length, 4);
    for (const response of refused) {
      assert.equal(response.headers.get("retry-after"), null, "no honest time to wait for a reply that is in progress");
      const body = await response.json();
      assert.equal(body.code, "chat_busy");
      assert.equal(body.access.reason, "rate", "a rate reason, not a quota or billing reason");
      assert.equal(body.access.detail.kind, "concurrent");
      assert.equal(body.access.resetAt, null);
      assert.doesNotMatch(`${body.error} ${body.access.message} ${body.access.cta}`, /credit|allowance|upgrade|plan|limit reached|used/i, "no allowance language: this is not about how much they have used");
      assert.equal(body.access.action, "retry");
      assert.equal(body.access.requiredPlan, null, "it never suggests a plan change");
    }
    await until(() => upstream.calls.length === 2, "the two admitted requests to reach the model");
    assert.equal(chatAbuseGuard.snapshot(userId).active, 2);
    upstream.gate.resolve();
    for (const response of admitted) {
      const events = eventsOf(await response.text());
      assert.ok(events.some((event) => event.event === "complete"), "an admitted request completes normally");
    }
    assert.equal(upstream.calls.length, 2, "the refused requests never reached the model");
    await until(() => chatAbuseGuard.snapshot(userId).active === 0, "the slots to be released");
    // With the slots free the same account can send again.
    upstream.gate = null;
    assert.equal((await send(userId, { message: "after" })).status, 200);
  });
});

test("a client that disconnects frees its slot", async () => {
  await withLimits({ burstMax: 100, burstWindowMs: 60_000, maxConcurrent: 1 }, async () => {
    const userId = await newUser();
    upstream.gate = deferred();
    const controller = new AbortController();
    const first = await send(userId, { signal: controller.signal });
    assert.equal(first.status, 200);
    await until(() => upstream.calls.length === 1, "the request to reach the model");
    assert.equal((await send(userId)).status, 429, "while it is in progress the slot is taken");
    controller.abort();
    await until(() => chatAbuseGuard.snapshot(userId).active === 0, "the aborted request to release its slot");
    upstream.gate.resolve();
    upstream.gate = null;
    assert.equal((await send(userId, { message: "again" })).status, 200, "the slot is usable again");
  });
});

test("burst: the request over the limit is refused with how long to wait, other accounts are unaffected, and a refusal does not extend the wait", async () => {
  await withLimits({ burstMax: 3, burstWindowMs: 60_000, maxConcurrent: 0 }, async () => {
    const userId = await newUser();
    const other = await newUser();
    for (let i = 0; i < 3; i += 1) {
      const response = await send(userId, { message: `burst ${i}` });
      assert.equal(response.status, 200);
      await response.text();
    }
    const fourth = await send(userId, { message: "burst 4" });
    assert.equal(fourth.status, 429);
    const retryAfter = Number(fourth.headers.get("retry-after"));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After is whole seconds within the window, got ${retryAfter}`);
    const body = await fourth.json();
    assert.equal(body.code, "chat_rate_limited");
    assert.equal(body.access.reason, "rate");
    assert.equal(body.access.detail.kind, "burst");
    assert.ok(Math.abs(Date.parse(body.access.resetAt) - (Date.now() + retryAfter * 1000)) < 2000, "resetAt agrees with Retry-After");
    assert.equal(upstream.calls.length, 3, "the refused request never reached the model");

    const fifth = await send(userId, { message: "burst 5" });
    assert.equal(fifth.status, 429);
    assert.equal((await fifth.json()).access.resetAt, body.access.resetAt, "a second refusal does not push the time out");
    assert.equal(chatAbuseGuard.snapshot(userId).inWindow, 3, "refused requests were not counted");

    const unaffected = await send(other, { message: "someone else" });
    assert.equal(unaffected.status, 200, "another account is not limited by this one");
    await unaffected.text();
  });
});

test("one tool turn is ONE request: the model is called twice but the burst count rises by one", async () => {
  await withLimits({ burstMax: 1, burstWindowMs: 60_000, maxConcurrent: 1 }, async () => {
    const userId = await newUser();
    // A tool turn needs a model whose route runs tools: Vulcan on the router (a Pro account), the current equivalent of the retired Nova.
    config.chatModels.vesper = "fixture-vesper";
    await db.insert(schema.subscriptions).values({ userId, tier: "pro", status: "active", billingSource: "internal" });
    await connectUserConnector(userId, "youtube", { accessToken: "tok_youtube_test", scopes: [], metadata: { accountId: "acct_fixture_chat_abuse_guard_1" } });
    upstream.script = (n) => (n === 1 ? toolTurn() : answerTurn("Your channel is Fixture Channel."));
    const response = await send(userId, { message: "what's my YouTube channel's name?", extra: { model: "vesper", selectedConnectors: ["youtube"] } });
    assert.equal(response.status, 200);
    const events = eventsOf(await response.text());
    assert.equal(events.find((event) => event.event === "error"), undefined, "the second model call was not refused by the guard");
    assert.equal(events.find((event) => event.event === "complete")?.data.reply, "Your channel is Fixture Channel.");
    assert.equal(upstream.calls.length, 2, "the tool request and the answer: two model calls");
    assert.deepEqual(chatAbuseGuard.snapshot(userId), { active: 0, inWindow: 1 }, "one request counted, however many model calls it made");
    // And the limit of one is really in force: the next request is the one that is refused.
    assert.equal((await send(userId, { message: "again" })).status, 429);
  });
});

test("the non-streaming route shares the same limits as the streaming route", async () => {
  await withLimits({ burstMax: 100, burstWindowMs: 60_000, maxConcurrent: 2 }, async () => {
    const userId = await newUser();
    upstream.gate = deferred();
    const streaming = await send(userId, { path: "/stream", message: "stream" });
    assert.equal(streaming.status, 200);
    const plain = send(userId, { path: "/", message: "plain" }); // held open at the model: not awaited yet
    await until(() => upstream.calls.length === 2, "both requests to reach the model");
    const third = await send(userId, { path: "/", message: "third" });
    assert.equal(third.status, 429, "a streaming and a plain request together fill the two slots");
    assert.equal((await third.json()).code, "chat_busy");
    upstream.gate.resolve();
    const plainResponse = await plain;
    assert.equal(plainResponse.status, 200);
    assert.ok(typeof (await plainResponse.json()).reply === "string");
    await streaming.text();
    await until(() => chatAbuseGuard.snapshot(userId).active === 0, "both slots to be released");
  });
});

test("the guard is independent of the credit balance: a user with no credits left is admitted by it and refused for credits, with a different reason", async () => {
  const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const before = { enabled: config.creditsPolicyEnabled, mode: config.creditsCarryMode, at: config.creditsActivatedAt };
  config.creditsPolicyEnabled = true;
  config.creditsCarryMode = "expiry";
  config.creditsActivatedAt = month;
  try {
    await withLimits({ burstMax: 2, burstWindowMs: 60_000, maxConcurrent: 2 }, async () => {
      const spent = await newUser();
      await db.insert(schema.usageEvents).values({ userId: spent, model: "lumen", costMicros: 5_000_000, inputTokens: 1, outputTokens: 1, createdAt: new Date() });
      // The plain route is used because the streaming route reports refusals as events after a 200.
      const response = await send(spent, { path: "/", message: "I have no credits left", extra: { model: "lumen" } });
      assert.equal(response.status, 429);
      const body = await response.json();
      assert.equal(body.access.reason, "quota", "refused for credits, not for rate");
      assert.match(body.code, /^credits_/);
      assert.equal(chatAbuseGuard.snapshot(spent).inWindow, 1, "the guard did admit it: the credit check came after");
      assert.equal(chatAbuseGuard.snapshot(spent).active, 0, "and released its slot when the refusal was sent");

      // The reverse: plenty of credits, but too fast. The reason is rate, not quota.
      const fast = await newUser();
      await db.insert(schema.subscriptions).values({
        userId: fast, tier: "plus", status: "active",
        currentPeriodStartedAt: new Date(Date.now() - 86_400_000), currentPeriodEndsAt: new Date(Date.now() + 29 * 86_400_000), updatedAt: new Date(),
      });
      for (let i = 0; i < 2; i += 1) { const ok = await send(fast, { path: "/", message: `fast ${i}` }); assert.equal(ok.status, 200); await ok.text(); }
      const limited = await send(fast, { path: "/", message: "fast 3" });
      assert.equal(limited.status, 429);
      const limitedBody = await limited.json();
      assert.equal(limitedBody.access.reason, "rate");
      assert.notEqual(limitedBody.access.reason, body.access.reason);
    });
  } finally { config.creditsPolicyEnabled = before.enabled; config.creditsCarryMode = before.mode; config.creditsActivatedAt = before.at; }
});

test("an unauthenticated request is refused by the session guard and never counted", async () => {
  await withLimits({ burstMax: 1, burstWindowMs: 60_000, maxConcurrent: 1 }, async () => {
    for (let i = 0; i < 3; i += 1) {
      const response = await fetch(`${base}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "lumen", message: "hi" }) });
      assert.equal(response.status, 401);
    }
    assert.equal(chatAbuseGuard.size(), 0);
  });
});
