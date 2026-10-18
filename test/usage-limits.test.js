import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { usageEvents, subscriptions, creditLedger } from "../src/db/schema.js";
process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
const { LIMITS, GENERATION_LIMITS, VOICE_LIMITS, normalizedProviderUsage, actualApiCostUsd, creditsForImage, creditsForVoiceSeconds, checkUsageLimit, utcMonthWindow, rollingTokenWindow, monthlyEntitlementPeriodEnd, monthlyEntitlementPeriodStart, reserveUsage, finalizeUsage, cancelUsageReservation, getCurrentUsage, createUsageTracker, inferenceTokenBudget } = await import("../src/usage/service.js");
const { VISION_IMAGE_TOKEN_ESTIMATE } = await import("../src/chat/context-window.js");

const blank = (tier = "free") => ({ tier, tokenBreakdown: {}, rollingTokenBreakdown: {}, reservedTokenBreakdown: {}, creditBalance: 99999, periodEndsAt: new Date("2026-11-01T00:00:00Z") });
test("every plan has the exact monthly and 5-hour caps", () => {
  assert.deepEqual(Object.values(LIMITS.free).map(({monthly, rolling}) => [monthly, rolling]), [[1e6,1e5],[1e6,1e5],[5e5,5e4],[0,0],[0,0]]);
  assert.deepEqual(Object.values(LIMITS.plus).map(({monthly, rolling}) => [monthly, rolling]), [[8e6,8e5],[8e6,8e5],[4e6,4e5],[1.5e6,1.5e5],[3e5,3e4]]);
  assert.deepEqual(Object.values(LIMITS.pro).map(({monthly, rolling}) => [monthly, rolling]), [[12e6,1.2e6],[12e6,1.2e6],[6e6,6e5],[3e6,3e5],[8e5,8e4]]);
  assert.equal(GENERATION_LIMITS.plus.images, 25);
  assert.equal(GENERATION_LIMITS.pro.images, 60);
  assert.deepEqual(VOICE_LIMITS, { free: 0, plus: 10, pro: 30, paid: 30 });
  assert.equal(creditsForImage(), 3);
  assert.equal(creditsForVoiceSeconds(60), 15);
});
test("monthly and rolling limits independently block every model, regardless of credits", () => {
  for (const tier of ["free", "plus", "pro"]) for (const [key, caps] of Object.entries(LIMITS[tier])) {
    if (!caps.monthly) { assert.throws(() => checkUsageLimit(blank(tier), key), (e) => e.reason === "plan"); continue; }
    for (const [window, field] of [["monthly", "tokenBreakdown"], ["rolling", "rollingTokenBreakdown"]]) {
      const usage = { ...blank(tier), [field]: { [key]: { total: caps[window] - 1 } } };
      assert.doesNotThrow(() => checkUsageLimit(usage, key, 1));
      assert.throws(() => checkUsageLimit(usage, key, 2), (e) => e.reason === "quota" && e.window === window && /limit/.test(e.message));
      usage[field][key].total++;
      assert.throws(() => checkUsageLimit(usage, key), (e) => e.status === 429 && e.window === window);
    }
  }
});
test("models and users have independent allowances and pending budgets prevent oversubscription", () => {
  const usage = { ...blank(), tokenBreakdown: { nova: { total: 1e6 } }, rollingTokenBreakdown: { nova: { total: 1e5 } }, reservedTokenBreakdown: { study: 49999 } };
  assert.doesNotThrow(() => checkUsageLimit(usage, "lumen"));
  assert.doesNotThrow(() => checkUsageLimit(usage, "study", 1));
  assert.throws(() => checkUsageLimit(usage, "study", 2), /Study limit/);
  assert.doesNotThrow(() => checkUsageLimit(blank(), "nova"));
});
test("cached and reasoning details are subsets of provider token totals", () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 100 } };
  assert.deepEqual(normalizedProviderUsage(usage), { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400, reasoningTokens: 100 });
  assert.equal(actualApiCostUsd("study", usage), (600 * 0.1 + 400 * 0.01 + 200 * 0.5) / 1e6);
  assert.deepEqual(normalizedProviderUsage({ input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } }), { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningTokens: 0 });
});
test("token windows handle month, year, leap-day, and exact rolling boundaries", () => {
  for (const [time, start, end] of [["2026-12-31T23:59:59Z", "2026-12-01T00:00:00Z", "2027-01-01T00:00:00Z"], ["2028-02-29T12:00:00Z", "2028-02-01T00:00:00Z", "2028-03-01T00:00:00Z"]]) {
    assert.deepEqual(utcMonthWindow(new Date(time)), { start: new Date(start), end: new Date(end) });
  }
  assert.equal(rollingTokenWindow(new Date("2026-10-01T02:00:00Z")).start.toISOString(), "2026-09-30T21:00:00.000Z");
});

test("Lumen cost estimates use paid fallback rates without assuming cached-input discounts", () => {
  assert.equal(actualApiCostUsd("lumen", { prompt_tokens: 1000, completion_tokens: 200 }), (1000 * 0.30 + 200 * 2.50) / 1e6);
  assert.equal(actualApiCostUsd("lumen", { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } }), (1000 * 0.30 + 200 * 2.50) / 1e6);
  assert.equal(actualApiCostUsd("nova", { prompt_tokens: 1000, completion_tokens: 200 }), (1000 * 0.14 + 200 * 0.42) / 1e6);
});

async function fixture() {
  const client = new PGlite();
  await client.exec(`CREATE TABLE usage_events (id uuid primary key default gen_random_uuid(), user_id text not null, model text not null, input_tokens integer default 0 not null, output_tokens integer default 0 not null, cost_micros integer default 0 not null, usage_units double precision default 1 not null, thinking_effort text default 'normal' not null, created_at timestamptz default now() not null, updated_at timestamptz default now() not null);
    CREATE TABLE subscriptions (id uuid primary key default gen_random_uuid(), user_id text, customer_id text, subscription_id text, tier text, status text, billing_source text, provider_product_id text, provider_base_plan_id text, provider_purchase_token_hash text, cancel_at_period_end boolean default false, current_period_started_at timestamptz, current_period_ends_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
    CREATE TABLE credit_ledger (id uuid primary key default gen_random_uuid(), user_id text, credits integer, kind text, usage_event_id uuid, external_reference text unique, created_at timestamptz default now(), updated_at timestamptz default now());
    CREATE FUNCTION pg_advisory_xact_lock(integer) RETURNS void LANGUAGE SQL AS 'SELECT';`);
  await client.exec(await readFile(new URL("../drizzle/0023_token_reservations.sql", import.meta.url), "utf8"));
  return { client, db: drizzle(client) };
}

test("Lumen settlement stores its cost estimate while quotas count only reported tokens", async () => {
  const f = await fixture();
  try {
    const now = new Date();
    const event = await reserveUsage("lumen-cost", "lumen", "normal", 2000, f.db, now);
    await finalizeUsage(event.id, { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } }, f.db, "lumen");
    const [stored] = await f.db.select().from(usageEvents);
    assert.equal(stored.costMicros, 800);
    assert.equal(stored.reservedTokens, 0);
    const usage = await getCurrentUsage("lumen-cost", f.db, new Date(now.getTime() + 1));
    assert.equal(usage.tokenBreakdown.lumen.total, 1200);
    assert.equal(usage.rollingTokenBreakdown.lumen.total, 1200);
  } finally { await f.client.close(); }
});

test("historical Spark tokens and holds share the Lumen pool and new alias reservations write lumen", async () => {
  const f = await fixture();
  try {
    const now = new Date("2026-10-04T12:00:00Z");
    await f.db.insert(usageEvents).values([
      { userId: "a", model: "spark", inputTokens: 60000, outputTokens: 1000, createdAt: now },
      { userId: "a", model: "lumen", inputTokens: 20000, outputTokens: 1000, createdAt: now },
      { userId: "a", model: "spark", reservedTokens: 17000, reservationExpiresAt: new Date(now.getTime() + 60000), createdAt: now },
    ]);
    const usage = await getCurrentUsage("a", f.db, now);
    assert.equal(usage.tokenBreakdown.lumen.total, 82000);
    assert.equal(usage.rollingTokenBreakdown.lumen.total, 82000);
    assert.equal(usage.reservedTokenBreakdown.lumen, 17000);
    assert.equal(usage.rollingReservedTokenBreakdown.lumen, 17000);
    assert.equal(usage.tokenBreakdown.spark, undefined);
    await assert.rejects(reserveUsage("a", "lumen", "normal", 1001, f.db, now), /Lumen limit/);
    for (const key of ["spark", "lumen"]) {
      const event = await reserveUsage("b", key, "normal", 100, f.db, now);
      const stored = (await f.db.select().from(usageEvents)).find((row) => row.id === event.id);
      assert.equal(stored.model, "lumen");
    }
    assert.deepEqual(LIMITS.free.lumen, { monthly: 1e6, rolling: 1e5 });
    assert.deepEqual(LIMITS.plus.lumen, { monthly: 8e6, rolling: 8e5 });
    assert.deepEqual(LIMITS.pro.lumen, { monthly: 12e6, rolling: 1.2e6 });
  } finally { await f.client.close(); }
});
test("Lumen usage counts lumen and spark rows, and the retired qwen key is treated as unknown", async () => {
  const f = await fixture();
  try {
    const now = new Date("2026-10-04T12:00:00Z");
    await f.db.insert(usageEvents).values([
      { userId: "a", model: "lumen", inputTokens: 3000, outputTokens: 500, createdAt: now },
      { userId: "a", model: "lumen", inputTokens: 1000, outputTokens: 250, createdAt: now },
      { userId: "a", model: "spark", inputTokens: 2000, outputTokens: 250, createdAt: now },
      { userId: "a", model: "nova", inputTokens: 700, outputTokens: 300, createdAt: now },
      { userId: "a", model: "qwen", inputTokens: 9000, outputTokens: 900, createdAt: now },
      { userId: "a", model: "not-a-model", inputTokens: 8000, outputTokens: 800, createdAt: now },
    ]);
    const usage = await getCurrentUsage("a", f.db, now);
    assert.deepEqual(usage.tokenBreakdown.lumen, { input: 6000, output: 1000, total: 7000 });
    assert.equal(usage.rollingTokenBreakdown.lumen.total, 7000);
    assert.equal(usage.tokenBreakdown.nova.total, 1000);
    assert.equal(usage.tokenBreakdown.qwen, undefined);
    for (const key of ["qwen", "not-a-model"]) {
      await assert.rejects(reserveUsage("b", key, "normal", 100, f.db, now), (error) => error.code === "plan-required" && error.status === 403);
    }
    assert.equal((await f.db.select().from(usageEvents)).filter((row) => row.userId === "b").length, 0);
  } finally { await f.client.close(); }
});
test("the pre-request hold counts text at bytes / 3, plus the output budget and margin", () => {
  const messages = [{ role: "user", content: "abc" }];
  const json = '{"messages":[{"role":"user","content":"abc"}]}';
  assert.equal(inferenceTokenBudget(messages, undefined, 100), Math.ceil(Buffer.byteLength(json) / 3) + 100 + 512);
  // Tools are part of the request, so they are part of the hold.
  const tools = [{ type: "function", function: { name: "web_search" } }];
  const withTools = '{"messages":[{"role":"user","content":"abc"}],"tools":[{"type":"function","function":{"name":"web_search"}}]}';
  assert.equal(inferenceTokenBudget(messages, tools, 100), Math.ceil(Buffer.byteLength(withTools) / 3) + 100 + 512);
  // Multi-byte text is counted by UTF-8 bytes and rounds up.
  const accented = [{ role: "user", content: "é" }];
  assert.equal(inferenceTokenBudget(accented, undefined, 0), Math.ceil(Buffer.byteLength('{"messages":[{"role":"user","content":"é"}]}') / 3) + 512);
});
test("each image holds the context window's fixed estimate, whatever its encoded size", () => {
  assert.equal(VISION_IMAGE_TOKEN_ESTIMATE, 4_096);
  const prompt = (urls) => [{ role: "user", content: [{ type: "text", text: "What is this?" }, ...urls.map((url) => ({ type: "image_url", image_url: { url } }))] }];
  const small = inferenceTokenBudget(prompt(["data:image/png;base64,AAAA"]), undefined, 2_048);
  const large = inferenceTokenBudget(prompt([`data:image/png;base64,${"A".repeat(2_000_000)}`]), undefined, 2_048);
  assert.equal(large, small, "base64 bytes never count as text");
  const none = inferenceTokenBudget(prompt([]), undefined, 2_048);
  const two = inferenceTokenBudget(prompt(["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"]), undefined, 2_048);
  // The image part's own JSON wrapper is a few bytes of text.
  assert.ok(small - none >= 4_096 && small - none < 4_096 + 20, `one image adds ${small - none}`);
  assert.ok(two - none >= 8_192 && two - none < 8_192 + 40, `two images add ${two - none}`);
});
test("a standard Vesper image request is held well below the Plus 5-hour cap", async () => {
  const { buildIdentitySystemPrompt } = await import("../src/chat/prompts.js");
  const { CHAT_TOOLS } = await import("../src/chat/tool-calls.js");
  const messages = [
    { role: "system", content: buildIdentitySystemPrompt("vesper") },
    { role: "user", content: [{ type: "text", text: "What is in this picture?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
  ];
  // responseTokenBudget's output budgets for normal, high and max effort.
  for (const [effort, maxTokens] of [["normal", 2_048], ["high", 4_096], ["max", 8_192]]) {
    const hold = inferenceTokenBudget(messages, CHAT_TOOLS, maxTokens);
    // A normal-effort image prompt fits twice in Plus's 5-hour window; every
    // effort fits in the whole window and in 46% of Pro's.
    if (effort === "normal") assert.ok(hold < LIMITS.plus.vesper.rolling / 2, `normal: ${hold} is under half of Plus's ${LIMITS.plus.vesper.rolling}`);
    assert.ok(hold < LIMITS.plus.vesper.rolling, `${effort}: ${hold} is under Plus's ${LIMITS.plus.vesper.rolling}`);
    assert.ok(hold < LIMITS.pro.vesper.rolling * 0.46, `${effort}: ${hold} fits in 46% of Pro's ${LIMITS.pro.vesper.rolling}`);
  }
});
test("failed generations refund reserved credits exactly once", async () => {
  const f = await fixture();
  try {
    const [event] = await f.db.insert(usageEvents).values({ userId: "refund-user", model: "__generation__" }).returning();
    const [reservation] = await f.db.insert(creditLedger).values({ userId: "refund-user", credits: -3, kind: "generation_reservation", usageEventId: event.id }).returning();
    await cancelUsageReservation(event.id, reservation.id, f.db);
    await cancelUsageReservation(event.id, reservation.id, f.db);
    const entries = await f.db.select().from(creditLedger);
    assert.equal(entries.length, 2);
    assert.equal(entries.reduce((sum, entry) => sum + entry.credits, 0), 0);
    assert.equal(entries.find((entry) => entry.kind === "usage_refund").externalReference, `refund:${reservation.id}`);
    assert.deepEqual(await f.db.select().from(usageEvents), []);
  } finally { await f.client.close(); }
});
test("settled tokens are counted when the next request starts in the same millisecond", async () => {
  const f = await fixture();
  try {
    const now = new Date("2026-10-04T12:00:00Z");
    const event = await reserveUsage("a", "study", "normal", 30000, f.db, now);
    await finalizeUsage(event.id, { prompt_tokens: 30000, completion_tokens: 0 }, f.db, "study");
    const usage = await getCurrentUsage("a", f.db, now);
    assert.equal(usage.tokenBreakdown.study.total, 30000);
    assert.equal(usage.rollingTokenBreakdown.study.total, 30000);
    await assert.rejects(reserveUsage("a", "study", "normal", 30000, f.db, now), /Study limit/);
  } finally { await f.client.close(); }
});
test("database aggregation separates users, resets calendar months, and expires exactly 5-hour-old tokens", async () => {
  const f = await fixture();
  try {
    const now = new Date("2026-10-01T02:00:00Z");
    await f.db.insert(usageEvents).values([
      { userId: "a", model: "study", inputTokens: 100, outputTokens: 20, createdAt: new Date("2026-09-30T23:00:00Z") },
      { userId: "a", model: "nova", inputTokens: 300, outputTokens: 40, createdAt: new Date("2026-09-30T21:00:00Z") },
      { userId: "a", model: "study", inputTokens: 200, outputTokens: 30, createdAt: new Date("2026-10-01T01:00:00Z") },
      { userId: "b", model: "study", inputTokens: 50000, createdAt: new Date("2026-10-01T01:00:00Z") },
    ]);
    const usage = await getCurrentUsage("a", f.db, now);
    assert.equal(usage.tokenBreakdown.study.total, 230);
    assert.equal(usage.rollingTokenBreakdown.study.total, 350);
    assert.equal(usage.rollingTokenBreakdown.nova.total, 0);
    assert.equal(usage.periodEndsAt.toISOString(), "2026-11-01T00:00:00.000Z");
    assert.equal(usage.tokenBreakdown.nova.total, 0);
    await f.db.insert(usageEvents).values({ userId: "a", model: "study", reservedTokens: 50000, reservationExpiresAt: null, createdAt: new Date("2026-09-30T23:59:59Z") });
    const held = await getCurrentUsage("a", f.db, now);
    assert.equal(held.reservedTokenBreakdown.study, 0);
    assert.equal(held.rollingReservedTokenBreakdown.study, 0);
    assert.doesNotThrow(() => checkUsageLimit(held, "study"));

  } finally { await f.client.close(); }
});
test("database reservations block concurrent budgets, settle actual usage, and refund failures without erasing usage", async () => {
  const f = await fixture();
  try {
    const first = await reserveUsage("a", "study", "normal", 30000, f.db);
    await assert.rejects(reserveUsage("a", "study", "normal", 30000, f.db), /Study limit/);
    await finalizeUsage(first.id, { prompt_tokens: 1000, completion_tokens: 200 }, f.db, "study");
    await cancelUsageReservation(first.id, null, f.db);
    assert.equal((await getCurrentUsage("a", f.db)).tokenBreakdown.study.total, 1200);
    const failed = await reserveUsage("a", "study", "normal", 30000, f.db);
    await cancelUsageReservation(failed.id, null, f.db);
    assert.equal((await getCurrentUsage("a", f.db)).reservedTokenBreakdown.study, 0);
    const tracker = createUsageTracker("b", "nova", "normal", f.db);
    await tracker.beforeCall([{ role: "user", content: "First" }], [], 100);
    await tracker.record({ prompt_tokens: 11, completion_tokens: 2 });
    await tracker.beforeCall([{ role: "user", content: "Tool result" }], [], 100);
    await tracker.record({ prompt_tokens: 22, completion_tokens: 3 });
    await tracker.release();
    assert.equal((await getCurrentUsage("b", f.db)).tokenBreakdown.nova.total, 38);
  } finally { await f.client.close(); }
});
test("expired reservations clear, missing usage keeps a conservative hold, and paid text uses calendar months", async () => {
  const f = await fixture();
  try {
    const now = new Date();
    await f.db.insert(subscriptions).values({ userId: "plus", tier: "plus", status: "active", currentPeriodStartedAt: new Date(now.getTime() - 15 * 86400000), currentPeriodEndsAt: new Date(now.getTime() + 15 * 86400000) });
    assert.equal((await getCurrentUsage("plus", f.db, now)).periodStart.toISOString(), utcMonthWindow(now).start.toISOString());
    await f.db.insert(usageEvents).values({ userId: "a", model: "study", reservedTokens: 50000, reservationExpiresAt: new Date(now.getTime() - 1) });
    assert.equal((await getCurrentUsage("a", f.db, now)).reservedTokenBreakdown.study, 0);
    const tracker = createUsageTracker("a", "study", "normal", f.db);
    await tracker.beforeCall([{ role: "user", content: "Explain" }], [], 100);
    await assert.rejects(tracker.record({}), /confirm token usage/);
    await tracker.release();
    const usage = await getCurrentUsage("a", f.db);
    assert.equal(usage.tokenBreakdown.study.total, 0);
    assert.ok(usage.reservedTokenBreakdown.study > 0);
    const rows = await f.db.select().from(usageEvents);
    const hold = rows.find((row) => row.reservedTokens > 0 && row.reservationExpiresAt > now);
    assert.ok(hold.reservationExpiresAt, "missing usage must not remove the expiry");
    const expired = await getCurrentUsage("a", f.db, hold.reservationExpiresAt);
    assert.equal(expired.reservedTokenBreakdown.study, 0);
    assert.equal(expired.rollingReservedTokenBreakdown.study, 0);
  } finally { await f.client.close(); }
});
test("Plus monthly limits reset on the subscription billing-date anniversary", () => {
  const subscription = { currentPeriodStartedAt: new Date("2026-01-15T12:00:00.000Z") };
  assert.equal(
    monthlyEntitlementPeriodStart(subscription, new Date("2026-03-14T23:59:59.000Z")).toISOString(),
    "2026-02-15T12:00:00.000Z",
  );
  assert.equal(
    monthlyEntitlementPeriodStart(subscription, new Date("2026-03-15T12:00:00.000Z")).toISOString(),
    "2026-03-15T12:00:00.000Z",
  );
  const monthEndSubscription = { currentPeriodStartedAt: new Date("2026-01-31T12:00:00.000Z") };
  assert.equal(
    monthlyEntitlementPeriodStart(monthEndSubscription, new Date("2026-03-01T12:00:00.000Z")).toISOString(),
    "2026-02-28T12:00:00.000Z",
  );
  assert.equal(
    monthlyEntitlementPeriodStart(monthEndSubscription, new Date("2026-03-31T12:00:00.000Z")).toISOString(),
    "2026-03-31T12:00:00.000Z",
  );
  assert.equal(
    monthlyEntitlementPeriodEnd(monthEndSubscription, new Date("2026-03-01T12:00:00.000Z")).toISOString(),
    "2026-03-31T12:00:00.000Z",
  );
});

test("Nebula estimates the highest verified route rates without a cache discount or quota change", () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } };
  assert.equal(actualApiCostUsd("nebula", usage), (1000 * 0.65 + 200 * 3.41) / 1e6);
  assert.deepEqual(LIMITS.plus.nebula, { monthly: 1500000, rolling: 150000 });
  assert.deepEqual(LIMITS.pro.nebula, { monthly: 3000000, rolling: 300000 });
});

test("the same pending-inclusive totals drive Vesper blocking and public quota metadata", () => {
  const usage = { ...blank("pro"), rollingTokenBreakdown: { vesper: { total: 16682 } }, rollingReservedTokenBreakdown: { vesper: 34894 }, nextRollingTokenReleaseAt: { vesper: new Date("2026-10-04T22:00:00Z") } };
  assert.doesNotThrow(() => checkUsageLimit(usage, "vesper", 28424));
  assert.throws(() => checkUsageLimit(usage, "vesper", 28425), (error) => error.window === "rolling" && error.requestTooLarge && error.pending === 34894 && error.used === 51576 && error.limit === 80000 && error.percentage === 64 && error.resetAt === "2026-10-04T22:00:00.000Z");
});

test("legacy null-expiry holds expire at five minutes without losing settled usage", async () => {
  const f = await fixture();
  try {
    const createdAt = new Date("2026-10-04T18:00:00Z");
    await f.db.insert(usageEvents).values([
      { userId: "legacy", model: "vesper", reservedTokens: 34894, createdAt },
      { userId: "legacy", model: "vesper", inputTokens: 100, outputTokens: 20, createdAt },
      { userId: "other", model: "vesper", reservedTokens: 500, createdAt },
    ]);
    const active = await getCurrentUsage("legacy", f.db, new Date("2026-10-04T18:04:59Z"));
    assert.equal(active.reservedTokenBreakdown.vesper, 34894);
    assert.equal(active.rollingReservedTokenBreakdown.vesper, 34894);
    assert.equal(active.nextRollingTokenReleaseAt.vesper.toISOString(), "2026-10-04T18:05:00.000Z");
    const expired = await getCurrentUsage("legacy", f.db, new Date("2026-10-04T18:05:00Z"));
    assert.equal(expired.reservedTokenBreakdown.vesper, 0);
    assert.equal(expired.rollingReservedTokenBreakdown.vesper, 0);
    assert.equal(expired.tokenBreakdown.vesper.total, 120);
    assert.equal(expired.rollingTokenBreakdown.vesper.total, 120);
    assert.equal(expired.nextRollingTokenReleaseAt.vesper.toISOString(), "2026-10-04T23:00:00.000Z");
  } finally { await f.client.close(); }
});

test("failed database settlement preserves the original reservation expiry", async () => {
  const f = await fixture();
  try {
    const executor = { transaction: (fn) => f.db.transaction(fn), update: () => { throw new Error("settlement failed"); } };
    const tracker = createUsageTracker("failed-settlement", "nova", "normal", executor);
    await tracker.beforeCall([{ role: "user", content: "Hello" }], [], 100);
    const [before] = await f.db.select().from(usageEvents);
    await assert.rejects(tracker.record({ prompt_tokens: 10, completion_tokens: 2 }), /settlement failed/);
    await tracker.release();
    const [after] = await f.db.select().from(usageEvents);
    assert.equal(after.reservationExpiresAt.toISOString(), before.reservationExpiresAt.toISOString());
    assert.equal(after.reservedTokens, before.reservedTokens);
    const expired = await getCurrentUsage("failed-settlement", f.db, before.reservationExpiresAt);
    assert.equal(expired.reservedTokenBreakdown.nova, 0);
    assert.equal(expired.rollingReservedTokenBreakdown.nova, 0);
  } finally { await f.client.close(); }
});

test("release times include expiring holds and settled usage leaving the rolling window", async () => {
  const f = await fixture();
  try {
    const now = new Date("2026-10-04T18:00:00Z");
    await f.db.insert(usageEvents).values([
      { userId: "release", model: "vesper", inputTokens: 100, outputTokens: 10, createdAt: new Date("2026-10-04T14:00:00Z") },
      { userId: "release", model: "vesper", reservedTokens: 500, reservationExpiresAt: new Date("2026-10-04T18:04:00Z"), createdAt: now },
    ]);
    const usage = await getCurrentUsage("release", f.db, now);
    assert.equal(usage.nextRollingTokenReleaseAt.vesper.toISOString(), "2026-10-04T18:04:00.000Z");
    assert.equal(usage.nextMonthlyTokenReleaseAt.vesper.toISOString(), "2026-10-04T18:04:00.000Z");
    const after = await getCurrentUsage("release", f.db, new Date("2026-10-04T18:05:00Z"));
    assert.equal(after.nextRollingTokenReleaseAt.vesper.toISOString(), "2026-10-04T19:00:00.000Z");
    assert.equal(after.rollingReservedTokenBreakdown.vesper, 0);
  } finally { await f.client.close(); }
});
