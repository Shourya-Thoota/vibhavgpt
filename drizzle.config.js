import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.js",
  out: "./drizzle",
  dbCredentials: process.env.DATABASE_URL
    ? { url: process.env.DATABASE_URL }
    : undefined,
});

