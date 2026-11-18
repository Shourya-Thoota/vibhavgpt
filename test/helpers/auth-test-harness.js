import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { setSkillsDbForTest } from "../../src/skills/service.js";
import { setConnectorsDbForTest } from "../../src/connectors/service.js";
import * as schema from "../../src/db/schema.js";

/**
 * Cloudflare Turnstile Test Keys (official always-passing test credentials).
 * Use these in test environments to test bot protection without bypassing verification.
 */
export const TURNSTILE_TEST_CONFIG = Object.freeze({
  secretKey: "1x0000000000000000000000000000000AA",
  siteKey: "1x00000000000000000000AA",
  dummyValidToken: "1x00000000000000000000AA",
  allowedHostnames: ["localhost", "127.0.0.1", "vibhavgpt.com"],
});

/**
 * Creates an in-memory, fully isolated authenticated test harness for unit and integration testing.
 * Runs against in-memory PGlite, creates standard schema tables, and establishes a valid user session.
 *
 * @param {Object} [options]
 * @param {string} [options.userId]
 * @param {string} [options.email]
 * @param {string} [options.tier] 'free' | 'plus' | 'pro' | 'max'
 * @returns {Promise<{
 *   client: PGlite,
 *   db: any,
 *   user: { id: string, email: string },
 *   session: { id: string, token: string, expiresAt: Date },
 *   cookieHeader: string,
 *   authHeaders: Record<string, string>,
 *   mockAuthMiddleware: (req: any, res: any, next: any) => void
 * }>}
 */
export async function createIsolatedAuthFixture({
  userId = `usr_${crypto.randomBytes(8).toString("hex")}`,
  email = "test-engineer@example.com",
  tier = "plus",
} = {}) {
  // Ensure test environment flags are populated
  process.env.TURNSTILE_SECRET_KEY ||= TURNSTILE_TEST_CONFIG.secretKey;
  process.env.TURNSTILE_ALLOWED_HOSTNAMES ||= TURNSTILE_TEST_CONFIG.allowedHostnames.join(",");
  process.env.BETTER_AUTH_SECRET ||= "isolated-test-auth-secret-32-chars-long-minimum";

  const client = new PGlite();

  // Core user table required by auth and foreign keys
  await client.exec(`
    CREATE TABLE IF NOT EXISTS "user" (
      id text PRIMARY KEY,
      email text NOT NULL UNIQUE,
      name text,
      "emailVerified" boolean DEFAULT false,
      image text,
      "createdAt" timestamp with time zone DEFAULT now(),
      "updatedAt" timestamp with time zone DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS "session" (
      id text PRIMARY KEY,
      "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      token text NOT NULL UNIQUE,
      "expiresAt" timestamp with time zone NOT NULL,
      "ipAddress" text,
      "userAgent" text,
      "createdAt" timestamp with time zone DEFAULT now(),
      "updatedAt" timestamp with time zone DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS "account" (
      id text PRIMARY KEY,
      "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS "verification" (
      id text PRIMARY KEY,
      identifier text NOT NULL,
      value text,
      "expiresAt" timestamp with time zone
    );
  `);

  // Execute drizzle migrations
  const journalUrl = new URL("../../drizzle/meta/_journal.json", import.meta.url);
  const journal = JSON.parse(await readFile(journalUrl, "utf8"));
  for (const entry of journal.entries) {
    const migrationSql = await readFile(new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
    await client.exec(migrationSql);
  }

  const db = drizzle(client, { schema });

  // Bind service test databases
  setSkillsDbForTest(db);
  setConnectorsDbForTest(db);

  // Seed user
  await client.query(
    `INSERT INTO "user" (id, email, name, "emailVerified") VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING`,
    [userId, email, "Test User"]
  );

  // Seed user profile
  await client.query(
    `INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING`,
    [userId]
  );

  // Seed subscription tier
  const now = new Date();
  await db.insert(schema.subscriptions).values({
    userId,
    tier,
    status: "active",
    currentPeriodStartedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    currentPeriodEndsAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    updatedAt: now,
  });

  // Seed session
  const sessionId = `sess_${crypto.randomBytes(12).toString("hex")}`;
  const sessionToken = `tok_${crypto.randomBytes(24).toString("hex")}`;
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  await client.query(
    `INSERT INTO "session" (id, "userId", token, "expiresAt") VALUES ($1, $2, $3, $4)`,
    [sessionId, userId, sessionToken, expiresAt]
  );

  const cookieHeader = `better-auth.session_token=${sessionToken}`;
  const authHeaders = {
    cookie: cookieHeader,
  };

  const user = { id: userId, email, name: "Test User" };
  const session = { id: sessionId, token: sessionToken, expiresAt };

  // Helper middleware for direct router unit testing (bypassing HTTP stack if desired)
  const mockAuthMiddleware = (req, _res, next) => {
    req.user = user;
    req.authSession = { session, user };
    next();
  };

  return {
    client,
    db,
    user,
    session,
    cookieHeader,
    authHeaders,
    mockAuthMiddleware,
  };
}

