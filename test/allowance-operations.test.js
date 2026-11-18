process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";

const { shadowCostLedger, subscriptions } = await import("../src/db/schema.js");
const { getAvailableAllowance, markDispatched, markUncertain, reserveAllowance, settleAllowance } = await import("../src/usage/allowance-service.js");
const { listOpenReservations, reconcileOpenReservation, releaseOpenReservationWithZeroUsage } = await import("../src/usage/allowance-operations.js");

const NOW = new Date("2026-10-20T12:00:00Z");
const OPERATOR = { actor: "ops person", reason: "provider record checked" };

async function setup(t) {
  const client = new PGlite();
  t.after(() => client.close());
  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  const db = drizzle(client);
  const userId = "ops-user";
  await db.execute(sql`INSERT INTO "user" (id, email) VALUES (${userId}, 'ops@example.com')`);
  await db.insert(subscriptions).values({ userId, tier: "plus", status: "active", currentPeriodStartedAt: new Date("2026-10-15T00:00:00Z"), currentPeriodEndsAt: new Date("2026-11-15T00:00:00Z") });
  return { db, userId };
}

async function uncertain(db, userId, requestId = "req_ops_1") {
  const reservation = await reserveAllowance({ userId, requestId, modelKey: "nova", idempotencyKey: `idem_${requestId}`, estimatedInputTokens: 1000, maxOutputTokens: 1000, now: NOW }, db);
  await markDispatched({ reservationId: reservation.reservationId, now: NOW }, db);
  await markUncertain({ reservationId: reservation.reservationId, reason: "client_aborted_unknown_usage", now: NOW }, db);
  return reservation.reservationId;
}

test("an uncertain hold is listed, stays counted as pending, and is never released by time", async (t) => {
  const { db, userId } = await setup(t);
  const reservationId = await uncertain(db, userId);
  const later = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
  const rows = await listOpenReservations({ now: NOW }, db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reservationId, reservationId);
  assert.equal(rows[0].status, "uncertain");
  assert.ok(rows[0].heldMicros > 0);
  const [row] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.id, reservationId));
  assert.equal(row.status, "uncertain", "no timer changed it");
  const balance = await getAvailableAllowance(userId, { now: NOW }, db);
  assert.equal(balance.monthly.pendingMicros, rows[0].heldMicros);
  assert.equal(balance.monthly.confirmedMicros, 0);
  assert.equal((await listOpenReservations({ now: later }, db)).length, 1, "still open a month later");
});

test("reconciliation needs an operator and a reason, shows a dry run first, and caps the deduction at the hold", async (t) => {
  const { db, userId } = await setup(t);
  const reservationId = await uncertain(db, userId);
  const held = (await listOpenReservations({ now: NOW }, db))[0].heldMicros;

  await assert.rejects(reconcileOpenReservation({ reservationId, rawCostMicros: 10, customerMicros: 10, reason: OPERATOR.reason, now: NOW }, db), (e) => e.code === "operator_required");
  await assert.rejects(reconcileOpenReservation({ reservationId, rawCostMicros: 10, customerMicros: 10, actor: OPERATOR.actor, reason: "short", now: NOW }, db), (e) => e.code === "reason_required");
  await assert.rejects(reconcileOpenReservation({ reservationId, rawCostMicros: 10.5, customerMicros: 10, ...OPERATOR, now: NOW }, db), (e) => e.code === "invalid_amount");
  await assert.rejects(reconcileOpenReservation({ reservationId, rawCostMicros: held + 500, customerMicros: held + 1, ...OPERATOR, now: NOW }, db), (e) => e.code === "exceeds_hold");

  const dry = await reconcileOpenReservation({ reservationId, rawCostMicros: held + 500, customerMicros: held, ...OPERATOR, now: NOW }, db);
  assert.equal(dry.applied, false);
  assert.equal(dry.absorbedByPlatformMicros, 500);
  assert.equal((await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.id, reservationId)))[0].status, "uncertain", "a dry run writes nothing");

  const done = await reconcileOpenReservation({ reservationId, rawCostMicros: 321, customerMicros: 321, ...OPERATOR, apply: true, now: NOW }, db);
  assert.equal(done.applied, true);
  const [row] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.id, reservationId));
  assert.equal(row.status, "reconciled");
  assert.equal(row.settledCostMicros, 321);
  assert.equal(row.metadata.auditLog.at(-1).reconciledBy.actorId, "ops person");
  const balance = await getAvailableAllowance(userId, { now: NOW }, db);
  assert.equal(balance.monthly.confirmedMicros, 321);
  assert.equal(balance.monthly.pendingMicros, 0);
  assert.equal((await listOpenReservations({ now: NOW }, db)).length, 0);
  await assert.rejects(reconcileOpenReservation({ reservationId, rawCostMicros: 1, customerMicros: 1, ...OPERATOR, now: NOW }, db), (e) => e.code === "not_open");
});

test("a hold is released only on an operator's confirmation that the provider shows no billable usage", async (t) => {
  const { db, userId } = await setup(t);
  const reservationId = await uncertain(db, userId, "req_ops_zero");
  const zero = { actor: "ops person", reason: "provider shows no usage" };
  const dry = await releaseOpenReservationWithZeroUsage({ reservationId, ...zero, now: NOW }, db);
  assert.equal(dry.applied, false);
  assert.equal((await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.id, reservationId)))[0].status, "uncertain");
  await releaseOpenReservationWithZeroUsage({ reservationId, ...zero, apply: true, now: NOW }, db);
  assert.equal((await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.id, reservationId)))[0].status, "released");
  assert.equal((await getAvailableAllowance(userId, { now: NOW }, db)).monthly.pendingMicros, 0);
});

test("a settled reservation cannot be touched by the operator path", async (t) => {
  const { db, userId } = await setup(t);
  const reservation = await reserveAllowance({ userId, requestId: "req_done", modelKey: "nova", idempotencyKey: "idem_done", estimatedInputTokens: 100, maxOutputTokens: 100, now: NOW }, db);
  await markDispatched({ reservationId: reservation.reservationId, now: NOW }, db);
  await settleAllowance({ reservationId: reservation.reservationId, usage: { prompt_tokens: 10, completion_tokens: 5 }, now: NOW }, db);
  await assert.rejects(releaseOpenReservationWithZeroUsage({ reservationId: reservation.reservationId, actor: "ops person", reason: "should not work", apply: true, now: NOW }, db), (e) => e.code === "not_open");
});
