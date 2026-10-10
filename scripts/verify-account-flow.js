import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { app } from "../src/server.js";
import { pool } from "../src/db/client.js";

const port = 3105;
const origin = `http://127.0.0.1:${port}`;
const email = `account-test-${randomUUID()}@example.invalid`;
// A fresh password per run for the disposable local test account.
const password = `Verify-${randomBytes(18).toString("base64url")}9`;
let userId;
let server;

async function request(path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = response.status === 204 ? null : await response.json();
  return { response, data };
}

async function cleanup() {
  if (!userId) return;
  await pool.query("DELETE FROM usage_events WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM subscriptions WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM memory_facts WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM user_profiles WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM conversations WHERE user_id = $1", [userId]);
  await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
}

try {
  server = app.listen(port, "127.0.0.1");
  const signup = await request("/api/auth/sign-up/email", { method: "POST", body: { email, password, name: "Account Verification" } });
  assert.equal(signup.response.status, 200, JSON.stringify(signup.data));
  userId = signup.data.user.id;
  const cookie = signup.response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const conversationId = randomUUID();
  await pool.query("INSERT INTO user_profiles (user_id, display_name) VALUES ($1, 'Account Verification')", [userId]);
  await pool.query("INSERT INTO conversations (id, user_id, title, model) VALUES ($1, $2, 'Export test', 'lumen')", [conversationId, userId]);
  await pool.query("INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'Export this message'), ($1, 'assistant', 'Exported reply')", [conversationId]);
  await pool.query("INSERT INTO memory_facts (user_id, content, source) VALUES ($1, 'User likes testing.', 'manual')", [userId]);
  await pool.query("INSERT INTO usage_events (user_id, model) VALUES ($1, 'lumen')", [userId]);

  const exported = await request("/api/account/export", { cookie });
  assert.equal(exported.response.status, 200, JSON.stringify(exported.data));
  assert.equal(exported.data.account.email, email);
  assert.equal(exported.data.conversations.length, 1);
  assert.equal(exported.data.messages.length, 2);
  assert.equal(exported.data.memory.length, 1);
  assert.equal(exported.data.usage.length, 1);

  const deleted = await request("/api/account", { method: "DELETE", cookie });
  assert.equal(deleted.response.status, 204);
  const remaining = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM "user" WHERE id = $1) AS users,
       (SELECT count(*)::int FROM conversations WHERE user_id = $1) AS conversations,
       (SELECT count(*)::int FROM memory_facts WHERE user_id = $1) AS memory,
       (SELECT count(*)::int FROM usage_events WHERE user_id = $1) AS usage`,
    [userId],
  );
  assert.deepEqual(remaining.rows[0], { users: 0, conversations: 0, memory: 0, usage: 0 });
  console.log(JSON.stringify({ accountExport: "ok", accountDeletion: "ok" }));
  userId = undefined;
} finally {
  await cleanup();
  console.log(JSON.stringify({ testAccountAndDataDeleted: true }));
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
