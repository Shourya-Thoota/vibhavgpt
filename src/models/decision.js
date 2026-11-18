import { eq, and, sql, desc } from "drizzle-orm";
import { modelFamilies, modelVersions, modelEndpoints, modelPricingSnapshots } from "../db/schema.js";
import { getDefaultDb, LIFECYCLE_STATES, PLAN_ELIGIBILITY } from "./registry.js";
import { CONSUMPTION_CATEGORIES } from "./consumption.js";
import { isFreeIncludedFamily } from "./free-included.js";

/**
 * Standardized safe decision reason codes for Milestone 2B.
 */
export const ROUTE_DECISION_REASONS = Object.freeze({
  ELIGIBLE: "eligible",
  PLAN_NOT_ELIGIBLE: "plan_not_eligible",
  PLUS_EXCLUDED_EXTRA_HIGH: "plus_excluded_extra_high",
  CAPABILITY_VISION_UNSUPPORTED: "capability_vision_unsupported",
  CAPABILITY_TOOLS_UNSUPPORTED: "capability_tools_unsupported",
  CAPABILITY_STREAMING_UNSUPPORTED: "capability_streaming_unsupported",
  CAPABILITY_STRUCTURED_OUTPUTS_UNSUPPORTED: "capability_structured_outputs_unsupported",
  CONTEXT_WINDOW_EXCEEDED: "context_window_exceeded",
  MAX_OUTPUT_TOKENS_EXCEEDED: "max_output_tokens_exceeded",
  REASONING_NOT_SUPPORTED: "reasoning_not_supported",
  REASONING_MODE_UNSUPPORTED: "reasoning_mode_unsupported",
  PRIVACY_NOT_APPROVED: "privacy_not_approved",
  PRIVACY_SCOPE_MISMATCH: "privacy_scope_mismatch",
  PRIVACY_APPROVAL_EXPIRED: "privacy_approval_expired",
  PRIVACY_APPROVAL_REVOKED: "privacy_approval_revoked",
  ZERO_RETENTION_REQUIRED_UNMET: "zero_retention_required_unmet",
  TRAINING_EXCLUSION_REQUIRED_UNMET: "training_exclusion_required_unmet",
  ENDPOINT_NOT_ACTIVE: "endpoint_not_active",
  VERSION_NOT_ACTIVE: "version_not_active",
  MODEL_NOT_FOUND: "model_not_found",
  NO_ELIGIBLE_ENDPOINTS: "no_eligible_endpoints",
  PRICING_SNAPSHOT_MISSING: "pricing_snapshot_missing",
  PRICING_SNAPSHOT_EXPIRED: "pricing_snapshot_expired",
  CONSUMPTION_CLASSIFICATION_PENDING: "consumption_classification_pending",
  TRANSPORT_MISMATCH: "transport_mismatch",
  NO_MATCHING_CANDIDATE: "no_matching_candidate",
  REGISTRY_EMPTY: "registry_empty",
});

/**
 * Customer-safe explanation dictionary.
 * Does not expose internal vendor identities, wholesale margins, or infrastructure endpoints.
 */
export const CUSTOMER_SAFE_REJECTIONS = Object.freeze({
  [ROUTE_DECISION_REASONS.PLAN_NOT_ELIGIBLE]: "This model is not available on your current plan. Please upgrade your plan to access it.",
  [ROUTE_DECISION_REASONS.PLUS_EXCLUDED_EXTRA_HIGH]: "This model is in the Extra High consumption tier, which is restricted to Pro members.",
  [ROUTE_DECISION_REASONS.CAPABILITY_VISION_UNSUPPORTED]: "The selected model does not support image analysis.",
  [ROUTE_DECISION_REASONS.CAPABILITY_TOOLS_UNSUPPORTED]: "The selected model does not support tool calling or web access.",
  [ROUTE_DECISION_REASONS.CAPABILITY_STREAMING_UNSUPPORTED]: "The selected model does not support real-time streaming.",
  [ROUTE_DECISION_REASONS.CAPABILITY_STRUCTURED_OUTPUTS_UNSUPPORTED]: "The selected model does not support structured JSON outputs.",
  [ROUTE_DECISION_REASONS.CONTEXT_WINDOW_EXCEEDED]: "The conversation exceeds the model's supported context limit.",
  [ROUTE_DECISION_REASONS.MAX_OUTPUT_TOKENS_EXCEEDED]: "The requested output token count exceeds the model's capacity.",
  [ROUTE_DECISION_REASONS.REASONING_NOT_SUPPORTED]: "Reasoning/thinking effort is not supported by this model.",
  [ROUTE_DECISION_REASONS.REASONING_MODE_UNSUPPORTED]: "The requested reasoning effort level is not supported by this model.",
  [ROUTE_DECISION_REASONS.PRIVACY_NOT_APPROVED]: "This model is currently unavailable pending privacy and compliance review.",
  [ROUTE_DECISION_REASONS.PRIVACY_SCOPE_MISMATCH]: "This model is not approved for your required workspace data scope.",
  [ROUTE_DECISION_REASONS.PRIVACY_APPROVAL_EXPIRED]: "This model's privacy compliance certification has expired and is undergoing re-review.",
  [ROUTE_DECISION_REASONS.PRIVACY_APPROVAL_REVOKED]: "This model has been temporarily disabled due to a privacy policy update.",
  [ROUTE_DECISION_REASONS.ZERO_RETENTION_REQUIRED_UNMET]: "Zero data retention is required for this request, but this model endpoint does not guarantee zero retention.",
  [ROUTE_DECISION_REASONS.TRAINING_EXCLUSION_REQUIRED_UNMET]: "Your policy requires training data exclusion, which this endpoint does not satisfy.",
  [ROUTE_DECISION_REASONS.ENDPOINT_NOT_ACTIVE]: "This model endpoint is currently unavailable.",
  [ROUTE_DECISION_REASONS.VERSION_NOT_ACTIVE]: "The requested model version is currently inactive.",
  [ROUTE_DECISION_REASONS.MODEL_NOT_FOUND]: "The requested model was not found in the catalog.",
  [ROUTE_DECISION_REASONS.NO_ELIGIBLE_ENDPOINTS]: "No active and compliant endpoints are currently available for this model.",
  [ROUTE_DECISION_REASONS.PRICING_SNAPSHOT_MISSING]: "Pricing information for this model is pending.",
  [ROUTE_DECISION_REASONS.PRICING_SNAPSHOT_EXPIRED]: "Pricing schedule for this model has expired.",
  [ROUTE_DECISION_REASONS.CONSUMPTION_CLASSIFICATION_PENDING]: "This model's rate classification is pending and requires review before plan unlock.",
  [ROUTE_DECISION_REASONS.TRANSPORT_MISMATCH]: "The requested transport is not available for this model.",
  [ROUTE_DECISION_REASONS.NO_MATCHING_CANDIDATE]: "No model in the catalog matches the required task criteria.",
  [ROUTE_DECISION_REASONS.REGISTRY_EMPTY]: "No models are currently registered.",
});

/**
 * Deep freezes an object recursively to guarantee snapshot immutability.
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  for (const prop of Object.getOwnPropertyNames(obj)) {
    if (obj[prop] !== null && typeof obj[prop] === "object") {
      deepFreeze(obj[prop]);
    }
  }
  return Object.freeze(obj);
}

/**
 * Loads an immutable registry snapshot from the database for pure routing evaluations.
 */
export async function loadRegistrySnapshot(executor = null) {
  const db = executor || (await getDefaultDb());
  const families = await db.select().from(modelFamilies);
  if (!families.length) return [];

  const versions = await db.select().from(modelVersions);
  const endpoints = await db.select().from(modelEndpoints);
  const pricingSnapshots = await db.select().from(modelPricingSnapshots);

  const snapshot = [];

  for (const fam of families) {
    const famVersions = versions.filter((v) => v.familyId === fam.id);
    for (const ver of famVersions) {
      const verEndpoints = endpoints.filter((e) => e.versionId === ver.id);
      const builtEndpoints = [];

      for (const ep of verEndpoints) {
        const epPricings = pricingSnapshots
          .filter((p) => p.endpointId === ep.id)
          .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom));

        builtEndpoints.push({
          ...ep,
          pricingSnapshots: epPricings,
        });
      }

      snapshot.push({
        family: { ...fam },
        version: { ...ver },
        endpoints: builtEndpoints,
      });
    }
  }

  return deepFreeze(snapshot);
}

/**
 * Finds the pricing snapshot effective at a specific evaluation timestamp.
 */
function getActivePricingSnapshot(endpoint, evaluatedAt) {
  const snapshots = endpoint.pricingSnapshots || (endpoint.pricing ? [endpoint.pricing] : []);
  if (!snapshots.length) return null;

  const target = new Date(evaluatedAt).getTime();
  return (
    snapshots.find((snap) => {
      const from = new Date(snap.effectiveFrom).getTime();
      const to = snap.effectiveTo ? new Date(snap.effectiveTo).getTime() : Infinity;
      return target >= from && target < to;
    }) || null
  );
}

/**
 * Evaluates whether a requested model or task is eligible for routing under
 * strict plan, capability, context, reasoning, transport, and privacy rules.
 *
 * This function is a PURE DECISION SERVICE:
 * - Does not call model providers
 * - Does not modify database balances or records
 * - Does not read ambient mutable state
 * - Never silently substitutes an explicit selection
 */
export async function evaluateRoutingDecision(
  request = {},
  options = {},
) {
  const evaluatedAt = options.evaluatedAt
    ? new Date(options.evaluatedAt).toISOString()
    : new Date().toISOString();
  const targetTime = new Date(evaluatedAt).getTime();
  const decisionPolicyVersion = options.decisionPolicyVersion || "decision_policy_2026_10";

  // 1. Resolve registry snapshot
  let snapshot = options.registrySnapshot;
  if (!snapshot && options.db) {
    snapshot = await loadRegistrySnapshot(options.db);
  } else if (!snapshot) {
    snapshot = [];
  }

  if (!snapshot || snapshot.length === 0) {
    return deepFreeze({
      decisionId: crypto.randomUUID(),
      eligible: false,
      evaluatedAt,
      decisionPolicyVersion,
      reasonCode: ROUTE_DECISION_REASONS.REGISTRY_EMPTY,
      customerMessage: CUSTOMER_SAFE_REJECTIONS[ROUTE_DECISION_REASONS.REGISTRY_EMPTY],
    });
  }

  const userPlan = (request.plan || "free").toLowerCase();
  const requestedModel = request.requestedModel || {};
  const isAuto = Boolean(requestedModel.auto || request.auto);
  const modalities = request.modalities || {};
  const reasoning = request.reasoning || {};
  const context = request.context || {};
  const privacy = request.privacy || {};
  const budget = request.budget || {};

  // 2. Resolve Candidate Set
  let candidates = [];

  if (isAuto) {
    // Auto Mode: evaluate all registered models
    candidates = [...snapshot];
  } else {
    // Explicit Mode: match exact family slug, version tag, model key, or alias
    const modelKey = (requestedModel.modelKey || requestedModel.tier || "").toLowerCase();
    const familySlug = (requestedModel.familySlug || "").toLowerCase();
    const versionTag = requestedModel.versionTag || requestedModel.modelId || "";

    const matched = snapshot.filter((item) => {
      const slug = item.family.slug.toLowerCase();
      const vTag = item.version.versionTag;
      const aliases = (item.version.aliases || []).map((a) => String(a).toLowerCase());

      if (familySlug && versionTag) {
        return slug === familySlug && vTag === versionTag;
      }
      if (familySlug) {
        return slug === familySlug;
      }
      if (versionTag) {
        return vTag === versionTag || aliases.includes(versionTag.toLowerCase());
      }
      if (modelKey) {
        return (
          slug === `vibhavgpt/${modelKey}` ||
          slug.endsWith(`/${modelKey}`) ||
          vTag.toLowerCase().includes(modelKey) ||
          aliases.includes(modelKey)
        );
      }
      return false;
    });

    if (!matched.length) {
      return deepFreeze({
        decisionId: crypto.randomUUID(),
        eligible: false,
        evaluatedAt,
        decisionPolicyVersion,
        userPlan,
        requestedModel,
        reasonCode: ROUTE_DECISION_REASONS.MODEL_NOT_FOUND,
        customerMessage: CUSTOMER_SAFE_REJECTIONS[ROUTE_DECISION_REASONS.MODEL_NOT_FOUND],
      });
    }

    candidates = matched;
  }

  // 3. Evaluate each candidate against version-level & endpoint-level gates
  const evaluatedCandidates = [];

  for (const cand of candidates) {
    const { family, version, endpoints } = cand;

    // Gate: Version Lifecycle State (must be active)
    if (version.lifecycleState !== LIFECYCLE_STATES.ACTIVE) {
      evaluatedCandidates.push({
        candidate: cand,
        eligible: false,
        reasonCode: ROUTE_DECISION_REASONS.VERSION_NOT_ACTIVE,
      });
      continue;
    }

    // Gate: Plan Level
    const planOrder = { free: 1, plus: 2, pro: 3, max: 4, custom: 4 };
    const userRank = planOrder[userPlan] || 1;

    if (version.planEligibility === PLAN_ELIGIBILITY.PRO_ONLY && userRank < 3) {
      evaluatedCandidates.push({
        candidate: cand,
        eligible: false,
        reasonCode: ROUTE_DECISION_REASONS.PLAN_NOT_ELIGIBLE,
      });
      continue;
    }
    if (version.planEligibility === PLAN_ELIGIBILITY.PAID && userRank < 2 && !isFreeIncludedFamily(family)) {
      // Cheap models are NOT automatically available to Free users
      evaluatedCandidates.push({
        candidate: cand,
        eligible: false,
        reasonCode: ROUTE_DECISION_REASONS.PLAN_NOT_ELIGIBLE,
      });
      continue;
    }

    // Gate: Context Limits
    const capDoc = version.capabilitiesDocumented || {};
    if (
      context.totalRequiredContextTokens &&
      capDoc.contextWindowTokens &&
      context.totalRequiredContextTokens > capDoc.contextWindowTokens
    ) {
      evaluatedCandidates.push({
        candidate: cand,
        eligible: false,
        reasonCode: ROUTE_DECISION_REASONS.CONTEXT_WINDOW_EXCEEDED,
      });
      continue;
    }
    if (
      context.maxOutputTokens &&
      capDoc.maxOutputTokens &&
      context.maxOutputTokens > capDoc.maxOutputTokens
    ) {
      evaluatedCandidates.push({
        candidate: cand,
        eligible: false,
        reasonCode: ROUTE_DECISION_REASONS.MAX_OUTPUT_TOKENS_EXCEEDED,
      });
      continue;
    }

    // Gate: Reasoning Compatibility
    const requestedEffort = reasoning.effort && reasoning.effort !== "none" ? reasoning.effort : null;
    if (requestedEffort) {
      if (!capDoc.reasoningSupported) {
        evaluatedCandidates.push({
          candidate: cand,
          eligible: false,
          reasonCode: ROUTE_DECISION_REASONS.REASONING_NOT_SUPPORTED,
        });
        continue;
      }
      if (Array.isArray(capDoc.reasoningModes) && capDoc.reasoningModes.length > 0) {
        if (!capDoc.reasoningModes.includes(requestedEffort)) {
          evaluatedCandidates.push({
            candidate: cand,
            eligible: false,
            reasonCode: ROUTE_DECISION_REASONS.REASONING_MODE_UNSUPPORTED,
          });
          continue;
        }
      }
    }

    // Gate: Structured Outputs
    if (modalities.structuredOutputs && capDoc.structuredOutputs === false) {
      evaluatedCandidates.push({
        candidate: cand,
        eligible: false,
        reasonCode: ROUTE_DECISION_REASONS.CAPABILITY_STRUCTURED_OUTPUTS_UNSUPPORTED,
      });
      continue;
    }

    // Gate: Endpoints Evaluation
    const isVesper = family.slug === "vibhavgpt/vesper";
    const transportPref = request.transportPreference || (isVesper ? "direct" : null);

    let candidateEndpoints = endpoints;
    if (transportPref) {
      candidateEndpoints = endpoints.filter((ep) => ep.transportType === transportPref);
      if (!candidateEndpoints.length) {
        evaluatedCandidates.push({
          candidate: cand,
          eligible: false,
          reasonCode: ROUTE_DECISION_REASONS.TRANSPORT_MISMATCH,
        });
        continue;
      }
    }

    const viableEndpoints = [];
    let lastEndpointFailure = ROUTE_DECISION_REASONS.NO_ELIGIBLE_ENDPOINTS;

    for (const ep of candidateEndpoints) {
      // Endpoint state must be active
      if (ep.endpointState !== LIFECYCLE_STATES.ACTIVE) {
        lastEndpointFailure = ROUTE_DECISION_REASONS.ENDPOINT_NOT_ACTIVE;
        continue;
      }

      // Verified capabilities (marketing claims vs endpoint verified reality)
      const capVer = ep.capabilitiesVerified || {};
      if (modalities.vision && capVer.vision !== true) {
        lastEndpointFailure = ROUTE_DECISION_REASONS.CAPABILITY_VISION_UNSUPPORTED;
        continue;
      }
      if (modalities.tools && capVer.tools !== true) {
        lastEndpointFailure = ROUTE_DECISION_REASONS.CAPABILITY_TOOLS_UNSUPPORTED;
        continue;
      }
      if (modalities.streaming && capVer.streaming === false) {
        lastEndpointFailure = ROUTE_DECISION_REASONS.CAPABILITY_STREAMING_UNSUPPORTED;
        continue;
      }

      // Privacy Review Gating
      const priv = ep.privacyReview || {};
      if (priv.privacyApproved !== true) {
        lastEndpointFailure = ROUTE_DECISION_REASONS.PRIVACY_NOT_APPROVED;
        continue;
      }
      if (priv.revoked === true || (priv.revokedAt && targetTime >= new Date(priv.revokedAt).getTime())) {
        lastEndpointFailure = ROUTE_DECISION_REASONS.PRIVACY_APPROVAL_REVOKED;
        continue;
      }
      if (priv.expiresAt && targetTime > new Date(priv.expiresAt).getTime()) {
        lastEndpointFailure = ROUTE_DECISION_REASONS.PRIVACY_APPROVAL_EXPIRED;
        continue;
      }
      if (privacy.requiredScope && priv.scope && priv.scope !== privacy.requiredScope) {
        lastEndpointFailure = ROUTE_DECISION_REASONS.PRIVACY_SCOPE_MISMATCH;
        continue;
      }
      if (privacy.zeroDataRetentionRequired && priv.zeroDataRetention !== true) {
        lastEndpointFailure = ROUTE_DECISION_REASONS.ZERO_RETENTION_REQUIRED_UNMET;
        continue;
      }
      if (
        privacy.trainingExcludedRequired &&
        priv.trainingPolicy !== "denied" &&
        priv.trainingPolicy !== "training_excluded"
      ) {
        lastEndpointFailure = ROUTE_DECISION_REASONS.TRAINING_EXCLUSION_REQUIRED_UNMET;
        continue;
      }

      // Pricing Snapshot Gating
      const pricingSnap = getActivePricingSnapshot(ep, evaluatedAt);
      if (!pricingSnap) {
        lastEndpointFailure = ROUTE_DECISION_REASONS.PRICING_SNAPSHOT_MISSING;
        continue;
      }

      // Consumption category evaluation
      const cat = pricingSnap.consumptionCategory;

      // Plus user exclusion from Extra High models
      if (userPlan === "plus") {
        if (cat === CONSUMPTION_CATEGORIES.EXTRA_HIGH || (pricingSnap.calculatedMu && pricingSnap.calculatedMu > 7.0)) {
          lastEndpointFailure = ROUTE_DECISION_REASONS.PLUS_EXCLUDED_EXTRA_HIGH;
          continue;
        }
        if (cat === CONSUMPTION_CATEGORIES.PENDING || cat === "pending") {
          lastEndpointFailure = ROUTE_DECISION_REASONS.CONSUMPTION_CLASSIFICATION_PENDING;
          continue;
        }
      }

      viableEndpoints.push({
        endpoint: ep,
        pricing: pricingSnap,
      });
    }

    if (!viableEndpoints.length) {
      evaluatedCandidates.push({
        candidate: cand,
        eligible: false,
        reasonCode: lastEndpointFailure,
      });
      continue;
    }

    // Sort viable endpoints by sortPriority ascending
    viableEndpoints.sort((a, b) => (a.endpoint.sortPriority || 10) - (b.endpoint.sortPriority || 10));

    evaluatedCandidates.push({
      candidate: cand,
      eligible: true,
      selectedEndpoint: viableEndpoints[0].endpoint,
      selectedPricing: viableEndpoints[0].pricing,
    });
  }

  // 4. Select Candidate
  const eligibleMatches = evaluatedCandidates.filter((item) => item.eligible);

  if (!eligibleMatches.length) {
    // If explicit selection, return that candidate's specific failure code
    const failureCode = evaluatedCandidates[0]?.reasonCode || ROUTE_DECISION_REASONS.NO_MATCHING_CANDIDATE;
    return deepFreeze({
      decisionId: crypto.randomUUID(),
      eligible: false,
      evaluatedAt,
      decisionPolicyVersion,
      userPlan,
      requestedModel,
      reasonCode: failureCode,
      customerMessage: CUSTOMER_SAFE_REJECTIONS[failureCode] || CUSTOMER_SAFE_REJECTIONS[ROUTE_DECISION_REASONS.NO_MATCHING_CANDIDATE],
    });
  }

  let chosenMatch;
  let tieBreakerUsed = null;

  if (isAuto) {
    // Deterministic Auto Selection
    const taskClass = (requestedModel.task?.classification || "general").toLowerCase();

    eligibleMatches.sort((a, b) => {
      const muA = a.selectedPricing.calculatedMu ?? 999;
      const muB = b.selectedPricing.calculatedMu ?? 999;
      const catA = a.selectedPricing.consumptionCategory;
      const catB = b.selectedPricing.consumptionCategory;

      // 1. Task classification preference
      if (taskClass === "lightweight") {
        const score = (cat) => (cat === "low" ? 1 : cat === "medium" ? 2 : 3);
        if (score(catA) !== score(catB)) return score(catA) - score(catB);
      } else if (taskClass === "reasoning" || taskClass === "stem" || taskClass === "coding") {
        const score = (cat) => (cat === "extra_high" ? 1 : cat === "high" ? 2 : cat === "medium" ? 3 : 4);
        if (score(catA) !== score(catB)) return score(catA) - score(catB);
      }

      // 2. Lower consumption score mu
      if (Math.abs(muA - muB) > 0.0001) {
        return muA - muB;
      }

      // 3. Family sortOrder
      const sortOrderA = a.candidate.family.sortOrder || 100;
      const sortOrderB = b.candidate.family.sortOrder || 100;
      if (sortOrderA !== sortOrderB) {
        return sortOrderA - sortOrderB;
      }

      // 4. Alphabetical tie-breaker on family slug and version tag
      const slugDiff = a.candidate.family.slug.localeCompare(b.candidate.family.slug);
      if (slugDiff !== 0) return slugDiff;
      return a.candidate.version.versionTag.localeCompare(b.candidate.version.versionTag);
    });

    chosenMatch = eligibleMatches[0];
    tieBreakerUsed = "task_affinity_and_lowest_mu";
  } else {
    // Explicit selection: take the exact matching candidate
    chosenMatch = eligibleMatches[0];
  }

  const { candidate, selectedEndpoint, selectedPricing } = chosenMatch;

  // Compute non-enforcing budget estimate if token context provided
  let estimatedCostMicros = null;
  if (
    selectedPricing.inputPriceMicrosPerM !== null &&
    selectedPricing.outputPriceMicrosPerM !== null &&
    context.estimatedInputTokens !== undefined
  ) {
    const inTokens = Number(context.estimatedInputTokens) || 0;
    const outTokens = Number(context.maxOutputTokens) || 0;
    const rawCost = (inTokens * selectedPricing.inputPriceMicrosPerM + outTokens * selectedPricing.outputPriceMicrosPerM) / 1_000_000;
    estimatedCostMicros = Math.ceil(rawCost * 1.10);
  }

  const decision = {
    decisionId: crypto.randomUUID(),
    eligible: true,
    evaluatedAt,
    decisionPolicyVersion,
    userPlan,
    requestedModel,
    selectedCandidate: {
      familyId: candidate.family.id,
      familySlug: candidate.family.slug,
      displayName: candidate.family.displayName,
      familyGroup: candidate.family.familyGroup,
      versionId: candidate.version.id,
      versionTag: candidate.version.versionTag,
      planEligibility: candidate.version.planEligibility,
      capabilitiesDocumented: Object.freeze({ ...candidate.version.capabilitiesDocumented }),
    },
    pinnedEndpoint: {
      id: selectedEndpoint.id,
      providerName: selectedEndpoint.providerName,
      transportType: selectedEndpoint.transportType,
      adapterType: selectedEndpoint.adapterType,
      capabilitiesVerified: Object.freeze({ ...selectedEndpoint.capabilitiesVerified }),
      endpointState: selectedEndpoint.endpointState,
    },
    pinnedPrivacyApproval: Object.freeze({
      auditRef: selectedEndpoint.privacyReview?.auditRef || null,
      scope: selectedEndpoint.privacyReview?.scope || "default",
      reviewedBy: selectedEndpoint.privacyReview?.reviewedBy || null,
      reviewedAt: selectedEndpoint.privacyReview?.reviewedAt || null,
      expiresAt: selectedEndpoint.privacyReview?.expiresAt || null,
      zeroDataRetention: Boolean(selectedEndpoint.privacyReview?.zeroDataRetention),
      trainingPolicy: selectedEndpoint.privacyReview?.trainingPolicy || "unknown",
    }),
    pinnedPricing: Object.freeze({
      pricingVersionId: selectedPricing.pricingVersionId,
      effectiveFrom: selectedPricing.effectiveFrom,
      effectiveTo: selectedPricing.effectiveTo,
      billingUnit: selectedPricing.billingUnit,
      currency: selectedPricing.currency,
      calculatedMu: selectedPricing.calculatedMu,
      consumptionCategory: selectedPricing.consumptionCategory,
      pricingConfidence: selectedPricing.pricingConfidence,
      inputPriceMicrosPerM: selectedPricing.inputPriceMicrosPerM,
      outputPriceMicrosPerM: selectedPricing.outputPriceMicrosPerM,
      cachedReadPriceMicrosPerM: selectedPricing.cachedReadPriceMicrosPerM,
    }),
    budgetEvaluation: Object.freeze({
      nonEnforcing: true,
      estimatedCostMicros,
      allowanceCreditsRemaining: budget.allowanceCreditsRemaining ?? null,
    }),
    metadata: Object.freeze({
      tieBreakerUsed,
      autoSelected: isAuto,
    }),
  };

  return deepFreeze(decision);
}

/**
 * Pre-dispatch revalidation boundary.
 *
 * Before an actual inference request is dispatched, this check ensures that:
 * 1. The pinned endpoint has not been disabled or deprecated since evaluation.
 * 2. The privacy approval has not been revoked in the interim.
 * 3. The privacy approval has not expired in the interim.
 *
 * Pinning a decision must never bypass a subsequent administrative revocation.
 */
export function revalidateRoutingDecision(
  decision,
  currentEndpointState,
  { currentTime = new Date() } = {},
) {
  if (!decision || !decision.eligible) {
    return { valid: false, reason: "invalid_decision_object" };
  }

  const now = new Date(currentTime).getTime();

  if (!currentEndpointState || currentEndpointState.endpointState !== LIFECYCLE_STATES.ACTIVE) {
    return {
      valid: false,
      reason: "endpoint_no_longer_active",
      customerMessage: CUSTOMER_SAFE_REJECTIONS[ROUTE_DECISION_REASONS.ENDPOINT_NOT_ACTIVE],
    };
  }

  const priv = currentEndpointState.privacyReview || {};
  if (priv.privacyApproved !== true) {
    return {
      valid: false,
      reason: "privacy_approval_no_longer_valid",
      customerMessage: CUSTOMER_SAFE_REJECTIONS[ROUTE_DECISION_REASONS.PRIVACY_NOT_APPROVED],
    };
  }

  if (priv.revoked === true || (priv.revokedAt && now >= new Date(priv.revokedAt).getTime())) {
    return {
      valid: false,
      reason: "privacy_approval_revoked",
      customerMessage: CUSTOMER_SAFE_REJECTIONS[ROUTE_DECISION_REASONS.PRIVACY_APPROVAL_REVOKED],
    };
  }

  if (priv.expiresAt && now > new Date(priv.expiresAt).getTime()) {
    return {
      valid: false,
      reason: "privacy_approval_expired",
      customerMessage: CUSTOMER_SAFE_REJECTIONS[ROUTE_DECISION_REASONS.PRIVACY_APPROVAL_EXPIRED],
    };
  }

  return { valid: true };
}

/**
 * Serializes a routing decision for customer-facing display.
 *
 * Strictly removes:
 * - Wholesale provider rates ($P_{\text{in}}$, $P_{\text{out}}$)
 * - Internal 10% platform multipliers ($\alpha$)
 * - Provider endpoints and base URLs
 * - Internal credentials, keys, or database primary keys
 */
export function serializeDecisionForClient(decision) {
  if (!decision) return null;

  if (!decision.eligible) {
    return {
      eligible: false,
      reasonCode: decision.reasonCode,
      message: decision.customerMessage,
    };
  }

  return {
    eligible: true,
    decisionId: decision.decisionId,
    evaluatedAt: decision.evaluatedAt,
    model: decision.selectedCandidate.versionTag,
    displayName: decision.selectedCandidate.displayName,
    familyGroup: decision.selectedCandidate.familyGroup,
    planEligibility: decision.selectedCandidate.planEligibility,
    consumptionCategory: decision.pinnedPricing.consumptionCategory,
    capabilities: {
      vision: Boolean(decision.pinnedEndpoint.capabilitiesVerified?.vision),
      tools: Boolean(decision.pinnedEndpoint.capabilitiesVerified?.tools),
      streaming: Boolean(decision.pinnedEndpoint.capabilitiesVerified?.streaming),
      reasoning: Boolean(decision.selectedCandidate.capabilitiesDocumented?.reasoningSupported),
    },
  };
}
