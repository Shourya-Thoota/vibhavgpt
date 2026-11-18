import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import {
  CoordinatorAllowanceError,
  COORDINATOR_ERROR_CODES,
  executeWithCoordinator,
} from "../models/execution-coordinator.js";
import { evaluateRoutingDecision, loadRegistrySnapshot } from "../models/decision.js";
import { getAvailableAllowance } from "../usage/allowance-service.js";
import { resolveApprovedFreeChoices } from "../usage/allowance-summary.js";
import { getActiveSubscription, tierForSubscription } from "../usage/service.js";
import { chatAllowanceEnforcement } from "../usage/chat-allowance-policy.js";
import { estimateChatPromptTokens } from "./context-window.js";
import {
  InferenceUnavailableError,
  callPinnedEndpoint,
  failureShowsZeroUsage,
  streamPinnedEndpoint,
} from "./providers.js";

/**
 * Connects a native chat model call to the allowance coordinator.
 *
 * Accounting defaults (owner policy):
 * - Customer-requested generation and tool-response calls each reserve and settle
 *   against the allowance exactly once, at actual cost.
 * - Background moderation, routing classification and automatic memory extraction
 *   are platform overhead: they never pass through here, are never deducted from a
 *   customer, and are recorded separately (shadow-ledger accounting classes).
 * - A call that may have been billed is never sent again. Another attempt is made
 *   only after a failure that proves no inference happened.
 * - Router tiers settle on the provider-reported cost of the request; token counts
 *   alone are not billed there. Missing figures leave the hold uncertain.
 *
 * The provider's raw reply (tool calls, reasoning items) stays server-internal: it is
 * returned only to the chat handler's tool loop, never through the coordinator's
 * sanitized result, and reply text is not copied into the ledger.
 */

export { ALLOWANCE_SUBSCRIBER_PLANS, ENFORCEMENT_REASONS, chatAllowanceEnforcement } from "../usage/chat-allowance-policy.js";

export const CALL_PURPOSES = Object.freeze({
  generation: "g",
  toolResponse: "t",
  finalAnswer: "f",
  rewrite: "w",
});
export const MAX_ZERO_USAGE_RETRIES = 2;
const ZERO_USAGE_RETRY_DELAYS_MS = [250, 750];

function confirmedTokens(usage) {
  return [usage?.prompt_tokens ?? usage?.input_tokens, usage?.completion_tokens ?? usage?.output_tokens]
    .every((value) => Number.isSafeInteger(value) && value >= 0);
}

function hasReportedCost(usage) {
  return Number.isFinite(Number(usage?.cost)) && Number(usage.cost) >= 0 && usage.cost !== null && usage.cost !== "";
}

/**
 * The usage the coordinator may settle. Null (uncertain) unless billable usage is
 * confirmed in the form this tier is billed in.
 */
export function settlementUsage(usage, { reportsCost }) {
  if (!confirmedTokens(usage) || usage?.estimated === true) return null;
  if (!reportsCost) return usage;
  return hasReportedCost(usage) ? { ...usage, cost: Number(usage.cost), costBasis: "provider_reported" } : null;
}

function customerAllowanceError(message, detail) {
  return new CoordinatorAllowanceError(message, {
    code: COORDINATOR_ERROR_CODES.ALLOWANCE_EXCEEDED,
    paidModelRestricted: true,
    customerMessage: message,
    canRetry: false,
    plan: detail?.plan,
    ...detail,
  });
}

/**
 * Wire shape for an exhausted allowance. Free choices come from the same source as
 * the summary API, so an unavailable endpoint is reported as unavailable.
 */
export const EXHAUSTION_COPY = Object.freeze({
  allowance_exhausted: "Your included AI allowance is used up for this period. You can choose an included model, or wait for your allowance to reset.",
  pending_usage_holds: "Your remaining AI allowance is reserved for requests that are still finishing. You can choose an included model, or try again shortly.",
  request_exceeds_remaining: "Your remaining AI allowance can't fund this request right now. You can choose an included model, or try again later.",
});

export async function allowanceExhaustedPayload(error, { db = null, registrySnapshot = null, plan = "free", now = new Date() } = {}) {
  const snapshot = registrySnapshot || await loadRegistrySnapshot(db).catch(() => []);
  const freeChoices = await resolveApprovedFreeChoices({ plan, registrySnapshot: snapshot, now });
  const reason = EXHAUSTION_COPY[error.reason] ? error.reason : (Number(error.remainingIncludedAllowanceMicros ?? 0) <= 0 ? "allowance_exhausted" : "request_exceeds_remaining");
  return {
    // Customer wording only: no timestamps, internal group names or provider detail.
    error: EXHAUSTION_COPY[reason],
    code: "allowance_exceeded",
    retryable: false,
    allowance: {
      paidModelRestricted: true,
      reason,
      resetAt: error.resetAt ?? null,
      freeChoices,
    },
  };
}

export function createChatAllowanceGateway({
  userId,
  requestId = null,
  modelKey,
  plan,
  signal = null,
  db = null,
  registrySnapshot = null,
  now = () => new Date(),
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const chatRequestId = requestId && requestId !== "unknown" ? requestId : randomUUID();
  const attribution = [];
  let snapshot = registrySnapshot;
  const counters = new Map();

  async function loadSnapshot() {
    snapshot ??= await loadRegistrySnapshot(db);
    return snapshot;
  }

  function nextLogicalId(purpose) {
    const code = CALL_PURPOSES[purpose] ?? "g";
    const n = (counters.get(code) ?? 0) + 1;
    counters.set(code, n);
    return `${chatRequestId}:${code}${n}`;
  }

  /**
   * Before anything is saved or sent: this tier must resolve to an eligible
   * registry endpoint, and some allowance must be available. Refusals are final;
   * nothing falls back to the legacy path.
   */
  async function preflight() {
    const registry = await loadSnapshot();
    // Vulcan is served over the transport the deployment configures (CHAT_VESPER_TRANSPORT), with or without enforcement: turning
    // enforcement on must not move it to another route, or leave it unavailable where only that route is registered. Every privacy
    // and endpoint check in the decision still applies.
    const decision = await evaluateRoutingDecision(
      { plan, requestedModel: { modelKey }, modalities: {}, reasoning: {}, context: {}, privacy: {}, transportPreference: modelKey === "vesper" ? config.vesperTransport : null },
      { registrySnapshot: registry, evaluatedAt: now().toISOString() },
    );
    if (!decision.eligible) throw new InferenceUnavailableError();
    const balance = await getAvailableAllowance(userId, { plan, now: now() }, db);
    if (balance.availableMicros <= 0) {
      const resetAt = balance.monthly.periodEnd ? new Date(balance.monthly.periodEnd).toISOString() : null;
      const exhausted = balance.monthly.confirmedMicros >= balance.monthly.limitMicros;
      const reason = exhausted ? "allowance_exhausted" : "pending_usage_holds";
      throw customerAllowanceError(EXHAUSTION_COPY[reason], { resetAt, remainingIncludedAllowanceMicros: 0, supportedOutputTokens: 0, plan, reason });
    }
    return decision;
  }

  async function attempt({ purpose, messages, tools, stream, options, logicalRequestId }) {
    const capture = { result: null };
    const registry = await loadSnapshot();
    const modalities = { vision: Boolean(options.imageInput), tools: Boolean(tools?.length), streaming: Boolean(stream) };

    const transport = async (context) => {
      const callOptions = { ...options, maxTokens: context.maxOutputTokens, signal: context.signal, fetchImpl: options.fetchImpl ?? fetchImpl };
      try {
        const result = stream
          ? await streamPinnedEndpoint(modelKey, context.endpoint, messages, tools, callOptions)
          : await callPinnedEndpoint(modelKey, context.endpoint, messages, tools, callOptions);
        capture.result = result;
        const usage = settlementUsage(result.data?.usage, { reportsCost: result.reportsCost });
        // No reply text is copied into the ledger; it lives in the conversation only.
        return { text: "", usage };
      } catch (error) {
        // Router tiers are billed on the provider-reported cost of the request.
        error.usage = settlementUsage(error?.usage, { reportsCost: context.endpoint?.transportType === "router" }) ?? undefined;
        error.confirmedZeroUsage = error?.code !== "client-aborted" && !signal?.aborted && failureShowsZeroUsage({ ...error, usage: error?.usage });
        throw error;
      }
    };

    const settlement = await executeWithCoordinator({
      userId,
      logicalRequestId,
      modelKey,
      messages,
      tools,
      modalities,
      reasoning: {},
      context: { estimatedInputTokens: estimateChatPromptTokens(messages), maxOutputTokens: options.maxTokens },
      signal,
      db,
      transport,
      transportPreference: modelKey === "vesper" ? config.vesperTransport : null,
      options: { userPlan: plan, registrySnapshot: registry },
    });
    // A replayed request id settles from the ledger and has no reply to hand back.
    if (!capture.result) throw Object.assign(new Error("A reply for this request id is not available."), { code: "duplicate_request" });
    attribution.push({ purpose, logicalRequestId, settlement: settlement.settlement });
    return { data: capture.result.data, internalStage: capture.result.internalStage };
  }

  /**
   * One customer-requested model call. The raw provider reply is returned to the
   * calling tool loop only.
   */
  async function call({ purpose = "generation", messages, tools, stream = false, options = {} }) {
    const baseId = nextLogicalId(purpose);
    for (let tryNumber = 0; ; tryNumber += 1) {
      const logicalRequestId = tryNumber === 0 ? baseId : `${baseId}:r${tryNumber}`;
      try {
        return await attempt({ purpose, messages, tools, stream, options, logicalRequestId });
      } catch (error) {
        if (error instanceof CoordinatorAllowanceError) { error.plan ??= plan; throw error; }
        const canRetry = error?.confirmedZeroUsage === true
          && !signal?.aborted
          && tryNumber < MAX_ZERO_USAGE_RETRIES
          && (!options.deadlineAt || options.deadlineAt - Date.now() > 5_000);
        if (canRetry) {
          await sleep(ZERO_USAGE_RETRY_DELAYS_MS[Math.min(tryNumber, ZERO_USAGE_RETRY_DELAYS_MS.length - 1)]);
          continue;
        }
        if (error?.code === COORDINATOR_ERROR_CODES.ABORTED_DURING_EXECUTION || error?.code === COORDINATOR_ERROR_CODES.ABORTED_PRE_DISPATCH || error?.code === COORDINATOR_ERROR_CODES.ABORTED_PRE_RESERVATION || signal?.aborted) {
          throw new InferenceUnavailableError();
        }
        // Eligibility, revalidation, reservation conflicts and execution failures
        // all stop here with the same customer-safe message; none reach a provider
        // through another path.
        throw Object.assign(new InferenceUnavailableError(), { stageCode: error?.code ?? null, reservationId: error?.reservationId ?? null });
      }
    }
  }

  return {
    chatRequestId,
    plan,
    preflight,
    call,
    attribution,
  };
}

/**
 * Resolves the plan and, when the request is enforced, returns its gateway.
 * Returns null for requests that stay on the legacy path.
 */
export async function maybeCreateChatAllowanceGateway({ userId, modelKey, requestId, signal, db = null, now = new Date(), settings = config, ...rest }) {
  if (!settings.featureChatAllowanceEnforcement) return null;
  const subscription = await getActiveSubscription(userId, db ?? undefined);
  const plan = tierForSubscription(subscription, now);
  const decision = chatAllowanceEnforcement({ modelKey, plan, now, settings });
  if (!decision.enforced) return null;
  return createChatAllowanceGateway({ userId, requestId, modelKey, plan, signal, db, ...rest });
}
