import { Router } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db/client.js";
import { requireSession } from "../middleware/require-session.js";
import { isTwoFactorRecordUsable } from "./two-factor-recovery.js";

export const securityRouter = Router();
securityRouter.use(requireSession);

async function readTwoFactorRecord(executor, userId, lock = false) {
  const suffix = lock ? " FOR UPDATE" : "";
  const result = await executor.query(
    `SELECT "id", "secret", "backupCodes" FROM "twoFactor" WHERE "userId" = $1 LIMIT 1${suffix}`,
    [userId],
  );
  return result.rows[0] ?? null;
}

// This endpoint is intentionally account-scoped and read-only. It lets the
// signed-in client distinguish a healthy enrollment from one that became
// unreadable after an auth-secret rotation without exposing any crypto state.
securityRouter.get("/two-factor/status", async (req, res, next) => {
  try {
    const row = await readTwoFactorRecord(pool, req.authSession.user.id);
    if (!row) return res.json({ state: "none" });
    const usable = await isTwoFactorRecordUsable(row, config.authSecret);
    return res.json({ state: usable ? "healthy" : "recovery-required" });
  } catch (error) {
    return next(error);
  }
});

// Email-code recovery has already authenticated this account. Remove only its
// unusable enrollment, then require a fresh authenticator setup. A transaction
// and row lock make the operation idempotent if the client retries.
securityRouter.post("/two-factor/recover", async (req, res, next) => {
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const row = await readTwoFactorRecord(client, req.authSession.user.id, true);
    if (!row) {
      await client.query("COMMIT");
      return res.json({ state: "none", recovered: false });
    }
    const usable = await isTwoFactorRecordUsable(row, config.authSecret);
    if (usable) {
      await client.query("COMMIT");
      return res.json({ state: "healthy", recovered: false });
    }

    await client.query('DELETE FROM "twoFactor" WHERE "id" = $1 AND "userId" = $2', [row.id, req.authSession.user.id]);
    await client.query('UPDATE "user" SET "twoFactorEnabled" = false WHERE "id" = $1', [req.authSession.user.id]);
    await client.query("COMMIT");
    return res.json({ state: "recovery-required", recovered: true });
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    client?.release();
  }
});

securityRouter.get("/backup-codes", async (req, res, next) => {
  try {
    const result = await auth.api.viewBackupCodes({
      body: { userId: req.authSession.user.id },
      headers: fromNodeHeaders(req.headers),
    });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

// Better Auth exposes setPassword as server-only. Keep the browser-facing
// wrapper authenticated and pass the request through its password policy.
securityRouter.post("/set-password", async (req, res, next) => {
  try {
    const result = await auth.api.setPassword({
      body: { newPassword: req.body?.newPassword ?? "" },
      headers: fromNodeHeaders(req.headers),
    });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});
