import { app } from "../src/server.js";
import { pool } from "../src/db/client.js";

const server = app.listen(3102, "127.0.0.1");
let existingVerificationIds = new Set();

try {
  const existing = await pool.query('SELECT id FROM verification');
  existingVerificationIds = new Set(existing.rows.map((row) => row.id));

  const response = await fetch("http://127.0.0.1:3102/api/auth/sign-in/social", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:3102",
    },
    body: JSON.stringify({
      provider: "google",
      callbackURL: "http://127.0.0.1:3102/auth-test-complete",
      disableRedirect: true,
    }),
  });
  const data = await response.json();

  if (!response.ok || typeof data.url !== "string" || !data.url.startsWith("https://accounts.google.com/")) {
    throw new Error(`Social sign-in initiation failed (${response.status}).`);
  }

  console.log(JSON.stringify({ socialSignInRedirect: "ok" }));
} finally {
  const after = await pool.query('SELECT id FROM verification');
  const createdIds = after.rows
    .map((row) => row.id)
    .filter((id) => !existingVerificationIds.has(id));

  if (createdIds.length) {
    await pool.query('DELETE FROM verification WHERE id = ANY($1::text[])', [createdIds]);
  }
  console.log(JSON.stringify({ verificationRecordsDeleted: createdIds.length }));
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
