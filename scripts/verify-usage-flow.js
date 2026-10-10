import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { app } from "../src/server.js";
import { pool } from "../src/db/client.js";
import { cancelUsageReservation, reserveUsage } from "../src/usage/service.js";

const port = 3104;
const origin = `http://127.0.0.1:${port}`;
const email = `usage-test-${randomUUID()}@example.invalid`;
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
  if (!userId) {
    const result = await pool.query('SELECT id FROM "user" WHERE email = $1', [email]);
    userId = result.rows[0]?.id;
  }
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
  const signup = await request("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password, name: "Usage Verification" },
  });
  assert.equal(signup.response.status, 200, JSON.stringify(signup.data));
  userId = signup.data.user.id;
  const cookie = signup.response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);

  const initial = await request("/api/usage", { cookie });
  assert.equal(initial.response.status, 200);
  assert.equal(initial.data.tier, "free");
  assert.equal(initial.data.tokensThisPeriod, 0);

  const chat = await request("/api/chat", {
    method: "POST",
    cookie,
    body: { model: "lumen", message: "Reply with the word confirmed." },
  });
  assert.equal(chat.response.status, 200, JSON.stringify(chat.data));

  const afterOne = await request("/api/usage", { cookie });
  assert.ok(afterOne.data.tokenBreakdown.lumen.total > 0);

  const paidModelBlocked = await request("/api/chat", {
    method: "POST",
    cookie,
    body: { model: "nebula", message: "This should be blocked before inference." },
  });
  assert.equal(paidModelBlocked.response.status, 429);

  await pool.query(
    "INSERT INTO usage_events (user_id, model, input_tokens) VALUES ($1, 'lumen', 100000)",
    [userId],
  );
  const capped = await request("/api/chat", {
    method: "POST",
    cookie,
    body: { model: "lumen", message: "This should be capped before inference." },
  });
  assert.equal(capped.response.status, 429);

  await pool.query(
    "INSERT INTO subscriptions (user_id, tier, status) VALUES ($1, 'paid', 'active')",
    [userId],
  );
  const paid = await request("/api/usage", { cookie });
  assert.equal(paid.data.tier, "pro");
  const reservation = await reserveUsage(userId, "nebula");
  await cancelUsageReservation(reservation.id);

  console.log(JSON.stringify({ freeUsageRecorded: "ok", freeCapsEnforced: "ok", paidTierAndAccess: "ok" }));
} finally {
  await cleanup();
  console.log(JSON.stringify({ testAccountAndDataDeleted: true }));
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
