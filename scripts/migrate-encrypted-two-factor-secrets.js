import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { pool } from "../src/db/client.js";

/**
 * One-time recovery for Better Auth's legacy bare-hex encrypted 2FA rows
 * after an auth-secret rotation. The previous secret is read from stdin so it
 * never needs to be placed in source, a command argument, or a Railway
 * variable. The script intentionally prints only aggregate counts.
 */
let previousSecret = "";
for await (const chunk of process.stdin) previousSecret += chunk;
previousSecret = previousSecret.trim();
const currentSecret = process.env.BETTER_AUTH_SECRET;
if (!previousSecret || !currentSecret || previousSecret === currentSecret) {
  throw new Error("A distinct previous secret on stdin and the current BETTER_AUTH_SECRET are required.");
}

const decrypt = async (value) => {
  if (!value) return null;
  for (const key of [currentSecret, previousSecret]) {
    try { return { plaintext: await symmetricDecrypt({ key, data: value }), key }; } catch {}
  }
  throw new Error("An encrypted two-factor value could not be decrypted.");
};

let migrated = 0;
let unchanged = 0;
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const result = await client.query('SELECT "id", "secret", "backupCodes" FROM "twoFactor" FOR UPDATE');
  for (const row of result.rows) {
    const secret = await decrypt(row.secret);
    const backupCodes = await decrypt(row.backupCodes);
    if (secret.key === currentSecret && backupCodes.key === currentSecret) {
      unchanged += 1;
      continue;
    }
    const nextSecret = await symmetricEncrypt({ key: currentSecret, data: secret.plaintext });
    const nextBackupCodes = await symmetricEncrypt({ key: currentSecret, data: backupCodes.plaintext });
    await client.query('UPDATE "twoFactor" SET "secret" = $1, "backupCodes" = $2 WHERE "id" = $3', [nextSecret, nextBackupCodes, row.id]);
    migrated += 1;
  }
  await client.query("COMMIT");
  console.log(JSON.stringify({ migrated, unchanged }));
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
