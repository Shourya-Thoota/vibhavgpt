// A read-only report of usage rows that count against an allowance without a settled cost (owner request, 2026-11-15: a design review
// and dry run before any policy change). It changes nothing: it reads usage_events in a read-only transaction and returns totals.
//
// Credit admission (credits.js creditSpendByWindow) and the older monthly budget (service.js reserveUsage) count a text row as:
//   costMicros > 0  -> its settled cost, marked up once;
//   otherwise       -> estimateTurnReservationHoldMicros(model, reservedTokens), with no expiry.
// So a row with no settled cost keeps counting until something settles it. This report sorts those rows into:
//   in_flight             reservedTokens > 0, younger than the stranded threshold: a reply that may still be running.
//   stranded              reservedTokens > 0, older than the threshold: a reply whose process ended before it settled or released
//                         (a deploy or restart mid-reply). Nothing will ever settle it.
//   released_but_counted  reservedTokens = 0 and costMicros = 0: settled at zero cost, or released by cancelUsageReservation without
//                         being deleted (it had tokens). The estimate still counts a default-sized hold (1,000 output tokens) for it.
// Rows whose model is free (an estimate of 0) cost nothing and are not reported. Nothing here decides what should happen to a row.

import { createHash, randomBytes } from "node:crypto";
import { isTextUsageRow } from "./credits.js";
import { estimateTurnReservationHoldMicros } from "./service.js";

export const DEFAULT_STRANDED_AFTER_MINUTES = 30;
const AGE_BUCKETS = [["under_1h", 60 * 60_000], ["1h_to_1d", 24 * 60 * 60_000], ["1d_to_7d", 7 * 24 * 60 * 60_000], ["over_7d", Infinity]];

/** One row's class, or null when it does not count against an allowance without a settled cost. */
export function classifyUsageRow(row, { now = new Date(), strandedAfterMinutes = DEFAULT_STRANDED_AFTER_MINUTES } = {}) {
  if (!isTextUsageRow(row.model)) return null;
  if (Number(row.costMicros) > 0) return null;
  const heldMicros = estimateTurnReservationHoldMicros(row.model, Number(row.reservedTokens) || 0);
  if (!(heldMicros > 0)) return null;
  const ageMs = now.getTime() - new Date(row.createdAt).getTime();
  if (Number(row.reservedTokens) > 0) return { kind: ageMs < strandedAfterMinutes * 60_000 ? "in_flight" : "stranded", heldMicros, ageMs };
  return { kind: "released_but_counted", heldMicros, ageMs };
}

const ageBucket = (ageMs) => AGE_BUCKETS.find(([, limit]) => ageMs < limit)[0];

/** Totals for a set of rows. Accounts are named by a one-way, per-report label unless revealUsers is set. */
export function summarizeHolds(rows, { now = new Date(), strandedAfterMinutes = DEFAULT_STRANDED_AFTER_MINUTES, revealUsers = false, salt = randomBytes(16).toString("hex"), top = 10 } = {}) {
  const label = (userId) => (revealUsers ? userId : `acct_${createHash("sha256").update(`${salt}:${userId}`).digest("hex").slice(0, 10)}`);
  const kinds = {};
  const perUser = new Map();
  for (const row of rows) {
    const found = classifyUsageRow(row, { now, strandedAfterMinutes });
    if (!found) continue;
    const kind = (kinds[found.kind] ??= { rows: 0, accounts: new Set(), heldMicros: 0, byAge: Object.fromEntries(AGE_BUCKETS.map(([name]) => [name, 0])), byModel: {} });
    kind.rows += 1;
    kind.accounts.add(row.userId);
    kind.heldMicros += found.heldMicros;
    kind.byAge[ageBucket(found.ageMs)] += 1;
    kind.byModel[row.model] = (kind.byModel[row.model] ?? 0) + 1;
    if (found.kind !== "in_flight") {
      const user = perUser.get(row.userId) ?? { rows: 0, heldMicros: 0 };
      user.rows += 1;
      user.heldMicros += found.heldMicros;
      perUser.set(row.userId, user);
    }
  }
  const out = {};
  for (const [name, kind] of Object.entries(kinds)) out[name] = { rows: kind.rows, accounts: kind.accounts.size, heldMicros: kind.heldMicros, heldUsd: Number((kind.heldMicros / 1_000_000).toFixed(4)), byAge: kind.byAge, byModel: kind.byModel };
  const mostAffected = [...perUser.entries()].sort((a, b) => b[1].heldMicros - a[1].heldMicros).slice(0, top)
    .map(([userId, user]) => ({ account: label(userId), rows: user.rows, heldMicros: user.heldMicros, heldUsd: Number((user.heldMicros / 1_000_000).toFixed(4)) }));
  return { kinds: out, mostAffected };
}

/**
 * Runs the report against a pg-compatible client (`query(text, params)`), inside a READ ONLY transaction that is always rolled back.
 * `since` defaults to the start of the current UTC month: the credit period every account uses.
 */
export async function usageHoldReport(client, { now = new Date(), since = null, strandedAfterMinutes = DEFAULT_STRANDED_AFTER_MINUTES, revealUsers = false, top = 10 } = {}) {
  const from = since ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout = '60s'");
    const { rows } = await client.query(
      `SELECT user_id AS "userId", model, cost_micros AS "costMicros", reserved_tokens AS "reservedTokens", created_at AS "createdAt"
         FROM usage_events
        WHERE created_at >= $1 AND created_at <= $2 AND cost_micros = 0 AND left(model, 2) <> '__'`,
      [from.toISOString(), now.toISOString()],
    );
    return {
      generatedAt: now.toISOString(),
      period: { from: from.toISOString(), to: now.toISOString() },
      strandedAfterMinutes,
      readOnly: true,
      ...summarizeHolds(rows, { now, strandedAfterMinutes, revealUsers, top }),
    };
  } finally {
    await client.query("ROLLBACK");
  }
}
