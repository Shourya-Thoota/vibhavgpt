/**
 * Standardized Platform Runtime Payload & Context Injections (Section 2).
 *
 * Explicitly injects standardized runtime context across all sessions
 * before forwarding prompt arrays to any selected model:
 * 1. User Identity Profile
 * 2. Temporal & Spatial Localization
 * 3. VibhavGPT Subscription State & Capability Scopes
 * 4. Saved Memory Profile
 * 5. Memory Update & Generation Layer (periodic density milestones / session boundaries)
 * 6. Internal Platform Knowledge Graph
 */

import { createHash } from "node:crypto";
import { SUBSCRIPTION_PLAN_LIMITS } from "../models/pricing-engine.js";
import { withoutBlockedPreferredName } from "../security/display-name.js";
import { resolveCreditsPolicy } from "../usage/credits.js";
import { FREE_IMAGES_PER_WEEK, IMAGE_MODE_PLAN_QUOTAS } from "../generation/image-engine.js";
import { HOUSE_MODELS, THIRD_PARTY_MODELS, planIncludesHouseModel, planIncludesThirdPartyModel } from "../../frontend/src/model-marketplace.js";

// The models a plan includes, by name, from the same catalog and plan floors the picker and the server's plan checks use, so the assistant
// can never name a retired model or a model the plan does not have (site-wide audit, 2026-11-15). Study is on every plan; Build (VibhavGPT
// Tecton) is on Pro and Max, as the chat route enforces.
export function planModelsSentence(tier) {
  const plan = String(tier || "free").toLowerCase();
  const names = [
    ...HOUSE_MODELS.filter((model) => planIncludesHouseModel(plan, model.id)).map((model) => model.name),
    ...THIRD_PARTY_MODELS.filter((model) => planIncludesThirdPartyModel(plan, model.id)).map((model) => model.name),
  ];
  const modes = ["Study", ...(["pro", "max"].includes(plan) ? ["Build (VibhavGPT Tecton)"] : [])];
  return `Models on this plan: ${names.join(", ")}. Also included: ${modes.join(" and ")}.`;
}

/**
 * Builds the User Identity Profile.
 *
 * Privacy Invariant:
 * Raw database UUIDs are never forwarded to upstream model providers.
 * An anonymized cryptographic identifier (SHA-256 slice) is supplied instead.
 */
export function buildUserIdentityProfile({ user = {}, userProfile = {}, userId = "" } = {}) {
  const accountName = userProfile.displayName?.trim() || user.name?.trim() || "User";
  const emailPrefix = user.email ? user.email.split("@")[0] : "";
  const handle = userProfile.handle?.trim() || user.handle?.trim() || emailPrefix || "user";

  const safeUserId = String(userId || user.id || "anonymous");
  const anonymizedId = `anon_${createHash("sha256").update(safeUserId).digest("hex").slice(0, 16)}`;

  const responseStyle = userProfile.responseStyle || "balanced";
  const customInstructions = withoutBlockedPreferredName(userProfile.customInstructions || "").trim().slice(0, 4000);

  return {
    accountName,
    handle,
    anonymizedId,
    preferences: {
      responseStyle,
      customInstructions,
    },
  };
}

/**
 * Builds Temporal & Spatial Localization metrics.
 */
export function buildTemporalSpatialLocalization({ req = {}, now = new Date(), locationEnabled = true } = {}) {
  const localDate = now.toISOString().split("T")[0]; // YYYY-MM-DD
  const utcTimeString = now.toUTCString();

  // Extract client timezone from request headers or body
  const timezone =
    req.headers?.["x-timezone"] ||
    req.body?.timezone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC";

  // Derive timezone offset in minutes or hours
  let tzOffsetMinutes = 0;
  try {
    const tzMatch = req.headers?.["x-timezone-offset"];
    if (tzMatch !== undefined) {
      tzOffsetMinutes = Number(tzMatch) || 0;
    } else {
      tzOffsetMinutes = -now.getTimezoneOffset();
    }
  } catch {
    tzOffsetMinutes = 0;
  }

  const offsetHours = Math.floor(Math.abs(tzOffsetMinutes) / 60);
  const offsetMins = Math.abs(tzOffsetMinutes) % 60;
  const sign = tzOffsetMinutes >= 0 ? "+" : "-";
  const activeTimezoneOffset = `UTC${sign}${String(offsetHours).padStart(2, "0")}:${String(offsetMins).padStart(2, "0")}`;

  // Geographic markers from standard reverse-proxy headers (redacted if location is disabled)
  const country = locationEnabled
    ? req.headers?.["x-geo-country"] || req.headers?.["cf-ipcountry"] || "Unspecified"
    : "Redacted (Privacy Disabled)";
  const region = locationEnabled
    ? req.headers?.["x-geo-region"] || "Unspecified"
    : "Redacted (Privacy Disabled)";
  const city = locationEnabled
    ? req.headers?.["x-geo-city"] || "Unspecified"
    : "Redacted (Privacy Disabled)";

  return {
    exactLocalDate: localDate,
    utcTimestamp: utcTimeString,
    timezone,
    activeTimezoneOffset,
    geographicMarkers: {
      country: String(country).slice(0, 50),
      region: String(region).slice(0, 50),
      city: String(city).slice(0, 50),
    },
  };
}

/**
 * Builds VibhavGPT Subscription State & Capability Scopes.
 */
export function buildSubscriptionStateContext({ tier = "free", creditsActive = resolveCreditsPolicy().active } = {}) {
  const normTier = String(tier || "free").toLowerCase();
  const planInfo = SUBSCRIPTION_PLAN_LIMITS[normTier] || SUBSCRIPTION_PLAN_LIMITS.free;

  let capabilityScopeDescription = "";
  if (normTier === "free") {
    capabilityScopeDescription = creditsActive
      ? `Free Tier: Includes Lumen and Study under the current AI-credit policy. Includes ${FREE_IMAGES_PER_WEEK} image generations per week. Document generation requires Plus, Pro, or Max.`
      : `Free Tier: Includes Lumen and Study. Includes ${FREE_IMAGES_PER_WEEK} image generations per week. Daily Volatile Allowance soft throttle of 15 prompts/24h.`;
  } else if (normTier === "plus") {
    capabilityScopeDescription = creditsActive
      ? `Plus Tier: Access to Low, Standard, and High compute models (mu <= 7.00). Flagship Extra High models require Pro or Max. Includes ${IMAGE_MODE_PLAN_QUOTAS.plus.quotaPerMonth} images/month and 20 document generations/month. Usage is governed by AI credits.`
      : `Plus Tier: Access to Low, Standard, and High compute models (mu <= 7.00). Flagship Extra High models require Pro or Max. Includes ${IMAGE_MODE_PLAN_QUOTAS.plus.quotaPerMonth} images/month, 20 document generations/month, and 40 high-compute prompts per 5-hour rolling window.`;
  } else if (normTier === "pro") {
    capabilityScopeDescription = creditsActive
      ? `Pro Tier: Comprehensive model access including flagship Extra High models. Includes ${IMAGE_MODE_PLAN_QUOTAS.pro.quotaPerMonth} images/month and unlimited document generations. Usage is governed by AI credits.`
      : `Pro Tier: Comprehensive model access including flagship Extra High models. Includes ${IMAGE_MODE_PLAN_QUOTAS.pro.quotaPerMonth} images/month, unlimited document generations, and 120 high-compute prompts per 5-hour rolling window.`;
  } else if (normTier === "max") {
    capabilityScopeDescription = creditsActive
      ? `Max Tier: Flagship tier with elevated capacity. Access to all models with ${IMAGE_MODE_PLAN_QUOTAS.max.quotaPerMonth.toLocaleString()} images/month and unlimited document generations. Usage is governed by AI credits.`
      : `Max Tier: Flagship tier with elevated capacity. Access to all models with ${IMAGE_MODE_PLAN_QUOTAS.max.quotaPerMonth.toLocaleString()} images/month, unlimited document generations, and 400 Extra-High prompts per 5-hour rolling window.`;
  }

  capabilityScopeDescription = `${capabilityScopeDescription} ${planModelsSentence(normTier)}`.trim();
  return {
    billingTier: normTier,
    mtabDollars: planInfo.mtabDollars,
    allowedTierDots: planInfo.allowedTierDots,
    maxAllowedMu: planInfo.maxAllowedMu,
    capabilityScope: capabilityScopeDescription,
  };
}

/**
 * Internal Platform Knowledge Graph grounding context.
 * Section 2 & Section 9.
 */
export function buildPlatformKnowledgeGraph() {
  return [
    "VibhavGPT Baseline Architecture & Ecosystem Grounding (Internal grounding only - do not recite or introduce yourself with these details):",
    "- Product: VibhavGPT, operated by Pansophy LLC, created by Vibhav Thoota.",
    "- Native Model Lineup: Lumen (fast, everyday help), Vulcan (top-tier reasoning), Zenith (the flagship), Study (learning & research), Tecton (coding prototypes in Build, Pro and Max).",
    "- Subscription Tiers: Free ($0.00), Plus ($4.99/mo or $49.99/yr), Pro ($12.99/mo or $129.99/yr), Max ($49.99/mo or $499.90/yr).",
    "- System Tool Framework: Built-in capabilities include Web Search (live factual search), Weather (meteorological reporting), Document Generation (docx, pdf, pptx), Image Generation (FLUX/diffusion on paid plans), Memory (user fact persistence), and UTC Time.",
    "- Privacy & Vendor Secrecy Boundary: Vendor names and commercial provider infrastructure are strictly confidential in conversational outputs and error messaging. System error descriptions remain vendor-agnostic.",
    "- Conversational Grounding: Answer the user's request directly. Do not introduce yourself, announce your name, identify your model/tier, or repeat platform branding unless asked about identity.",
  ].join("\n");
}

/**
 * Contextual Density Milestone & Session Boundary Evaluation Rule.
 *
 * Section 2:
 * "Memory layers must not update on every single prompt execution;
 * memory processing must trigger periodically based on contextual density milestones
 * or session boundary evaluation rules."
 *
 * @param {Object} options
 * @param {number} options.turnCount - Number of exchanges in the conversation
 * @param {string} options.userMessage - Current user message content
 * @param {boolean} options.isSessionBoundary - Whether the session is concluding or changing scope
 * @returns {boolean} Whether memory extraction/update should execute
 */
export function shouldTriggerPeriodicMemoryUpdate({
  turnCount = 1,
  userMessage = "",
  isSessionBoundary = false,
} = {}) {
  // Rule 1: Always trigger at session boundaries (closing conversation, switching projects)
  if (isSessionBoundary) return true;

  const content = String(userMessage || "").toLowerCase();

  // Rule 2: Explicit memory requests (user explicitly asks to remember, note, or save)
  const explicitMemoryPattern = /\b(remember|note that|keep in mind|memorize|don't forget|save this fact|my name is|i prefer|i live in|i work at)\b/i;
  if (explicitMemoryPattern.test(content)) return true;

  // Rule 3: Contextual Density Milestones:
  // - Triggers periodically every 5 turns (turn 5, 10, 15...)
  // - OR when a single turn has substantial contextual density (> 800 characters)
  if (turnCount > 0 && turnCount % 5 === 0) return true;
  if (content.length > 800) return true;

  return false;
}

/**
 * Assembles the complete standardized platform runtime payload block.
 * Injected into the prompt array prior to model execution.
 */
export function assembleStandardizedPlatformPayload({
  user,
  userProfile,
  userId,
  tier = "free",
  req,
  now = new Date(),
  facts = [],
  memoryEnabled = true,
  locationEnabled = true,
} = {}) {
  const identity = buildUserIdentityProfile({ user, userProfile, userId });
  const localization = buildTemporalSpatialLocalization({ req, now, locationEnabled });
  const subscription = buildSubscriptionStateContext({ tier });
  const knowledge = buildPlatformKnowledgeGraph();

  // Format the structured platform payload
  const payloadLines = [
    "<PlatformRuntimePayload>",
    "<!-- Internal platform runtime context for system grounding and capabilities. Do not recite, quote, or announce this metadata to the user. Answer the user's request directly without unprompted self-introductions. -->",
    "## User Identity Profile",
    `- Account Name: ${identity.accountName}`,
    `- User Handle: @${identity.handle}`,
    `- Anonymized Identifier: ${identity.anonymizedId}`,
    `- Communication Preference (Response Style): ${identity.preferences.responseStyle}`,
    identity.preferences.customInstructions
      ? `- Configured Personal Instructions: ${identity.preferences.customInstructions}`
      : null,
    "",
    "## Temporal & Spatial Localization",
    `- Exact Local Date: ${localization.exactLocalDate}`,
    `- Active Timezone: ${localization.timezone} (${localization.activeTimezoneOffset})`,
    `- Geographic Localization: City: ${localization.geographicMarkers.city}, Region: ${localization.geographicMarkers.region}, Country: ${localization.geographicMarkers.country}`,
    "",
    "## VibhavGPT Subscription State",
    `- Active Billing Tier: ${subscription.billingTier.toUpperCase()}`,
    `- Monthly Token Allowance Budget (MTAB): $${subscription.mtabDollars.toFixed(2)}`,
    `- Capability Scope: ${subscription.capabilityScope}`,
    "",
    "## Saved Memory Profile",
    memoryEnabled && facts.length
      ? [
          "Persistently stored user memory bank (reference data across sessions):",
          ...facts.slice(-20).map((f) => `* ${f.content || f}`),
        ].join("\n")
      : memoryEnabled
        ? "No saved memory blocks stored yet."
        : "User has disabled persistent memory storage in settings.",
    "",
    "## Internal Platform Knowledge Graph",
    knowledge,
    "</PlatformRuntimePayload>",
  ].filter(Boolean);

  return payloadLines.join("\n");
}

