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
// A non-negative whole number from the environment. Unset or blank is the default; anything that
// is not a whole number (text, a fraction, a negative) is also the default, never a silent zero.
// 0 is a deliberate choice and switches that one limit off.
// Complimentary-plan accounts (COMP_PLAN_ACCOUNTS): comma-separated emails, trimmed and lower-cased; anything that is not an address is
// dropped. Empty or unset: no account is complimentary.
export function parseCompPlanAccounts(value) {
  return [...new Set(String(value ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(entry)))];
}

export function limitFromEnv(name, fallback, source = process.env) {
  const raw = source[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}
const turnstileAllowedHostnames = splitOrigins(process.env.TURNSTILE_ALLOWED_HOSTNAMES);
const mobileAuthScheme = process.env.MOBILE_AUTH_SCHEME?.trim() || "vibhavgpt";
const mobileAuthTrustedOrigins = [
  `${mobileAuthScheme}://`,
  `${mobileAuthScheme}://*`,
  // Expo Go uses an exp:// origin during local development. This is not
  // included in production, where only the app's registered scheme is valid.
  ...(process.env.NODE_ENV === "production" ? [] : ["exp://", "exp://**"]),
];

export function lumenChatRouteFrom(environment = {}) {
  const value = String(environment.CHAT_LUMEN_ROUTE ?? "").trim().toLowerCase();
  return value === "staged" ? "staged" : value === "paid-zdr" ? "paid-zdr" : "gateway";
}

// Paid zero-retention hosts for Lumen's "paid-zdr" route, in order (router provider tags; quantization pinned). Each one must pass the
// live guard (training false, prompts not retained) before anything is sent. Server-side only.
export const LUMEN_PAID_ZDR_DEFAULT_PROVIDERS = Object.freeze(["crusoe/bf16", "parasail/fp8", "deepinfra/fp8"]);

// Zenith (Slice 7): the owner-chosen engine (docs/models/marketplace-evidence.md records its verification), pinned to the maker's
// first-party host, held to the same zero-retention guard as Lumen's paid-zdr route. Server-side only; the UI never names it.
export const ZENITH_DEFAULT_MODEL = "mistralai/mistral-large-4-0";
// Tecton (Build, owner decision 2026-11-14): one engine on one host, no fallbacks and no setting that changes either. The host's published
// policy (no training, no prompt retention) is checked live before the route opens (route-inventory.js: strict).
export const TECTON_MODEL = "qwen/qwen-2.5-coder-32b-instruct";
export const TECTON_PROVIDERS = Object.freeze(["cloudflare"]);
// The maker's own zero-retention endpoint, by its router tag (the same maker's other endpoint is not used).
export const ZENITH_DEFAULT_PROVIDERS = Object.freeze(["mistral/zdr"]);

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
  // Accounts always on Max with unlimited AI usage (src/billing/comp-accounts.js). Abuse protections still apply to them.
  compPlanAccounts: parseCompPlanAccounts(process.env.COMP_PLAN_ACCOUNTS),
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  // More sign-in providers (Slice 8). Each one is offered only while both of its values are set (src/auth/social-providers.js).
  githubClientId: process.env.GITHUB_CLIENT_ID?.trim() || undefined,
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET?.trim() || undefined,
  microsoftClientId: process.env.MICROSOFT_CLIENT_ID?.trim() || undefined,
  microsoftClientSecret: process.env.MICROSOFT_CLIENT_SECRET?.trim() || undefined,
  discordClientId: process.env.DISCORD_CLIENT_ID?.trim() || undefined,
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET?.trim() || undefined,
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
  stripeMaxPriceId: process.env.STRIPE_PRICE_ID_MAX?.trim() || null,
  stripeMaxYearlyPriceId: (process.env.STRIPE_PRICE_ID_MAX_YEARLY || process.env.STRIPE_PRICE_ID_MAX_ANNUAL)?.trim() || null,
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
    vesperDirect: process.env.CHAT_MODEL_VESPER_DIRECT?.trim() || undefined,
    zenith: process.env.CHAT_MODEL_ZENITH?.trim() || ZENITH_DEFAULT_MODEL,
    tecton: TECTON_MODEL,
  },
  tectonProviders: [...TECTON_PROVIDERS],
  zenithProviders: (() => {
    const configured = splitOrigins(process.env.CHAT_ZENITH_PROVIDERS);
    return configured.length ? configured : [...ZENITH_DEFAULT_PROVIDERS];
  })(),
  // Third-party models in the picker (Slice 7). MODEL_MARKETPLACE=off hides them all; each is still listed only while its live guard,
  // capability check and price allow (src/models/marketplace.js).
  modelMarketplaceEnabled: (process.env.MODEL_MARKETPLACE?.trim().toLowerCase() || "on") !== "off",
  vesperTransport: process.env.CHAT_VESPER_TRANSPORT?.trim().toLowerCase() || "router",
  lumenPrimaryApproved: process.env.CHAT_LUMEN_PRIMARY_APPROVED === "true",
  // Data-policy approval for Lumen's fallback stages, each pinned to the exact
  // model that was reviewed (see lumenStageApproval in chat/providers.js).
  // The primary's pin is optional; the fallbacks' pins are required.
  lumenApprovals: {
    primaryModel: env("CHAT_LUMEN_PRIMARY_APPROVED_MODEL"),
    gateway: { approved: process.env.CHAT_LUMEN_GATEWAY_APPROVED === "true", model: env("CHAT_LUMEN_GATEWAY_APPROVED_MODEL") },
    secondary: { approved: process.env.CHAT_LUMEN_SECONDARY_APPROVED === "true", model: env("CHAT_LUMEN_SECONDARY_APPROVED_MODEL") },
    reserve: { approved: process.env.CHAT_LUMEN_RESERVE_APPROVED === "true", model: env("CHAT_LUMEN_RESERVE_APPROVED_MODEL") },
  },
  // Lumen chat's route: "gateway" (default: the pinned free endpoint alone, Slice 4) or "staged" (the previous four-stage chain, kept
  // only as an owner-controlled rollback switch, CHAT_LUMEN_ROUTE=staged).
  lumenChatRoute: lumenChatRouteFrom(process.env),
  // The one provider Lumen's gateway is pinned to on the router (server-side only; never shown to anyone).
  lumenGatewayProvider: env("CHAT_LUMEN_GATEWAY_PROVIDER") || "Google AI Studio",
  // CHAT_LUMEN_ROUTE=paid-zdr (owner-gated, off by default): the same Gemma instruct model on paid hosts that neither train nor retain
  // prompts. The model defaults to the free route's model without ":free"; CHAT_MODEL_LUMEN_PAID_ZDR overrides it.
  get lumenPaidZdrModel() {
    return env("CHAT_MODEL_LUMEN_PAID_ZDR") || (this.chatModels.lumenFallback1 ? this.chatModels.lumenFallback1.replace(/:free$/i, "") : undefined);
  },
  lumenPaidZdrProviders: (() => {
    const configured = splitOrigins(process.env.CHAT_LUMEN_PAID_ZDR_PROVIDERS);
    return configured.length ? configured : [...LUMEN_PAID_ZDR_DEFAULT_PROVIDERS];
  })(),
  // A dedicated moderation key needs its own approval; on the shared primary
  // key, moderation follows the primary's.
  moderationDataPolicyApproved: process.env.MODERATION_DATA_POLICY_APPROVED === "true",
  nebulaDataPolicyVerified: process.env.CHAT_NEBULA_DATA_POLICY_VERIFIED === "true",
  vesperDataPolicyVerified: process.env.CHAT_VESPER_DATA_POLICY_VERIFIED === "true",
  // The owner's attestation for the Gemini 4 routes (src/models/marketplace.js directRouteOpen): paid tier, AI Studio logging off.
  geminiDataPolicyVerified: process.env.GEMINI_DATA_POLICY_VERIFIED === "true",
  featureAllowanceLedgerShadow: process.env.FEATURE_ALLOWANCE_LEDGER_SHADOW === "true",
  featureRegistryRouteShadow: process.env.FEATURE_REGISTRY_ROUTE_SHADOW === "true",
  featureModelCatalogApi: process.env.FEATURE_MODEL_CATALOG_API !== "false",
  featureAllowanceSummaryApi: process.env.FEATURE_ALLOWANCE_SUMMARY_API === "true",
  // Native chat consumes the subscription allowance only when all three are set:
  // the gate, a cutover timestamp (usage before it is never charged), and the
  // tiers to enforce. Each tier additionally needs an active, privacy-approved,
  // priced registry endpoint; without one its requests are refused, never sent
  // through the legacy path.
  featureChatAllowanceEnforcement: process.env.FEATURE_CHAT_ALLOWANCE_ENFORCEMENT === "true",
  chatAllowanceActivatedAt: (() => {
    const raw = process.env.CHAT_ALLOWANCE_ACTIVATED_AT?.trim();
    const parsed = raw ? new Date(raw) : null;
    return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
  })(),
  chatAllowanceEnforcedTiers: (process.env.CHAT_ALLOWANCE_ENFORCED_TIERS ?? "")
    .split(",").map((tier) => tier.trim().toLowerCase()).filter((tier) => ["nova", "study", "nebula", "vesper"].includes(tier)),
  // AI credits replace the daily, five-hour and per-model text-usage gates. They
  // are active only when the policy is enabled AND the owner has chosen what
  // happens to unused weekly credits ("expiry" or "carry"). Enabled without a
  // choice stays off; there is no default policy.
  creditsPolicyEnabled: process.env.CREDITS_POLICY_ENABLED === "true",
  creditsCarryMode: process.env.CREDITS_CARRY_MODE?.trim().toLowerCase() ?? "",
  // The instant AI credits begin, for every account. It is required: spend before it is never
  // counted, so activation starts a fresh credit period without touching any stored row, and a
  // time in the future simply keeps the existing gates in force until that moment. Use
  // 00:00 UTC on the 1st of a month to avoid a partial first week (see docs/credits-policy.md).
  creditsActivatedAt: (() => {
    const raw = process.env.CREDITS_ACTIVATED_AT?.trim();
    const parsed = raw ? new Date(raw) : null;
    return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
  })(),
  // Independent abuse protection on chat requests. It is separate from any allowance and counts
  // each request once, however many model calls the reply makes. See docs/credits-policy.md.
  chatAbuse: {
    burstMax: limitFromEnv("CHAT_BURST_MAX_REQUESTS", 20),
    burstWindowMs: limitFromEnv("CHAT_BURST_WINDOW_SECONDS", 60) * 1000,
    maxConcurrent: limitFromEnv("CHAT_MAX_CONCURRENT_REQUESTS", 3),
  },
  // Shared chat capacity across every API replica (src/chat/capacity.js): in-flight caps, global, per tier, per account and per
  // project, held as leases in Postgres. Over a cap a reply waits its turn; when the wait is full or too long the person is told the
  // tier is in high demand. CHAT_CAPACITY=off turns the layer off (the tests that predate it run with it off).
  chatCapacity: {
    enabled: (process.env.CHAT_CAPACITY?.trim().toLowerCase() || "on") !== "off",
    global: limitFromEnv("CHAT_CAPACITY_GLOBAL", 64),
    tiers: {
      lumen: limitFromEnv("CHAT_CAPACITY_LUMEN", 16),
      nova: limitFromEnv("CHAT_CAPACITY_NOVA", 24),
      nebula: limitFromEnv("CHAT_CAPACITY_NEBULA", 16),
      vesper: limitFromEnv("CHAT_CAPACITY_VESPER", 8),
      study: limitFromEnv("CHAT_CAPACITY_STUDY", 12),
      zenith: limitFromEnv("CHAT_CAPACITY_ZENITH", 8),
      tecton: limitFromEnv("CHAT_CAPACITY_TECTON", 8),
      // Every third-party model shares one bucket.
      marketplace: limitFromEnv("CHAT_CAPACITY_MARKETPLACE", 8),
    },
    perUser: limitFromEnv("CHAT_CAPACITY_PER_USER", 3),
    perGroup: limitFromEnv("CHAT_CAPACITY_PER_GROUP", 2),
    maxQueuedPerTier: limitFromEnv("CHAT_CAPACITY_QUEUE_PER_TIER", 40),
    maxQueuedPerUser: limitFromEnv("CHAT_CAPACITY_QUEUE_PER_USER", 2),
    maxWaitMs: limitFromEnv("CHAT_CAPACITY_MAX_WAIT_SECONDS", 45) * 1000,
  },
  searchIntentModel: process.env.SEARCH_INTENT_MODEL?.trim(),
  // Comma-separated provider allow-lists for the routed tiers.
  routeProviders: {
    nova: splitOrigins(process.env.CHAT_NOVA_ROUTE_PROVIDERS),
    nebula: splitOrigins(process.env.CHAT_NEBULA_ROUTE_PROVIDERS),
  },
  memoryExtractionModel: env("MEMORY_EXTRACTION_MODEL"),
  imageGenerationModel: env("IMAGE_GENERATION_MODEL"),
  // VibhavGPT Aura (src/generation/image-models.js): owner-approved 2026-11-15, on unless this is "false"; its route's strict privacy gate still applies.
  imageAuraEnabled: process.env.IMAGE_AURA_ENABLED?.trim() !== "false",
  voice: {
    realtimeModel: env("VOICE_REALTIME_MODEL"),
    transcriptionModel: env("VOICE_TRANSCRIPTION_MODEL"),
  },
  // Names that must never be stored as facts about the assistant.
  providerNameTerms: splitOrigins(process.env.PROVIDER_NAME_TERMS),
  // Terms a display name may not contain (see src/security/display-name.js).
  nameBlocklist: splitOrigins(process.env.NAME_BLOCKLIST),
  // Chat-completions base URLs (no trailing slash) for each inference stage.
  providerBaseUrls: {
    // Google's Gemini API, its OpenAI-compatible endpoint (fixed: the key decides the account, not the address). Gemini 4 marketplace routes.
    google: "https://generativelanguage.googleapis.com/v1beta/openai",
    primaryFree: endpoint("INFERENCE_PRIMARY_BASE_URL"),
    gatewayFree: endpoint("INFERENCE_GATEWAY_BASE_URL"),
    secondaryFree: endpoint("INFERENCE_SECONDARY_BASE_URL"),
    reserveFree: endpoint("INFERENCE_RESERVE_BASE_URL"),
    paid: endpoint("INFERENCE_ROUTER_BASE_URL"),
    study: endpoint("INFERENCE_DIRECT_BASE_URL"),
    direct: endpoint("INFERENCE_DIRECT_BASE_URL"),
  },
  providerKeys: {
    // The owner's paid Gemini API key (Gemini 4 marketplace routes). Server-only: never sent to the app, logged or put in an error.
    google: process.env.GEMINI_API_KEY,
    primaryFree: process.env.INFERENCE_PRIMARY_API_KEY,
    gatewayFree: process.env.INFERENCE_GATEWAY_API_KEY,
    secondaryFree: process.env.INFERENCE_SECONDARY_API_KEY,
    reserveFree: process.env.INFERENCE_RESERVE_API_KEY,
    paid: process.env.INFERENCE_ROUTER_API_KEY,
    study: process.env.INFERENCE_DIRECT_API_KEY,
    direct: process.env.INFERENCE_DIRECT_API_KEY,
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
