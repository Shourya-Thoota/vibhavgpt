import cors from "cors";
import { accessPayload, accessStatus } from "../frontend/src/access-status.js";
import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { auth, configuredSocialProviders } from "./auth.js";
import { createTotpReplayGuard, totpReplayIdentity } from "./security/totp-replay.js";
import { config } from "./config.js";
import { logInferencePolicy } from "./chat/policy-report.js";
import { startRouteGuards } from "./chat/route-policy-guard.js";
import { guardedRoutes, routeInventoryReport } from "./chat/route-inventory.js";
import { startMarketplaceReferences } from "./models/marketplace.js";
import { chatCapacity } from "./chat/capacity.js";
import { chatRouter } from "./chat/router.js";
import { memoryRouter } from "./memory/router.js";
import { usageRouter } from "./usage/router.js";
import { allowanceRouter } from "./usage/allowance-router.js";
import { billingRouter, stripeWebhookHandler } from "./billing/router.js";
import { accountRouter } from "./account/router.js";
import { searchRouter } from "./search/router.js";
import { VOICE_REMOVED, voiceRouter } from "./voice/router.js";
import { startLiveUsageReconciliationJob } from "./voice/live-usage.js";
import { securityRouter } from "./security/router.js";
import { generationRouter } from "./generation/router.js";
import { profileRouter, surveyStatus } from "./profile/router.js";
import { createPictureRouter } from "./profile/picture-router.js";
import { createChatSearchRouter } from "./chat/search-router.js";
import { createBuildRouter } from "./build/router.js";
import { googlePhotoUrl, pictureVersion } from "./profile/picture.js";
import { createPreferencesRouter, loadPreferences } from "./profile/preferences.js";
import { GATED_PATHS, createAgreementsGate, createAgreementsRouter } from "./account/agreements.js";
import { createLibraryRouter } from "./library/router.js";
import { createAvatarRouter } from "./avatars/router.js";
import { createLocationRouter } from "./location/router.js";
import { catalogRouter, meCatalogPreferencesRouter } from "./models/catalog-router.js";
import { connectorsRouter } from "./connectors/router.js";
import { skillsRouter } from "./skills/router.js";
import { visibleNameFields, warnIfNameBlocklistMissing } from "./security/display-name.js";
import { uploadRouter } from "./uploads/router.js";
import { disableTwoFactorWithReauth } from "./middleware/require-two-factor-password.js";
import { createNativeOAuthRouter } from "./auth/native-oauth.js";
import { compPlanAccountCount } from "./billing/comp-accounts.js";
import { pool } from "./db/client.js";
import { Sentry, reportServerError } from "./sentry.js";
import { logApiError } from "./security/error-log.js";
import { parserFailureMessage } from "./security/request-error-message.js";

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
// Authenticator codes are single-use (security/totp-replay.js): an accepted code is refused if sent again while it could still be valid.
const totpReplay = createTotpReplayGuard();
app.post("/api/auth/two-factor/verify-totp", authLimiter, express.json(), async (req, res, next) => {
  try {
    const identity = totpReplayIdentity(req.headers.cookie, req.ip);
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    if (code && totpReplay.wasUsed(identity, code)) {
      return res.status(401).json({ error: "That code was already used. Wait for your authenticator to show a new one.", code: "TOTP_CODE_REUSED" });
    }
    const response = await auth.api.verifyTOTP({
      request: new Request(`${config.authBaseUrl}/api/auth/two-factor/verify-totp`, {
        method: "POST",
        headers: fromNodeHeaders(req.headers),
        body: JSON.stringify(req.body ?? {}),
      }),
      body: req.body ?? {},
      headers: fromNodeHeaders(req.headers),
    });
    if (code && response.ok) totpReplay.markUsed(identity, code);
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
// Which social sign-in providers are set up, for the sign-in page (Slice 8). Names only; a provider without its two values is absent,
// so the page never shows a button that cannot work.
app.get("/api/sign-in-options", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ socialProviders: configuredSocialProviders });
});
app.all("/api/auth/*splat", authLimiter, authHandler);
app.use("/api/native-auth", createNativeOAuthRouter({ auth, authBaseUrl: config.authBaseUrl, limiter: authLimiter, providers: configuredSocialProviders }));

app.post("/api/webhooks/stripe", ...stripeWebhookHandler);

// Eligibility and agreements (src/account/agreements.js): the age question and the Terms and Privacy acceptance are recorded here, and
// the routes that do work refuse an account that has not done them (or is under the minimum age). Mounted before those routes.
app.use("/api/me/agreements", createAgreementsRouter());
app.use(GATED_PATHS, createAgreementsGate());

// Voice has been retired (see voice/router.js). The two entry points that used to start a
// session always answer 410, so they answer here, before any JSON parser reads a body they
// will never use. The lifecycle routes that settle an earlier call remain in the router,
// which gives each one a parser sized to its own body (the 28 MB limit that base64-encoded
// audio uploads once needed is gone).
app.post(["/api/voice/transcribe", "/api/voice/live/session"], (_req, res) => res.status(410).json(VOICE_REMOVED));
app.use("/api/voice", voiceRouter);

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
  // Survey completion rides along so a new device never re-asks.
  const survey = await surveyStatus(session.user.id);
  // The uploaded picture's version (null when there is none), and the Google photo the person signed in with, if that is what
  // the account's image is. A picture is optional: if its table is not there yet, the app carries on without one.
  let uploaded = null;
  try {
    uploaded = (await pool.query("SELECT sha256 FROM profile_pictures WHERE user_id = $1 LIMIT 1", [session.user.id])).rows[0]?.sha256 ?? null;
  } catch {
    uploaded = null;
  }
  // The accent follows the account between devices. It is optional: if its table is not there yet, the app uses the device's own.
  let accent = null;
  try {
    accent = (await loadPreferences(session.user.id))?.accent ?? null;
  } catch {
    accent = null;
  }
  return res.status(200).json({ user: { ...session.user, ...names, hasPassword: credential.rowCount > 0, ...survey, image: googlePhotoUrl(session.user.image), pictureVersion: pictureVersion(uploaded), accent } });
});

app.use("/api/me/preferences", createPreferencesRouter());
app.use("/api/me/location", createLocationRouter());
app.use("/api/library", createLibraryRouter());
app.use("/api/avatars", createAvatarRouter());
app.use("/api/chat/search", createChatSearchRouter());
// Build's projects: owner-only reads, downloads and restores (src/build).
app.use("/api/build", createBuildRouter());
app.use("/api/chat", chatRouter);
app.use("/api/memory", memoryRouter);
app.use("/api/usage/allowance", allowanceRouter);
app.use("/api/usage", usageRouter);
app.use("/api/billing", billingRouter);
app.use("/api/account", accountRouter);
app.use("/api/search", searchRouter);
app.use("/api/security", securityRouter);
app.use("/api/profile/picture", createPictureRouter());
app.use("/api/profile", profileRouter);
app.use("/api/generation", generationRouter);
app.use("/api/models", catalogRouter);
app.use("/api/connectors", connectorsRouter);
app.use("/api/skills", skillsRouter);
app.use("/api/me/catalog-preferences", meCatalogPreferencesRouter);

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
    logApiError(error, _req);
  }
  const status = error.status ?? 500;
  // Only server errors (5xx) are reported, tagged with the chat reference id
  // when there is one; client errors are answered and not reported.
  if (config.sentryDsn && reportServerError(error, { status, requestId: _req.chatRequestId ?? null, route: _req.baseUrl || null })) {
    await Sentry.flush(2000).catch(() => {});
  }
  res.status(status).json({ error: status < 500 ? (parserFailureMessage(error) ?? error.message ?? "Request could not be completed.") : "Something went wrong. Please try again.", code: status < 500 ? error.code : undefined });
});

export function startServer() {
  warnIfNameBlocklistMissing();
  const server = app.listen(config.port, () => {
    console.log(`VibhavGPT API listening on port ${config.port}`);
    // The social sign-in providers that are set up (names only; never an id or secret).
    console.info(JSON.stringify({ event: "auth_providers", configured: configuredSocialProviders }));
    // How many complimentary-plan accounts are configured (a count only; never an address).
    console.info(JSON.stringify({ event: "comp_accounts", configured: compPlanAccountCount() }));
    // The Lumen gateway's live policy check runs before the policy line, so the line states what the check found. Until it finishes
    // the gateway is closed (lumenStageApproval), so nothing can reach it unverified.
    // Every route on the router is checked (route-policy-guard.js); Lumen's line keeps its own event name. Then one line lists every
    // route, what it sends to (host name only) and what was decided, before the policy line.
    // Third-party models on a maker's own API (GPT-6) are not the guard's to decide; their live price and capabilities are read here,
    // at the guard's cadence ("market_reference", names and prices only), and they list only while that read is fresh.
    Promise.all([
      startRouteGuards(guardedRoutes()).catch(() => null),
      config.modelMarketplaceEnabled === false ? null : startMarketplaceReferences().catch(() => null),
    ])
      .finally(() => {
        console.info(JSON.stringify(routeInventoryReport()));
        logInferencePolicy();
      });
  });
  startLiveUsageReconciliationJob();
  // Queue depth, in-flight replies and wait times per tier, from the shared capacity store, once a minute (counts only).
  chatCapacity.startReporter();

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
