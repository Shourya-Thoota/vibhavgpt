process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";

const { accountPreferences } = await import("../src/db/schema.js");
const prefs = await import("../src/profile/preferences.js");

async function createDatabase(t) {
  const client = new PGlite();
  t.after(() => client.close());
  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  return { client, db: drizzle(client) };
}
const fakeSession = (req, res, next) => {
  const id = req.headers["x-test-user"];
  if (!id) return res.status(401).json({ error: "Sign in is required." });
  req.authSession = { user: { id } };
  return next();
};
async function serve(t, db, tiers = {}) {
  const app = express();
  app.use("/api/me/preferences", prefs.createPreferencesRouter({ database: db, session: fakeSession, tierOf: async (id) => tiers[id] ?? "free" }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/api/me/preferences`;
}
const send = (url, user, method, body) => fetch(url, { method, headers: { ...(user ? { "x-test-user": user } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("the migration adds one new table and changes nothing that exists", async (t) => {
  const { client } = await createDatabase(t);
  const columns = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'account_preferences' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
  assert.deepEqual(columns, ["user_id", "accent", "watermark_enabled", "location_mode", "location_city", "location_region", "location_country", "location_timezone", "created_at", "updated_at", "sidebar_hidden", "image_watermark"]);
  // 0053 adds the paid plans' watermark opt-in: one column, off by default, nothing else.
  const watermarkSql = await readFile(new URL("../drizzle/0053_image_watermark_opt_in.sql", import.meta.url), "utf8");
  assert.match(watermarkSql, /ADD COLUMN IF NOT EXISTS "image_watermark" boolean DEFAULT false NOT NULL/);
  assert.doesNotMatch(watermarkSql.replace(/--.*$/gm, ""), /\b(DROP|DELETE|TRUNCATE|UPDATE)\b/i, "additive only");
  // 0050 adds the sidebar choice: one column with an empty default, nothing else.
  const sidebarSql = await readFile(new URL("../drizzle/0050_sidebar_hidden_items.sql", import.meta.url), "utf8");
  assert.match(sidebarSql, /ADD COLUMN IF NOT EXISTS "sidebar_hidden" jsonb DEFAULT '\[\]'::jsonb NOT NULL/);
  assert.doesNotMatch(sidebarSql.replace(/--.*$/gm, ""), /\b(DROP|DELETE|TRUNCATE|UPDATE)\b/i, "additive only");
  const sql = await readFile(new URL("../drizzle/0039_account_preferences.sql", import.meta.url), "utf8");
  assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /\b(DROP|DELETE|TRUNCATE|UPDATE|ALTER)\b/i, "additive only");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "account_preferences"/);
});

test("the accent is saved to the account, validated, and visible only to its owner", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, db, { alice: "plus", bob: "free" });
  assert.equal((await send(url, null, "GET")).status, 401, "a session is required");
  assert.equal((await send(url, null, "PATCH", { accent: "pine" })).status, 401);
  assert.equal((await (await send(url, "alice", "GET")).json()).preferences.accent, null, "nothing saved yet: the device's own is used");
  const saved = await send(url, "alice", "PATCH", { accent: "pine" });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get("cache-control"), "private, no-store");
  assert.equal((await saved.json()).preferences.accent, "pine");
  assert.equal((await (await send(url, "alice", "GET")).json()).preferences.accent, "pine", "it follows the account to another device");
  assert.equal((await (await send(url, "bob", "GET")).json()).preferences.accent, null, "another account does not see it");
  for (const bad of ["red", "", 5, ["pine"], {}, "<script>", "PINE"]) assert.equal((await send(url, "alice", "PATCH", { accent: bad })).status, 400, JSON.stringify(bad));
  assert.equal((await send(url, "alice", "PATCH", { accent: null })).status, 200, "clearing returns to the default");
  assert.equal((await (await send(url, "alice", "GET")).json()).preferences.accent, null);
  // A user id in the body names nobody: the account is the session's.
  await send(url, "alice", "PATCH", { accent: "ember", userId: "bob", user_id: "bob" });
  assert.equal((await (await send(url, "bob", "GET")).json()).preferences.accent, null);
  assert.equal((await send(url, "alice", "PATCH", {})).status, 400, "nothing to change");
  assert.equal((await send(url, "alice", "PATCH", "not an object")).status, 400);
});

// The watermark policy (owner decision, 2026-11-16, superseding #70): Free always marked and cannot change it; paid plans off by default.
test("the image watermark: locked on for Free (the server refuses turning it off), off by default and switchable on paid plans", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, db, { alice: "plus", bob: "free", carol: "max" });
  const prefsOf = async (user) => (await (await send(url, user, "GET")).json()).preferences;
  assert.deepEqual((await prefsOf("bob")).imageWatermark, { enabled: true, locked: true }, "Free: on and locked");
  assert.deepEqual((await prefsOf("alice")).imageWatermark, { enabled: false, locked: false }, "paid: off until chosen");
  // Free cannot turn it off, whatever the request says; asking for on changes nothing and is fine.
  const refused = await send(url, "bob", "PATCH", { imageWatermark: false });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, "watermark_required");
  assert.equal((await send(url, "bob", "PATCH", { imageWatermark: true })).status, 200);
  assert.deepEqual((await prefsOf("bob")).imageWatermark, { enabled: true, locked: true });
  // Paid: on, then off again; it follows the account and nobody else's.
  const on = await send(url, "alice", "PATCH", { imageWatermark: true });
  assert.equal(on.status, 200);
  assert.deepEqual((await on.json()).preferences.imageWatermark, { enabled: true, locked: false });
  assert.equal((await prefs.loadPreferences("alice", db)).imageWatermark, true);
  assert.deepEqual((await prefsOf("carol")).imageWatermark, { enabled: false, locked: false }, "another account is unaffected");
  assert.equal((await send(url, "alice", "PATCH", { imageWatermark: false })).status, 200);
  assert.deepEqual((await prefsOf("alice")).imageWatermark, { enabled: false, locked: false });
  for (const bad of ["true", 1, null, {}]) assert.equal((await send(url, "alice", "PATCH", { imageWatermark: bad })).status, 400, JSON.stringify(bad));
  // A stored choice of off on a Free account (from when it was paid) still reads as on: the plan decides.
  await send(url, "carol", "PATCH", { imageWatermark: false });
  const row = await prefs.loadPreferences("carol", db);
  assert.deepEqual(prefs.preferencesResponse(row, "free").imageWatermark, { enabled: true, locked: true });
  // The old opt-out field is not read or accepted.
  const old = await send(url, "alice", "PATCH", { watermarkEnabled: false });
  assert.equal(old.status, 400);
  assert.equal((await old.json()).code, "empty");
});

test("sidebar items can be hidden from a fixed list, per account, and nothing else is accepted", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, db, { alice: "plus", bob: "free" });
  const saved = await send(url, "alice", "PATCH", { sidebarHidden: ["memory", "merch", "memory"] });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).preferences.sidebarHidden, ["memory", "merch"], "kept once each");
  assert.deepEqual((await (await send(url, "alice", "GET")).json()).preferences.sidebarHidden, ["memory", "merch"], "it follows the account");
  assert.deepEqual((await (await send(url, "bob", "GET")).json()).preferences.sidebarHidden, [], "another account keeps its full sidebar");
  for (const bad of [["chat"], ["settings"], "memory", [5], { memory: true }, null]) assert.equal((await send(url, "alice", "PATCH", { sidebarHidden: bad })).status, 400, JSON.stringify(bad));
  assert.deepEqual((await (await send(url, "alice", "GET")).json()).preferences.sidebarHidden, ["memory", "merch"], "a refused change stores nothing");
  assert.equal((await send(url, "alice", "PATCH", { sidebarHidden: [] })).status, 200, "showing everything again");
  assert.deepEqual((await (await send(url, "alice", "GET")).json()).preferences.sidebarHidden, []);
});
