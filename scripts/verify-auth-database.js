import { pool } from "../src/db/client.js";

const expectedTables = ["user", "session", "account", "verification"];

try {
  const result = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  const tables = result.rows
    .map((row) => row.table_name)
    .filter((name) => expectedTables.includes(name));
  const missing = expectedTables.filter((name) => !tables.includes(name));

  if (missing.length) {
    throw new Error(`Missing authentication tables: ${missing.join(", ")}`);
  }

  console.log(JSON.stringify({ connected: true, tables }));
} finally {
  await pool.end();
}
