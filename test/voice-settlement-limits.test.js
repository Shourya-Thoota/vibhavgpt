// First import: removes inherited credentials and sets placeholders before any application code reads them.
import { blockOutbound, databaseSpy } from "./synthetic-environment.js";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The routes that settle a call connected before voice was retired. Authentication is replaced by a
// stand-in that signs in only a request carrying x-test-user, and the three settlement functions by
// recorders, so valid requests work without a database and every rejected request can be shown never to
// have reached them. Both stand-ins count their calls.
const calls = { auth: 0, connected: [], heartbeat: [], end: [] };
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => {
      calls.auth += 1;
      if (req.headers["x-test-user"]) { req.authSession = { user: { id: "user-1" } }; return next(); }
      return res.status(401).json({ error: "Sign in is required." });
    },
    loadOptionalSession: (_req, _res, next) => next(),
  },
});
mock.module(new URL("../src/voice/live-comet.js", import.meta.url).href, {
  namedExports: {
    confirmLiveCometConnection: async (...args) => { calls.connected.push(args); return true; },
    heartbeatLiveCometSession: async (...args) => { calls.heartbeat.push(args); return true; },
    endLiveCometSession: async (...args) => { calls.end.push(args); return true; },
  },
});

const { app } = await import("../src/server.js");
const { SETTLEMENT_JSON_LIMIT, TRANSCRIPT_JSON_LIMIT } = await import("../src/voice/router.js");

const SIGNED_IN = { "x-test-user": "user-1" };
const TOO_LARGE = { error: "The request body is too large." };
const json = (extra) => JSON.stringify({ actualSeconds: 5, ...extra });
// A body of exactly `bytes` bytes: valid JSON padded with a string field.
const bodyOfSize = (bytes, base = {}) => {
  const empty = JSON.stringify({ ...base, pad: "" }).length;
  return JSON.stringify({ ...base, pad: "x".repeat(bytes - empty) });
};

async function withApp(t, run) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const outbound = blockOutbound(origin);
  const database = await databaseSpy(t);
  calls.auth = 0; calls.connected.length = 0; calls.heartbeat.length = 0; calls.end.length = 0;
  const logs = [];
  const realError = console.error;
  console.error = (...args) => logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  try { return await run({ origin, logs, database, outbound }); }
  finally { console.error = realError; outbound.restore(); await new Promise((resolve) => server.close(resolve)); }
}
const post = (origin, path, { headers = {}, body = "{}" } = {}) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
const nothingRan = ({ outbound, database }) => {
  assert.deepEqual(outbound.blocked, [], "no request to any other destination was attempted");
  assert.equal(database.total(), 0, `no database query or connection: ${JSON.stringify(database.calls)}`);
  assert.deepEqual([calls.connected.length, calls.heartbeat.length, calls.end.length], [0, 0, 0], "no settlement function ran");
};

test("the limits are sized to the bodies the routes carry", () => {
  assert.equal(SETTLEMENT_JSON_LIMIT, "16kb");
  assert.equal(TRANSCRIPT_JSON_LIMIT, "256kb");
});

test("an oversized body is rejected by the small parser before authentication or any settlement work", async (t) => {
  await withApp(t, async (box) => {
    for (const suffix of ["connected", "heartbeat", "end"]) {
      for (const headers of [{}, SIGNED_IN]) {
        // 20 KB is over the 16 KB limit; 1 MB would have been accepted under the old 28 MB parser.
        for (const size of [20_000, 1_000_000]) {
          const response = await post(box.origin, `/api/voice/live/session/abc/${suffix}`, { headers, body: bodyOfSize(size) });
          assert.equal(response.status, 413, `${suffix} ${size} bytes ${headers["x-test-user"] ? "signed in" : "signed out"}`);
          assert.deepEqual(await response.json(), TOO_LARGE);
        }
      }
    }
    assert.equal(calls.auth, 0, "authentication never ran: the small parser refused first, which costs nothing");
    nothingRan(box);
  });
});

test("a signed-in transcript over 256 KB is rejected before any transcript is saved", async (t) => {
  await withApp(t, async (box) => {
    for (const size of [300_000, 5_000_000]) {
      const response = await post(box.origin, "/api/voice/live/session/abc/transcript", { headers: SIGNED_IN, body: bodyOfSize(size, { segments: [] }) });
      assert.equal(response.status, 413, `${size} bytes`);
      assert.deepEqual(await response.json(), TOO_LARGE);
    }
    nothingRan(box);
  });
});

test("an unauthenticated request never reaches the transcript route's parser, whatever its body", async (t) => {
  await withApp(t, async (box) => {
    // A body over the transcript limit would be 413, and malformed JSON would be 400, if the parser ran.
    for (const body of [bodyOfSize(300_000, { segments: [] }), bodyOfSize(5_000_000, { segments: [] }), `{"segments":`, "not json at all"]) {
      calls.auth = 0;
      const response = await post(box.origin, "/api/voice/live/session/abc/transcript", { body });
      assert.equal(response.status, 401, `${body.length} bytes`);
      assert.deepEqual(await response.json(), { error: "Sign in is required." });
      assert.equal(calls.auth, 1, "authentication ran first, and stopped the request");
    }
    nothingRan(box);
  });
});

test("normal valid requests still work on every settlement route", async (t) => {
  await withApp(t, async (box) => {
    const base = "/api/voice/live/session/abc";
    assert.equal((await post(box.origin, `${base}/connected`, { headers: SIGNED_IN })).status, 204);
    assert.equal((await post(box.origin, `${base}/heartbeat`, { headers: SIGNED_IN })).status, 204);
    const usage = { inputText: 10, outputAudio: 20 };
    const timings = [{ event: "message_submitted", timestampMs: 1, elapsedMs: 0 }];
    assert.equal((await post(box.origin, `${base}/end`, { headers: SIGNED_IN, body: json({ realtimeUsage: usage, timings }) })).status, 204);
    const transcript = await post(box.origin, `${base}/transcript`, { headers: SIGNED_IN, body: JSON.stringify({ segments: [] }) });
    assert.equal(transcript.status, 200);
    assert.deepEqual(await transcript.json(), { conversationId: null }, "an empty transcript saves nothing, so needs no database");
    assert.deepEqual(calls.connected.map(([user, id]) => [user.id, id]), [["user-1", "abc"]]);
    assert.deepEqual(calls.heartbeat.map(([user, id]) => [user.id, id]), [["user-1", "abc"]]);
    assert.deepEqual(calls.end.map(([user, id, seconds, reported, timed]) => [user.id, id, seconds, reported, timed]), [["user-1", "abc", 5, usage, timings]]);
    assert.equal(box.database.total(), 0);
    assert.deepEqual(box.outbound.blocked, []);
  });
});

test("the limits sit at their edges: just under passes, just over is refused", async (t) => {
  await withApp(t, async (box) => {
    // 16 KB is 16384 bytes.
    assert.equal((await post(box.origin, "/api/voice/live/session/abc/end", { headers: SIGNED_IN, body: bodyOfSize(16_000, { actualSeconds: 5 }) })).status, 204);
    assert.equal((await post(box.origin, "/api/voice/live/session/abc/end", { headers: SIGNED_IN, body: bodyOfSize(16_800, { actualSeconds: 5 }) })).status, 413);
    // 256 KB is 262144 bytes; a transcript of realistic size (about 100 KB) passes the parser.
    assert.equal((await post(box.origin, "/api/voice/live/session/abc/transcript", { headers: SIGNED_IN, body: bodyOfSize(100_000, { segments: [] }) })).status, 200);
    assert.equal((await post(box.origin, "/api/voice/live/session/abc/transcript", { headers: SIGNED_IN, body: bodyOfSize(262_000, { segments: [] }) })).status, 200);
    assert.equal((await post(box.origin, "/api/voice/live/session/abc/transcript", { headers: SIGNED_IN, body: bodyOfSize(264_000, { segments: [] }) })).status, 413);
    assert.equal(box.database.total(), 0);
  });
});

test("the retired entry points still answer 410 first, and no other route's parser limit changed", async (t) => {
  await withApp(t, async (box) => {
    for (const path of ["/api/voice/transcribe", "/api/voice/live/session"]) {
      const response = await post(box.origin, path, { body: bodyOfSize(5_000_000) });
      assert.equal(response.status, 410, "even a huge body gets the same 410, unread");
      assert.deepEqual(await response.json(), { error: "Voice is no longer available in VibhavGPT.", code: "voice-removed" });
    }
    nothingRan(box);
  });
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const router = readFileSync(new URL("../src/voice/router.js", import.meta.url), "utf8");
  assert.doesNotMatch(server + router, /28mb/i, "the 28 MB parser is gone");
  assert.match(server, /app\.use\(express\.json\(\{ limit: "1mb" \}\)\);/, "the shared 1 MB parser is untouched");
  const retired = server.indexOf('app.post(["/api/voice/transcribe", "/api/voice/live/session"]');
  const mount = server.indexOf('app.use("/api/voice", voiceRouter);');
  assert.ok(retired > 0 && mount > retired, "the 410 comes before the router");
});

test("each settlement route is wired in the order its comment promises", () => {
  const router = readFileSync(new URL("../src/voice/router.js", import.meta.url), "utf8");
  for (const suffix of ["connected", "heartbeat", "end"]) assert.match(router, new RegExp(`"/live/session/:id/${suffix}", settlementJson, requireSession,`), `${suffix}: small parser, then authentication`);
  assert.match(router, /"\/live\/session\/:id\/transcript", requireSession, transcriptJson,/, "transcript: authentication, then its parser");
  assert.match(router, /const settlementJson = express\.json\(\{ limit: SETTLEMENT_JSON_LIMIT \}\);/);
  assert.match(router, /const transcriptJson = express\.json\(\{ limit: TRANSCRIPT_JSON_LIMIT \}\);/);
});
