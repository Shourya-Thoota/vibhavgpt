import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// A saved avatar as the reference for an image (owner request 2026-11-15), through the real route: only its owner can use it, the
// avatar's own bytes are what reach the image provider, one reference at a time, and nothing is attached when none was chosen.
// The database is PGlite with every migration; the image provider is a local stub that records what it was asked. No real account,
// provider or image is involved.

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";
process.env.UPLOAD_STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-reference-"));

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
const { eq, and } = await import("drizzle-orm");

const OUT_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const asked = [];
const provider = http.createServer((req, res) => {
  let text = "";
  req.on("data", (c) => { text += c; });
  req.on("end", () => {
    asked.push(JSON.parse(text || "{}"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ b64_json: OUT_PNG }], usage: { prompt_tokens: 10, completion_tokens: 0, cost: 0.02 } }));
  });
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
config.providerBaseUrls.paid = `http://127.0.0.1:${provider.address().port}`;
config.providerKeys.paid = "fixture-key";
config.imageGenerationModel = "fixture/image";
test.after(async () => { provider.closeAllConnections?.(); provider.close(); await client.close(); });

let counter = 0;
async function addUser(tier = "plus") {
  const id = `${tier}-avatar-${++counter}`;
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, `${id}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [id]);
  await db.insert(schema.subscriptions).values({ userId: id, tier, status: "active", currentPeriodStartedAt: new Date(Date.now() - 10 * 86_400_000), currentPeriodEndsAt: new Date(Date.now() + 20 * 86_400_000) });
  return id;
}
// Distinct bytes per avatar, so the test can tell exactly which picture reached the provider.
async function addAvatar(userId, label) {
  const data = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`avatar:${label}:${userId}`)]);
  const [row] = await db.insert(schema.savedAvatars).values({ userId, name: label, contentType: "image/png", width: 1, height: 1, byteSize: data.length, sha256: label, data }).returning({ id: schema.savedAvatars.id });
  return { id: row.id, data };
}
const imageRows = async (userId) => (await db.select().from(schema.usageEvents).where(and(eq(schema.usageEvents.userId, userId), eq(schema.usageEvents.model, "fixture/image")))).length
  + (await db.select().from(schema.usageEvents).where(and(eq(schema.usageEvents.userId, userId), eq(schema.usageEvents.model, "__image__")))).length;

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
const references = (request) => request.input_references ?? [];

test("the owner's chosen avatar is the reference: its own bytes, and only it, reach the image provider", async (t) => {
  const owner = await addUser("plus");
  const chosen = await addAvatar(owner, "chosen");
  await addAvatar(owner, "other"); // a second saved avatar that must not be sent
  const base = await serve(t, owner);
  asked.length = 0;
  const res = await post(base, { prompt: "me as an astronaut", referenceAvatarId: chosen.id, standalone: true });
  assert.equal(res.status, 201, await res.clone().text());
  assert.equal(asked.length, 1, "one provider request");
  const refs = references(asked[0]);
  assert.equal(refs.length, 1, "exactly one reference");
  assert.equal(refs[0].type, "image_url");
  assert.equal(refs[0].image_url.url, `data:image/png;base64,${chosen.data.toString("base64")}`, "the chosen avatar's exact bytes");
});

test("another account's avatar is refused exactly like one that does not exist, and nothing is spent or sent", async (t) => {
  const owner = await addUser("plus");
  const theirs = await addAvatar(owner, "private");
  const stranger = await addUser("pro");
  const base = await serve(t, stranger);
  asked.length = 0;
  const foreign = await post(base, { prompt: "a portrait", referenceAvatarId: theirs.id });
  const missing = await post(base, { prompt: "a portrait", referenceAvatarId: "00000000-0000-4000-8000-000000000000" });
  const malformed = await post(base, { prompt: "a portrait", referenceAvatarId: "../../etc/passwd" });
  for (const res of [foreign, missing, malformed]) {
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "That saved avatar is no longer available." }, "the same answer, so an id cannot be probed");
  }
  assert.equal(asked.length, 0, "the provider was never asked");
  assert.equal(await imageRows(stranger), 0, "nothing was reserved or charged");
});

test("one reference at a time: an avatar and an uploaded reference together are refused before any work", async (t) => {
  const owner = await addUser("plus");
  const avatar = await addAvatar(owner, "solo");
  const base = await serve(t, owner);
  asked.length = 0;
  const res = await post(base, { prompt: "a portrait", referenceAvatarId: avatar.id, referenceAttachmentId: "00000000-0000-4000-8000-000000000000" });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Choose one reference image." });
  assert.equal(asked.length, 0);
});

test("no auto-attach: an account with saved avatars that picks no reference sends none", async (t) => {
  const owner = await addUser("plus");
  await addAvatar(owner, "never-used");
  const base = await serve(t, owner);
  asked.length = 0;
  const res = await post(base, { prompt: "a quiet harbour at dawn", standalone: true });
  assert.equal(res.status, 201, await res.clone().text());
  assert.equal(asked.length, 1);
  assert.equal("input_references" in asked[0], false, "no reference reaches the provider");
});

test("an avatar deleted after it was chosen is refused at Generate, not silently replaced", async (t) => {
  const owner = await addUser("plus");
  const avatar = await addAvatar(owner, "gone");
  await addAvatar(owner, "still-here");
  await db.delete(schema.savedAvatars).where(eq(schema.savedAvatars.id, avatar.id));
  const base = await serve(t, owner);
  asked.length = 0;
  const res = await post(base, { prompt: "a portrait", referenceAvatarId: avatar.id });
  assert.equal(res.status, 400);
  assert.equal(asked.length, 0, "no other avatar is substituted");
});
