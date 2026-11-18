import { config } from "../config.js";
import {
  evaluateRoutingDecision,
  loadRegistrySnapshot,
  ROUTE_DECISION_REASONS,
} from "./decision.js";
import { getDefaultDb } from "./registry.js";

/**
 * Standardized outcome categories for Milestone 2C runtime shadow evaluation.
 * These distinguish honest compatibility matches, expected evidence gaps,
 * rejections, and true runtime mismatches.
 */
export const ROUTE_OBSERVER_OUTCOMES = Object.freeze({
  MATCHED: "matched",
  EXPECTED_MISSING_MAPPING: "expected_missing_mapping",
  EXPECTED_PENDING_APPROVAL: "expected_pending_approval",
  EXPECTED_UNPRICED: "expected_unpriced",
  CAPABILITY_EVIDENCE_MISSING: "capability_evidence_missing",
  PROPOSED_REJECTION: "proposed_rejection",
  UNEXPECTED_ENDPOINT_MISMATCH: "unexpected_endpoint_mismatch",
  ACTUAL_EXECUTION_UNOBSERVED: "actual_execution_unobserved",
  EVALUATION_FAILED: "evaluation_failed",
  OBSERVATION_SKIPPED: "observation_skipped",
});

// Cache and limit configuration
export const SNAPSHOT_CACHE_TTL_MS = 60_000; // 60 seconds
export const SNAPSHOT_QUERY_TIMEOUT_MS = 1_000; // 1 second
export const MAX_SNAPSHOT_ITEMS = 500;
export const MAX_DIAGNOSTIC_EVENTS = 100;
export const MAX_SEEN_REQUESTS = 1_000;

// Internal cache state
let cachedSnapshot = null;
let cacheExpiresAt = 0;
let inFlightRefresh = null;
let testSnapshotOverride = null;

// Deduplication state for retries and multi-turn tool steps
const seenRequests = new Map();

// Diagnostics ring buffer & metrics
const diagnosticRingBuffer = [];
const aggregateMetrics = {
  [ROUTE_OBSERVER_OUTCOMES.MATCHED]: 0,
  [ROUTE_OBSERVER_OUTCOMES.EXPECTED_MISSING_MAPPING]: 0,
  [ROUTE_OBSERVER_OUTCOMES.EXPECTED_PENDING_APPROVAL]: 0,
  [ROUTE_OBSERVER_OUTCOMES.EXPECTED_UNPRICED]: 0,
  [ROUTE_OBSERVER_OUTCOMES.CAPABILITY_EVIDENCE_MISSING]: 0,
  [ROUTE_OBSERVER_OUTCOMES.PROPOSED_REJECTION]: 0,
  [ROUTE_OBSERVER_OUTCOMES.UNEXPECTED_ENDPOINT_MISMATCH]: 0,
  [ROUTE_OBSERVER_OUTCOMES.ACTUAL_EXECUTION_UNOBSERVED]: 0,
  [ROUTE_OBSERVER_OUTCOMES.EVALUATION_FAILED]: 0,
  [ROUTE_OBSERVER_OUTCOMES.OBSERVATION_SKIPPED]: 0,
};

/**
 * Resets the observer cache, ring buffer, and request deduplication.
 * Strictly used for test teardown and clean restarts.
 */
export function resetRouteObserverState() {
  cachedSnapshot = null;
  cacheExpiresAt = 0;
  inFlightRefresh = null;
  testSnapshotOverride = null;
  seenRequests.clear();
  diagnosticRingBuffer.length = 0;
  for (const key of Object.keys(aggregateMetrics)) {
    aggregateMetrics[key] = 0;
  }
}

/**
 * Sets a synthetic or mock snapshot override for testing without database I/O.
 */
export function setRouteObserverSnapshotForTesting(snapshot) {
  testSnapshotOverride = snapshot ? Object.freeze(snapshot) : null;
}

/**
 * Retrieves the current registry snapshot using bounded caching, concurrency
 * control, and query timeouts.
 */
export async function getOrFetchRegistrySnapshot(
  executor = null,
  {
    forceRefresh = false,
    ttlMs = SNAPSHOT_CACHE_TTL_MS,
    timeoutMs = SNAPSHOT_QUERY_TIMEOUT_MS,
  } = {},
) {
  if (testSnapshotOverride) {
    return testSnapshotOverride;
  }

  const now = Date.now();
  if (!forceRefresh && cachedSnapshot && now < cacheExpiresAt) {
    return cachedSnapshot;
  }

  if (inFlightRefresh) {
    return await inFlightRefresh;
  }

  inFlightRefresh = (async () => {
    try {
      const db = executor || (await getDefaultDb());
      if (!db) return cachedSnapshot || null;

      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("snapshot_query_timeout"));
        }, timeoutMs);
      });

      const snapshotPromise = loadRegistrySnapshot(db);
      const snapshot = await Promise.race([snapshotPromise, timeoutPromise]);
      clearTimeout(timeoutId);

      if (Array.isArray(snapshot)) {
        if (snapshot.length > MAX_SNAPSHOT_ITEMS) {
          cachedSnapshot = snapshot.slice(0, MAX_SNAPSHOT_ITEMS);
        } else {
          cachedSnapshot = snapshot;
        }
        cacheExpiresAt = Date.now() + ttlMs;
      }
      return cachedSnapshot;
    } catch {
      // On query failure or timeout, gracefully degrade to stale cache if present
      if (cachedSnapshot && cachedSnapshot.length > 0) {
        return cachedSnapshot;
      }
      return null;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return await inFlightRefresh;
}

/**
 * Records a bounded diagnostic event into the circular buffer and increments metrics.
 * Strictly filters fields to internal non-sensitive diagnostics.
 */
function recordDiagnosticEvent({
  requestId = "unknown",
  requestedTier = "unknown",
  actualStage = null,
  snapshotVersion = null,
  policyVersion = "decision_policy_2026_10",
  outcome = ROUTE_OBSERVER_OUTCOMES.OBSERVATION_SKIPPED,
  reasonCode = "none",
  observerDurationMs = 0,
  failureCategory = null,
  attemptsCount = 1,
} = {}) {
  const sanitized = Object.freeze({
    requestId: String(requestId).slice(0, 100),
    requestedTier: String(requestedTier).slice(0, 50),
    actualStage: actualStage ? String(actualStage).slice(0, 50) : null,
    snapshotVersion: snapshotVersion ? String(snapshotVersion).slice(0, 50) : null,
    policyVersion: String(policyVersion).slice(0, 50),
    outcome,
    reasonCode: String(reasonCode).slice(0, 60),
    observerDurationMs: Math.max(0, Number(observerDurationMs) || 0),
    failureCategory: failureCategory ? String(failureCategory).slice(0, 50) : null,
    attemptsCount: Math.max(1, Number(attemptsCount) || 1),
    observedAt: new Date().toISOString(),
  });

  if (diagnosticRingBuffer.length >= MAX_DIAGNOSTIC_EVENTS) {
    diagnosticRingBuffer.shift();
  }
  diagnosticRingBuffer.push(sanitized);

  if (Object.prototype.hasOwnProperty.call(aggregateMetrics, outcome)) {
    aggregateMetrics[outcome] += 1;
  }

  return sanitized;
}

/**
 * Returns recent sampled diagnostics from the bounded ring buffer.
 */
export function getRouteObserverDiagnostics() {
  return [...diagnosticRingBuffer];
}

/**
 * Returns aggregate observation counts by outcome category.
 */
export function getRouteObserverMetrics() {
  return { ...aggregateMetrics };
}

/**
 * Tracks request execution and handles retries or tool turns without emitting
 * duplicate comparison events.
 */
function trackRequestExecution(requestId, actualExecution) {
  if (!requestId || requestId === "unknown") {
    return { isDuplicate: false, attemptsCount: actualExecution?.attemptNumber || 1 };
  }

  const existing = seenRequests.get(requestId);
  if (existing) {
    existing.attempts = Math.max(existing.attempts, actualExecution?.attemptNumber || 1);
    existing.turnCount += 1;
    if (actualExecution?.actualStage) {
      existing.latestStage = actualExecution.actualStage;
    }
    return { isDuplicate: true, attemptsCount: existing.attempts, turnCount: existing.turnCount };
  }

  if (seenRequests.size >= MAX_SEEN_REQUESTS) {
    const oldestKey = seenRequests.keys().next().value;
    seenRequests.delete(oldestKey);
  }

  seenRequests.set(requestId, {
    attempts: actualExecution?.attemptNumber || 1,
    turnCount: 1,
    initialStage: actualExecution?.actualStage || null,
  });

  return { isDuplicate: false, attemptsCount: actualExecution?.attemptNumber || 1, turnCount: 1 };
}

/**
 * Compares a proposed registry decision against actual provider execution.
 */
export function compareProposedWithActual(
  proposedDecision,
  actualExecution,
  requestedTier,
) {
  if (!proposedDecision || !proposedDecision.eligible) {
    const reason = proposedDecision?.reasonCode || "unknown_rejection";

    if (reason === ROUTE_DECISION_REASONS.MODEL_NOT_FOUND) {
      return {
        outcome: ROUTE_OBSERVER_OUTCOMES.EXPECTED_MISSING_MAPPING,
        reasonCode: reason,
      };
    }
    if (
      reason === ROUTE_DECISION_REASONS.PRIVACY_NOT_APPROVED ||
      reason === ROUTE_DECISION_REASONS.PRIVACY_APPROVAL_EXPIRED ||
      reason === ROUTE_DECISION_REASONS.PRIVACY_APPROVAL_REVOKED
    ) {
      return {
        outcome: ROUTE_OBSERVER_OUTCOMES.EXPECTED_PENDING_APPROVAL,
        reasonCode: reason,
      };
    }
    if (
      reason === ROUTE_DECISION_REASONS.PRICING_SNAPSHOT_MISSING ||
      reason === ROUTE_DECISION_REASONS.PRICING_SNAPSHOT_EXPIRED ||
      reason === ROUTE_DECISION_REASONS.CONSUMPTION_CLASSIFICATION_PENDING
    ) {
      return {
        outcome: ROUTE_OBSERVER_OUTCOMES.EXPECTED_UNPRICED,
        reasonCode: reason,
      };
    }
    if (
      reason === ROUTE_DECISION_REASONS.CAPABILITY_VISION_UNSUPPORTED ||
      reason === ROUTE_DECISION_REASONS.CAPABILITY_TOOLS_UNSUPPORTED ||
      reason === ROUTE_DECISION_REASONS.CAPABILITY_STREAMING_UNSUPPORTED
    ) {
      return {
        outcome: ROUTE_OBSERVER_OUTCOMES.CAPABILITY_EVIDENCE_MISSING,
        reasonCode: reason,
      };
    }

    return {
      outcome: ROUTE_OBSERVER_OUTCOMES.PROPOSED_REJECTION,
      reasonCode: reason,
    };
  }

  // Proposed decision was eligible
  if (!actualExecution || !actualExecution.actualStage || actualExecution.actualStage === "unobserved") {
    return {
      outcome: ROUTE_OBSERVER_OUTCOMES.ACTUAL_EXECUTION_UNOBSERVED,
      reasonCode: "actual_execution_not_captured",
    };
  }

  const proposedEndpoint = proposedDecision.pinnedEndpoint;
  const proposedVersion = proposedDecision.selectedCandidate;
  const actualStage = actualExecution.actualStage;
  const actualTransport = actualExecution.actualTransport;
  const actualModel = actualExecution.actualModel;

  // Transport isolation check (e.g. Vulcan direct must not cross to router)
  if (proposedEndpoint.transportType && actualTransport && proposedEndpoint.transportType !== actualTransport) {
    return {
      outcome: ROUTE_OBSERVER_OUTCOMES.UNEXPECTED_ENDPOINT_MISMATCH,
      reasonCode: "transport_mismatch",
    };
  }

  // Stage & endpoint matching
  const stageMatches =
    proposedEndpoint.providerName === actualStage ||
    (actualStage === "primaryFree" && proposedEndpoint.providerName === "primaryFree") ||
    (actualStage === "paid" && (proposedEndpoint.transportType === "router" || proposedEndpoint.providerName === "paid")) ||
    (actualStage === "vesperDirect" && proposedEndpoint.transportType === "direct");

  const modelMatches =
    !actualModel ||
    proposedVersion.versionTag === actualModel ||
    (actualModel.includes("gpt-6.1-terra") && proposedVersion.versionTag.includes("vesper")) ||
    (actualModel.includes("deepseek") && proposedVersion.versionTag.includes("nova")) ||
    (actualModel.includes("kimi") && proposedVersion.versionTag.includes("nebula")) ||
    (actualModel.includes("luna") && proposedVersion.versionTag.includes("study"));

  if (stageMatches || modelMatches) {
    return {
      outcome: ROUTE_OBSERVER_OUTCOMES.MATCHED,
      reasonCode: "compatible_execution",
    };
  }

  return {
    outcome: ROUTE_OBSERVER_OUTCOMES.UNEXPECTED_ENDPOINT_MISMATCH,
    reasonCode: "endpoint_divergence",
  };
}

/**
 * Main observation entry point.
 * Evaluates proposed registry decision against actual provider execution metadata.
 *
 * SAFETY CONTRACT:
 * - When FEATURE_REGISTRY_ROUTE_SHADOW is false: does nothing, zero I/O, zero background work.
 * - Never throws, rejects, or delays provider dispatch.
 * - Never modifies balances, approvals, or routing paths.
 * - Never receives prompt text, customer content, credentials, or user location.
 */
export async function observeRoutingDecision({
  requestId = "unknown",
  userPlan = "free",
  requestedTier = "lumen",
  modalities = {},
  reasoningEffort = null,
  tokenEstimation = {},
  privacy = {},
  transportPreference = null,
  actualExecution = null,
  taskClass = null,
  executor = null,
  now = new Date(),
  force = false,
} = {}) {
  // 1. Feature Flag Gate: Disabled by default
  const isEnabled = force || Boolean(config.featureRegistryRouteShadow);
  if (!isEnabled) {
    return Object.freeze({
      observed: false,
      outcome: ROUTE_OBSERVER_OUTCOMES.OBSERVATION_SKIPPED,
      reasonCode: "feature_flag_disabled",
    });
  }

  const startTime = Date.now();

  try {
    // 2. Request Attribution and Deduplication (retries & multi-turn tool steps)
    const { isDuplicate, attemptsCount } = trackRequestExecution(requestId, actualExecution);
    if (isDuplicate) {
      // Attribute retry or follow-up tool turn without duplicate comparison events
      return Object.freeze({
        observed: true,
        attributedTurn: true,
        attemptsCount,
        outcome: ROUTE_OBSERVER_OUTCOMES.MATCHED,
        reasonCode: "turn_attributed",
      });
    }

    // 3. Bounded Read-Only Snapshot Resolution
    const snapshot = await getOrFetchRegistrySnapshot(executor);
    if (!snapshot || snapshot.length === 0) {
      const skippedRecord = recordDiagnosticEvent({
        requestId,
        requestedTier,
        actualStage: actualExecution?.actualStage ?? null,
        outcome: ROUTE_OBSERVER_OUTCOMES.OBSERVATION_SKIPPED,
        reasonCode: "snapshot_unavailable",
        observerDurationMs: Date.now() - startTime,
        failureCategory: "snapshot_unavailable",
        attemptsCount,
      });
      return Object.freeze({
        observed: false,
        outcome: ROUTE_OBSERVER_OUTCOMES.OBSERVATION_SKIPPED,
        reasonCode: "snapshot_unavailable",
        diagnostics: skippedRecord,
      });
    }

    // 4. Pure Decision Evaluation
    let proposedDecision;
    try {
      proposedDecision = await evaluateRoutingDecision(
        {
          plan: userPlan,
          requestedModel: { modelKey: requestedTier },
          modalities,
          reasoning: { effort: reasoningEffort },
          context: {
            ...tokenEstimation,
            confidence: tokenEstimation.confidence || "heuristic",
          },
          privacy,
          transportPreference,
        },
        {
          registrySnapshot: snapshot,
          evaluatedAt: now.toISOString(),
        },
      );
    } catch {
      const evalFailRecord = recordDiagnosticEvent({
        requestId,
        requestedTier,
        actualStage: actualExecution?.actualStage ?? null,
        outcome: ROUTE_OBSERVER_OUTCOMES.EVALUATION_FAILED,
        reasonCode: "decision_evaluation_exception",
        observerDurationMs: Date.now() - startTime,
        failureCategory: "eval_exception",
        attemptsCount,
      });
      return Object.freeze({
        observed: false,
        outcome: ROUTE_OBSERVER_OUTCOMES.EVALUATION_FAILED,
        reasonCode: "decision_evaluation_exception",
        diagnostics: evalFailRecord,
      });
    }

    // 5. Native Compatibility Comparison
    const comparison = compareProposedWithActual(proposedDecision, actualExecution, requestedTier);

    // 6. Separate Auto Recommendation (for advisory telemetry; does not fail native comparison)
    let autoRecommendation = null;
    if (taskClass) {
      try {
        const autoDecision = await evaluateRoutingDecision(
          {
            plan: userPlan,
            requestedModel: { auto: true, task: { classification: taskClass } },
            modalities,
            reasoning: { effort: reasoningEffort },
            context: tokenEstimation,
            privacy,
          },
          {
            registrySnapshot: snapshot,
            evaluatedAt: now.toISOString(),
          },
        );
        if (autoDecision?.eligible) {
          autoRecommendation = {
            recommendedModel: autoDecision.selectedCandidate?.versionTag,
            consumptionScoreMu: autoDecision.pinnedPricing?.calculatedMu,
            eligible: true,
          };
        }
      } catch {
        // Auto advisory failure must never impact native observation
        autoRecommendation = null;
      }
    }

    const durationMs = Date.now() - startTime;
    const diagRecord = recordDiagnosticEvent({
      requestId,
      requestedTier,
      actualStage: actualExecution?.actualStage ?? null,
      snapshotVersion: proposedDecision.decisionPolicyVersion,
      outcome: comparison.outcome,
      reasonCode: comparison.reasonCode,
      observerDurationMs: durationMs,
      attemptsCount,
    });

    return Object.freeze({
      observed: true,
      requestId,
      requestedTier,
      outcome: comparison.outcome,
      reasonCode: comparison.reasonCode,
      proposedEligible: proposedDecision.eligible,
      actualStage: actualExecution?.actualStage ?? null,
      autoRecommendation,
      durationMs,
      diagnostics: diagRecord,
    });
  } catch {
    // Fail closed safely: observer errors never bubble to the caller
    const errRecord = recordDiagnosticEvent({
      requestId,
      requestedTier,
      actualStage: actualExecution?.actualStage ?? null,
      outcome: ROUTE_OBSERVER_OUTCOMES.EVALUATION_FAILED,
      reasonCode: "unexpected_observer_failure",
      observerDurationMs: Date.now() - startTime,
      failureCategory: "fatal_observer_exception",
    });
    return Object.freeze({
      observed: false,
      outcome: ROUTE_OBSERVER_OUTCOMES.EVALUATION_FAILED,
      reasonCode: "unexpected_observer_failure",
      diagnostics: errRecord,
    });
  }
}

