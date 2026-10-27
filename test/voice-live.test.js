import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { readFile } from "node:fs/promises";

process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
const { sanitizeCometTimings } = await import("../src/voice/live-comet.js");
const { creditsForLiveSessionReservation, creditsForLiveSessionSettlement, MINI_POOL_SECONDS, PRO_FLAGSHIP_MONTHLY_SECONDS, liveSessionSettlement, realtimeUsageCost, staleLiveSessionCondition } = await import("../src/voice/live-usage.js");
const { creditsForVoiceSeconds } = await import("../src/usage/service.js");

// Voice is retired: no route starts a session (see src/voice/router.js and the
// last test below). What stays covered here is the code that still runs, which
// settles and reconciles a call that was connected before voice was removed.

test("settling an earlier call: the quota table keeps Plus limited and Pro unlimited", () => {
  assert.equal(MINI_POOL_SECONDS.free, 0);
  assert.equal(MINI_POOL_SECONDS.plus, 600);
  assert.equal(PRO_FLAGSHIP_MONTHLY_SECONDS, Infinity);
  assert.equal(creditsForLiveSessionReservation("plus", 900), 225);
  assert.equal(creditsForLiveSessionReservation("pro", 900), 0);
  assert.equal(creditsForLiveSessionSettlement({ status: "completed", actualSeconds: 60 }, "plus"), 15);
  assert.equal(creditsForLiveSessionSettlement({ status: "completed", actualSeconds: 60 }, "pro"), 0);
});

test("settling an earlier call charges per second at 15 credits per minute rounded once", () => {
  assert.equal(creditsForVoiceSeconds(1), 1);
  assert.equal(creditsForVoiceSeconds(4), 1);
  assert.equal(creditsForVoiceSeconds(5), 2);
  assert.equal(creditsForVoiceSeconds(60), 15);
});

test("an earlier call's end report keeps only the six sanitized timing milestones", () => {
  assert.deepEqual(sanitizeCometTimings([
    { event: "message_submitted", timestampMs: 10, elapsedMs: 0, content: "redacted" },
    { event: "audio_playback_started", timestampMs: 300, elapsedMs: 290 },
    { event: "not-a-comet-event", timestampMs: 400, elapsedMs: 390 },
  ]), [
    { event: "message_submitted", timestampMs: 10, elapsedMs: 0 },
    { event: "audio_playback_started", timestampMs: 300, elapsedMs: 290 },
  ]);
});

test("settling an earlier call: the realtime usage estimate includes cached input and the separate transcription model", () => {
  assert.deepEqual(realtimeUsageCost({ inputAudio: 300, cachedInputText: 100, outputAudio: 600, outputText: 100 }), {
    inputTokens: 400, outputTokens: 700, costMicros: 15_246,
  });
  assert.equal(realtimeUsageCost({ inputAudio: -1 }), null);
  assert.deepEqual(realtimeUsageCost({ inputAudio: 100, transcriptionInputAudio: 50, transcriptionOutputText: 10 }), { inputTokens: 150, outputTokens: 10, costMicros: 1_113 });
  assert.equal(realtimeUsageCost(null), null);
});

test("reconciling unfinished earlier calls emits a timestamp-typed cutoff query", () => {
  const query = new PgDialect().sqlToQuery(staleLiveSessionCondition(new Date("2026-09-22T00:00:00.000Z")));
  assert.equal(
    query.sql,
    '"voice_live_sessions"."created_at" < ($1::timestamptz - ("voice_live_sessions"."reserved_seconds" + $2) * interval \'1 second\')',
  );
  assert.deepEqual(query.params, [new Date("2026-09-22T00:00:00.000Z"), 120]);
});

test("an earlier call that failed before connecting is abandoned and refunds its entire reservation", () => {
  const settlement = liveSessionSettlement({ reservedSeconds: 900, connectedAt: null, lastActivityAt: null }, new Date("2026-09-23T01:00:00.000Z"));
  assert.deepEqual(settlement, { status: "abandoned", actualSeconds: 0 });
  assert.equal(creditsForLiveSessionSettlement(settlement), 0);
});

test("stale connected earlier calls settle at their final authenticated heartbeat, not the reservation cap", () => {
  const settlement = liveSessionSettlement({
    reservedSeconds: 900,
    connectedAt: new Date("2026-09-23T00:00:00.000Z"),
    lastActivityAt: new Date("2026-09-23T00:00:47.000Z"),
  }, new Date("2026-09-24T00:00:00.000Z"), { useLastActivity: true, status: "incomplete" });
  assert.deepEqual(settlement, { status: "incomplete", actualSeconds: 47 });
  assert.equal(creditsForLiveSessionSettlement(settlement), 12);
});

test("the lifecycle routes and migration that settle an earlier call are still present", async () => {
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
