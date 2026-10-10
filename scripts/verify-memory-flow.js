import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { app } from "../src/server.js";
import { pool } from "../src/db/client.js";

const port = 3103;
const origin = `http://127.0.0.1:${port}`;
const email = `memory-test-${randomUUID()}@example.invalid`;
// A fresh password per run for the disposable local test account.
const password = `Verify-${randomBytes(18).toString("base64url")}9`;
let userId;
let server;

async function request(path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
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
    body: { email, password, name: "Memory Verification" },
  });
  assert.equal(signup.response.status, 200, JSON.stringify(signup.data));
  userId = signup.data.user.id;
  const cookie = signup.response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "Sign-up did not create a session.");

  const created = await request("/api/memory", {
    method: "POST",
    cookie,
    body: { content: "User's favorite subject is science." },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));

  const edited = await request(`/api/memory/${created.data.fact.id}`, {
    method: "PATCH",
    cookie,
    body: { content: "User's favorite subject is computer science." },
  });
  assert.equal(edited.response.status, 200, JSON.stringify(edited.data));

  const crossConversation = await request("/api/chat", {
    method: "POST",
    cookie,
    body: {
      model: "lumen",
      message: "Based only on what you remember about me, what is my favorite subject?",
    },
  });
  assert.equal(crossConversation.response.status, 200, JSON.stringify(crossConversation.data));
  assert.match(crossConversation.data.reply, /computer science/i);

  const extracted = await request("/api/chat", {
    method: "POST",
    cookie,
    body: { model: "lumen", message: "I play chess competitively." },
  });
  assert.equal(extracted.response.status, 200, JSON.stringify(extracted.data));

  const listed = await request("/api/memory", { cookie });
  assert.equal(listed.response.status, 200, JSON.stringify(listed.data));
  assert.ok(listed.data.facts.some((fact) => /chess competitively/i.test(fact.content)));

  const deleted = await request(`/api/memory/${created.data.fact.id}`, {
    method: "DELETE",
    cookie,
  });
  assert.equal(deleted.response.status, 204);
  console.log(JSON.stringify({ manualMemoryCrud: "ok", crossConversationRecall: "ok", autoExtraction: "ok" }));
} finally {
  await cleanup();
  console.log(JSON.stringify({ testAccountAndDataDeleted: true }));
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
