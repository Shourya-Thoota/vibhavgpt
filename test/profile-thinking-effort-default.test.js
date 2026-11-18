import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

// Spin up PGlite and run all migrations to match the deployed database schema
const client = new PGlite();
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) {
  await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
}
const db = drizzle(client);

mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db, pool: { query: (sql, params) => client.query(sql, params) } },
});
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => (req.authSession ? next() : res.status(401).json({ error: "Sign in is required." })),
    loadOptionalSession: (_req, _res, next) => next(),
  },
});

const { default: express } = await import("express");
const { profileRouter } = await import("../src/profile/router.js");
const { thinkingUsageFor } = await import("../src/usage/service.js");
const { reasoningParameter } = await import("../src/chat/reasoning-effort.js");

async function call(t, userId, method, path, body) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/profile", profileRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/profile${path}`, {
    method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

test("deployed database schema retains old 'normal' default in information_schema", async () => {
  const { rows } = await client.query(
    "SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'thinking_effort'"
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0].column_default, /'normal'/);
});

test("a newly created profile with no preference receives Low through application behavior", async (t) => {
  const userId = "user-brand-new";

  // 1. Before any database row exists, GET /api/profile returns Low
  const initial = await call(t, userId, "GET", "/preferences");
  assert.equal(initial.status, 200);
  assert.equal(initial.body.thinkingEffort, "low");

  // Frontend selection fallback agrees
  const frontendSelection = initial.body.thinkingEffort ?? "low";
  assert.equal(frontendSelection, "low");

  // Outbound model effort agrees
  const outboundEffort = thinkingUsageFor("nova", initial.body.thinkingEffort);
  assert.deepEqual(outboundEffort, { effort: "low", providerEffort: "low" });
  assert.deepEqual(reasoningParameter("anthropic/claude-haiku-5.5", outboundEffort.providerEffort), { effort: "low" });

  // 2. Saving initial preferences without providing thinkingEffort writes "low" to DB
  const saved = await call(t, userId, "PATCH", "/preferences", { responseStyle: "concise" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.thinkingEffort, "low");

  // Verify the row stored in the database has "low", not the database column default "normal"
  const { rows } = await client.query("SELECT thinking_effort FROM user_profiles WHERE user_id = $1", [userId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].thinking_effort, "low");

  // Reading profile back confirms "low"
  const readBack = await call(t, userId, "GET", "/preferences");
  assert.equal(readBack.body.thinkingEffort, "low");
});

test("auxiliary profile creation (last-used-model, product-mode, onboarding) explicitly writes Low", async (t) => {
  const userA = "user-aux-model";
  const modelRes = await call(t, userA, "PATCH", "/last-used-model", { lastUsedModel: "vesper" });
  assert.equal(modelRes.status, 200);
  const { rows: rowsA } = await client.query("SELECT thinking_effort FROM user_profiles WHERE user_id = $1", [userA]);
  assert.equal(rowsA[0].thinking_effort, "low");
  const readA = await call(t, userA, "GET", "/preferences");
  assert.equal(readA.body.thinkingEffort, "low");

  const userB = "user-aux-mode";
  const modeRes = await call(t, userB, "PATCH", "/product-mode", { productMode: "study" });
  assert.equal(modeRes.status, 200);
  const { rows: rowsB } = await client.query("SELECT thinking_effort FROM user_profiles WHERE user_id = $1", [userB]);
  assert.equal(rowsB[0].thinking_effort, "low");
  const readB = await call(t, userB, "GET", "/preferences");
  assert.equal(readB.body.thinkingEffort, "low");
});

test("an existing explicit Normal preference remains Normal and is not overwritten", async (t) => {
  const userId = "user-existing-normal";
  // Seed existing database row with "normal"
  await client.query(
    "INSERT INTO user_profiles (user_id, response_style, thinking_effort) VALUES ($1, $2, $3)",
    [userId, "balanced", "normal"]
  );

  // Read returns Normal
  const profile = await call(t, userId, "GET", "/preferences");
  assert.equal(profile.body.thinkingEffort, "normal");

  // Frontend selection agrees
  const frontendSelection = profile.body.thinkingEffort ?? "low";
  assert.equal(frontendSelection, "normal");

  // Outbound: an older Normal is the unified Medium (2026-11-16), sent as medium; the stored value itself is not rewritten.
  const outboundEffort = thinkingUsageFor("nova", profile.body.thinkingEffort);
  assert.deepEqual(outboundEffort, { effort: "medium", providerEffort: "medium" });
  assert.deepEqual(reasoningParameter("anthropic/claude-haiku-5.5", outboundEffort.providerEffort), { effort: "medium" });

  // Updating other preferences without thinkingEffort preserves Normal
  const updated = await call(t, userId, "PATCH", "/preferences", { customInstructions: "Remember my name" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.thinkingEffort, "normal");

  // Auxiliary writes preserve Normal
  await call(t, userId, "PATCH", "/last-used-model", { lastUsedModel: "vesper" });
  const { rows } = await client.query("SELECT thinking_effort FROM user_profiles WHERE user_id = $1", [userId]);
  assert.equal(rows[0].thinking_effort, "normal");
});

test("higher explicit selections (high, xhigh, max) remain unchanged", async (t) => {
  for (const level of ["high", "xhigh", "max"]) {
    const userId = `user-existing-${level}`;
    await client.query(
      "INSERT INTO user_profiles (user_id, response_style, thinking_effort) VALUES ($1, $2, $3)",
      [userId, "detailed", level]
    );

    // Profile read returns explicit level
    const profile = await call(t, userId, "GET", "/preferences");
    assert.equal(profile.body.thinkingEffort, level);

    // Frontend selection agrees
    assert.equal(profile.body.thinkingEffort ?? "low", level);

    // Outbound: each is the unified High, the engine's highest level (2026-11-16); the stored value itself is not rewritten.
    const outboundEffort = thinkingUsageFor("nova", profile.body.thinkingEffort);
    assert.deepEqual(outboundEffort, { effort: "max", providerEffort: "max" });
    assert.deepEqual(reasoningParameter("anthropic/claude-haiku-5.5", outboundEffort.providerEffort), { effort: "max" });

    // Partial preference update preserves level
    const patched = await call(t, userId, "PATCH", "/preferences", { responseStyle: "concise" });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.thinkingEffort, level);

    const { rows } = await client.query("SELECT thinking_effort FROM user_profiles WHERE user_id = $1", [userId]);
    assert.equal(rows[0].thinking_effort, level);
  }
});
