import "dotenv/config";

const splitOrigins = (value) =>
  (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
const env = (name) => process.env[name]?.trim() || undefined;
// Every inference, search and weather endpoint, model and route is supplied
// by the environment (see .env.example); none is named in code.
const endpoint = (name) => env(name)?.replace(/\/+$/, "");
const turnstileAllowedHostnames = splitOrigins(process.env.TURNSTILE_ALLOWED_HOSTNAMES);
const mobileAuthScheme = process.env.MOBILE_AUTH_SCHEME?.trim() || "vibhavgpt";
const mobileAuthTrustedOrigins = [
  `${mobileAuthScheme}://`,
  `${mobileAuthScheme}://*`,
  // Expo Go uses an exp:// origin during local development. This is not
  // included in production, where only the app's registered scheme is valid.
  ...(process.env.NODE_ENV === "production" ? [] : ["exp://", "exp://**"]),
];

export const config = {
  environment: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3001),
  uploadStoragePath: process.env.UPLOAD_STORAGE_PATH ?? ".data/uploads",
  databaseUrl: process.env.DATABASE_URL,
  databaseSsl: process.env.DATABASE_SSL === "true",
  databaseSslRejectUnauthorized:
    process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false",
  authSecret: process.env.BETTER_AUTH_SECRET,
  authBaseUrl: process.env.BETTER_AUTH_URL ?? "http://localhost:3001",
  clientOrigins: splitOrigins(process.env.CLIENT_ORIGINS ?? "http://localhost:5173"),
  mobileAuthScheme,
  authTrustedOrigins: [
    ...splitOrigins(process.env.CLIENT_ORIGINS ?? "http://localhost:5173"),
    ...mobileAuthTrustedOrigins,
  ],
  // WebAuthn verifies the browser-facing origin, rather than the API
  // subdomain. These defaults cover localhost development and vibhavgpt.com;
  // explicit variables remain available if either deployment changes.
  passkeyOrigin: process.env.PASSKEY_ORIGIN,
  passkeyRpId: process.env.PASSKEY_RP_ID,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  resendApiKey: process.env.RESEND_API_KEY,
  turnstileSecretKey: process.env.TURNSTILE_SECRET_KEY,
  turnstileAllowedHostnames: turnstileAllowedHostnames.length
    ? turnstileAllowedHostnames
    : process.env.NODE_ENV === "production"
      ? ["vibhavgpt.com"]
      : [],
  sentryDsn: process.env.SENTRY_DSN,
  moderationApiUrl: env("MODERATION_API_URL"),
  moderationApiKey: process.env.MODERATION_API_KEY,
  moderationModel: env("MODERATION_MODEL"),
  emailFrom:
    process.env.EMAIL_FROM?.trim() || "VibhavGPT Support <support@pansophy.com>",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  searchApiKey: process.env.SEARCH_API_KEY,
  searchApiUrl: env("SEARCH_API_URL"),
  weatherApiKey: process.env.WEATHER_API_KEY,
  weatherApiUrl: env("WEATHER_API_URL"),
  // The attribution passed to the model with each observation.
  weatherSourceName: env("WEATHER_SOURCE_NAME") ?? "Weather service",
  chatModels: {
    lumen: process.env.CHAT_MODEL_LUMEN?.trim(),
    lumenFallback1: process.env.CHAT_MODEL_LUMEN_FALLBACK_1?.trim(),
    lumenFallback2: process.env.CHAT_MODEL_LUMEN_FALLBACK_2?.trim(),
    lumenFallback3: process.env.CHAT_MODEL_LUMEN_FALLBACK_3?.trim(),
    nova: process.env.CHAT_MODEL_NOVA?.trim(),
    study: process.env.CHAT_MODEL_STUDY?.trim(),
    nebula: process.env.CHAT_MODEL_NEBULA?.trim(),
    vesper: process.env.CHAT_MODEL_VESPER?.trim(),
  },
  lumenPrimaryApproved: process.env.CHAT_LUMEN_PRIMARY_APPROVED === "true",
  nebulaDataPolicyVerified: process.env.CHAT_NEBULA_DATA_POLICY_VERIFIED === "true",
  searchIntentModel: process.env.SEARCH_INTENT_MODEL?.trim(),
  // Comma-separated provider allow-lists for the routed tiers.
  routeProviders: {
    nova: splitOrigins(process.env.CHAT_NOVA_ROUTE_PROVIDERS),
    nebula: splitOrigins(process.env.CHAT_NEBULA_ROUTE_PROVIDERS),
  },
  memoryExtractionModel: env("MEMORY_EXTRACTION_MODEL"),
  imageGenerationModel: env("IMAGE_GENERATION_MODEL"),
  voice: {
    realtimeModel: env("VOICE_REALTIME_MODEL"),
    transcriptionModel: env("VOICE_TRANSCRIPTION_MODEL"),
    voiceName: env("VOICE_NAME"),
  },
  // Names that must never be stored as facts about the assistant.
  providerNameTerms: splitOrigins(process.env.PROVIDER_NAME_TERMS),
  // Terms a display name may not contain (see src/security/display-name.js).
  nameBlocklist: splitOrigins(process.env.NAME_BLOCKLIST),
  // Chat-completions base URLs (no trailing slash) for each inference stage.
  providerBaseUrls: {
    primaryFree: endpoint("INFERENCE_PRIMARY_BASE_URL"),
    gatewayFree: endpoint("INFERENCE_GATEWAY_BASE_URL"),
    secondaryFree: endpoint("INFERENCE_SECONDARY_BASE_URL"),
    reserveFree: endpoint("INFERENCE_RESERVE_BASE_URL"),
    paid: endpoint("INFERENCE_ROUTER_BASE_URL"),
    study: endpoint("INFERENCE_DIRECT_BASE_URL"),
  },
  providerKeys: {
    primaryFree: process.env.INFERENCE_PRIMARY_API_KEY,
    gatewayFree: process.env.INFERENCE_GATEWAY_API_KEY,
    secondaryFree: process.env.INFERENCE_SECONDARY_API_KEY,
    reserveFree: process.env.INFERENCE_RESERVE_API_KEY,
    paid: process.env.INFERENCE_ROUTER_API_KEY,
    study: process.env.INFERENCE_DIRECT_API_KEY,
  },
};

export function requireDatabaseConfig() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required before starting the API.");
  }
}

export function requireAuthConfig() {
  requireDatabaseConfig();

  if (!config.authSecret || config.authSecret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters long.");
  }
}
