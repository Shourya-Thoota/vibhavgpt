import { getMigrations } from "better-auth/db/migration";
import { auth } from "../src/auth.js";
import { pool } from "../src/db/client.js";

try {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  console.log("Authentication tables migrated successfully.");
} finally {
  await pool.end();
}
