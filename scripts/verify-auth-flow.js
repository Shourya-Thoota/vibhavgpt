import { randomBytes, randomUUID } from "node:crypto";
import { app } from "../src/server.js";
import { pool } from "../src/db/client.js";

const email = `migration-test-${randomUUID()}@example.invalid`;
// A fresh password per run for the disposable local test account.
const password = `Verify-${randomBytes(18).toString("base64url")}9`;
const server = app.listen(3101, "127.0.0.1");

async function request(path, body) {
  const response = await fetch(`http://127.0.0.1:3101${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:3101",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Auth request failed (${response.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

try {
  const signup = await request("/api/auth/sign-up/email", {
    email,
    password,
    name: "Migration Test",
  });
  const login = await request("/api/auth/sign-in/email", { email, password });

  if (signup.user?.email !== email || login.user?.email !== email) {
    throw new Error("Authentication responses did not return the test account.");
  }

  console.log(JSON.stringify({ signup: "ok", login: "ok" }));
} finally {
  const deletion = await pool.query('DELETE FROM "user" WHERE email = $1', [email]);
  if (deletion.rowCount !== 1) {
    throw new Error("The test account cleanup did not delete exactly one user.");
  }
  console.log(JSON.stringify({ testAccountDeleted: true }));
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
