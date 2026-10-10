import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../auth.js";

export async function loadOptionalSession(req, _res, next) {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (session) req.authSession = session;
    return next();
  } catch (error) {
    return next(error);
  }
}

export async function requireSession(req, res, next) {
  if (req.authSession) return next();
  return loadOptionalSession(req, res, (error) => {
    if (error) return next(error);
    if (!req.authSession) return res.status(401).json({ error: "Sign in is required." });
    return next();
  });
}
