import { and, asc, eq, lte, or } from "drizzle-orm";
import { shadowCostLedger } from "../db/schema.js";
import {
  ALLOWANCE_LIFECYCLE_STATES,
  AllowanceError,
  reconcileAllowanceReservation,
  releaseAllowance,
} from "./allowance-service.js";

/**
 * Operator path for reservations whose billable usage could not be established
 * (an uncertain operation, or a dispatched one whose lease lapsed).
 *
 * Such a hold is never released or charged by a timer. An operator resolves it with
 * figures taken from the provider's own record of that request:
 * - reconcile: confirmed actual cost, capped at the original hold (no customer debt);
 * - release: only when the provider's record shows no billable usage.
 *
 * The operator's name must be supplied by the person running it; nothing is assumed.
 * Amounts are never priced here from repository estimates.
 */

const OPEN_STATES = [ALLOWANCE_LIFECYCLE_STATES.UNCERTAIN, ALLOWANCE_LIFECYCLE_STATES.DISPATCHED];

export async function listOpenReservations({ userId = null, now = new Date(), staleAfterMs = 60_000 } = {}, executor) {
  const conditions = [
    or(
      eq(shadowCostLedger.status, ALLOWANCE_LIFECYCLE_STATES.UNCERTAIN),
      and(eq(shadowCostLedger.status, ALLOWANCE_LIFECYCLE_STATES.DISPATCHED), lte(shadowCostLedger.leaseExpiresAt, new Date(now.getTime() - staleAfterMs))),
    ),
  ];
  if (userId) conditions.push(eq(shadowCostLedger.userId, userId));
  const rows = await executor.select().from(shadowCostLedger).where(and(...conditions)).orderBy(asc(shadowCostLedger.createdAt));
  return rows.map((row) => ({
    reservationId: row.id,
    userId: row.userId,
    requestId: row.requestId,
    status: row.status,
    heldMicros: Number(row.reservedCostMicros ?? 0),
    modelKey: row.modelKey,
    reason: row.metadata?.uncertainReason ?? null,
    ageMinutes: Math.round((now.getTime() - new Date(row.createdAt).getTime()) / 60_000),
  }));
}

function requireOperator(actor, reason) {
  if (!actor || typeof actor !== "string" || !actor.trim()) throw new AllowanceError("The operator name is required.", { code: "operator_required" });
  if (!reason || typeof reason !== "string" || reason.trim().length < 8) throw new AllowanceError("A reason of at least 8 characters is required.", { code: "reason_required" });
}

async function openRow(reservationId, executor) {
  const [row] = await executor.select().from(shadowCostLedger).where(eq(shadowCostLedger.id, reservationId)).limit(1);
  if (!row) throw new AllowanceError("Reservation not found.", { code: "reservation_not_found" });
  if (!OPEN_STATES.includes(row.status)) throw new AllowanceError(`Only an uncertain or dispatched reservation can be resolved here (status: ${row.status}).`, { code: "not_open" });
  return row;
}

const wholeMicros = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new AllowanceError(`${name} must be a whole number of micro-dollars, zero or more.`, { code: "invalid_amount" });
  return value;
};

/**
 * Records the provider-confirmed actual cost. `apply: false` returns what would be
 * recorded without writing.
 */
export async function reconcileOpenReservation({ reservationId, rawCostMicros, customerMicros, actor, reason, apply = false, now = new Date() }, executor) {
  requireOperator(actor, reason);
  wholeMicros(rawCostMicros, "rawCostMicros");
  wholeMicros(customerMicros, "customerMicros");
  const row = await openRow(reservationId, executor);
  const held = Number(row.reservedCostMicros ?? 0);
  if (customerMicros > held) {
    throw new AllowanceError(`The customer deduction (${customerMicros}) cannot exceed the original hold (${held}); the platform absorbs any overrun.`, { code: "exceeds_hold", heldMicros: held });
  }
  const preview = { reservationId, from: row.status, heldMicros: held, rawCostMicros, customerMicros, absorbedByPlatformMicros: Math.max(0, rawCostMicros - customerMicros) };
  if (!apply) return { applied: false, ...preview };
  await reconcileAllowanceReservation({
    reservationId, adminOverride: true, adminContext: { actorId: actor.trim(), role: "operator" },
    confirmedRawCostMicros: rawCostMicros, confirmedCustomerDeductionMicros: customerMicros, reason: reason.trim(), now,
  }, executor);
  return { applied: true, ...preview };
}

/**
 * Releases a hold only when the provider's own record shows the request consumed
 * nothing billable.
 */
export async function releaseOpenReservationWithZeroUsage({ reservationId, actor, reason, apply = false, now = new Date() }, executor) {
  requireOperator(actor, reason);
  const row = await openRow(reservationId, executor);
  const preview = { reservationId, from: row.status, heldMicros: Number(row.reservedCostMicros ?? 0) };
  if (!apply) return { applied: false, ...preview };
  await releaseAllowance({ reservationId, reason: `operator_confirmed_zero_usage: ${actor.trim()}: ${reason.trim()}`, confirmedZeroUsage: true, now }, executor);
  return { applied: true, ...preview };
}

export { OPEN_STATES };
