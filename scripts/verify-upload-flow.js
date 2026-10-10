import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { pool } from "../src/db/client.js";
import { uploadRoot } from "../src/uploads/service.js";

const baseUrl = process.env.UPLOAD_TEST_BASE_URL ?? "http://127.0.0.1:3001";
const verifyLocalFile = process.env.UPLOAD_TEST_SKIP_LOCAL_FILE_CHECK !== "true";
const origin = process.env.UPLOAD_TEST_ORIGIN ?? "http://localhost:5173";
const email = `upload-test-${randomUUID()}@example.invalid`;
// A fresh password per run for the disposable local test account.
const password = `Verify-${randomBytes(18).toString("base64url")}9`;
let userId;
let storedName;

async function jsonRequest(pathname, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, data: response.status === 204 ? null : await response.json() };
}

async function cleanup() {
  if (!userId) return;
  const uploaded = await pool.query("SELECT stored_name FROM attachments WHERE user_id = $1", [userId]);
  for (const row of uploaded.rows) {
    await import("node:fs/promises").then(({ rm }) => rm(path.join(uploadRoot, row.stored_name), { force: true }));
  }
  await pool.query("DELETE FROM usage_events WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM subscriptions WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM memory_facts WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM user_profiles WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM conversations WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM attachments WHERE user_id = $1", [userId]);
  await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
}

try {
  const signup = await jsonRequest("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password, name: "Upload Verification" },
  });
  assert.equal(signup.response.status, 200, JSON.stringify(signup.data));
  userId = signup.data.user?.id;
  assert.ok(userId, "Sign-up did not create a test user.");
  // New accounts correctly do not receive a session until email verification.
  // Mark only this disposable account verified, then exercise the normal
  // password sign-in path used by a real verified account.
  await pool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [userId]);
  const login = await jsonRequest("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password },
  });
  assert.equal(login.response.status, 200, JSON.stringify(login.data));
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "Sign-in did not create a session cookie.");

  const formData = new FormData();
  formData.append("files", new Blob(["The project deadline is Friday. The launch priority is reliability."], { type: "text/plain" }), "project-notes.txt");
  const uploadResponse = await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie },
    body: formData,
  });
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 201, JSON.stringify(upload));
  assert.equal(upload.attachments.length, 1);

  const [stored] = await pool.query(
    "SELECT stored_name, extracted_text, message_id FROM attachments WHERE id = $1 AND user_id = $2",
    [upload.attachments[0].id, userId],
  ).then((result) => result.rows);
  assert.ok(stored?.extracted_text.includes("deadline is Friday"), "Extracted document text was not stored.");
  assert.equal(stored.message_id, null, "Fresh upload was unexpectedly attached to a message.");
  storedName = stored.stored_name;
  if (verifyLocalFile) await access(path.join(uploadRoot, storedName));

  const chat = await jsonRequest("/api/chat", {
    method: "POST",
    cookie,
    body: { model: "lumen", message: "What deadline is mentioned in the attached note?", attachmentIds: [upload.attachments[0].id] },
  });
  assert.equal(chat.response.status, 200, JSON.stringify(chat.data));
  assert.match(chat.data.reply, /Friday/i, "The model did not use the attached document text.");

  const attached = await pool.query(
    "SELECT conversation_id, message_id FROM attachments WHERE id = $1 AND user_id = $2",
    [upload.attachments[0].id, userId],
  );
  assert.equal(attached.rows[0].conversation_id, chat.data.conversationId);
  assert.ok(attached.rows[0].message_id, "The upload was not linked to the user message.");

  const deleted = await jsonRequest("/api/account", { method: "DELETE", cookie });
  assert.equal(deleted.response.status, 204, "Account deletion did not complete.");
  const remaining = await pool.query(
    `SELECT
      (SELECT count(*)::int FROM "user" WHERE id = $1) AS users,
      (SELECT count(*)::int FROM attachments WHERE user_id = $1) AS attachments,
      (SELECT count(*)::int FROM conversations WHERE user_id = $1) AS conversations`,
    [userId],
  );
  assert.deepEqual(remaining.rows[0], { users: 0, attachments: 0, conversations: 0 });
  if (verifyLocalFile) await assert.rejects(() => access(path.join(uploadRoot, storedName)));
  userId = undefined;
  console.log(JSON.stringify({ upload: "ok", extraction: "ok", chatReference: "ok", accountCleanup: "ok" }));
} finally {
  await cleanup();
  await pool.end();
}
