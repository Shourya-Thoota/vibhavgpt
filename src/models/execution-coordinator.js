import { eq } from "drizzle-orm";
import { modelEndpoints } from "../db/schema.js";
import { getDefaultDb } from "./registry.js";
import {
  evaluateRoutingDecision,
  revalidateRoutingDecision,
  serializeDecisionForClient,
  CUSTOMER_SAFE_REJECTIONS,
  ROUTE_DECISION_REASONS,
} from "./decision.js";
import {
  reserveAllowance,
  markDispatched,
  heartbeatReservation,
  settleAllowance,
  releaseAllowance,
  markUncertain,
  ALLOWANCE_LIFECYCLE_STATES,
  DEFAULT_LEASE_DURATION_MS,
  AllowanceError,
  AllowanceExceededError,
  AllowanceIdempotencyConflictError,
  APPROVED_FREE_MODEL_GROUP,
} from "../usage/allowance-service.js";
import {
  getActiveSubscription,
  tierForSubscription,
} from "../usage/service.js";

/**
 * Standardized lifecycle stages for coordinator execution tracking.
 */
export const COORDINATOR_LIFECYCLE_STAGES = Object.freeze({
  INITIALIZED: "initialized",
  EVALUATED: "evaluated",
  RESERVED: "reserved",
  REVALIDATED: "revalidated",
  DISPATCHED: "dispatched",
  EXECUTING: "executing",
  SETTLED: "settled",
  RELEASED: "released",
  UNCERTAIN: "uncertain",
  FAILED: "failed",
});

/**
 * Machine-readable coordinator error codes.
 */
export const COORDINATOR_ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: "coordinator_validation_error",
  ROUTING_INELIGIBLE: "coordinator_routing_ineligible",
  ALLOWANCE_EXCEEDED: "coordinator_allowance_exceeded",
  IDEMPOTENCY_CONFLICT: "coordinator_idempotency_conflict",
  DUPLICATE_REQUEST: "coordinator_duplicate_request",
  REVALIDATION_FAILED: "coordinator_revalidation_failed",
  ABORTED_PRE_RESERVATION: "coordinator_aborted_pre_reservation",
  ABORTED_PRE_DISPATCH: "coordinator_aborted_pre_dispatch",
  ABORTED_DURING_EXECUTION: "coordinator_aborted_during_execution",
  EXECUTION_FAILED: "coordinator_execution_failed",
  EXECUTION_TIMEOUT: "coordinator_execution_timeout",
  UNKNOWN_EXECUTION: "coordinator_unknown_execution",
  POLICY_BLOCKED: "coordinator_policy_blocked",
  ENDPOINT_OVERRUN_CIRCUIT_TRIPPED: "coordinator_endpoint_overrun_circuit_tripped",
  ACTIVATION_BLOCKED: "coordinator_activation_blocked",
  REDISPATCH_UNCERTAIN_PROHIBITED: "coordinator_redispatch_uncertain_prohibited",
});

export { APPROVED_FREE_MODEL_GROUP };

/**
 * Standardized activation blocker reason codes for readiness assertion.
 */
export const ACTIVATION_BLOCKER_CODES = Object.freeze({
  OWNER_APPROVAL_MISSING: "owner_approval_missing",
  LIVE_EXECUTION_DISCONNECTED: "live_execution_disconnected",
});

/**
 * Base Coordinator Error.
 */
export class CoordinatorError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code || COORDINATOR_ERROR_CODES.EXECUTION_FAILED;
    this.status = options.status || 500;
    this.stage = options.stage || null;
    this.customerMessage = options.customerMessage || message;
    this.reservationId = options.reservationId || null;
    this.decisionId = options.decisionId || null;
    this.canRetry = options.canRetry ?? false;
    Object.assign(this, options);
  }
}

export class CoordinatorValidationError extends CoordinatorError {
  constructor(message, options = {}) {
    super(message, { code: COORDINATOR_ERROR_CODES.VALIDATION_ERROR, status: 400, ...options });
  }
}

export class CoordinatorRoutingError extends CoordinatorError {
  constructor(message, options = {}) {
    super(message, { code: COORDINATOR_ERROR_CODES.ROUTING_INELIGIBLE, status: 403, ...options });
  }
}

export class CoordinatorAllowanceError extends CoordinatorError {
  constructor(message, options = {}) {
    super(message, { code: COORDINATOR_ERROR_CODES.ALLOWANCE_EXCEEDED, status: 429, ...options });
  }
}

export class CoordinatorConflictError extends CoordinatorError {
  constructor(message, options = {}) {
    super(message, { code: COORDINATOR_ERROR_CODES.IDEMPOTENCY_CONFLICT, status: 409, ...options });
  }
}

export class CoordinatorDuplicateRequestError extends CoordinatorError {
  constructor(message, options = {}) {
    super(message, { code: COORDINATOR_ERROR_CODES.DUPLICATE_REQUEST, status: 409, ...options });
  }
}

export class CoordinatorRevalidationError extends CoordinatorError {
  constructor(message, options = {}) {
    super(message, { code: COORDINATOR_ERROR_CODES.REVALIDATION_FAILED, status: 403, ...options });
  }
}

export class CoordinatorAbortError extends CoordinatorError {
  constructor(message, options = {}) {
    super(message, { code: options.code || COORDINATOR_ERROR_CODES.ABORTED_DURING_EXECUTION, status: 499, ...options });
  }
}

export class CoordinatorExecutionError extends CoordinatorError {
  constructor(message, options = {}) {
    super(message, { code: COORDINATOR_ERROR_CODES.EXECUTION_FAILED, status: 502, ...options });
  }
}

export class CoordinatorPolicyBlockedError extends CoordinatorError {
  constructor(message, options = {}) {
    super(message, { code: COORDINATOR_ERROR_CODES.POLICY_BLOCKED, status: 501, ...options });
  }
}

export class CoordinatorOverrunCircuitError extends CoordinatorError {
  constructor(message, options = {}) {
    super(message, { code: COORDINATOR_ERROR_CODES.ENDPOINT_OVERRUN_CIRCUIT_TRIPPED, status: 503, ...options });
  }
}

export class ActivationBlockedError extends CoordinatorError {
  constructor(message, options = {}) {
    super(message, { code: COORDINATOR_ERROR_CODES.ACTIVATION_BLOCKED, status: 503, ...options });
  }
}

// Active heartbeat timer registry for testability and zero dangling timer guarantees
const activeHeartbeatTimers = new Set();

/**
 * Returns the number of currently active worker heartbeat intervals.
 * Used by tests to assert zero timer leaks across all terminal paths.
 */
export function getActiveHeartbeatTimerCount() {
  return activeHeartbeatTimers.size;
}

/**
 * Clears all registered heartbeat timers.
 * Used for test teardown and safety resets.
 */
export function clearAllHeartbeatTimers() {
  for (const timer of activeHeartbeatTimers) {
    clearInterval(timer);
  }
  activeHeartbeatTimers.clear();
}

/**
 * Evaluates live activation readiness against owner approval and runtime connection prerequisites.
 *
 * Rules:
 * 1. Requires explicit owner activation approval (config.ownerActivationApproved === true).
 * 2. Verifies live handler gating (must remain disconnected until all requirements are met).
 */
export function checkActivationReadiness({ config = {} } = {}) {
  const blockers = [];

  const ownerApproval = config.ownerActivationApproved === true;
  if (!ownerApproval) {
    blockers.push(ACTIVATION_BLOCKER_CODES.OWNER_APPROVAL_MISSING);
  }

  if (!config.liveExecutionEnabled) {
    blockers.push(ACTIVATION_BLOCKER_CODES.LIVE_EXECUTION_DISCONNECTED);
  }

  return {
    ready: blockers.length === 0,
    blockers,
    ownerApproval,
  };
}

/**
 * Asserts activation readiness, throwing ActivationBlockedError if any prerequisite is unmet.
 */
export function assertActivationReadiness(options = {}) {
  const readiness = checkActivationReadiness(options);
  if (!readiness.ready) {
    throw new ActivationBlockedError(
      `Live execution activation blocked: ${readiness.blockers.join(", ")}`,
      {
        code: COORDINATOR_ERROR_CODES.ACTIVATION_BLOCKED,
        blockers: readiness.blockers,
        readiness,
        canRetry: false,
      }
    );
  }
  return readiness;
}

/**
 * Default threshold for repeated endpoint limit violations before tripping circuit breaker.
 */
export const DEFAULT_MAX_CONSECUTIVE_OVERRUNS = 3;

// In-memory state tracking endpoint overrun events
const endpointOverrunState = new Map();

/**
 * Records an execution overrun event for a model endpoint.
 */
export function recordEndpointOverrun({
  endpointId,
  modelKey,
  overrunMicros = 0,
  outputTokens = 0,
  authorizedMaxTokens = 0,
  now = new Date(),
}) {
  if (!endpointId) return null;
  const current = endpointOverrunState.get(endpointId) || {
    consecutiveOverruns: 0,
    totalOverruns: 0,
    cumulativeOverrunMicros: 0,
    lastOverrunAt: null,
    modelKey,
  };

  const isOverrun = overrunMicros > 0 || (authorizedMaxTokens > 0 && outputTokens > authorizedMaxTokens);
  if (isOverrun) {
    current.consecutiveOverruns += 1;
    current.totalOverruns += 1;
    current.cumulativeOverrunMicros += overrunMicros;
    current.lastOverrunAt = new Date(now).toISOString();
  } else {
    current.consecutiveOverruns = 0;
  }

  endpointOverrunState.set(endpointId, current);
  return current;
}

/**
 * Inspects whether an endpoint has tripped repeated overrun protection.
 */
export function checkEndpointOverrunStatus(endpointId, { maxConsecutiveOverruns = DEFAULT_MAX_CONSECUTIVE_OVERRUNS } = {}) {
  if (!endpointId) return { tripped: false, consecutiveOverruns: 0, cumulativeOverrunMicros: 0 };
  const current = endpointOverrunState.get(endpointId);
  if (!current) return { tripped: false, consecutiveOverruns: 0, cumulativeOverrunMicros: 0 };

  const tripped = current.consecutiveOverruns >= maxConsecutiveOverruns;
  return {
    tripped,
    consecutiveOverruns: current.consecutiveOverruns,
    totalOverruns: current.totalOverruns,
    cumulativeOverrunMicros: current.cumulativeOverrunMicros,
    lastOverrunAt: current.lastOverrunAt,
    reason: tripped ? `consecutive_overruns_exceeded_${current.consecutiveOverruns}` : null,
  };
}

/**
 * Resets overrun tracking state. Used for test isolation and admin circuit recovery.
 */
export function resetEndpointOverrunTracker() {
  endpointOverrunState.clear();
}

/**
 * Sanitizes an execution result for public/client delivery.
 * Strictly scrubs internal provider names, raw vendor costs, internal endpoints,
 * database primary keys, and wholesale price margins.
 */
export function sanitizePublicExecutionResult(result) {
  if (!result) return null;
  return {
    success: Boolean(result.success),
    logicalRequestId: result.logicalRequestId,
    model: result.model,
    displayName: result.displayName,
    familyGroup: result.familyGroup,
    consumptionCategory: result.consumptionCategory,
    output: result.output ?? null,
    usage: result.usage ? {
      promptTokens: result.usage.promptTokens ?? result.usage.prompt_tokens ?? 0,
      completionTokens: result.usage.completionTokens ?? result.usage.completion_tokens ?? 0,
      totalTokens: result.usage.totalTokens ?? result.usage.total_tokens ?? (
        (result.usage.promptTokens ?? result.usage.prompt_tokens ?? 0) +
        (result.usage.completionTokens ?? result.usage.completion_tokens ?? 0)
      ),
    } : null,
    settlement: result.settlement ? {
      status: result.settlement.status,
      settledCostMicros: result.settlement.settledCostMicros ?? null,
      isPartial: Boolean(result.settlement.isPartial),
    } : null,
  };
}

/**
 * Server-Side Execution Coordinator for Model Routing and Allowance Accounting.
 *
 * Implements authoritative request lifecycle:
 * 1. Resolves authoritative server-side plan and entitlements (never trusts client plan).
 * 2. Evaluates candidate routing eligibility via pure decision service.
 * 3. Places atomic, idempotent allowance reservation hold in PostgreSQL.
 * 4. Revalidates route and privacy status immediately prior to dispatch.
 *    Releases undispatched hold if revalidation fails.
 * 5. Marks dispatched at documented boundary (tracking worker lease via heartbeats).
 * 6. Invokes injected transport with AbortSignal.
 * 7. Settles confirmed usage or marks uncertain on unconfirmed exit.
 * 8. Cleans up worker leases and heartbeat timers on every terminal path.
 */
export async function executeWithCoordinator({
  userId,
  logicalRequestId,
  modelKey = null,
  requestedModel = null,
  prompt = null,
  messages = [],
  tools = undefined,
  reasoning = null,
  modalities = null,
  context = {},
  privacy = null,
  // The transport the caller's deployment serves this model over (for example Vulcan's CHAT_VESPER_TRANSPORT); null keeps the
  // decision engine's own default.
  transportPreference = null,
  signal = null,
  transport,
  heartbeatIntervalMs = 15_000,
  leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
  db = null,
  now = () => new Date(),
  idempotencyKey = null,
  options = {},
}) {
  const activeSignal = signal || (new AbortController()).signal;

  // 1. Validate Required Parameters
  if (!userId) {
    throw new CoordinatorValidationError("userId is required", { code: COORDINATOR_ERROR_CODES.VALIDATION_ERROR });
  }
  if (!logicalRequestId) {
    throw new CoordinatorValidationError("logicalRequestId is required", { code: COORDINATOR_ERROR_CODES.VALIDATION_ERROR });
  }
  if (!transport) {
    throw new CoordinatorValidationError("Injected transport is required", { code: COORDINATOR_ERROR_CODES.VALIDATION_ERROR });
  }

  // Pre-reservation cancellation boundary
  if (activeSignal.aborted) {
    throw new CoordinatorAbortError("Operation aborted before reservation", {
      code: COORDINATOR_ERROR_CODES.ABORTED_PRE_RESERVATION,
      stage: COORDINATOR_LIFECYCLE_STAGES.INITIALIZED,
      canRetry: false,
    });
  }

  // Activation prerequisites check if requested or in activation assertion mode
  if (options.assertActivationReadiness) {
    assertActivationReadiness({
      config: options.activationConfig || options.config || {},
      cumulativeAbsorbedMicros: options.cumulativeAbsorbedMicros || 0,
    });
  }

  // Reject unsupported automatic paid redispatch
  if (options.allowPaidRedispatch) {
    throw new CoordinatorPolicyBlockedError("Automatic paid redispatch for uncertain execution is strictly prohibited", {
      code: COORDINATOR_ERROR_CODES.REDISPATCH_UNCERTAIN_PROHIBITED,
      canRetry: false,
    });
  }

  // Reject unsupported multi-attempt retry loop
  if (options.maxRetries && options.maxRetries > 0) {
    throw new CoordinatorPolicyBlockedError("Multi-attempt retry loop is not authorized for live execution", {
      code: COORDINATOR_ERROR_CODES.POLICY_BLOCKED,
      canRetry: false,
    });
  }

  const executor = db || (await getDefaultDb());
  const nowFn = typeof now === "function" ? now : () => now;
  const currentTime = nowFn();

  // 2. Resolve Authoritative Server-Side User Plan
  let userPlan = options.userPlan;
  if (!userPlan) {
    const sub = await getActiveSubscription(userId, executor);
    userPlan = tierForSubscription(sub, currentTime);
  }

  // 3. Evaluate Routing Eligibility via Pure Decision Service
  const targetRequestedModel = requestedModel || (modelKey ? { modelKey } : { auto: true });
  const estimatedInputTokens = context.estimatedInputTokens !== undefined
    ? Number(context.estimatedInputTokens)
    : prompt
      ? Math.ceil(Buffer.byteLength(prompt, "utf8") / 3.5)
      : 256;
  const maxOutputTokens = context.maxOutputTokens !== undefined
    ? Number(context.maxOutputTokens)
    : 4096;

  const routingRequest = {
    plan: userPlan,
    requestedModel: targetRequestedModel,
    modalities: modalities || {},
    reasoning: reasoning || {},
    context: {
      ...context,
      estimatedInputTokens,
      maxOutputTokens,
    },
    privacy: privacy || {},
    transportPreference,
  };

  const decision = await evaluateRoutingDecision(routingRequest, {
    db: executor,
    registrySnapshot: options.registrySnapshot || null,
    evaluatedAt: currentTime.toISOString(),
  });

  if (!decision.eligible) {
    throw new CoordinatorRoutingError(decision.customerMessage || "Model is not eligible for routing", {
      code: decision.reasonCode || COORDINATOR_ERROR_CODES.ROUTING_INELIGIBLE,
      stage: COORDINATOR_LIFECYCLE_STAGES.EVALUATED,
      customerMessage: decision.customerMessage,
      decisionId: decision.decisionId,
      canRetry: false,
    });
  }

  // Pre-reservation abort check
  if (activeSignal.aborted) {
    throw new CoordinatorAbortError("Operation aborted before reservation", {
      code: COORDINATOR_ERROR_CODES.ABORTED_PRE_RESERVATION,
      stage: COORDINATOR_LIFECYCLE_STAGES.EVALUATED,
      decisionId: decision.decisionId,
      canRetry: false,
    });
  }

  // 4. Reserve Allowance Hold
  const effectiveModelKey = decision.selectedCandidate.familySlug || modelKey;
  const effectiveIdempotencyKey = idempotencyKey || options.idempotencyKey || `req_${logicalRequestId}`;

  const pinnedRates = (decision.pinnedPricing?.inputPriceMicrosPerM != null && decision.pinnedPricing?.outputPriceMicrosPerM != null)
    ? {
        input: decision.pinnedPricing.inputPriceMicrosPerM / 1_000_000,
        output: decision.pinnedPricing.outputPriceMicrosPerM / 1_000_000,
        cacheRead: (decision.pinnedPricing.cachedReadPriceMicrosPerM ?? decision.pinnedPricing.inputPriceMicrosPerM) / 1_000_000,
      }
    : null;

  let reservation;
  try {
    reservation = await reserveAllowance({
      userId,
      requestId: logicalRequestId,
      operation: options.operation || "inference",
      modality: modalities?.image ? "image" : "text",
      modelKey: effectiveModelKey,
      modelIdentifier: decision.selectedCandidate.versionTag,
      provider: decision.pinnedEndpoint.providerName,
      transport: decision.pinnedEndpoint.transportType,
      estimatedInputTokens,
      maxOutputTokens,
      pricingVersionId: decision.pinnedPricing.pricingVersionId,
      idempotencyKey: effectiveIdempotencyKey,
      metadata: {
        logicalRequestId,
        displayName: decision.selectedCandidate.displayName,
        familyGroup: decision.selectedCandidate.familyGroup,
        consumptionCategory: decision.pinnedPricing.consumptionCategory,
        ...(pinnedRates ? { pinnedRates } : {}),
      },
      now: currentTime,
    }, executor);
  } catch (err) {
    if (err instanceof AllowanceExceededError) {
      const resetIso = err.resetAt ? (err.resetAt instanceof Date ? err.resetAt.toISOString() : new Date(err.resetAt).toISOString()) : null;
      const isExhausted = (err.availableMicros ?? 0) <= 0;
      const customerMessage = isExhausted
        ? `Your included AI allowance is exhausted for this billing cycle. Paid models are restricted until your allowance resets on ${resetIso}. You can continue chatting using the free model group (Lumen).`
        : `Your remaining included AI allowance cannot fund this request with the requested output limit. You can proceed with up to ${err.supportedOutputTokens || 0} output tokens, or switch to the free model group (Lumen).`;

      throw new CoordinatorAllowanceError(customerMessage, {
        code: COORDINATOR_ERROR_CODES.ALLOWANCE_EXCEEDED,
        stage: COORDINATOR_LIFECYCLE_STAGES.RESERVED,
        window: err.window,
        limitMicros: err.limitMicros,
        remainingIncludedAllowanceMicros: err.availableMicros ?? 0,
        resetAt: resetIso,
        paidModelRestricted: true,
        availableFreeChoices: APPROVED_FREE_MODEL_GROUP,
        supportedOutputTokens: err.supportedOutputTokens ?? 0,
        customerMessage,
        decisionId: decision.decisionId,
        canRetry: false,
      });
    }
    if (err instanceof AllowanceIdempotencyConflictError) {
      throw new CoordinatorConflictError(err.message, {
        code: COORDINATOR_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        stage: COORDINATOR_LIFECYCLE_STAGES.RESERVED,
        decisionId: decision.decisionId,
        canRetry: false,
      });
    }
    throw err;
  }

  const reservationId = reservation.reservationId;

  // Handle Idempotent Duplicate Request
  if (reservation.isDuplicate) {
    const existingStatus = reservation.status;
    if (existingStatus === ALLOWANCE_LIFECYCLE_STATES.SETTLED) {
      // Operation already settled: return public-safe cached outcome without redispatching transport
      return sanitizePublicExecutionResult({
        success: true,
        logicalRequestId,
        model: reservation.row.modelKey,
        displayName: reservation.row.metadata?.displayName || reservation.row.modelKey,
        familyGroup: reservation.row.metadata?.familyGroup || "Standard",
        consumptionCategory: reservation.row.metadata?.consumptionCategory || "medium",
        output: reservation.row.metadata?.cachedOutput || null,
        usage: {
          promptTokens: reservation.row.inputTokens,
          completionTokens: reservation.row.outputTokens,
          totalTokens: (reservation.row.inputTokens || 0) + (reservation.row.outputTokens || 0),
        },
        settlement: {
          status: existingStatus,
          settledCostMicros: reservation.row.settledCostMicros,
          isPartial: Boolean(reservation.row.metadata?.isPartial),
        },
      });
    }

    if (existingStatus === ALLOWANCE_LIFECYCLE_STATES.UNCERTAIN) {
      throw new CoordinatorPolicyBlockedError(
        "Automatic paid redispatch for uncertain execution is strictly prohibited",
        {
          code: COORDINATOR_ERROR_CODES.REDISPATCH_UNCERTAIN_PROHIBITED,
          stage: COORDINATOR_LIFECYCLE_STAGES.RESERVED,
          reservationId,
          existingStatus,
          canRetry: false,
        }
      );
    }

    // If reservation exists in an in-flight or other state: do not dispatch twice!
    throw new CoordinatorDuplicateRequestError(
      `Duplicate logical request already exists with status: ${existingStatus}`,
      {
        code: COORDINATOR_ERROR_CODES.DUPLICATE_REQUEST,
        stage: COORDINATOR_LIFECYCLE_STAGES.RESERVED,
        reservationId,
        existingStatus,
        canRetry: false,
      }
    );
  }

  // 5. Post-Reservation, Pre-Dispatch Abort Check
  if (activeSignal.aborted) {
    await releaseAllowance({
      reservationId,
      reason: "client_aborted_pre_dispatch",
      confirmedZeroUsage: true,
      now: nowFn(),
    }, executor);

    throw new CoordinatorAbortError("Operation aborted before dispatch", {
      code: COORDINATOR_ERROR_CODES.ABORTED_PRE_DISPATCH,
      stage: COORDINATOR_LIFECYCLE_STAGES.RESERVED,
      reservationId,
      canRetry: false,
    });
  }

  // 6. Pre-Dispatch Route and Privacy Revalidation
  let currentEndpointState = options.currentEndpointState || null;
  if (!currentEndpointState && decision.pinnedEndpoint?.id) {
    const [row] = await executor
      .select()
      .from(modelEndpoints)
      .where(eq(modelEndpoints.id, decision.pinnedEndpoint.id))
      .limit(1);
    currentEndpointState = row || null;
  }

  const revalidation = revalidateRoutingDecision(decision, currentEndpointState, {
    currentTime: nowFn(),
  });

  if (!revalidation.valid) {
    // Release undispatched hold immediately
    await releaseAllowance({
      reservationId,
      reason: `revalidation_failed: ${revalidation.reason}`,
      confirmedZeroUsage: true,
      now: nowFn(),
    }, executor);

    throw new CoordinatorRevalidationError(revalidation.customerMessage || "Route revalidation failed before dispatch", {
      code: revalidation.reason || COORDINATOR_ERROR_CODES.REVALIDATION_FAILED,
      stage: COORDINATOR_LIFECYCLE_STAGES.REVALIDATED,
      customerMessage: revalidation.customerMessage,
      reservationId,
      canRetry: false,
    });
  }

  // Pre-dispatch repeated endpoint overrun circuit breaker check
  const overrunStatus = checkEndpointOverrunStatus(decision.pinnedEndpoint.id, options.overrunOptions);
  if (overrunStatus.tripped) {
    await releaseAllowance({
      reservationId,
      reason: `endpoint_overrun_circuit_tripped: ${overrunStatus.reason}`,
      confirmedZeroUsage: true,
      now: nowFn(),
    }, executor);

    throw new CoordinatorOverrunCircuitError(
      `Endpoint execution blocked due to repeated limit violations (${overrunStatus.consecutiveOverruns} consecutive overruns)`,
      {
        code: COORDINATOR_ERROR_CODES.ENDPOINT_OVERRUN_CIRCUIT_TRIPPED,
        stage: COORDINATOR_LIFECYCLE_STAGES.REVALIDATED,
        customerMessage: "This model endpoint is temporarily suspended due to repeated limit overruns. Please select another model.",
        reservationId,
        endpointId: decision.pinnedEndpoint.id,
        canRetry: false,
      }
    );
  }

  // Check abort immediately prior to marking dispatch
  if (activeSignal.aborted) {
    await releaseAllowance({
      reservationId,
      reason: "client_aborted_pre_dispatch",
      confirmedZeroUsage: true,
      now: nowFn(),
    }, executor);

    throw new CoordinatorAbortError("Operation aborted before dispatch", {
      code: COORDINATOR_ERROR_CODES.ABORTED_PRE_DISPATCH,
      stage: COORDINATOR_LIFECYCLE_STAGES.REVALIDATED,
      reservationId,
      canRetry: false,
    });
  }

  // 7. Mark Dispatched Boundary (The Crash Gap)
  // CRASH GAP NOTICE:
  // Once markDispatched commits in PostgreSQL, the reservation is in "dispatched" state.
  // If the process crashes or network disconnects before external transport bytes are sent,
  // the database cannot know whether the upstream provider initiated execution.
  // Conservative recovery invariant:
  // - Background sweeper will transition expired leases to "uncertain".
  // - The coordinator strictly forbids automatic redispatch of unknown operations.
  await markDispatched({
    reservationId,
    leaseDurationMs,
    now: nowFn(),
  }, executor);

  // 8. Start Worker Heartbeat Lease Tracking
  let heartbeatTimer = null;
  const startHeartbeat = () => {
    heartbeatTimer = setInterval(async () => {
      try {
        await heartbeatReservation({
          reservationId,
          leaseDurationMs,
          now: nowFn(),
        }, executor);
      } catch {
        // Safe ignore: reservation may be terminal or executor closing
      }
    }, heartbeatIntervalMs);

    if (typeof heartbeatTimer.unref === "function") {
      heartbeatTimer.unref();
    }
    activeHeartbeatTimers.add(heartbeatTimer);
  };

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      activeHeartbeatTimers.delete(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  startHeartbeat();

  // 9. Execute Injected Transport
  // Bounded output limit aligned with authorized reservation hold:
  const authorizedMaxOutputTokens = reservation.cappedOutputTokens ?? maxOutputTokens;

  let transportResult;
  try {
    if (activeSignal.aborted) {
      throw new CoordinatorAbortError("Operation aborted before transport start", {
        code: COORDINATOR_ERROR_CODES.ABORTED_DURING_EXECUTION,
        reservationId,
      });
    }

    const transportContext = {
      endpoint: decision.pinnedEndpoint,
      candidate: decision.selectedCandidate,
      pricing: decision.pinnedPricing,
      prompt,
      messages,
      tools,
      signal: activeSignal,
      maxOutputTokens: authorizedMaxOutputTokens,
      authorizedMaxOutputTokens,
      options,
    };

    if (typeof transport === "function") {
      transportResult = await transport(transportContext);
    } else if (transport && typeof transport.execute === "function") {
      transportResult = await transport.execute(transportContext);
    } else {
      throw new CoordinatorValidationError("Transport must be a function or provide an execute method", {
        code: COORDINATOR_ERROR_CODES.VALIDATION_ERROR,
      });
    }
  } catch (transportErr) {
    stopHeartbeat();

    // Cancellation During Transport Execution
    if (activeSignal.aborted || transportErr.name === "AbortError" || transportErr.code === "client-aborted") {
      const partialUsage = transportErr.usage || transportResult?.usage;
      const hasConfirmedTokens = (
        partialUsage &&
        (Number(partialUsage.prompt_tokens || partialUsage.input_tokens) > 0 ||
         Number(partialUsage.completion_tokens || partialUsage.output_tokens) > 0)
      );

      if (hasConfirmedTokens) {
        // Confirmed partial usage: settle partial tokens
        await settleAllowance({
          reservationId,
          usage: partialUsage,
          promptText: prompt,
          responseText: transportErr.partialText || null,
          modelKey: effectiveModelKey,
          modelIdentifier: decision.selectedCandidate.versionTag,
          provider: decision.pinnedEndpoint.providerName,
          transport: decision.pinnedEndpoint.transportType,
          isPartial: true,
          metadata: { abortReason: "client_aborted_with_partial_usage" },
          now: nowFn(),
        }, executor);
      } else {
        // Unknown usage on abort: retain hold and mark uncertain
        // (Browser disconnect must not automatically establish zero usage)
        await markUncertain({
          reservationId,
          reason: "client_aborted_unknown_usage",
          now: nowFn(),
        }, executor);
      }

      throw new CoordinatorAbortError("Execution aborted by client", {
        code: COORDINATOR_ERROR_CODES.ABORTED_DURING_EXECUTION,
        stage: COORDINATOR_LIFECYCLE_STAGES.EXECUTING,
        reservationId,
        canRetry: false,
      });
    }

    // Transport Execution Failure
    const confirmedZero = transportErr.confirmedZeroUsage === true;
    if (confirmedZero) {
      // Confirmed zero usage: safe to release hold
      await releaseAllowance({
        reservationId,
        reason: `transport_failed_zero_usage: ${transportErr.message || transportErr.code || "unknown"}`,
        confirmedZeroUsage: true,
        now: nowFn(),
      }, executor);
    } else {
      // Unknown upstream execution: mark uncertain to retain hold pending audit
      // Unknown execution is NEVER automatically retried!
      await markUncertain({
        reservationId,
        reason: `transport_error_unknown_usage: ${transportErr.code || transportErr.message || "unknown"}`,
        now: nowFn(),
      }, executor);
    }

    const safeMessage = "Upstream model execution failed";
    throw new CoordinatorExecutionError(safeMessage, {
      code: transportErr.code || COORDINATOR_ERROR_CODES.EXECUTION_FAILED,
      stage: COORDINATOR_LIFECYCLE_STAGES.FAILED,
      customerMessage: safeMessage,
      reservationId,
      canRetry: false,
      confirmedZeroUsage: confirmedZero,
    });
  } finally {
    stopHeartbeat();
  }

  // 10. Settle Normal Completion
  const usage = transportResult?.usage || null;
  const textOutput = transportResult?.text ?? transportResult?.output ?? transportResult?.content ?? "";

  const settledResult = await settleAllowance({
    reservationId,
    usage,
    promptText: prompt,
    responseText: textOutput,
    modelKey: effectiveModelKey,
    modelIdentifier: decision.selectedCandidate.versionTag,
    provider: decision.pinnedEndpoint.providerName,
    transport: decision.pinnedEndpoint.transportType,
    isPartial: false,
    metadata: {
      displayName: decision.selectedCandidate.displayName,
      familyGroup: decision.selectedCandidate.familyGroup,
      consumptionCategory: decision.pinnedPricing.consumptionCategory,
      cachedOutput: textOutput,
      authorizedMaxOutputTokens,
    },
    now: nowFn(),
  }, executor);

  // Record overrun event for repeated endpoint-overrun tracking
  recordEndpointOverrun({
    endpointId: decision.pinnedEndpoint.id,
    modelKey: effectiveModelKey,
    overrunMicros: settledResult.overrunMicros ?? 0,
    outputTokens: settledResult.outputTokens ?? 0,
    authorizedMaxTokens: authorizedMaxOutputTokens,
    now: currentTime,
  });

  return sanitizePublicExecutionResult({
    success: true,
    logicalRequestId,
    model: decision.selectedCandidate.versionTag,
    displayName: decision.selectedCandidate.displayName,
    familyGroup: decision.selectedCandidate.familyGroup,
    consumptionCategory: decision.pinnedPricing.consumptionCategory,
    output: textOutput,
    usage: {
      promptTokens: settledResult.inputTokens ?? usage?.prompt_tokens ?? 0,
      completionTokens: settledResult.outputTokens ?? usage?.completion_tokens ?? 0,
      totalTokens: (settledResult.inputTokens ?? 0) + (settledResult.outputTokens ?? 0),
    },
    settlement: {
      status: settledResult.status,
      settledCostMicros: settledResult.settledCostMicros,
      isPartial: false,
    },
  });
}

