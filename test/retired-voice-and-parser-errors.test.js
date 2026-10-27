// First import: removes inherited credentials and sets placeholders before any application code reads them.
import { blockOutbound, databaseSpy } from "./synthetic-environment.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { app } = await import("../src/server.js");
const { parserFailureMessage } = await import("../src/security/request-error-message.js");

const SENTINEL = "SENTINEL_REQUEST_VALUE";
const VOICE_REMOVED = { error: "Voice is no longer available in VibhavGPT.", code: "voice-removed" };

// Runs the real app on a free local port. fetch may reach only that exact origin (anything else
// throws at once and is recorded, never forwarded), and the database pool is spied so any query or
// connection throws and is counted. Usage reservation and every other database-backed path go
// through that pool, so a zero count is the proof that none of them ran.
async function withApp(t, run) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const outbound = blockOutbound(origin);
  const database = await databaseSpy(t);
  const logs = [];
  const realError = console.error;
  console.error = (...args) => logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  try { return await run({ origin, logs, database, outbound }); }
  finally { console.error = realError; outbound.restore(); await new Promise((resolve) => server.close(resolve)); }
}
const expectNoActivity = ({ outbound, database }) => {
  assert.deepEqual(outbound.blocked, [], "no request to any other destination was attempted");
  assert.equal(database.total(), 0, `no database query or connection (so no usage reservation): ${JSON.stringify(database.calls)}`);
};

const post = (origin, path, { headers = {}, body = "{}" } = {}) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

test("the guard lets only the exact test origin through and throws for everything else without forwarding", async () => {
  // A recording fake sits underneath the guard, so anything that gets through is visible.
  const realFetch = globalThis.fetch;
  const reached = [];
  globalThis.fetch = async (url) => { reached.push(String(url)); return new Response("ok"); };
  const guard = blockOutbound("http://127.0.0.1:4000");
  try {
    for (const destination of ["https://api.example.invalid/x", "http://127.0.0.1:4001/x", "http://127.0.0.1:4000.evil.invalid/x", "http://localhost:4000/x", "not a url"]) {
      assert.throws(() => fetch(destination), /blocked outbound request in a test/, destination);
    }
    assert.equal(guard.blocked.length, 5, "every blocked destination was recorded");
    assert.deepEqual(reached, [], "none of them was forwarded");
    await fetch("http://127.0.0.1:4000/allowed");
    assert.deepEqual(reached, ["http://127.0.0.1:4000/allowed"], "only the exact test origin is passed on");
  } finally { guard.restore(); globalThis.fetch = realFetch; }
});

test("the retired voice entry points answer 410 before the JSON parser reads their body", async (t) => {
  await withApp(t, async (box) => {
    const { origin, logs } = box;
    // A body the parser would reject with 400 proves it was never parsed.
    for (const path of ["/api/voice/transcribe", "/api/voice/live/session", "/api/voice/live/session/"]) {
      const response = await post(origin, path, { body: `{"audio":"${SENTINEL}",` });
      assert.equal(response.status, 410, path);
      assert.deepEqual(await response.json(), VOICE_REMOVED, `${path} keeps its response contract`);
    }
    // Nor does a body of the wrong type, an empty one, or one sent with credentials get any further.
    for (const options of [{ headers: { "content-type": "text/plain" }, body: SENTINEL }, { body: "" }, { headers: { authorization: `Bearer ${SENTINEL}`, cookie: `session=${SENTINEL}` } }]) {
      const response = await post(origin, "/api/voice/transcribe", options);
      assert.equal(response.status, 410);
      assert.deepEqual(await response.json(), VOICE_REMOVED);
    }
    expectNoActivity(box);
    assert.deepEqual(logs, [], "and nothing was logged");
  });
});

test("the routes that settle an earlier call still parse JSON, and other methods are unchanged", async (t) => {
  await withApp(t, async (box) => {
    for (const suffix of ["end", "heartbeat", "connected"]) {
      const response = await post(box.origin, `/api/voice/live/session/abc/${suffix}`, { body: `{"x":` });
      assert.equal(response.status, 400, `${suffix} still goes through its parser, which rejects before any database work`);
    }
    // The transcript route authenticates first (see voice-settlement-limits.test.js), so a signed-out caller stops there.
    const unauthenticated = await post(box.origin, "/api/voice/live/session/abc/transcript", { body: `{"x":` });
    assert.equal(unauthenticated.status, 401, "transcript: authentication comes before its parser");
    const get = await fetch(`${box.origin}/api/voice/transcribe`);
    assert.equal(get.status, 404, "only POST was ever answered with 410");
    expectNoActivity(box);
  });
});

test("the retired entry points are registered ahead of the voice router, and the router keeps its own rejection", () => {
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const retired = server.indexOf('app.post(["/api/voice/transcribe", "/api/voice/live/session"]');
  const mount = server.indexOf('app.use("/api/voice", voiceRouter);');
  assert.ok(retired > 0 && mount > 0 && retired < mount, "the 410 comes first");
  assert.match(server, /res\.status\(410\)\.json\(VOICE_REMOVED\)/);
  const router = readFileSync(new URL("../src/voice/router.js", import.meta.url), "utf8");
  assert.match(router, /voiceRouter\.post\(\["\/transcribe", "\/live\/session"\], \(req, res\) => res\.status\(410\)\.json\(VOICE_REMOVED\)\)/);
  assert.doesNotMatch(server, /express\.json\(\{ limit: "28mb" \}\)/, "the voice mount no longer carries a parser: each settlement route has its own");
});

test("a rejected request body is never quoted back in the response or the log", async (t) => {
  const cases = [
    ["malformed JSON", { body: `{"password":"${SENTINEL}_PASSWORD","note":"${SENTINEL}_NOTE",` }, 400, "The request body is not valid JSON."],
    ["a JSON value the strict parser refuses", { body: `"${SENTINEL}_PLAIN_STRING"` }, 400, "The request body is not valid JSON."],
    ["an unsupported charset", { headers: { "content-type": `application/json; charset=${SENTINEL}_CHARSET` } }, 415, "The request's character set is not supported."],
    ["an unsupported content encoding", { headers: { "content-encoding": `${SENTINEL}_ENCODING` } }, 415, "The request's content encoding is not supported."],
  ];
  await withApp(t, async (box) => {
    for (const [name, options, status, message] of cases) {
      box.logs.length = 0;
      const response = await post(box.origin, "/api/voice/live/session/abc/end", { ...options, headers: { authorization: `Bearer ${SENTINEL}_TOKEN`, cookie: `session=${SENTINEL}_COOKIE`, ...options.headers } });
      const text = await response.text();
      assert.equal(response.status, status, `${name}: the status code is the parser's own`);
      assert.deepEqual(JSON.parse(text), { error: message }, `${name}: a fixed sentence`);
      assert.equal(text.toLowerCase().includes("sentinel"), false, `${name}: the response quoted the request: ${text}`);
      assert.equal(box.logs.join("\n").toLowerCase().includes("sentinel"), false, `${name}: the log quoted the request`);
    }
    expectNoActivity(box);
  });
});

test("only the body parser's failures get a fixed sentence; any other error keeps the message its route gave it", () => {
  for (const type of ["entity.parse.failed", "entity.too.large", "entity.verify.failed", "request.aborted", "request.size.invalid", "stream.encoding.set", "encoding.unsupported", "charset.unsupported", "parameters.too.many", "querystring.parse.rangeError"]) {
    assert.equal(typeof parserFailureMessage({ type, message: SENTINEL }), "string", type);
    assert.equal(parserFailureMessage({ type, message: SENTINEL }).includes(SENTINEL), false, type);
  }
  for (const error of [new Error("That import is too large. Please keep it under 30,000 characters."), { type: SENTINEL, message: "x" }, { type: "constructor" }, { type: "__proto__" }, { type: 7 }, null, undefined]) {
    assert.equal(parserFailureMessage(error), null);
  }
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(server, /error: status < 500 \? \(parserFailureMessage\(error\) \?\? error\.message \?\? "Request could not be completed\."\)/, "other 4xx messages still come from the error");
});
