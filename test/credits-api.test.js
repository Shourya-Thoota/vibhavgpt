/**
 * GET /api/usage and GET /api/usage/policy over the real routers and an
 * in-memory database. What the server reports is checked against the shared
 * credits module and the customer view built from it, so the number a screen
 * shows can only be the number the server computed.
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

const schema = await import("../src/db/schema.js");
const { config } = await import("../src/config.js");
const { createUsageRouter } = await import("../src/usage/router.js");
const { allowanceRouter } = await import("../src/usage/allowance-router.js");
const { creditsSummary, creditDenial, resolveCreditsPolicy } = await import("../src/usage/credits.js");
const { accessPayload } = await import("../frontend/src/access-status.js");
const credits = await import("../frontend/src/credits-policy.js");
const { creditsView } = await import("../frontend/src/credits-view.js");
const { default: express } = await import("express");

const DAY = 86_400_000;
// The router's clock is fixed so the weekly window these tests land in never depends on today's date.
// 2026-04-10 12:00 UTC is in the second weekly window (Apr 8 to Apr 15) of a month that began on the 1st.
const FIXED = new Date("2026-04-10T12:00:00.000Z");
const MONTH_START = new Date("2026-04-01T00:00:00.000Z");

async function withCredits({ enabled = true, mode = "expiry", activatedAt = MONTH_START } = {}, fn) {
  const before = { enabled: config.creditsPolicyEnabled, mode: config.creditsCarryMode, at: config.creditsActivatedAt, summary: config.featureAllowanceSummaryApi };
  config.creditsPolicyEnabled = enabled;
  config.creditsCarryMode = mode;
  config.creditsActivatedAt = activatedAt;
  try { return await fn(); } finally { config.creditsPolicyEnabled = before.enabled; config.creditsCarryMode = before.mode; config.creditsActivatedAt = before.at; config.featureAllowanceSummaryApi = before.summary; }
}

let counter = 0;
async function serve(t, userId, clock = FIXED) {
  const app = express();
  app.use((req, _res, next) => { if (userId) req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/usage/allowance", allowanceRouter);
  app.use("/api/usage", createUsageRouter({ now: () => clock }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (path) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
}
// A Plus account ten days into its monthly period: in its second weekly window.
async function plusUser(daysIntoPeriod = 10) {
  const userId = `api_user_${++counter}`;
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
  await db.insert(schema.subscriptions).values({
    userId, tier: "plus", status: "active",
    currentPeriodStartedAt: new Date(FIXED.getTime() - daysIntoPeriod * DAY), currentPeriodEndsAt: new Date(Date.now() + 30 * DAY), updatedAt: new Date(), // the subscription lookup uses the real clock, so it must still be current today
  });
  return userId;
}

test("the policy endpoint is public, tiny and says exactly what the server enforces", async (t) => {
  const get = await serve(t, null);
  const off = await get("/api/usage/policy");
  assert.equal(off.status, 200);
  assert.equal(off.headers.get("cache-control"), "no-store");
  assert.deepEqual(off.body, { version: credits.CREDITS_POLICY_VERSION, active: false, carryMode: null, scheduledFor: null, activatedAt: null, reason: "disabled", unit: { creditMicros: 50_000 } });

  await withCredits({ enabled: true, mode: "" }, async () => {
    const unselected = await get("/api/usage/policy");
    assert.equal(unselected.body.active, false);
    assert.equal(unselected.body.reason, "carry_mode_unselected", "enabled without a choice is reported as exactly that");
    assert.equal(unselected.body.carryMode, null);
  });
  await withCredits({ enabled: true, mode: "expiry", activatedAt: null }, async () => {
    const unset = await get("/api/usage/policy");
    assert.equal(unset.body.active, false);
    assert.equal(unset.body.reason, "activation_time_unset", "enabled with a choice but no activation instant");
    assert.equal(unset.body.scheduledFor, null);
  });
  await withCredits({ enabled: true, mode: "carry", activatedAt: new Date("2026-05-01T00:00:00.000Z") }, async () => {
    const scheduled = await get("/api/usage/policy");
    assert.equal(scheduled.body.active, false, "not active until the instant");
    assert.equal(scheduled.body.reason, "before_activation");
    assert.equal(scheduled.body.carryMode, null, "no mode is enforced yet");
    assert.equal(scheduled.body.scheduledFor, "2026-05-01T00:00:00.000Z", "the schedule is visible to a deployment check");
    assert.equal(scheduled.body.activatedAt, null);
  });
  for (const mode of ["expiry", "carry"]) {
    await withCredits({ enabled: true, mode }, async () => {
      const on = await get("/api/usage/policy");
      assert.equal(on.body.active, true);
      assert.equal(on.body.carryMode, mode);
      assert.equal(on.body.reason, "active");
      assert.equal(on.body.activatedAt, "2026-04-01T00:00:00.000Z");
      assert.equal(on.body.scheduledFor, null);
      assert.deepEqual(Object.keys(on.body).sort(), ["activatedAt", "active", "carryMode", "reason", "scheduledFor", "unit", "version"], "nothing else is disclosed");
    });
  }
  // The same endpoint turns on at the exact instant: it reads the router's clock.
  await withCredits({ enabled: true, mode: "expiry", activatedAt: FIXED }, async () => {
    const before = await serve(t, null, new Date(FIXED.getTime() - 1));
    assert.equal((await before("/api/usage/policy")).body.reason, "before_activation");
    const exactly = await serve(t, null, FIXED);
    assert.equal((await exactly("/api/usage/policy")).body.reason, "active");
  });
});

test("activating mid-month: the screen's numbers are the folded first week, the exact total, and nothing from before", async (t) => {
  const A = new Date("2026-04-10T12:00:00.000Z");
  await withCredits({ mode: "expiry", activatedAt: A }, async () => {
    const userId = await plusUser();
    await db.insert(schema.usageEvents).values([
      { userId, model: "nova", costMicros: 5_000_000, inputTokens: 1, outputTokens: 1, createdAt: new Date("2026-04-05T10:00:00.000Z") }, // before activation: not counted
      { userId, model: "nova", costMicros: 100_000, inputTokens: 1, outputTokens: 1, createdAt: new Date("2026-04-10T12:30:00.000Z") },
    ]);
    const get = await serve(t, userId, new Date("2026-04-10T13:00:00.000Z"));
    const c = (await get("/api/usage")).body.credits;
    assert.equal(c.period.startsAt, "2026-04-10T12:00:00.000Z");
    assert.equal(c.period.monthStartsAt, "2026-04-01T00:00:00.000Z");
    assert.deepEqual(c.period.activation, { at: "2026-04-10T12:00:00.000Z", foldedCredits: 14, firstWeekPartial: true });
    assert.deepEqual(c.schedule.map((week) => week.credits), [28, 14, 14, 4]);
    assert.equal(c.schedule.reduce((sum, week) => sum + week.credits, 0), 60, "the month's total is exact");
    assert.equal(c.monthly.consumedMicros, 110_000, "only the spend after activation, with the markup applied once");
    assert.equal(c.week.allocationCredits, 28);
    assert.equal(c.available.micros, 28 * credits.CREDIT_MICROS - 110_000);
    assert.equal(c.week.endsAt, "2026-04-15T00:00:00.000Z");
    // The customer view still reads cleanly from this payload.
    const view = creditsView(c, { locale: "en-US", timeZone: "UTC" });
    assert.equal(view.rows.find((row) => row.id === "monthly").value, "60 credits per month");
  });
});

test("the usage endpoint is unchanged while credits are off, apart from saying so", async (t) => {
  const userId = await plusUser();
  const get = await serve(t, userId);
  const { status, body } = await get("/api/usage");
  assert.equal(status, 200);
  assert.equal(body.credits, null);
  assert.equal(body.policy.active, false);
  for (const key of ["tier", "tokenBreakdown", "rollingTokenBreakdown", "limits", "creditBalance", "periodEndsAt", "imageGenerationsThisPeriod", "documentLimit"]) {
    assert.ok(key in body, `${key} is still reported`);
  }
  assert.equal(body.tier, "plus");
  assert.equal(body.limits.nova.monthly, 8_000_000, "the token tables still describe the legacy limits");
});

test("an unauthenticated usage request is refused", async (t) => {
  const get = await serve(t, null);
  assert.equal((await get("/api/usage")).status, 401);
});

test("with credits active the usage endpoint reports the server's calculation, and the screen is built from exactly that", async (t) => {
  await withCredits({ mode: "carry" }, async () => {
    const userId = await plusUser();
    await db.insert(schema.usageEvents).values({ userId, model: "nova", costMicros: 1_000_000, inputTokens: 1, outputTokens: 1, createdAt: new Date(FIXED.getTime() - 3_600_000) });
    await db.insert(schema.creditLedger).values({ userId, credits: 320, kind: "stripe_purchase", externalReference: `api:${userId}` });
    const get = await serve(t, userId);
    const { body } = await get("/api/usage");
    const c = body.credits;

    assert.equal(body.policy.active, true);
    assert.equal(c.active, true);
    assert.equal(c.policyVersion, credits.CREDITS_POLICY_VERSION);
    assert.equal(c.carryMode, "carry");
    assert.equal(c.plan, "plus");

    // The totals are the shared module's, and the schedule re-derives from the reported period.
    assert.equal(c.monthly.credits, 60);
    assert.equal(c.monthly.micros, credits.monthlyAllowanceMicros("plus"));
    const recomputed = credits.allocationSchedule({ periodStart: c.period.startsAt, periodEnd: c.period.endsAt, monthlyCredits: c.monthly.credits });
    assert.deepEqual(c.schedule.map((week) => week.credits), recomputed.windows.map((window) => window.credits));
    assert.equal(c.schedule.reduce((sum, week) => sum + week.credits, 0), 60, "the weeks add up to the month");
    assert.equal(c.week.count, recomputed.windows.length);
    assert.equal(c.week.allocationCredits, recomputed.windows[c.week.index].credits);
    assert.equal(c.week.startsAt, new Date(recomputed.windows[c.week.index].startMs).toISOString());

    // Spend, once: the $1.00 provider cost is the ledger's 1.10 debit, which is 22 credits.
    assert.equal(c.monthly.consumedMicros, 1_100_000);
    assert.equal(c.monthly.consumedMicros / credits.CREDIT_MICROS, 22);
    assert.equal(c.monthly.remainingMicros, c.monthly.micros - 1_100_000);

    // Carry: everything allocated so far, less everything spent; never a later week early.
    assert.equal(c.available.micros, Math.max(0, c.allocatedToDateMicros - 1_100_000));
    assert.ok(c.available.micros <= c.monthly.remainingMicros);
    assert.equal(c.futureAllocationMicros, c.monthly.micros - c.allocatedToDateMicros);
    assert.equal(c.nextAllocationAt === null, c.week.isFinal);
    assert.equal(c.resetsAt, c.period.endsAt);

    // Purchased balance rides along, separately.
    assert.deepEqual(c.purchased, { kind: "flex", balance: 320, coversText: false });

    // The customer view shows these numbers in the approved wording.
    const view = creditsView(c, { locale: "en-US", timeZone: "UTC" });
    assert.equal(view.rows.find((row) => row.id === "monthly").value, "60 credits per month");
    assert.equal(view.rows.find((row) => row.id === "allocated").text, `${c.week.allocationCredits} credits allocated this week`);
    assert.equal(view.rows.find((row) => row.id === "used").value, "22 credits");
    assert.equal(view.headline.label, "Available this week");
    assert.equal(view.headline.value, credits.creditsPhrase(c.available.micros, "down"));
    assert.equal(view.flex.balance, 320);
  });
});

test("expiry reports only this week's allocation as spendable", async (t) => {
  await withCredits({ mode: "expiry" }, async () => {
    const userId = await plusUser();
    const get = await serve(t, userId);
    const { body } = await get("/api/usage");
    const c = body.credits;
    assert.equal(c.carryMode, "expiry");
    assert.equal(c.available.micros, c.week.allocationMicros - c.week.consumedMicros, "this week's allocation, less this week's spend");
    assert.equal(c.available.carriedInMicros, 0);
    const view = creditsView(c, { locale: "en-US", timeZone: "UTC" });
    assert.match(view.timing.label, c.week.isFinal ? /Resets on/ : /Resets on/);
    assert.match(view.policyNote, /expire/i);
  });
  await withCredits({ mode: "carry" }, async () => {
    const userId = await plusUser();
    const get = await serve(t, userId);
    const c = (await get("/api/usage")).body.credits;
    const view = creditsView(c, { locale: "en-US", timeZone: "UTC" });
    assert.match(view.timing.label, c.week.isFinal ? /Resets on/ : /Next allocation/);
    assert.match(view.policyNote, /carry forward/i);
  });
});

test("the dollar-based allowance summary API is not available while credits are active", async (t) => {
  await withCredits({ mode: "expiry" }, async () => {
    config.featureAllowanceSummaryApi = true;
    const userId = await plusUser();
    const get = await serve(t, userId);
    const response = await get("/api/usage/allowance");
    assert.equal(response.status, 404);
    assert.equal(response.body.code, "superseded_by_credits");
  });
});

test("the credits payload and the refusal carry no provider names or internal detail", async (t) => {
  await withCredits({ mode: "expiry" }, async () => {
    const userId = await plusUser();
    const get = await serve(t, userId);
    const text = JSON.stringify((await get("/api/usage")).body.credits);
    assert.doesNotMatch(text, /openrouter|openai|anthropic|gemini|claude|groq|composio|stripe|wholesale|markup|1\.10/i);
    assert.deepEqual(Object.keys((await get("/api/usage")).body.credits).sort(), [
      "active", "allocatedToDateMicros", "available", "carryMode", "exhausted", "futureAllocationMicros", "monthly", "nextAllocationAt",
      "period", "plan", "policyVersion", "purchased", "resetsAt", "schedule", "unit", "week",
    ]);
  });
});

test("the refusal reaches the client in the shape the notice reads, including how its time is worded", () => {
  const policy = { active: true, carryMode: "expiry" };
  const schedule = credits.allocationSchedule({ periodStart: Date.UTC(2026, 3, 1), periodEnd: Date.UTC(2026, 4, 1), monthlyCredits: 5 });
  const balance = credits.computeCreditBalance({ schedule, now: Date.UTC(2026, 3, 10), carryMode: "expiry", spentByWindowMicros: [0, 50_000, 0, 0, 0] });
  const payload = accessPayload(creditDenial({ balance, incomingHoldMicros: 700 }));
  assert.equal(payload.code, "credits_week_exhausted");
  assert.equal(payload.access.reason, "quota");
  assert.equal(payload.access.feature, "AI credits");
  assert.equal(payload.access.window, "week");
  assert.equal(payload.access.resetAt, "2026-04-15T00:00:00.000Z");
  assert.deepEqual(payload.access.detail, { creditsMode: "expiry", resetKind: "week-reset" });
  assert.equal(policy.active, resolveCreditsPolicy({ creditsPolicyEnabled: true, creditsCarryMode: "expiry", creditsActivatedAt: MONTH_START }, FIXED).active);
  assert.equal(resolveCreditsPolicy({ creditsPolicyEnabled: true, creditsCarryMode: "expiry" }, FIXED).active, false, "no activation instant, no credits");
  // A payload for any other quota keeps its exact existing shape: no `detail` key appears.
  assert.equal("detail" in accessPayload({ reason: "quota", feature: "Images" }).access, false);
});

test("the credits summary builder is pure and rebuilds the same object from the same inputs", () => {
  const schedule = credits.allocationSchedule({ periodStart: Date.UTC(2026, 3, 1), periodEnd: Date.UTC(2026, 4, 1), monthlyCredits: 60 });
  const balance = credits.computeCreditBalance({ schedule, now: Date.UTC(2026, 3, 10), carryMode: "carry", spentByWindowMicros: [100_000, 0, 0, 0, 0] });
  const build = () => creditsSummary({ policy: { version: "v", carryMode: "carry" }, plan: "plus", period: { basis: "utc-calendar-month" }, schedule, balance, flexCreditBalance: 3 });
  assert.deepEqual(build(), build());
  assert.equal(JSON.parse(JSON.stringify(build())).schedule.length, 5);
});
