import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
const { classifyUsageRow, summarizeHolds, usageHoldReport } = await import("../src/usage/hold-report.js");
const { estimateTurnReservationHoldMicros } = await import("../src/usage/service.js");

// The stranded-hold dry run (owner request 2026-11-15): it sorts unsettled usage rows and totals what they hold, and it changes nothing.

const NOW = new Date("2026-11-15T12:00:00.000Z");
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60_000);
const PRICED = "zenith";
assert.ok(estimateTurnReservationHoldMicros(PRICED, 0) > 0, "precondition: the priced model has a non-zero default hold");
assert.equal(estimateTurnReservationHoldMicros("auto", 4000), 0, "precondition: a model whose hold estimate is 0");

const ROWS = [
  { userId: "u-a", model: PRICED, costMicros: 1200, reservedTokens: 0, createdAt: ago(300) },        // settled: not reported
  { userId: "u-a", model: PRICED, costMicros: 0, reservedTokens: 4000, createdAt: ago(5) },          // in flight
  { userId: "u-a", model: PRICED, costMicros: 0, reservedTokens: 4000, createdAt: ago(120) },        // stranded, 1h to 1d
  { userId: "u-b", model: PRICED, costMicros: 0, reservedTokens: 8000, createdAt: ago(3 * 1440) },   // stranded, 1d to 7d
  { userId: "u-b", model: PRICED, costMicros: 0, reservedTokens: 0, createdAt: ago(600) },           // released, still counted
  { userId: "u-c", model: "auto", costMicros: 0, reservedTokens: 4000, createdAt: ago(600) },        // a model whose hold estimate is 0: holds nothing
  { userId: "u-c", model: "__image__", costMicros: 0, reservedTokens: 0, createdAt: ago(600) },      // not a text row
];

test("each unsettled row is classed by what it is, and settled, free and non-text rows are left out", () => {
  const kinds = ROWS.map((row) => classifyUsageRow(row, { now: NOW })?.kind ?? null);
  assert.deepEqual(kinds, [null, "in_flight", "stranded", "stranded", "released_but_counted", null, null]);
  assert.equal(classifyUsageRow(ROWS[1], { now: NOW, strandedAfterMinutes: 1 }).kind, "stranded", "the threshold is configurable");
  assert.equal(classifyUsageRow(ROWS[4], { now: NOW }).heldMicros, estimateTurnReservationHoldMicros(PRICED, 0), "a released row still counts the default estimate");
});

test("totals by class, age and model, with accounts as one-way labels unless revealed", () => {
  const report = summarizeHolds(ROWS, { now: NOW, salt: "fixed" });
  assert.deepEqual(Object.keys(report.kinds).sort(), ["in_flight", "released_but_counted", "stranded"]);
  assert.equal(report.kinds.stranded.rows, 2);
  assert.equal(report.kinds.stranded.accounts, 2);
  assert.deepEqual(report.kinds.stranded.byAge, { under_1h: 0, "1h_to_1d": 1, "1d_to_7d": 1, over_7d: 0 });
  assert.deepEqual(report.kinds.stranded.byModel, { zenith: 2 });
  assert.equal(report.kinds.stranded.heldMicros, estimateTurnReservationHoldMicros(PRICED, 4000) + estimateTurnReservationHoldMicros(PRICED, 8000));
  assert.equal(report.kinds.released_but_counted.rows, 1);
  // In-flight rows are not anyone's problem yet, so they are not in the most-affected list.
  assert.deepEqual(report.mostAffected.map((entry) => entry.rows).sort(), [1, 2]);
  for (const entry of report.mostAffected) assert.match(entry.account, /^acct_[0-9a-f]{10}$/, "no raw account id by default");
  assert.notEqual(summarizeHolds(ROWS, { now: NOW, salt: "other" }).mostAffected[0].account, report.mostAffected[0].account, "labels change between runs");
  assert.deepEqual(summarizeHolds(ROWS, { now: NOW, revealUsers: true }).mostAffected.map((entry) => entry.account).sort(), ["u-a", "u-b"]);
});

test("against a real schema: it reads this period only, in a read-only transaction, and changes nothing", async () => {
  const client = new PGlite();
  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  for (const row of [...ROWS, { userId: "u-old", model: PRICED, costMicros: 0, reservedTokens: 4000, createdAt: new Date("2026-10-20T00:00:00Z") }]) {
    await client.query("INSERT INTO usage_events (user_id, model, cost_micros, reserved_tokens, created_at) VALUES ($1, $2, $3, $4, $5)", [row.userId, row.model, row.costMicros, row.reservedTokens, row.createdAt.toISOString()]);
  }
  const before = (await client.query("SELECT id, cost_micros, reserved_tokens, reservation_expires_at FROM usage_events ORDER BY id")).rows;
  const statements = [];
  const recording = { query: (text, params) => { statements.push(text.trim().split(/\s+/).slice(0, 3).join(" ")); return client.query(text, params); } };
  const report = await usageHoldReport(recording, { now: NOW });
  assert.equal(report.readOnly, true);
  assert.equal(report.period.from, "2026-11-01T00:00:00.000Z", "the current UTC month by default");
  assert.equal(report.kinds.stranded.rows, 2, "October's row is outside this period");
  assert.equal(report.kinds.released_but_counted.rows, 1);
  assert.deepEqual(statements, ["BEGIN READ ONLY", "SET LOCAL statement_timeout", "SELECT user_id AS", "ROLLBACK"], "only reads, inside a read-only transaction that is rolled back");
  const after = (await client.query("SELECT id, cost_micros, reserved_tokens, reservation_expires_at FROM usage_events ORDER BY id")).rows;
  assert.deepEqual(after, before, "no row changed");
  // The transaction really is read-only: a write inside one is refused by the database.
  await client.query("BEGIN READ ONLY");
  await assert.rejects(client.query("UPDATE usage_events SET reserved_tokens = 0"), /read-only/i);
  await client.query("ROLLBACK");
  await client.close();
});

test("the command is read-only and wired as npm run usage:holds", async () => {
  const script = await readFile(new URL("../scripts/usage-holds-report.js", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["usage:holds"], "node scripts/usage-holds-report.js");
  assert.match(script, /usageHoldReport\(client/);
  assert.doesNotMatch(script.replace(/^\s*\/\/.*$/gm, ""), /\b(?:UPDATE|DELETE|INSERT|ALTER|DROP|TRUNCATE)\b/, "no write statement anywhere in the command");
  const module = await readFile(new URL("../src/usage/hold-report.js", import.meta.url), "utf8");
  assert.doesNotMatch(module.replace(/^\s*\/\/.*$/gm, ""), /\b(?:UPDATE|DELETE|INSERT|ALTER|DROP|TRUNCATE)\b/);
});
