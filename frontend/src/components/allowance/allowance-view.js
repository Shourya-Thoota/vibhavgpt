/**
 * Presentation helpers for the AI allowance summary.
 *
 * Every amount shown comes from the server (GET /api/usage/allowance), which
 * also decides restriction state and free-choice availability. These helpers
 * only choose wording and turn server micros into bar widths; they never
 * recompute balances, limits, or eligibility.
 */

export const ALLOWANCE_PLAN_LABELS = Object.freeze({ plus: "Plus", pro: "Pro", max: "Max", free: "Free" });

export const ALLOWANCE_LOAD_STATES = Object.freeze({
  IDLE: "idle",
  LOADING: "loading",
  READY: "ready",
  ERROR: "error",
  SESSION_EXPIRED: "session_expired",
  DISABLED: "disabled",
});

export function allowanceLoadErrorState(error) {
  if (error?.status === 401) return ALLOWANCE_LOAD_STATES.SESSION_EXPIRED;
  if (error?.status === 404 && error?.code === "feature_disabled") return ALLOWANCE_LOAD_STATES.DISABLED;
  return ALLOWANCE_LOAD_STATES.ERROR;
}

export function allowanceLoadErrorMessage(state, error) {
  if (state === ALLOWANCE_LOAD_STATES.SESSION_EXPIRED) return "Your session has expired. Sign in again to see your AI allowance.";
  if (error?.code === "network-error") return "We couldn't reach VibhavGPT to load your AI allowance. Check your connection and try again.";
  return "We couldn't load your AI allowance right now. Try again in a moment.";
}

export function formatAllowanceResetDate(iso, { locale, timeZone } = {}) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric", ...(timeZone ? { timeZone } : {}) });
}

function share(part, whole) {
  const p = Number(part) || 0;
  const w = Number(whole) || 0;
  if (w <= 0 || p <= 0) return 0;
  return Math.min(100, Math.round((p / w) * 1000) / 10);
}

// While chat is not connected to the allowance, nothing is actually paused, so
// the notice describes what will happen instead of claiming it already does.
const PREVIEW_RESTRICTION_COPY = Object.freeze({
  allowance_exhausted: {
    status: "Used up",
    title: "Paid allowance used up",
    body: "This month's included AI allowance is used up. Once the allowance applies to chat, paid models will pause until it resets; nothing will be charged to your card. Chat isn't affected today.",
  },
  pending_usage_holds: {
    status: "On hold",
    title: "Remaining allowance is on hold",
    body: "What's left of your allowance is reserved for requests that are still finishing, and any unused part is returned. Chat isn't affected today.",
  },
});

const RESTRICTION_COPY = Object.freeze({
  allowance_exhausted: {
    status: "Used up",
    title: "Paid allowance used up",
    body: "You've used this month's included AI allowance, so the models that use it are paused. Nothing is charged to your card.",
  },
  pending_usage_holds: {
    status: "On hold",
    title: "Remaining allowance is on hold",
    body: "What's left of your allowance is reserved for requests that are still finishing. Paid models are paused until they complete, and any unused part is returned.",
  },
});

/**
 * Builds display-ready copy from a server summary. Returns null when there is
 * nothing to show.
 */
export function allowanceViewModel(summary, options = {}) {
  if (!summary || typeof summary !== "object") return null;
  const planLabel = ALLOWANCE_PLAN_LABELS[summary.plan] ?? "Free";
  const freeChoices = Array.isArray(summary.freeChoices) ? summary.freeChoices : [];
  const restriction = summary.paidUsage?.restricted ? summary.paidUsage.reason : null;
  const enforcedNames = Array.isArray(summary.enforcedModels) ? summary.enforcedModels.map((model) => model.displayName).filter(Boolean) : [];
  // Say exactly what is true: which models use the allowance, and that the rest keep their plan limits.
  const previewNote = summary.enforcementConnected
    ? (enforcedNames.length ? `Applies to ${enforcedNames.join(", ")}. Other models keep your existing plan limits.` : null)
    : "Preview: chat doesn't apply this allowance yet. Your current chat limits are shown below and still decide access.";

  const allowance = summary.allowance;
  if (!allowance) {
    return {
      kind: "no_allowance",
      planLabel,
      headline: "AI allowance comes with Plus, Pro, and Max",
      freeChoices,
      restriction,
      previewNote,
    };
  }

  const display = allowance.display ?? {};
  const resetDate = formatAllowanceResetDate(allowance.resetAt, options);
  const copy = (summary.enforcementConnected ? RESTRICTION_COPY : PREVIEW_RESTRICTION_COPY)[restriction] ?? null;
  return {
    kind: "subscription",
    planLabel,
    headline: `${display.available} remaining of ${display.included}`,
    available: display.available,
    included: display.included,
    confirmed: display.confirmed,
    pending: display.pending,
    hasPending: Number(allowance.pendingMicros) > 0,
    confirmedShare: share(allowance.confirmedMicros, allowance.includedMicros),
    pendingShare: Math.min(
      share(allowance.pendingMicros, allowance.includedMicros),
      Math.max(0, 100 - share(allowance.confirmedMicros, allowance.includedMicros)),
    ),
    meterLabel: `AI allowance: ${display.confirmed} spent, ${display.pending} pending, ${display.available} remaining of ${display.included}.`,
    statusText: copy?.status ?? "Available",
    resetDate,
    resetLabel: resetDate ? `Resets ${resetDate}` : "Resets at the start of your next monthly period",
    pendingNote: Number(allowance.pendingMicros) > 0
      ? `${display.pending} is reserved for requests that are still finishing. It isn't counted as spent until they complete, and any unused part is returned.`
      : null,
    monthlyGrantNote: allowance.billingTermExtendsBeyondReset
      ? "Your allowance refreshes every month, separately from your plan's renewal date."
      : null,
    restriction,
    enforcementConnected: Boolean(summary.enforcementConnected),
    restrictionTitle: copy?.title ?? null,
    restrictionBody: copy?.body ?? null,
    freeChoices,
    previewNote,
  };
}

const CHAT_EXHAUSTION_TITLES = Object.freeze({
  allowance_exhausted: "Paid allowance used up",
  pending_usage_holds: "Remaining allowance is on hold",
  request_exceeds_remaining: "Not enough allowance for this request",
});

/**
 * A view for AllowanceExhaustedNotice built from the chat's own refusal. The wording and
 * the choices come from the server; this only lays them out. Nothing is sent or switched.
 */
export function allowanceViewFromChatError(error, options = {}) {
  const allowance = error?.allowance;
  if (!allowance?.paidModelRestricted) return null;
  const reason = CHAT_EXHAUSTION_TITLES[allowance.reason] ? allowance.reason : "allowance_exhausted";
  return {
    kind: "subscription",
    restriction: reason,
    restrictionTitle: CHAT_EXHAUSTION_TITLES[reason],
    restrictionBody: error.message,
    resetDate: formatAllowanceResetDate(allowance.resetAt, options),
    freeChoices: Array.isArray(allowance.freeChoices) ? allowance.freeChoices : [],
    enforcementConnected: true,
  };
}
