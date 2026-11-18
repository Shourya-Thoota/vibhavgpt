// File storage by plan (owner report, 2026-11-15: a Max account was refused with "You've reached your 25 MB document storage limit").
// Cause: the upload table had no Max row, so Max and complimentary accounts fell back to Free's limits. Over a real Postgres (PGlite) and
// the real chat router: Max and comp get Pro's limits, a plan change moves the limit, the two storage problems are told apart, deleting a
// file frees its bytes, re-using an attachment adds nothing, and a text-only message still works at the cap. No file content is logged.
import test, { mock, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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
const { config, parseCompPlanAccounts } = await import("../src/config.js");
config.moderationApiKey = "";
config.providerKeys.primaryFree = "";
config.providerKeys.paid = "fixture-key";
config.lumenChatRoute = "paid-zdr";
config.lumenPaidZdrProviders = ["fixture-host"];
config.chatModels.lumenFallback1 = "fixture-lumen-upstream-id";
const { UPLOAD_LIMITS, uploadLimitsForUser, assertUploadQuota } = await import("../src/uploads/service.js");
const { UPLOAD_REQUEST_LIMITS } = await import("../src/uploads/router.js");
const { chatRouter } = await import("../src/chat/router.js");
const { default: express } = await import("express");

const MB = 1024 * 1024;
const encoder = new TextEncoder();
let upstreamCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.startsWith(config.providerBaseUrls.paid)) {
    if (href.includes("/generation")) return new Response("{}", { status: 404 });
    upstreamCalls += 1;
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Plant cells have a cell wall." } }] })}\n\n`));
      c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 8 } })}\n\n`));
      c.close();
    } }), { headers: { "Content-Type": "text/event-stream" } });
  }
  if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
  throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
};

async function person(id, { tier = null, email = `${id}@example.com` } = {}) {
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, email]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [id]);
  if (tier) await client.query("INSERT INTO subscriptions (user_id, subscription_id, tier, status, current_period_ends_at) VALUES ($1, $2, $3, 'active', now() + interval '20 days')", [id, `sub_${id}`, tier]);
  return id;
}
const storeBytes = (userId, bytes, kind = "image") => client.query(
  "INSERT INTO attachments (user_id, original_name, stored_name, mime_type, kind, size_bytes) VALUES ($1, 'stored.png', $2, 'image/png', $3, $4) RETURNING id",
  [userId, `${userId}-${Math.random().toString(36).slice(2)}.png`, kind, bytes],
).then((r) => r.rows[0].id);
const file = (name, size) => ({ originalname: name, size });
const refusal = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authSession = { user: { id: req.get("x-test-user") } }; next(); });
app.use("/api/chat", chatRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
after(async () => { globalThis.fetch = realFetch; await new Promise((resolve) => server.close(resolve)); server.closeAllConnections?.(); await client.close(); });

test("the plan table: Max has Pro's upload limits and upload rate, not Free's", () => {
  assert.deepEqual(
    Object.fromEntries(["free", "plus", "pro", "max"].map((tier) => [tier, [UPLOAD_LIMITS[tier].fileBytes / MB, UPLOAD_LIMITS[tier].imageBytes / MB, UPLOAD_LIMITS[tier].messageBytes / MB, UPLOAD_LIMITS[tier].accountBytes / MB]])),
    { free: [5, 5, 10, 25], plus: [25, 10, 50, 150], pro: [80, 20, 160, 250], max: [80, 20, 160, 250] },
  );
  assert.equal(UPLOAD_REQUEST_LIMITS.max, UPLOAD_REQUEST_LIMITS.pro);
});

test("a Max subscriber and a complimentary account (no subscription row) both get Max's limits", async () => {
  const max = await person("storage-max", { tier: "max" });
  assert.equal((await uploadLimitsForUser(max)).accountBytes, 250 * MB);
  const comp = await person("storage-comp", { email: "comp-storage@example.com" });
  const before = config.compPlanAccounts;
  config.compPlanAccounts = parseCompPlanAccounts("comp-storage@example.com");
  try {
    const limits = await uploadLimitsForUser(comp);
    assert.equal(limits.tier, "max");
    assert.equal(limits.accountBytes, 250 * MB);
    assert.equal(limits.imageBytes, 20 * MB);
  } finally { config.compPlanAccounts = before; }
});

test("with 30 MB stored, a Max account can still attach an image (the reported case); Free could not", async () => {
  const max = await person("storage-max-30", { tier: "max" });
  await storeBytes(max, 30 * MB, "generated-image");
  assert.equal(await refusal(async () => assertUploadQuota(max, [file("plant_cell.jpg", 2 * MB)], await uploadLimitsForUser(max))), null);
  const free = await person("storage-free-30");
  await storeBytes(free, 30 * MB);
  const error = await refusal(async () => assertUploadQuota(free, [file("plant_cell.jpg", 2 * MB)], await uploadLimitsForUser(free)));
  assert.equal(error?.code, "storage-limit");
});

test("full storage and 'this file would not fit' are told apart, and a file too large for the plan is a different code", async () => {
  const free = await person("storage-free-full");
  await storeBytes(free, 25 * MB);
  const full = await refusal(async () => assertUploadQuota(free, [file("a.png", 1 * MB)], await uploadLimitsForUser(free)));
  assert.equal(full.code, "storage-limit");
  assert.match(full.message, /file storage is full/);
  assert.match(full.message, /Messages without files still work/);
  const nearly = await person("storage-free-nearly");
  await storeBytes(nearly, 23 * MB);
  const over = await refusal(async () => assertUploadQuota(nearly, [file("a.png", 3 * MB)], await uploadLimitsForUser(nearly)));
  assert.equal(over.code, "storage-limit");
  assert.match(over.message, /would go over your 25 MB of file storage \(2\.0 MB left\)/);
  const tooBig = await refusal(async () => assertUploadQuota(nearly, [file("big.png", 6 * MB)], await uploadLimitsForUser(nearly)));
  assert.equal(tooBig.code, "upload-plan-limit", "a per-file limit is not a storage problem");
});

test("a plan change moves the limit: Max to Plus lowers it, Plus to Max raises it", async () => {
  const user = await person("storage-plan-change", { tier: "max" });
  await storeBytes(user, 200 * MB);
  assert.equal(await refusal(async () => assertUploadQuota(user, [file("a.png", 1 * MB)], await uploadLimitsForUser(user))), null);
  await client.query("UPDATE subscriptions SET tier = 'plus', updated_at = now() WHERE user_id = $1", [user]);
  assert.equal((await refusal(async () => assertUploadQuota(user, [file("a.png", 1 * MB)], await uploadLimitsForUser(user))))?.code, "storage-limit");
  await client.query("UPDATE subscriptions SET tier = 'max', updated_at = now() WHERE user_id = $1", [user]);
  assert.equal(await refusal(async () => assertUploadQuota(user, [file("a.png", 1 * MB)], await uploadLimitsForUser(user))), null);
});

test("deleting a stored file frees its bytes; a refused upload stores nothing", async () => {
  const user = await person("storage-delete");
  const id = await storeBytes(user, 25 * MB);
  const count = async () => (await client.query("SELECT count(*)::int AS n FROM attachments WHERE user_id = $1", [user])).rows[0].n;
  assert.equal((await refusal(async () => assertUploadQuota(user, [file("a.png", 1 * MB)], await uploadLimitsForUser(user))))?.code, "storage-limit");
  assert.equal(await count(), 1, "the refused upload added no row");
  await client.query("DELETE FROM attachments WHERE id = $1", [id]);
  assert.equal(await refusal(async () => assertUploadQuota(user, [file("a.png", 1 * MB)], await uploadLimitsForUser(user))), null);
});

async function stream(user, body) {
  const response = await realFetch(`${baseUrl}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json", "x-test-user": user }, body: JSON.stringify({ model: "lumen", ...body }) });
  return (await response.text()).split("\n\n").map((b) => ({ event: b.match(/^event:\s*(.+)$/m)?.[1], data: b.match(/^data:\s*(.+)$/m)?.[1] })).filter((e) => e.event && e.data).map((e) => ({ event: e.event, data: JSON.parse(e.data) }));
}

test("at the storage cap, a text-only message is answered: stored files never block a message without files", async () => {
  const user = await person("storage-text-only");
  await storeBytes(user, 25 * MB);
  const before = upstreamCalls;
  const events = await stream(user, { message: "What is in a plant cell?" });
  assert.ok(events.some((e) => e.event === "complete"), JSON.stringify(events.filter((e) => e.event === "error")));
  assert.equal(upstreamCalls, before + 1, "one inference");
});

test("re-using an already stored attachment in a message adds no storage", async () => {
  const user = await person("storage-reuse", { tier: "max" });
  const { rows: [image] } = await client.query(
    "INSERT INTO attachments (user_id, original_name, stored_name, mime_type, kind, size_bytes, extraction_status) VALUES ($1, 'plant_cell.jpg', $2, 'image/jpeg', 'image', $3, 'ready') RETURNING id",
    [user, `${user}-plant.jpg`, 2 * MB],
  );
  const bytes = async () => Number((await client.query("SELECT coalesce(sum(size_bytes), 0)::bigint AS b FROM attachments WHERE user_id = $1", [user])).rows[0].b);
  const before = await bytes();
  await stream(user, { message: "What is this?", attachmentIds: [image.id] });
  assert.equal(await bytes(), before, "the message referred to the stored file; nothing new was stored");
});
