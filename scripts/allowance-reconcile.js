// Resolves reservations whose billable usage could not be established.
//
//   node scripts/allowance-reconcile.js --list [--user=<id>]
//   node scripts/allowance-reconcile.js --reservation=<id> --raw-cost-micros=N --customer-micros=N \
//        --actor="<your name>" --reason="<why, 8+ chars>" [--confirm=reconcile]
//   node scripts/allowance-reconcile.js --reservation=<id> --zero-usage \
//        --actor="<your name>" --reason="<why, 8+ chars>" [--confirm=release]
//
// Without --confirm it only shows what would be recorded. Amounts come from the
// provider's own record of that request; nothing is priced from estimates here.
// DATABASE_URL is never printed.
import { listOpenReservations, reconcileOpenReservation, releaseOpenReservationWithZeroUsage } from "../src/usage/allowance-operations.js";

const argv = process.argv.slice(2);
const flag = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const has = (name) => argv.includes(`--${name}`);
const whole = (value) => (value === undefined || !/^\d+$/.test(value) ? undefined : Number(value));

let pool = null;
let exitCode = 0;
try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const client = await import("../src/db/client.js");
  pool = client.pool;
  const { db } = client;

  if (has("list")) {
    const rows = await listOpenReservations({ userId: flag("user") ?? null }, db);
    if (!rows.length) console.log("No uncertain or lapsed reservations.");
    for (const row of rows) console.log(`${row.reservationId}  ${row.status.padEnd(9)} held=${row.heldMicros}  age=${row.ageMinutes}m  model=${row.modelKey}  user=${row.userId}  request=${row.requestId}  ${row.reason ?? ""}`);
  } else if (flag("reservation")) {
    const common = { reservationId: flag("reservation"), actor: flag("actor"), reason: flag("reason") };
    const result = has("zero-usage")
      ? await releaseOpenReservationWithZeroUsage({ ...common, apply: flag("confirm") === "release" }, db)
      : await reconcileOpenReservation({ ...common, rawCostMicros: whole(flag("raw-cost-micros")), customerMicros: whole(flag("customer-micros")), apply: flag("confirm") === "reconcile" }, db);
    console.log(JSON.stringify(result, null, 2));
    if (!result.applied) console.log("Dry run only. Nothing was written. Add the matching --confirm to record it.");
  } else {
    console.error("Use --list, or --reservation=<id> with the options shown at the top of this file.");
    exitCode = 2;
  }
} catch (error) {
  console.error(error?.code ? `${error.code}: ${error.message}` : `Failed: ${error?.name ?? "Error"}`);
  exitCode = 1;
} finally {
  await pool?.end?.();
}
process.exit(exitCode);
