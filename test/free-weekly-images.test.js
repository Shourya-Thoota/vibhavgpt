import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// Free accounts get 2 images per fixed UTC week (Monday 00:00 UTC). The server counts them under the same per-user lock the credits
// code uses: a reservation is a row, a failed one is deleted, and two requests at once cannot both take the last slot. Paid limits and
// the credits balance are not touched. Nothing here talks to a provider or a real account: the image provider is a local stub.

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";
process.env.UPLOAD_STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "free-images-"));

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

const { config } = await import("../src/config.js");
const schema = await import("../src/db/schema.js");
const { default: express } = await import("express");
const { generationRouter } = await import("../src/generation/router.js");
const { generateImage } = await import("../src/generation/service.js");
const { reserveImageGeneration, reserveUsage, getCurrentUsage, GENERATION_LIMITS } = await import("../src/usage/service.js");
const { authorizeImageGeneration, utcWeekWindow, FREE_IMAGES_PER_WEEK, IMAGE_MODE_PLAN_QUOTAS } = await import("../src/generation/image-engine.js");
const { eq, and } = await import("drizzle-orm");

// The image provider: a local stub that records what it was asked and answers with a tiny picture.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const asked = [];
let providerMode = "ok";
const provider = http.createServer((req, res) => {
  let text = "";
  req.on("data", (c) => { text += c; });
  req.on("end", () => {
    asked.push(JSON.parse(text || "{}"));
    if (providerMode === "fail") { res.writeHead(500, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "down" })); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ data: [{ b64_json: PNG }], usage: { prompt_tokens: 10, completion_tokens: 0, cost: 0.02 } }));
  });
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
config.providerBaseUrls.paid = `http://127.0.0.1:${provider.address().port}`;
config.providerKeys.paid = "fixture-key";
config.imageGenerationModel = "fixture/image";
test.after(async () => { mock.timers.reset(); provider.closeAllConnections?.(); provider.close(); await client.close(); });

let counter = 0;
async function addUser(tier = "free") {
  const id = `${tier}-weekly-${++counter}`;
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, `${id}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [id]);
  if (tier !== "free") {
    await db.insert(schema.subscriptions).values({ userId: id, tier, status: "active", currentPeriodStartedAt: new Date(Date.now() - 10 * 86_400_000), currentPeriodEndsAt: new Date(Date.now() + 20 * 86_400_000) });
  }
  return id;
}
const seed = async (userId, createdAt, count, model = "__image__") => {
  for (let i = 0; i < count; i += 1) await db.insert(schema.usageEvents).values({ userId, model, createdAt: new Date(createdAt) });
};
const imageRows = async (userId) => (await db.select().from(schema.usageEvents).where(and(eq(schema.usageEvents.userId, userId), eq(schema.usageEvents.model, "__image__")))).length;
const attempt = (userId) => reserveImageGeneration(userId).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
const at = (iso) => mock.timers.enable({ apis: ["Date"], now: new Date(iso) });

// ---- The window ------------------------------------------------------------------------------------------------

test("the week is fixed, UTC, and starts on Monday at 00:00:00.000", () => {
  const check = (iso, startIso) => {
    const week = utcWeekWindow(new Date(iso));
    assert.equal(week.start.toISOString(), startIso, `${iso} is in the week that starts ${startIso}`);
    assert.equal(week.end.getTime() - week.start.getTime(), 7 * 86_400_000);
    assert.equal(week.start.getUTCDay(), 1, "a Monday");
  };
  check("2026-11-09T00:00:00.000Z", "2026-11-09T00:00:00.000Z"); // Monday 00:00:00: the new week
  check("2026-11-08T23:59:59.999Z", "2026-11-02T00:00:00.000Z"); // Sunday 23:59:59.999: still the old one
  check("2026-11-02T00:00:00.000Z", "2026-11-02T00:00:00.000Z");
  check("2026-11-04T13:30:00.000Z", "2026-11-02T00:00:00.000Z");
  check("2027-01-03T23:59:59.999Z", "2026-12-28T00:00:00.000Z"); // across a year end
  assert.equal(utcWeekWindow(new Date("2026-11-08T23:59:59.999Z")).end.toISOString(), "2026-11-09T00:00:00.000Z");
});

test("Free is 2 a week; the paid numbers are the ones enforced, and unchanged", () => {
  assert.equal(FREE_IMAGES_PER_WEEK, 2);
  assert.equal(IMAGE_MODE_PLAN_QUOTAS.free.quotaPerWeek, 2);
  assert.deepEqual([IMAGE_MODE_PLAN_QUOTAS.plus.quotaPerMonth, IMAGE_MODE_PLAN_QUOTAS.pro.quotaPerMonth, IMAGE_MODE_PLAN_QUOTAS.max.quotaPerMonth], [100, 400, 1500]);
  assert.deepEqual([GENERATION_LIMITS.free.images, GENERATION_LIMITS.plus.images, GENERATION_LIMITS.pro.images], [2, 100, 400], "the displayed limits are the enforced ones");
  // Max image quota resolved by owner decision: 1,500 a month (matching engine enforcement).
  assert.equal(GENERATION_LIMITS.max.images, 1500);
});

test("authorization: Free's third image in a week is refused with the plain message and the Monday reset", () => {
  const now = new Date("2026-11-05T10:00:00.000Z");
  assert.equal(authorizeImageGeneration("free", 0, { now }).remaining, 2);
  assert.equal(authorizeImageGeneration("free", 1, { now }).remaining, 1);
  const refused = authorizeImageGeneration("free", 2, { now });
  assert.equal(refused.authorized, false);
  assert.equal(refused.error.status, 429);
  assert.equal(refused.error.code, "image_quota_exhausted");
  assert.equal(refused.error.message, "You've used your 2 free images this week. More arrive Monday at 12:00 AM UTC.");
  assert.equal(refused.resetAt.toISOString(), "2026-11-09T00:00:00.000Z");
  assert.equal(refused.error.resetAt, "2026-11-09T00:00:00.000Z", "so the app can show it in the person's own time");
  // Paid plans: untouched.
  assert.equal(authorizeImageGeneration("plus", 99).authorized, true);
  assert.equal(authorizeImageGeneration("plus", 100).authorized, false);
  assert.equal(authorizeImageGeneration("pro", 399).authorized, true);
  assert.equal(authorizeImageGeneration("max", 1500).authorized, false);
});

// ---- Reservation: one row per image, counted in the week -----------------------------------------------------------

test("a Free account can reserve exactly two images in a week, and usage reports what is left", async () => {
  const userId = await addUser("free");
  const before = await getCurrentUsage(userId);
  assert.equal(before.imagePeriod, "week");
  assert.equal(before.imageLimit, 2);
  assert.equal(before.imagesRemaining, 2);
  assert.ok(new Date(before.imagePeriodEndsAt).getUTCDay() === 1 && new Date(before.imagePeriodEndsAt).getUTCHours() === 0, "the next Monday at 00:00 UTC");
  assert.equal((await attempt(userId)).ok, true);
  assert.equal((await attempt(userId)).ok, true);
  const third = await attempt(userId);
  assert.equal(third.ok, false);
  assert.equal(third.error.code, "image_quota_exhausted");
  assert.match(third.error.message, /^You've used your 2 free images this week\. More arrive Monday at 12:00 AM UTC\.$/);
  assert.equal(await imageRows(userId), 2, "the refused one left no row");
  const after = await getCurrentUsage(userId);
  assert.equal(after.imagesRemaining, 0);
  assert.equal(after.imageGenerationsThisPeriod, 2);
});

test("the boundary: Sunday 23:59:59.999 UTC is the old week, Monday 00:00:00 UTC is the new one", async (t) => {
  t.after(() => mock.timers.reset());
  // This week's slots used on its first instant: still used at the very end of it.
  const early = await addUser("free");
  await seed(early, "2026-11-02T00:00:00.000Z", 2);
  at("2026-11-08T23:59:59.999Z");
  assert.equal((await attempt(early)).error?.code, "image_quota_exhausted", "Monday 00:00:00.000 is inside its own week");
  // Slots used in the last instant of a week: gone one millisecond later.
  const late = await addUser("free");
  await seed(late, "2026-11-08T23:59:59.999Z", 2);
  mock.timers.reset();
  at("2026-11-08T23:59:59.999Z");
  assert.equal((await attempt(late)).error?.code, "image_quota_exhausted", "Sunday 23:59:59.999: both still count");
  mock.timers.reset();
  at("2026-11-09T00:00:00.000Z");
  const first = await attempt(late);
  assert.equal(first.ok, true, "Monday 00:00:00.000: a new week, a new allowance");
  assert.equal((await attempt(late)).ok, true);
  assert.equal((await attempt(late)).error?.code, "image_quota_exhausted", "and it is two, not more");
  mock.timers.reset();
});

test("a rolling window is not used: images from six days ago count, from last week do not", async (t) => {
  t.after(() => mock.timers.reset());
  const userId = await addUser("free");
  await seed(userId, "2026-11-02T08:00:00.000Z", 1); // Monday, this week
  await seed(userId, "2026-10-30T08:00:00.000Z", 5); // the Friday before, last week
  at("2026-11-07T12:00:00.000Z"); // Saturday
  assert.equal((await attempt(userId)).ok, true, "one slot left: last week's five do not count");
  assert.equal((await attempt(userId)).error?.code, "image_quota_exhausted");
  mock.timers.reset();
});

test("concurrent requests cannot take more than the two slots", async () => {
  const userId = await addUser("free");
  const results = await Promise.all(Array.from({ length: 8 }, () => attempt(userId)));
  assert.equal(results.filter((r) => r.ok).length, 2, "exactly two succeed");
  assert.ok(results.filter((r) => !r.ok).every((r) => r.error.code === "image_quota_exhausted"));
  assert.equal(await imageRows(userId), 2);
});

test("a paid plan's reservation is still counted in its own month, and not in the week", async () => {
  const plus = await addUser("plus");
  await seed(plus, new Date(), 99);
  assert.equal((await attempt(plus)).ok, true, "the 100th is allowed");
  assert.equal((await attempt(plus)).error?.code, "image_quota_exhausted", "the 101st is not");
  const usage = await getCurrentUsage(plus);
  assert.equal(usage.imagePeriod, "month");
  assert.equal(usage.imageLimit, 100);
});

// ---- Generation: failed and refused ones do not use a slot -----------------------------------------------------------

const run = (userId, options = {}) => generateImage({ userId, prompt: "a calm lake at dawn", aspectRatio: "square", ...options });

test("a failed generation gives its slot back, so a failure costs nothing", async () => {
  const userId = await addUser("free");
  providerMode = "fail";
  await assert.rejects(run(userId), (error) => error.reason === "service");
  await assert.rejects(run(userId), (error) => error.reason === "service");
  await assert.rejects(run(userId), (error) => error.reason === "service", "three failures in a row: still not out of images");
  assert.equal(await imageRows(userId), 0);
  providerMode = "ok";
  assert.ok((await run(userId)).buffer.length > 0);
  assert.ok((await run(userId)).buffer.length > 0);
  assert.equal(await imageRows(userId), 2);
  await assert.rejects(run(userId), (error) => error.code === "image_quota_exhausted");
  assert.equal(await imageRows(userId), 2, "a refused request makes no row and calls no provider");
});

test("a request that fails while its prompt is prepared also gives the slot back", async () => {
  const userId = await addUser("free");
  await assert.rejects(run(userId, { preparePrompt: async () => { throw new Error("rewrite failed"); } }));
  assert.equal(await imageRows(userId), 0);
  assert.equal((await getCurrentUsage(userId)).imagesRemaining, 2);
});

test("a refused request never reaches the provider", async () => {
  const userId = await addUser("free");
  await seed(userId, new Date(), 2);
  const before = asked.length;
  await assert.rejects(run(userId), (error) => error.code === "image_quota_exhausted");
  assert.equal(asked.length, before);
});

// ---- The route: Free gets the plain image, not the extras ----------------------------------------------------------------

async function serve(t, userId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/generation", generationRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (base, body) => fetch(`${base}/api/generation/image`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("route: a Free account's image is one plain image, with no custom size and no several-at-once, and says what is left", async (t) => {
  const userId = await addUser("free");
  const base = await serve(t, userId);
  asked.length = 0;
  const res = await post(base, { prompt: "a red bicycle", variations: 4, size: "1536x1024", aspectRatio: "landscape" });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.images.length, 1, "variations are ignored for Free");
  assert.equal(asked.length, 1);
  assert.equal("size" in asked[0], false, "no custom size reaches the provider");
  assert.deepEqual({ limit: body.allowance.limit, remaining: body.allowance.remaining, period: body.allowance.period }, { limit: 2, remaining: 1, period: "week" });
  assert.match(body.allowance.resetsAt, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  assert.equal(new Date(body.allowance.resetsAt).getUTCDay(), 1);
  assert.equal(JSON.stringify(body).includes("watermark"), false, "and nothing about a watermark");
});

test("route: Free cannot use a reference photo or a saved avatar, and the refusal costs nothing", async (t) => {
  const userId = await addUser("free");
  const base = await serve(t, userId);
  const before = asked.length;
  for (const field of [{ referenceAttachmentId: "00000000-0000-0000-0000-000000000000" }, { referenceAvatarId: "00000000-0000-0000-0000-000000000000" }]) {
    const res = await post(base, { prompt: "a portrait", ...field });
    assert.equal(res.status, 403);
    const payload = await res.json();
    assert.equal(payload.access.reason, "plan");
    assert.equal(payload.access.requiredPlan, "Plus or Pro");
  }
  assert.equal(asked.length, before);
  assert.equal(await imageRows(userId), 0);
});

test("route: out of images, a Free account gets 429 with the plain message and the reset time", async (t) => {
  const userId = await addUser("free");
  await seed(userId, new Date(), 2);
  const base = await serve(t, userId);
  const res = await post(base, { prompt: "one more" });
  assert.equal(res.status, 429);
  const payload = await res.json();
  assert.equal(payload.code, "image_quota_exhausted");
  assert.equal(payload.error, "You've used your 2 free images this week. More arrive Monday at 12:00 AM UTC.");
});

test("route: a paid plan's request is unchanged: variations and size still work", async (t) => {
  const userId = await addUser("plus");
  const base = await serve(t, userId);
  asked.length = 0;
  const res = await post(base, { prompt: "a red bicycle", variations: 2, size: "1536x1024" });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.images.length, 2);
  assert.equal(asked[0].size, "1536x1024");
  assert.equal(body.allowance.limit, 100);
});

test("images stay outside the credits balance: no credit rows are written for any of this", async () => {
  const rows = await db.select().from(schema.creditLedger);
  assert.equal(rows.filter((row) => String(row.kind).includes("generation")).length, 0);
});

// ---- Free asking for Vulcan: the wording says Pro, the rules are unchanged -----------------------------------------------

test("a Free account asking for Vulcan is told it is Pro only; Nebula still says Plus or Pro; Plus is still refused Vulcan", async () => {
  const free = await addUser("free");
  await assert.rejects(reserveUsage(free, "vesper", "normal", 1000), (error) => error.status === 403 && error.message === "Vulcan is available on Pro or Max." && error.requiredPlan === "Pro or Max" && error.code === "free_restricted_to_green_dot");
  await assert.rejects(reserveUsage(free, "nebula", "normal", 1000), (error) => error.status === 403 && error.requiredPlan === "Plus or Pro" && /Plus or Pro/.test(error.message));
  const plus = await addUser("plus");
  await assert.rejects(reserveUsage(plus, "vesper", "normal", 1000), (error) => error.code === "plus_forbidden_extra_high" && error.status === 403);
  // The chat router's own refusal says the same thing for Free.
  const router = fs.readFileSync(new URL("../src/chat/router.js", import.meta.url), "utf8");
  assert.ok(router.includes(`modelKey === "vesper" ? "Vulcan is available on Pro or Max." : "This model isn't included with your current plan. Available with Plus or Pro."`), "Vulcan says Pro only; every other model keeps its wording");
  assert.match(router, /"free_restricted_to_green_dot"/, "same code, same status");
});
