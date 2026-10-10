import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../auth.js";
import { pool } from "../db/client.js";

// Better Auth permits passwordless users when allowPasswordless is enabled.
// That must never permit disabling an active second factor without reauth.
export async function disableTwoFactorWithReauth(req, res, next) {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) return res.status(401).json({ error: "Sign in is required." });

    const result = await pool.query(
      'SELECT 1 FROM account WHERE "userId" = $1 AND "providerId" = \'credential\' AND "password" IS NOT NULL LIMIT 1',
      [session.user.id],
    );
    if (result.rowCount === 0) {
      return res.status(403).json({
        error: "This account has no password. Sign in with Google again to confirm this security change.",
        code: "GOOGLE_REAUTH_REQUIRED",
      });
    }

    if (!req.body?.password) {
      return res.status(400).json({ error: "Enter your current password to continue." });
    }

    await auth.api.verifyPassword({
      headers: fromNodeHeaders(req.headers),
      body: { password: req.body.password },
    });
    const resultResponse = await auth.api.disableTwoFactor({
      headers: fromNodeHeaders(req.headers),
      body: { password: req.body.password },
      returnHeaders: true,
      returnStatus: true,
    });
    for (const [name, value] of resultResponse.headers ?? []) res.append(name, value);
    return res.status(resultResponse.status ?? 200).json(resultResponse.response);
  } catch (error) {
    if (error?.status === 400 || error?.statusCode === 400) {
      return res.status(400).json({ error: "Incorrect password." });
    }
    return next(error);
  }
}
