import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// An old client that still sends the retired "qwen" model key gets the same
// answers as for any other unknown key. Runs against an in-memory database.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
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
const { chatRouter } = await import("../src/chat/router.js");

async function call(t, userId, method, path, body) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/profile", profileRouter);
  app.use("/api/chat", chatRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

const conversationId = "11111111-1111-4111-8111-111111111111";

test("saving qwen as a preference is refused exactly like any unknown model", async (t) => {
  for (const key of ["qwen", "not-a-model"]) {
    for (const field of ["preferredModel", "lastUsedModel"]) {
      const refused = await call(t, "old-client", "PATCH", "/api/profile/preferences", { [field]: key });
      assert.equal(refused.status, 400);
      assert.deepEqual(refused.body, { error: "Choose a valid model." });
    }
  }
});

test("switching a conversation to qwen is refused exactly like any unknown model", async (t) => {
  for (const key of ["qwen", "not-a-model"]) {
    const refused = await call(t, "old-client", "PATCH", `/api/chat/conversations/${conversationId}`, { model: key });
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, { error: "That model is not available." });
  }
});

test("a stored qwen preference is returned as no preference, so the client falls back to Lumen", async (t) => {
  await client.query("INSERT INTO user_profiles (user_id, preferred_model, last_used_model) VALUES ('stale', 'qwen', 'qwen')");
  const loaded = await call(t, "stale", "GET", "/api/profile/preferences");
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.preferredModel, null);
  assert.equal(loaded.body.lastUsedModel, null);
});
