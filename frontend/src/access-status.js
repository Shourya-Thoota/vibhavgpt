// Shared by the API and every UI surface. Reasons come from execution/access
// checks, never inferred from the user's tier or an ambiguous HTTP 429.
import { usagePercentage } from "./usage-percentage.js";
const REASONS = new Set(["plan", "quota", "credits", "service", "network", "permission", "device", "entitlement-sync", "restricted", "storage", "rate"]);
const CODES = {
  "plan-required": "plan", "usage-limit": "quota", "quota-reached": "quota",
  "credits-required": "credits", "service-unavailable": "service",
  "network-error": "network", "permission-required": "permission", "device-unavailable": "device",
  "entitlement-sync": "entitlement-sync", "storage-limit": "storage", "upload-plan-limit": "plan",
  // A security rate limit on chat requests: independent of any allowance or credit balance.
  "chat_rate_limited": "rate", "chat_busy": "rate",
};

export function accessStatus(input = {}) {
  const reason = REASONS.has(input.reason) ? input.reason : CODES[input.code]
    ?? (input.name === "NotAllowedError" ? "permission" : input.name === "NotFoundError" ? "device" : null);
  if (!reason) return null;
  const feature = input.feature || "This feature";
  const messages = {
    plan: `${feature} isn't included with your current plan.`,
    quota: `You've reached your ${feature === "This feature" ? "usage" : feature} allowance.`,
    credits: `You need more image & document credits to use ${feature === "This feature" ? "this feature" : feature}.`,
    service: `${feature} is temporarily unavailable. Please try again shortly.`,
    network: "Couldn't connect. Check your internet connection and try again.",
    permission: "Permission is required to use this feature. Allow access in your device settings.",
    device: "The device this feature needs isn't available. Check it and try again.",
    "entitlement-sync": "We found your subscription, but couldn't verify it yet. Please try again.",
    restricted: "This feature is paused on this account. Contact support for help.",
    storage: "You've reached your file storage limit. Delete older files or chats to make space.",
    rate: "You're sending requests too quickly. Please wait a moment and try again.",
  };
  const actions = {
    plan: ["plans", "See plans"], quota: ["usage", "View usage"], credits: ["credits", "View image & document credits"],
    service: ["retry", "Try again"], network: ["retry", "Try again"], permission: ["permission", "Check permissions"],
    device: ["retry", "Try again"], "entitlement-sync": ["restore", "Restore subscription"],
    restricted: ["support", "Contact support"], storage: ["storage", "Manage files"], rate: ["retry", "Try again"],
  };
  const reset = input.resetAt && new Date(input.resetAt);
  const resetAt = reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null;
  const used = Number.isFinite(input.used) && input.used >= 0 ? input.used : null;
  const limit = Number.isFinite(input.limit) && input.limit > 0 ? input.limit : null;
  return { reason, feature, message: input.publicMessage || messages[reason],
    action: actions[reason][0], cta: actions[reason][1], resetAt, requiredPlan: input.requiredPlan ?? null, window: input.window ?? null, requestTooLarge: Boolean(input.requestTooLarge), pending: Math.max(0, Number(input.pending) || 0),
    used, limit, percentage: used !== null && limit !== null ? usagePercentage(used, limit) : null,
    // Optional structured detail for a screen (for example how an AI-credit reset is worded).
    // Absent unless the error supplies it, so every other access status keeps its exact shape.
    ...(input.detail && typeof input.detail === "object" ? { detail: input.detail } : {}) };
}

export function accessError(reason, options = {}) {
  const access = accessStatus({ ...options, reason });
  const error = new Error(access.message);
  return Object.assign(error, access, { publicMessage: access.message, code: options.code ?? ({ plan: "plan-required", quota: "quota-reached", credits: "credits-required" }[reason] ?? reason),
    status: options.status ?? ({ plan: 403, quota: 429, credits: 402, service: 503, "entitlement-sync": 409, rate: 429 }[reason] ?? 400) });
}

export function accessPayload(error) {
  const access = accessStatus(error);
  return { error: error.message, code: error.code, ...(access ? { access } : {}) };
}
