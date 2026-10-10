import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { app } from "../src/server.js";
import { pool } from "../src/db/client.js";

const port = 3106, origin = `http://127.0.0.1:${port}`;
// A fresh password per run for the disposable local test account.
const password = `Verify-${randomBytes(18).toString("base64url")}9`;
const emails = [`admin-test-${randomUUID()}@example.invalid`, `member-test-${randomUUID()}@example.invalid`];
const ids = [];
let server;
async function request(path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { response, data: response.status === 204 ? null : await response.json() };
}
async function cleanup() {
  for (const id of ids) { await pool.query("DELETE FROM usage_events WHERE user_id=$1", [id]); await pool.query("DELETE FROM subscriptions WHERE user_id=$1", [id]); await pool.query("DELETE FROM memory_facts WHERE user_id=$1", [id]); await pool.query("DELETE FROM user_profiles WHERE user_id=$1", [id]); await pool.query("DELETE FROM conversations WHERE user_id=$1", [id]); await pool.query('DELETE FROM "user" WHERE id=$1', [id]); }
}
try {
  server = app.listen(port, "127.0.0.1");
  const sessions = [];
  for (const [index, email] of emails.entries()) {
    const signup = await request("/api/auth/sign-up/email", { method: "POST", body: { email, password, name: index ? "Member Test" : "Admin Test" } });
    assert.equal(signup.response.status, 200); ids.push(signup.data.user.id); sessions.push(signup.response.headers.get("set-cookie").split(";")[0]);
  }
  await pool.query("INSERT INTO user_profiles (user_id, is_admin) VALUES ($1, true)", [ids[0]]);
  const denied = await request("/api/admin/stats", { cookie: sessions[1] });
  assert.equal(denied.response.status, 403);
  const allowed = await request("/api/admin/stats", { cookie: sessions[0] });
  assert.equal(allowed.response.status, 200, JSON.stringify(allowed.data));
  assert.ok(allowed.data.totalUsers >= 2); assert.ok("messagesByModel" in allowed.data);
  console.log(JSON.stringify({ adminAllowed: "ok", nonAdminDenied: "ok" }));
} finally { await cleanup(); console.log(JSON.stringify({ testAccountsAndDataDeleted: true })); if (server) await new Promise((r) => server.close(r)); await pool.end(); }
