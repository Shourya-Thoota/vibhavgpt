import cors from "cors";
import { accessPayload, accessStatus } from "../frontend/src/access-status.js";
import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { auth } from "./auth.js";
import { config } from "./config.js";
import { chatRouter } from "./chat/router.js";
import { memoryRouter } from "./memory/router.js";
import { usageRouter } from "./usage/router.js";
import { billingRouter, stripeWebhookHandler } from "./billing/router.js";
import { accountRouter } from "./account/router.js";
import { searchRouter } from "./search/router.js";
import { voiceRouter } from "./voice/router.js";
import { startLiveUsageReconciliationJob } from "./voice/live-usage.js";
import { securityRouter } from "./security/router.js";
import { generationRouter } from "./generation/router.js";
import { profileRouter } from "./profile/router.js";
import { visibleNameFields, warnIfNameBlocklistMissing } from "./security/display-name.js";
import { uploadRouter } from "./uploads/router.js";
import { disableTwoFactorWithReauth } from "./middleware/require-two-factor-password.js";
import { createNativeOAuthRouter } from "./auth/native-oauth.js";
import { pool } from "./db/client.js";
import { Sentry, reportServerError } from "./sentry.js";

export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet());
app.use(
  cors({
    origin: config.clientOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Please wait a moment before trying again." },
});

// Applies to initial passwordless delivery and resends alike. `trust proxy`
// above makes Express use Railway's forwarded client IP rather than one shared
// proxy address.
const otpDeliveryLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 3,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Please wait a minute before requesting another code." },
});

// Password-reset requests get a tighter delivery limit than ordinary auth
// requests. Better Auth returns the same success response for unknown emails,
// preventing account enumeration.
const passwordResetDeliveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Please wait before requesting another password reset code." },
});

const authHandler = toNodeHandler(auth);

async function writeAuthResponse(res, response) {
  response.headers.forEach((value, key) => {
    if (key === "set-cookie") return;
    res.setHeader(key, value);
  });
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : response.headers.get("set-cookie");
  if (setCookies?.length) res.setHeader("set-cookie", setCookies);
  res.statusCode = response.status;
  if (!response.body) return res.end();
  return (await import("node:stream")).Readable.fromWeb(response.body).pipe(res);
}

// Better Auth must be mounted before express.json(); see its Express integration docs.
app.post("/api/auth/email-otp/send-verification-otp", authLimiter, otpDeliveryLimiter, authHandler);
app.post("/api/auth/email-otp/request-password-reset", authLimiter, passwordResetDeliveryLimiter, authHandler);
app.post("/api/auth/two-factor/disable", express.json(), disableTwoFactorWithReauth);
// Better Auth intentionally returns an empty HTTP 500 for unexpected endpoint
// errors. Keep the normal handler for every auth route, but proxy this one
// endpoint so an undecipherable legacy TOTP seed gets a safe, actionable
// response instead of the generic "try again" message.
app.post("/api/auth/two-factor/verify-totp", authLimiter, express.json(), async (req, res, next) => {
  try {
    const response = await auth.api.verifyTOTP({
      request: new Request(`${config.authBaseUrl}/api/auth/two-factor/verify-totp`, {
        method: "POST",
        headers: fromNodeHeaders(req.headers),
        body: JSON.stringify(req.body ?? {}),
      }),
      body: req.body ?? {},
      headers: fromNodeHeaders(req.headers),
    });
    return writeAuthResponse(res, response);
  } catch (error) {
    if (error?.message === "invalid tag" || error?.code === "INVALID_TAG") {
      console.error(JSON.stringify({
        event: "auth_two_factor_secret_unavailable",
        path: "/api/auth/two-factor/verify-totp",
        errorType: "encrypted_totp_seed_unavailable",
      }));
      return res.status(409).json({
        error: "Your authenticator setup needs to be renewed. Use an email code or backup code to finish signing in.",
        code: "TWO_FACTOR_SETUP_INVALID",
      });
    }
    return next(error);
  }
});
app.all("/api/auth/*splat", authLimiter, authHandler);
app.use("/api/native-auth", createNativeOAuthRouter({ auth, authBaseUrl: config.authBaseUrl, limiter: authLimiter }));

app.post("/api/webhooks/stripe", ...stripeWebhookHandler);

// Voice uploads are base64-encoded JSON, which expands their size by roughly a third.
app.use("/api/voice", express.json({ limit: "28mb" }), voiceRouter);

// Multipart parsing belongs only to the upload router. Keeping it isolated
// avoids accepting files on unrelated JSON endpoints.
app.use("/api/uploads", uploadRouter);

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", async (_req, res, next) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ status: "ok", database: "connected" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/me", async (req, res) => {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!session) {
    return res.status(401).json({ error: "Sign in is required." });
  }

  const credential = await pool.query(
    'SELECT 1 FROM account WHERE "userId" = $1 AND "providerId" = \'credential\' AND "password" IS NOT NULL LIMIT 1',
    [session.user.id],
  );
  const profile = await pool.query("SELECT custom_instructions FROM user_profiles WHERE user_id = $1 LIMIT 1", [session.user.id]);
  // A stored name that fails the name check is withheld here, so no screen
  // shows it; the app falls back to a neutral name instead.
  const names = visibleNameFields(session.user, profile.rows[0]?.custom_instructions);
  return res.status(200).json({ user: { ...session.user, ...names, hasPassword: credential.rowCount > 0 } });
});

app.use("/api/chat", chatRouter);
app.use("/api/memory", memoryRouter);
app.use("/api/usage", usageRouter);
app.use("/api/billing", billingRouter);
app.use("/api/account", accountRouter);
app.use("/api/search", searchRouter);
app.use("/api/security", securityRouter);
app.use("/api/profile", profileRouter);
app.use("/api/generation", generationRouter);

app.use((_req, res) => res.status(404).json({ error: "Not found." }));

app.use(async (error, _req, res, _next) => {
  if (accessStatus(error)) return res.status(error.status ?? 429).json(accessPayload(error));
  const authPath = String(_req.originalUrl ?? "");
  const twoFactorSecretError =
    authPath.includes("/api/auth/two-factor/verify-totp") &&
    (error?.message === "invalid tag" || error?.code === "INVALID_TAG");
  if (twoFactorSecretError) {
    // A rotated Better Auth secret can make an older encrypted TOTP seed
    // undecipherable. Keep the raw crypto error out of the client and give
    // the user a safe recovery path (email or backup code) instead.
    console.error(JSON.stringify({
      event: "auth_two_factor_secret_unavailable",
      path: "/api/auth/two-factor/verify-totp",
      errorType: "encrypted_totp_seed_unavailable",
    }));
    return res.status(409).json({
      error: "Your authenticator setup needs to be renewed. Use an email code or backup code to finish signing in.",
      code: "TWO_FACTOR_SETUP_INVALID",
    });
  }
  if (String(_req.originalUrl ?? "").startsWith("/api/chat")) {
    console.error(JSON.stringify({
      event: "chat_api_error",
      requestId: _req.chatRequestId ?? null,
      errorType: String(error?.name ?? "Error").slice(0, 60),
      code: /^[a-z0-9_.-]{1,60}$/i.test(String(error?.code ?? "")) ? error.code : "unclassified",
      status: Number.isInteger(error?.status) ? error.status : null,
      sqlState: /^[0-9A-Z]{5}$/.test(String(error?.code ?? "")) ? error.code : null,
    }));
  } else {
    console.error("Unhandled API error", error);
  }
  const status = error.status ?? 500;
  // Only server errors (5xx) are reported, tagged with the chat reference id
  // when there is one; client errors are answered and not reported.
  if (config.sentryDsn && reportServerError(error, { status, requestId: _req.chatRequestId ?? null, route: _req.baseUrl || null })) {
    await Sentry.flush(2000).catch(() => {});
  }
  res.status(status).json({ error: status < 500 ? (error.message ?? "Request could not be completed.") : "Something went wrong. Please try again.", code: status < 500 ? error.code : undefined });
});

export function startServer() {
  warnIfNameBlocklistMissing();
  const server = app.listen(config.port, () => {
    console.log(`VibhavGPT API listening on port ${config.port}`);
  });
  startLiveUsageReconciliationJob();

  async function shutdown(signal) {
    console.log(`${signal} received; closing API server.`);
    server.close(() => process.exit(0));
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  return server;
}

if (process.env.START_SERVER !== "false") {
  startServer();
}
