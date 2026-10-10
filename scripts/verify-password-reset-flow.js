import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { createLocalAccountIssuer } from "@better-auth/core/db";
import { auth } from "../src/auth.js";
import { pool } from "../src/db/client.js";

const email = `password-reset-test-${Date.now()}@example.invalid`;
// Fresh passwords per run for the disposable local test account.
const oldPassword = `Verify-${randomBytes(18).toString("base64url")}9`;
const newPassword = `Verify-${randomBytes(18).toString("base64url")}9`;
let userId;

async function cleanup() {
  await pool.query('DELETE FROM verification WHERE identifier LIKE $1', [`%${email}%`]);
  if (!userId) return;
  await pool.query('DELETE FROM "session" WHERE "userId" = $1', [userId]);
  await pool.query('DELETE FROM account WHERE "userId" = $1', [userId]);
  await pool.query("DELETE FROM user_profiles WHERE user_id = $1", [userId]);
  await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
}

try {
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser({
    email,
    name: "Password reset test",
    emailVerified: true,
  });
  userId = user.id;

  await context.internalAdapter.createAccount({
    userId,
    providerId: "credential",
    issuer: createLocalAccountIssuer("credential"),
    accountId: userId,
    password: await context.password.hash(oldPassword),
  });

  // This server-only helper uses the exact production OTP storage and hashing
  // logic, without sending a disposable test address an email.
  const otp = await auth.api.createVerificationOTP({
    body: { email, type: "forget-password" },
  });
  assert.match(otp, /^\d{6}$/);

  const reset = await auth.api.resetPasswordEmailOTP({
    body: { email, otp, password: newPassword },
  });
  assert.equal(reset.success, true);

  const account = await pool.query(
    'SELECT password FROM account WHERE "userId" = $1 AND "providerId" = \'credential\'',
    [userId],
  );
  assert.equal(account.rowCount, 1);
  const storedHash = account.rows[0].password;
  assert.equal(typeof storedHash, "string");
  assert.equal(
    await context.password.verify({ hash: storedHash, password: newPassword }),
    true,
  );
  assert.equal(
    await context.password.verify({ hash: storedHash, password: oldPassword }),
    false,
  );

  console.log("Password reset verification passed.");
} finally {
  await cleanup();
  await pool.end();
}
