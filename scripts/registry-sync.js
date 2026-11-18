// Prepares the native model registry from researched evidence.
//
//   node scripts/registry-sync.js                 dry run against DATABASE_URL (reads only)
//   node scripts/registry-sync.js --offline       dry run against an empty registry (no database)
//   node scripts/registry-sync.js --json          print the plan as JSON
//   node scripts/registry-sync.js --apply --confirm=write-pending-records
//
// It writes only pending records: no privacy approval, reviewer, activation or active
// state. See src/models/registry-sync.js for the guarantees. DATABASE_URL is never printed.
import { buildDesiredNativeRegistry, OWNER_EVIDENCE_REQUIRED } from "../src/models/native-registry-evidence.js";
import { applyRegistrySync, formatRegistryPlan, planRegistrySync, readCurrentRegistry, RegistrySyncError } from "../src/models/registry-sync.js";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const confirmed = process.argv.includes("--confirm=write-pending-records");
const offline = args.has("--offline");
const asJson = args.has("--json");

if (apply && !confirmed) {
  console.error("Refusing to write: pass --confirm=write-pending-records together with --apply.");
  process.exit(2);
}
if (apply && offline) {
  console.error("--offline can only be a dry run.");
  process.exit(2);
}

const desired = buildDesiredNativeRegistry();
let exitCode = 0;
let pool = null;
try {
  let plan;
  if (offline) {
    plan = planRegistrySync(desired);
  } else {
    if (!process.env.DATABASE_URL) throw new RegistrySyncError("DATABASE_URL is required (use --offline for a dry run without a database).", "no_database");
    const client = await import("../src/db/client.js");
    pool = client.pool;
    plan = apply ? await applyRegistrySync(desired, client.db) : planRegistrySync(desired, await readCurrentRegistry(client.db));
  }
  if (asJson) console.log(JSON.stringify(plan, null, 2));
  else {
    console.log(formatRegistryPlan(plan));
    console.log(apply ? "\nApplied. Records are pending; nothing was approved or activated." : "\nDry run only. Nothing was written.");
    console.log("\nStill needed from the account owner before any tier can be activated:");
    for (const item of OWNER_EVIDENCE_REQUIRED) console.log(` - [${item.tiers.join(", ")}] ${item.fact}\n     Where: ${item.where}`);
  }
  if (plan.conflicts.length) exitCode = 3;
} catch (error) {
  console.error(error instanceof RegistrySyncError ? `${error.code}: ${error.message}` : `Registry sync failed: ${error.name}`);
  exitCode = 1;
} finally {
  await pool?.end?.();
}
process.exit(exitCode);
