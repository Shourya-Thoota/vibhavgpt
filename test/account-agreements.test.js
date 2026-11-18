// Eligibility and agreements (src/account/agreements.js; legal audit, 2026-11-16): a neutral age question and Terms/Privacy acceptance,
// recorded on the server for every account, and a gate in front of the routes that do work.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";

const agreements = await import("../src/account/agreements.js");
const { PRIVACY_VERSION, TERMS_VERSION, MINIMUM_AGE } = await import("../frontend/src/legal-versions.js");

async function createDatabase(t) {
  const client = new PGlite();
  t.after(() => client.close());
  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  return { client, db: drizzle(client) };
}
const fakeSession = (req, _res, next) => { const id = req.headers["x-test-user"]; if (id) req.authSession = { user: { id } }; next(); };
const requireFake = (req, res, next) => fakeSession(req, res, () => (req.authSession ? next() : res.status(401).json({ error: "Sign in is required." })));
const NOW = new Date("2026-11-16T12:00:00Z");

async function serve(t, db) {
  const app = express();
  app.use("/api/me/agreements", agreements.createAgreementsRouter({ database: db, session: requireFake, now: () => NOW }));
  app.use(agreements.GATED_PATHS, agreements.createAgreementsGate({ database: db, session: fakeSession }));
  app.all(["/api/chat/send", "/api/chat/conversations", "/api/uploads"], (req, res) => (req.authSession ? res.json({ ok: true, method: req.method }) : res.status(401).json({ error: "Sign in is required." })));
  app.delete("/api/account", (_req, res) => res.json({ deleted: true }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (method, path, user, body) => fetch(`${base}${path}`, { method, headers: { ...(user ? { "x-test-user": user } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test("the age check counts conservatively from month and year, and refuses impossible dates", () => {
  assert.equal(MINIMUM_AGE, 16, "the Terms' minimum age");
  const now = NOW; // November 2026
  assert.equal(agreements.oldEnough(10, 2010, { now }), true, "16 since the end of October 2026");
  assert.equal(agreements.oldEnough(11, 2010, { now }), false, "born this month 16 years ago: not certainly 16 until the month ends");
  assert.equal(agreements.oldEnough(12, 2010, { now }), false);
  assert.equal(agreements.oldEnough(1, 1990, { now }), true);
  assert.equal(agreements.oldEnough(5, 2015, { now }), false);
  for (const [m, y] of [[0, 2000], [13, 2000], [6, 1800], [1, 2027], [12, 2026], [1.5, 2000], [NaN, 2000]]) assert.equal(agreements.oldEnough(m, y, { now }), null, `${m}/${y}`);
});

test("the migration adds one table, additively, keeping only the age check's result", async (t) => {
  const { client } = await createDatabase(t);
  const columns = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'account_agreements' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
  assert.deepEqual(columns, ["user_id", "terms_version", "privacy_version", "accepted_at", "age_check", "age_checked_at", "created_at", "updated_at"]);
  assert.ok(!columns.some((c) => /birth|dob/.test(c)), "no date of birth is stored");
  const sql = await readFile(new URL("../drizzle/0054_account_agreements.sql", import.meta.url), "utf8");
  assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /\b(DROP|DELETE|TRUNCATE|UPDATE|ALTER)\b/i);
  await assert.rejects(client.query(`INSERT INTO account_agreements (user_id, age_check) VALUES ('x', 'maybe')`), "only the two results are allowed");
});

test("a new account is asked; accepting records the versions and the result; the gate then lets work through", async (t) => {
  const { db } = await createDatabase(t);
  const send = await serve(t, db);
  const fresh = await (await send("GET", "/api/me/agreements", "alice")).json();
  assert.deepEqual({ required: fresh.agreements.required, blocked: fresh.agreements.blocked }, { required: true, blocked: false });
  // Before: work is refused, reading is not, and account deletion is not gated.
  const refused = await send("POST", "/api/chat/send", "alice", { text: "hi" });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, "agreements_required");
  assert.equal((await send("POST", "/api/uploads", "alice", {})).status, 403);
  assert.equal((await send("GET", "/api/chat/conversations", "alice")).status, 200, "reading what exists is not refused");
  assert.equal((await send("DELETE", "/api/account", "alice")).status, 200, "deletion is never gated");
  assert.equal((await send("POST", "/api/chat/send")).status, 401, "without a session the route answers as before");
  // Half an answer is refused.
  assert.equal((await (await send("POST", "/api/me/agreements", "alice", { birthMonth: 3, birthYear: 1995 })).json()).code, "terms_required");
  assert.equal((await (await send("POST", "/api/me/agreements", "alice", { acceptTerms: true })).json()).code, "bad_birth_date");
  const ok = await send("POST", "/api/me/agreements", "alice", { birthMonth: 3, birthYear: 1995, acceptTerms: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  assert.equal((await ok.json()).agreements.required, false);
  const row = await agreements.loadAgreements("alice", db);
  assert.equal(row.ageCheck, "16_plus");
  assert.equal(row.termsVersion, TERMS_VERSION);
  assert.equal(row.privacyVersion, PRIVACY_VERSION);
  assert.equal(row.acceptedAt.toISOString(), NOW.toISOString());
  assert.equal((await send("POST", "/api/chat/send", "alice", { text: "hi" })).status, 200, "now work goes through");
  assert.equal((await (await send("GET", "/api/me/agreements", "bob")).json()).agreements.required, true, "another account is still asked");
});

test("under 16: blocked everywhere it is gated, and the answer cannot be changed afterwards", async (t) => {
  const { db } = await createDatabase(t);
  const send = await serve(t, db);
  const young = await send("POST", "/api/me/agreements", "kid", { birthMonth: 6, birthYear: 2013, acceptTerms: true });
  assert.equal(young.status, 403);
  assert.equal((await young.json()).code, "age_blocked");
  const row = await agreements.loadAgreements("kid", db);
  assert.equal(row.ageCheck, "under_16");
  assert.equal(row.termsVersion, null, "nothing is accepted for a blocked account");
  for (const [method, path] of [["POST", "/api/chat/send"], ["GET", "/api/chat/conversations"], ["POST", "/api/uploads"]]) {
    const res = await send(method, path, "kid");
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await res.json()).code, "age_blocked");
  }
  const retry = await send("POST", "/api/me/agreements", "kid", { birthMonth: 1, birthYear: 1990, acceptTerms: true });
  assert.equal(retry.status, 403, "a second, older answer is not accepted");
  assert.equal((await agreements.loadAgreements("kid", db)).ageCheck, "under_16");
  assert.equal((await send("DELETE", "/api/account", "kid")).status, 200, "they can still delete the account");
});

test("a new version of the Terms asks again, without asking the age again", async (t) => {
  const { db } = await createDatabase(t);
  const { accountAgreements } = await import("../src/db/schema.js");
  await db.insert(accountAgreements).values({ userId: "old", termsVersion: "2026-10-04", privacyVersion: "2026-10-04", acceptedAt: new Date("2026-10-05"), ageCheck: "16_plus", ageCheckedAt: new Date("2026-10-05") });
  const send = await serve(t, db);
  const status = (await (await send("GET", "/api/me/agreements", "old")).json()).agreements;
  assert.deepEqual({ required: status.required, ageChecked: status.ageChecked, accepted: status.accepted }, { required: true, ageChecked: true, accepted: false });
  assert.equal((await send("POST", "/api/chat/send", "old")).status, 403);
  assert.equal((await send("POST", "/api/me/agreements", "old", { acceptTerms: true })).status, 200, "only the acceptance is needed");
  assert.equal((await send("POST", "/api/chat/send", "old")).status, 200);
});

test("if the record can't be read, work is refused rather than let through", async () => {
  const gate = agreements.createAgreementsGate({ database: { select: () => { throw new Error("db down"); } }, session: fakeSession });
  const res = { statusCode: 0, headers: {}, body: null, set(h) { Object.assign(this.headers, h); return this; }, status(code) { this.statusCode = code; return this; }, json(b) { this.body = b; return this; } };
  let passed = false;
  await new Promise((resolve) => { gate({ method: "POST", headers: { "x-test-user": "a" } }, new Proxy(res, { get: (target, key) => (key === "json" ? (b) => { target.json(b); resolve(); return target; } : target[key]) }), () => { passed = true; resolve(); }); });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "agreements_unavailable");
});

test("the gate is mounted before the routes it guards, and covers every route that does work", async () => {
  const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const gateAt = server.indexOf("app.use(GATED_PATHS, createAgreementsGate());");
  assert.ok(gateAt > 0);
  for (const path of ["/api/voice", "/api/uploads", "/api/chat", "/api/build", "/api/generation", "/api/memory", "/api/library"]) {
    const mount = server.indexOf(`app.use("${path}"`);
    assert.ok(mount > gateAt, `${path} is mounted after the gate`);
    assert.ok(agreements.GATED_PATHS.includes(path), `${path} is gated`);
  }
  for (const open of ["/api/account", "/api/billing", "/api/me/preferences"]) assert.ok(!agreements.GATED_PATHS.includes(open), `${open} stays open`);
});
