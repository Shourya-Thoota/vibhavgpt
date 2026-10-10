import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { app } from "../src/server.js";
import { pool } from "../src/db/client.js";

const port = 3102;
const origin = `http://127.0.0.1:${port}`;
const email = `chat-test-${randomUUID()}@example.invalid`;
// A fresh password per run for the disposable local test account.
const password = `Verify-${randomBytes(18).toString("base64url")}9`;
let userId;
let server;

async function request(path, body, cookie) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}

async function get(path, cookie) {
  const response = await fetch(`${origin}${path}`, { headers: { Origin: origin, Cookie: cookie } });
  const data = await response.json();
  return { response, data };
}

async function stream(path, body, cookie) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", Origin: origin, Cookie: cookie },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const events = text.split("\n\n").flatMap((block) => {
    const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
    const data = block.match(/^data:\s*(.+)$/m)?.[1];
    if (!event || !data) return [];
    return [{ event, data: JSON.parse(data) }];
  });
  return { response, events };
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
    email,
    password,
    name: "Chat Verification",
  });
  assert.equal(signup.response.status, 200, JSON.stringify(signup.data));
  userId = signup.data.user?.id;
  assert.ok(userId, "Sign-up did not return a user id.");

  const rawCookie = signup.response.headers.get("set-cookie");
  const cookie = rawCookie?.split(";")[0];
  assert.ok(cookie, "Sign-up did not create a session cookie.");

  const chat = await request(
    "/api/chat",
    { model: "lumen", message: "What is your name? Answer with only your name." },
    cookie,
  );
  assert.equal(chat.response.status, 200, JSON.stringify(chat.data));
  assert.ok(chat.data.conversationId, "Chat did not return a conversation id.");
  assert.match(chat.data.reply, /VibhavGPT Lumen/i);
  assert.equal(chat.data.model, "VibhavGPT Lumen");

  const stored = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM conversations WHERE id = $1 AND user_id = $2) AS conversations,
       (SELECT count(*)::int FROM messages WHERE conversation_id = $1) AS messages`,
    [chat.data.conversationId, userId],
  );
  assert.equal(stored.rows[0].conversations, 1);
  assert.equal(stored.rows[0].messages, 2);

  const resumed = await get(`/api/chat/conversations/${chat.data.conversationId}`, cookie);
  assert.equal(resumed.response.status, 200, JSON.stringify(resumed.data));
  assert.deepEqual(resumed.data.history.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "What is your name? Answer with only your name." },
    { role: "assistant", content: chat.data.reply },
  ]);

  // Exercise the actual long-history handler with >10 saved exchanges. These
  // synthetic prior turns are dated before the real exchange and are removed
  // with this throwaway test account in finally.
  const longContent = `Older context: ${"prior conversation fact ".repeat(60)}`;
  for (let index = 0; index < 25; index += 1) {
    const baseMinutes = 1_440 - 50 + index * 2;
    await pool.query(
      `INSERT INTO messages (conversation_id, role, content, created_at) VALUES
        ($1, 'user', $2, now() - ($3::int * interval '1 minute')),
        ($1, 'assistant', $4, now() - (($3::int - 1) * interval '1 minute'))`,
      [chat.data.conversationId, `Earlier question ${index}: ${longContent}`, baseMinutes, `Earlier answer ${index}: ${longContent}`],
    );
  }
  const streamed = await stream("/api/chat/stream", {
    model: "lumen",
    conversationId: chat.data.conversationId,
    message: "Please summarize the conversation briefly, including the original name you stated.",
  }, cookie);
  assert.equal(streamed.response.status, 200);
  assert.ok(streamed.events.some((event) => event.event === "complete"), JSON.stringify(streamed.events.find((event) => event.event === "error")?.data));
  const resumedAfterStream = await get(`/api/chat/conversations/${chat.data.conversationId}`, cookie);
  assert.equal(resumedAfterStream.response.status, 200);
  assert.equal(resumedAfterStream.data.history.at(-1).role, "assistant");

  console.log(JSON.stringify({
    chat: "ok",
    conversationPersisted: true,
    conversationResumedAfterReload: true,
    streamedReplyAfterLongHistory: true,
    seededPriorExchanges: 25,
    contextFitEstimate: "within shared budget (verified by successful live model response)",
  }));
} finally {
  await cleanup();
  console.log(JSON.stringify({ testAccountAndDataDeleted: true }));
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
