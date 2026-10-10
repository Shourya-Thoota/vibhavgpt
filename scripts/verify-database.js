import { pool } from "../src/db/client.js";

const expectedTables = [
  "conversations",
  "memory_facts",
  "messages",
  "subscriptions",
  "usage_events",
  "user_profiles",
];

try {
  const result = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  const tables = result.rows
    .map((row) => row.table_name)
    .filter((name) => expectedTables.includes(name));

  if (tables.length !== expectedTables.length) {
    const missing = expectedTables.filter((name) => !tables.includes(name));
    throw new Error(`Missing application tables: ${missing.join(", ")}`);
  }

  console.log(JSON.stringify({ connected: true, tables }));
} finally {
  await pool.end();
}
