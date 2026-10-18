import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import { fromNodeHeaders } from "better-auth/node";

// Google sign-in from the Capacitor app.
//
// The app's WebView cannot finish OAuth itself: Google's page opens in an
// external browser, so the callback arrives in a browser that never saw the
// WebView's state cookie and Better Auth rejects it (state_security_mismatch).
// Instead the whole OAuth round trip runs in one external browser:
//
//   1. WebView  POST /start {verifierHash}   -> proxy URL (plants state cookie, then Google)
//   2. Browser  Google -> /api/auth/callback/google -> GET /finish?handoff=…
//   3. /finish  moves the fresh session cookies off the browser into a
//               single-use code and redirects to vibhavgpt://account/auth?code=…
//   4. WebView  POST /exchange {code, verifier} -> the same cookies, set here
//
// The code is useless without the verifier, which never leaves the WebView, so
// another app that intercepts the vibhavgpt:// link cannot redeem it.

const HANDOFF_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 2 * 60 * 1000;
// Same scheme and host as the billing return link, so it matches the app's
// existing deep-link intent filter.
const APP_RETURN_URL = "vibhavgpt://account/auth";
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;
// Query parameters the 2FA gate adds to the callback redirect; forwarded so
// the app can open the second-factor step. Nothing else is passed through.
const FORWARDED_PARAMS = ["twoFactorRequired", "twoFactor", "twoFactorMethods"];

const token = () => randomBytes(32).toString("base64url");
const sha256 = (value) => createHash("sha256").update(value).digest("base64url");

function parseCookies(header = "") {
  const cookies = new Map();
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

// Better Auth expresses maxAge in seconds; Express wants milliseconds.
export function expressCookieOptions(attributes) {
  const { maxAge, sameSite, ...rest } = attributes;
  return {
    ...rest,
    sameSite: typeof sameSite === "string" ? sameSite.toLowerCase() : sameSite,
    ...(maxAge ? { maxAge: maxAge * 1000 } : {}),
    // Values are carried over exactly as Better Auth signed and encoded them.
    encode: (value) => value,
  };
}

async function transferableCookies(auth) {
  const ctx = await auth.$context;
  return [
    ctx.authCookies.sessionToken,
    ctx.authCookies.dontRememberToken,
    ctx.createAuthCookie("two_factor", { maxAge: 600 }),
  ];
}

async function consumeJson(auth, identifier) {
  const ctx = await auth.$context;
  const record = await ctx.internalAdapter.consumeVerificationValue(identifier);
  if (!record || new Date(record.expiresAt).getTime() < Date.now()) return null;
  try {
    return JSON.parse(record.value);
  } catch {
    return null;
  }
}

async function storeJson(auth, identifier, value, ttlMs) {
  const ctx = await auth.$context;
  await ctx.internalAdapter.createVerificationValue({
    identifier,
    value: JSON.stringify(value),
    expiresAt: new Date(Date.now() + ttlMs),
  });
}

function returnToApp(res, params) {
  const url = new URL(APP_RETURN_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  res.set("Cache-Control", "no-store");
  return res.redirect(302, url.toString());
}

export function createNativeOAuthRouter({ auth, authBaseUrl, limiter }) {
  const router = express.Router();
  router.use(limiter);

  router.post("/google/start", express.json(), async (req, res, next) => {
    try {
      const verifierHash = req.body?.verifierHash;
      if (typeof verifierHash !== "string" || !HASH_PATTERN.test(verifierHash)) {
        return res.status(400).json({ error: "Google sign-in could not be started. Please try again." });
      }
      const handoff = token();
      await storeJson(auth, `native-oauth-handoff:${handoff}`, { verifierHash }, HANDOFF_TTL_MS);

      const finishUrl = `${authBaseUrl}/api/native-auth/finish?handoff=${handoff}`;
      const { url } = await auth.api.signInSocial({
        body: { provider: "google", callbackURL: finishUrl, errorCallbackURL: finishUrl, disableRedirect: true },
        headers: fromNodeHeaders(req.headers),
      });
      // The expo plugin's proxy sets the state cookie in the browser that
      // will receive the callback, then forwards to Google.
      const proxy = new URL(`${authBaseUrl}/api/auth/expo-authorization-proxy`);
      proxy.searchParams.set("authorizationURL", url);
      return res.status(200).json({ url: proxy.toString() });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/finish", async (req, res, next) => {
    try {
      const handoff = String(req.query.handoff ?? "");
      const pending = TOKEN_PATTERN.test(handoff) ? await consumeJson(auth, `native-oauth-handoff:${handoff}`) : null;
      if (!pending) return returnToApp(res, { error: "expired" });
      if (req.query.error) return returnToApp(res, { error: String(req.query.error).slice(0, 64) });

      const present = parseCookies(req.headers.cookie);
      const cookies = [];
      for (const cookie of await transferableCookies(auth)) {
        const value = present.get(cookie.name);
        if (!value) continue;
        cookies.push({ name: cookie.name, value });
        // The session now belongs to the app; leave nothing usable behind in
        // the external browser.
        res.clearCookie(cookie.name, expressCookieOptions({ ...cookie.attributes, maxAge: undefined }));
      }
      if (!cookies.length) return returnToApp(res, { error: "no_session" });

      const params = {};
      for (const key of FORWARDED_PARAMS) {
        if (typeof req.query[key] === "string") params[key] = req.query[key].slice(0, 64);
      }
      const code = token();
      await storeJson(auth, `native-oauth-code:${code}`, { verifierHash: pending.verifierHash, cookies, params }, CODE_TTL_MS);
      return returnToApp(res, { code });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/exchange", express.json(), async (req, res, next) => {
    try {
      const { code, verifier } = req.body ?? {};
      const valid = typeof code === "string" && TOKEN_PATTERN.test(code)
        && typeof verifier === "string" && VERIFIER_PATTERN.test(verifier);
      // Consumed before the verifier check: a wrong guess burns the code.
      const grant = valid ? await consumeJson(auth, `native-oauth-code:${code}`) : null;
      const expected = Buffer.from(grant?.verifierHash ?? "");
      const actual = Buffer.from(valid ? sha256(verifier) : "");
      if (!grant || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return res.status(400).json({ error: "Google sign-in expired. Please try again." });
      }

      const attributes = new Map((await transferableCookies(auth)).map((cookie) => [cookie.name, cookie.attributes]));
      for (const { name, value } of grant.cookies) {
        if (attributes.has(name)) res.cookie(name, value, expressCookieOptions(attributes.get(name)));
      }
      res.set("Cache-Control", "no-store");
      return res.status(200).json({ params: grant.params ?? {} });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}


