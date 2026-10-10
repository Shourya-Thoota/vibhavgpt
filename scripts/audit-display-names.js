// READ ONLY. Counts the accounts whose stored account name or survey
// "Call me" name fails the display-name check, and lists their user IDs.
// It never prints a name and never writes: everything runs inside a
// read-only transaction that is rolled back. Names that fail are already
// withheld wherever they would be shown, so nothing needs to change.
//
// Usage: node scripts/audit-display-names.js
// Uses DATABASE_URL and NAME_BLOCKLIST from the environment, and only the
// local check (no moderation call).
import { pool } from "../src/db/client.js";
import { checkDisplayName, preferredNameFromInstructions, warnIfNameBlocklistMissing } from "../src/security/display-name.js";

export function auditRows(rows) {
  const flagged = { accountName: [], preferredName: [] };
  const reasons = {};
  for (const row of rows) {
    const account = checkDisplayName(row.name);
    const preferred = checkDisplayName(preferredNameFromInstructions(row.custom_instructions));
    if (!account.allowed) flagged.accountName.push(row.id);
    if (!preferred.allowed) flagged.preferredName.push(row.id);
    for (const verdict of [account, preferred]) if (!verdict.allowed) reasons[verdict.reason] = (reasons[verdict.reason] ?? 0) + 1;
  }
  return { checked: rows.length, flagged, reasons };
}

async function run() {
  warnIfNameBlocklistMissing();
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const { rows } = await client.query(
      'SELECT u.id, u.name, p.custom_instructions FROM "user" u LEFT JOIN user_profiles p ON p.user_id = u.id ORDER BY u.id',
    );
    const { checked, flagged, reasons } = auditRows(rows);
    console.log(`Accounts checked: ${checked}`);
    console.log(`Account names that fail the check: ${flagged.accountName.length}`);
    for (const id of flagged.accountName) console.log(`  ${id}`);
    console.log(`"Call me" names that fail the check: ${flagged.preferredName.length}`);
    for (const id of flagged.preferredName) console.log(`  ${id}`);
    console.log(`By reason: ${JSON.stringify(reasons)}`);
  } finally {
    await client.query("ROLLBACK").catch(() => null);
    client.release();
    await pool.end();
  }
}

// Run only when called directly, so tests can import auditRows.
if (process.argv[1]?.endsWith("audit-display-names.js")) {
  run().catch((error) => {
    console.error("Audit failed:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  });
}
