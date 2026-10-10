import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { readFile } from "node:fs/promises";

process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
const { config } = await import("../src/config.js");
const { createLiveCometSession, LiveCometConfigError, VoiceSessionError, sanitizeCometTimings } = await import("../src/voice/live-comet.js");
const { creditsForLiveSessionReservation, creditsForLiveSessionSettlement, LIVE_VOICE_MODEL, MINI_POOL_SECONDS, PRO_FLAGSHIP_MONTHLY_SECONDS, liveSessionSettlement, realtimeUsageCost, staleLiveSessionCondition } = await import("../src/voice/live-usage.js");
const { creditsForVoiceSeconds } = await import("../src/usage/service.js");

const user = { id: "test-user", name: "Test" };
const reservation = { id: "session-1", model: LIVE_VOICE_MODEL, reservedSeconds: 120 };

test("voice monthly quota table keeps Plus limited while Pro Comet is unlimited", () => {
  assert.equal(MINI_POOL_SECONDS.free, 0);
  assert.equal(MINI_POOL_SECONDS.plus, 600);
  assert.equal(PRO_FLAGSHIP_MONTHLY_SECONDS, Infinity);
  assert.equal(creditsForLiveSessionReservation("plus", 900), 225);
  assert.equal(creditsForLiveSessionReservation("pro", 900), 0);
  assert.equal(creditsForLiveSessionSettlement({ status: "completed", actualSeconds: 60 }, "plus"), 15);
  assert.equal(creditsForLiveSessionSettlement({ status: "completed", actualSeconds: 60 }, "pro"), 0);
});

test("voice session uses the direct stage's realtime calls multipart SDP exchange", async () => {
  let request;
  const result = await createLiveCometSession(user, "offer-sdp", {
    apiKey: "test-key", reserve: async () => reservation, instructionsForUser: async () => "hello",
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, text: async () => "answer-sdp" }; },
  });
  assert.equal(request.url, `${config.providerBaseUrls.study}/realtime/calls`);
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.equal(request.options.body.get("sdp"), "offer-sdp");
  const session = JSON.parse(request.options.body.get("session"));
  assert.equal(session.type, "realtime");
  assert.equal(session.model, config.voice.realtimeModel);
  assert.equal(session.instructions, "hello");
  assert.equal(session.audio.input.transcription.model, config.voice.transcriptionModel);
  assert.equal(session.audio.output.voice, config.voice.voiceName);
  assert.equal(LIVE_VOICE_MODEL, session.model);
  assert.equal(result.sdp, "answer-sdp");
  assert.equal(Object.hasOwn(result, "model"), false);
});

test("quota rejection makes no upstream call and remains client-safe", async () => {
  let called = false;
  await assert.rejects(() => createLiveCometSession(user, "offer", {
    apiKey: "test-key", reserve: async () => { throw new VoiceSessionError(); }, fetchImpl: async () => { called = true; },
  }), (error) => error instanceof VoiceSessionError && /voice is temporarily unavailable/i.test(error.message));
  assert.equal(called, false);
});

test("voice charges per second at 15 credits per minute rounded once", () => {
  assert.equal(creditsForVoiceSeconds(1), 1);
  assert.equal(creditsForVoiceSeconds(4), 1);
  assert.equal(creditsForVoiceSeconds(5), 2);
  assert.equal(creditsForVoiceSeconds(60), 15);
});

test("Comet latency diagnostics accept only the six sanitized timing milestones", () => {
  assert.deepEqual(sanitizeCometTimings([
    { event: "message_submitted", timestampMs: 10, elapsedMs: 0, content: "redacted" },
    { event: "audio_playback_started", timestampMs: 300, elapsedMs: 290 },
    { event: "not-a-comet-event", timestampMs: 400, elapsedMs: 390 },
  ]), [
    { event: "message_submitted", timestampMs: 10, elapsedMs: 0 },
    { event: "audio_playback_started", timestampMs: 300, elapsedMs: 290 },
  ]);
});

test("Realtime usage estimate includes cached input and the separate transcription model", () => {
  assert.deepEqual(realtimeUsageCost({ inputAudio: 300, cachedInputText: 100, outputAudio: 600, outputText: 100 }), {
    inputTokens: 400, outputTokens: 700, costMicros: 15_246,
  });
  assert.equal(realtimeUsageCost({ inputAudio: -1 }), null);
  assert.deepEqual(realtimeUsageCost({ inputAudio: 100, transcriptionInputAudio: 50, transcriptionOutputText: 10 }), { inputTokens: 150, outputTokens: 10, costMicros: 1_113 });
  assert.equal(realtimeUsageCost(null), null);
});

test("stale voice reconciliation emits a timestamp-typed cutoff query", () => {
  const query = new PgDialect().sqlToQuery(staleLiveSessionCondition(new Date("2026-09-22T00:00:00.000Z")));
  assert.equal(
    query.sql,
    '"voice_live_sessions"."created_at" < ($1::timestamptz - ("voice_live_sessions"."reserved_seconds" + $2) * interval \'1 second\')',
  );
  assert.deepEqual(query.params, [new Date("2026-09-22T00:00:00.000Z"), 120]);
});

test("failed live-session setup maps errors and invokes the reservation refund cleanup", async () => {
  let refunded = null;
  await assert.rejects(() => createLiveCometSession(user, "offer", {
    apiKey: "test-key", reserve: async () => reservation, instructionsForUser: async () => "hello",
    fetchImpl: async () => ({ ok: false, status: 503 }), cancel: async (userId, sessionId) => { refunded = { userId, sessionId }; },
  }), (error) => error instanceof LiveCometConfigError && error.message === "Voice is temporarily unavailable. Please try again shortly.");
  assert.deepEqual(refunded, { userId: user.id, sessionId: reservation.id });
});

test("a failed-before-connect session is abandoned and refunds its entire reservation", () => {
  const settlement = liveSessionSettlement({ reservedSeconds: 900, connectedAt: null, lastActivityAt: null }, new Date("2026-09-23T01:00:00.000Z"));
  assert.deepEqual(settlement, { status: "abandoned", actualSeconds: 0 });
  assert.equal(creditsForLiveSessionSettlement(settlement), 0);
});

test("stale connected sessions settle at their final authenticated heartbeat, not the reservation cap", () => {
  const settlement = liveSessionSettlement({
    reservedSeconds: 900,
    connectedAt: new Date("2026-09-23T00:00:00.000Z"),
    lastActivityAt: new Date("2026-09-23T00:00:47.000Z"),
  }, new Date("2026-09-24T00:00:00.000Z"), { useLastActivity: true, status: "incomplete" });
  assert.deepEqual(settlement, { status: "incomplete", actualSeconds: 47 });
  assert.equal(creditsForLiveSessionSettlement(settlement), 12);
});

test("voice connection activity migration and router endpoints are present", async () => {
  const [migration, router] = await Promise.all([
    readFile(new URL("../drizzle/0017_voice_live_connection_activity.sql", import.meta.url), "utf8"),
    readFile(new URL("../src/voice/router.js", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /connected_at timestamp with time zone/);
  assert.match(migration, /last_activity_at timestamp with time zone/);
  assert.match(router, /\/live\/session\/:id\/connected/);
  assert.match(router, /\/live\/session\/:id\/heartbeat/);
});

test("voice entry points are closed: dictation and new Live Comet sessions answer 410", async () => {
  const source = await readFile(new URL("../src/voice/router.js", import.meta.url), "utf8");
  assert.match(source, /voiceRouter\.post\(\["\/transcribe", "\/live\/session"\], \(req, res\) => res\.status\(410\)\.json\(VOICE_REMOVED\)\)/);
  assert.match(source, /code: "voice-removed"/);
  assert.doesNotMatch(source, /createLiveCometSession|reserveVoiceUsage|audio\/transcriptions/);
});
