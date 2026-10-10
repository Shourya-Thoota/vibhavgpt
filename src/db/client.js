import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config, requireDatabaseConfig } from "../config.js";

requireDatabaseConfig();

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl
    ? { rejectUnauthorized: config.databaseSslRejectUnauthorized }
    : undefined,
});

export const db = drizzle({ client: pool });
