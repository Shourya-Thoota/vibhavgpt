import { and, desc, eq, sql } from "drizzle-orm";
import {
  modelEndpoints,
  modelFamilies,
  modelPricingSnapshots,
  modelVersions,
} from "../db/schema.js";
import { calculateConsumptionScore, CONSUMPTION_CATEGORIES } from "./consumption.js";
import { buildNativeCompatibilityInventory } from "./inventory.js";
import { isFreeIncludedFamily } from "./free-included.js";

let defaultDb = null;
export async function getDefaultDb() {
  if (!defaultDb) {
    const clientModule = await import("../db/client.js");
    defaultDb = clientModule.db;
  }
  return defaultDb;
}

export const LIFECYCLE_STATES = Object.freeze({
  CANDIDATE: "candidate",
  REVIEWED: "reviewed",
  ACTIVE: "active",
  DEPRECATED: "deprecated",
  DISABLED: "disabled",
});

export const PLAN_ELIGIBILITY = Object.freeze({
  FREE: "free",
  ALL_LIMITED: "all_limited",
  PAID: "paid",
  PRO_ONLY: "pro_only",
});

export const ALLOWED_LIFECYCLE_TRANSITIONS = Object.freeze({
  [LIFECYCLE_STATES.CANDIDATE]: Object.freeze([LIFECYCLE_STATES.REVIEWED, LIFECYCLE_STATES.DISABLED]),
  [LIFECYCLE_STATES.REVIEWED]: Object.freeze([LIFECYCLE_STATES.ACTIVE, LIFECYCLE_STATES.CANDIDATE, LIFECYCLE_STATES.DISABLED]),
  [LIFECYCLE_STATES.ACTIVE]: Object.freeze([LIFECYCLE_STATES.DEPRECATED, LIFECYCLE_STATES.DISABLED]),
  [LIFECYCLE_STATES.DEPRECATED]: Object.freeze([LIFECYCLE_STATES.DISABLED, LIFECYCLE_STATES.ACTIVE]),
  [LIFECYCLE_STATES.DISABLED]: Object.freeze([LIFECYCLE_STATES.CANDIDATE]),
});

export class ModelRegistryValidationError extends Error {
  constructor(message, code = "registry_validation_error", details = {}) {
    super(message);
    this.name = "ModelRegistryValidationError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Validates whether a lifecycle transition is allowed by the state machine.
 */
export function isValidLifecycleTransition(currentState, nextState) {
  const allowed = ALLOWED_LIFECYCLE_TRANSITIONS[currentState];
  if (!allowed) return false;
  return allowed.includes(nextState);
}

// ==========================================
// Model Families
// ==========================================

export async function createModelFamily({
  slug,
  displayName,
  familyGroup = "native",
  description = "",
  sortOrder = 100,
} = {}, executor = null) {
  if (!slug || typeof slug !== "string") {
    throw new ModelRegistryValidationError("Family slug is required", "missing_slug");
  }
  if (!displayName || typeof displayName !== "string") {
    throw new ModelRegistryValidationError("Display name is required", "missing_display_name");
  }

  const db = executor || (await getDefaultDb());
  const [row] = await db
    .insert(modelFamilies)
    .values({
      slug: slug.trim().toLowerCase(),
      displayName: displayName.trim(),
      familyGroup: familyGroup.trim().toLowerCase(),
      description: description.trim(),
      sortOrder: Math.max(0, Number(sortOrder) || 100),
    })
    .onConflictDoUpdate({
      target: modelFamilies.slug,
      set: {
        displayName: displayName.trim(),
        familyGroup: familyGroup.trim().toLowerCase(),
        description: description.trim(),
        sortOrder: Math.max(0, Number(sortOrder) || 100),
        updatedAt: new Date(),
      },
    })
    .returning();

  return row;
}

export async function getModelFamilyBySlug(slug, executor = null) {
  if (!slug) return null;
  const db = executor || (await getDefaultDb());
  const [row] = await db
    .select()
    .from(modelFamilies)
    .where(eq(modelFamilies.slug, String(slug).trim().toLowerCase()));
  return row ?? null;
}

export async function listModelFamilies(executor = null) {
  const db = executor || (await getDefaultDb());
  return db
    .select()
    .from(modelFamilies)
    .orderBy(modelFamilies.sortOrder, modelFamilies.slug);
}

// ==========================================
// Model Versions
// ==========================================

export async function createModelVersion({
  familyId,
  versionTag,
  aliases = [],
  capabilitiesDocumented = {},
  planEligibility = PLAN_ELIGIBILITY.PAID,
  lifecycleState = LIFECYCLE_STATES.CANDIDATE,
  metadata = {},
} = {}, executor = null) {
  if (!familyId) {
    throw new ModelRegistryValidationError("familyId is required", "missing_family_id");
  }
  if (!versionTag || typeof versionTag !== "string") {
    throw new ModelRegistryValidationError("versionTag is required", "missing_version_tag");
  }

  // New models are NEVER born active; default is candidate
  const initialLifecycleState = Object.values(LIFECYCLE_STATES).includes(lifecycleState)
    ? lifecycleState
    : LIFECYCLE_STATES.CANDIDATE;

  const db = executor || (await getDefaultDb());
  const [row] = await db
    .insert(modelVersions)
    .values({
      familyId,
      versionTag: versionTag.trim(),
      aliases: Array.isArray(aliases) ? aliases.map((a) => String(a).trim()) : [],
      capabilitiesDocumented: capabilitiesDocumented || {},
      planEligibility: Object.values(PLAN_ELIGIBILITY).includes(planEligibility) ? planEligibility : PLAN_ELIGIBILITY.PAID,
      lifecycleState: initialLifecycleState,
      metadata: metadata || {},
    })
    .onConflictDoUpdate({
      target: [modelVersions.familyId, modelVersions.versionTag],
      set: {
        aliases: Array.isArray(aliases) ? aliases.map((a) => String(a).trim()) : [],
        capabilitiesDocumented: capabilitiesDocumented || {},
        planEligibility: Object.values(PLAN_ELIGIBILITY).includes(planEligibility) ? planEligibility : PLAN_ELIGIBILITY.PAID,
        metadata: metadata || {},
        updatedAt: new Date(),
      },
    })
    .returning();

  return row;
}

export async function getModelVersion(versionId, executor = null) {
  if (!versionId) return null;
  const db = executor || (await getDefaultDb());
  const [row] = await db
    .select()
    .from(modelVersions)
    .where(eq(modelVersions.id, versionId));
  return row ?? null;
}

/**
 * Transitions a model version's lifecycle state under strict state machine rules.
 * Transitioning to ACTIVE requires:
 * 1. Current state must be REVIEWED.
 * 2. At least one endpoint must have verified privacy approval (privacyReview.privacyApproved === true).
 */
export async function transitionModelVersionState(
  versionId,
  nextState,
  { reason = "", actor = "system" } = {},
  executor = null,
) {
  const db = executor || (await getDefaultDb());
  const current = await getModelVersion(versionId, db);
  if (!current) {
    throw new ModelRegistryValidationError(`Model version ${versionId} not found`, "version_not_found");
  }

  if (!isValidLifecycleTransition(current.lifecycleState, nextState)) {
    throw new ModelRegistryValidationError(
      `Invalid lifecycle transition from '${current.lifecycleState}' to '${nextState}'`,
      "invalid_transition",
      { from: current.lifecycleState, to: nextState },
    );
  }

  // Pre-condition for activation: requires at least one active, privacy-approved endpoint
  if (nextState === LIFECYCLE_STATES.ACTIVE) {
    const endpoints = await db
      .select()
      .from(modelEndpoints)
      .where(eq(modelEndpoints.versionId, versionId));

    const hasPrivacyApprovedEndpoint = endpoints.some(
      (ep) => ep.privacyReview?.privacyApproved === true && ep.endpointState !== LIFECYCLE_STATES.DISABLED,
    );

    if (!hasPrivacyApprovedEndpoint) {
      throw new ModelRegistryValidationError(
        `Cannot activate model version ${versionId}: no privacy-approved endpoint exists. Public discovery is not customer-data approval.`,
        "privacy_approval_required",
        { versionId },
      );
    }
  }

  const updatedMetadata = {
    ...current.metadata,
    auditTrail: [
      ...(current.metadata?.auditTrail || []),
      {
        from: current.lifecycleState,
        to: nextState,
        reason,
        actor,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const [updated] = await db
    .update(modelVersions)
    .set({
      lifecycleState: nextState,
      metadata: updatedMetadata,
      updatedAt: new Date(),
    })
    .where(eq(modelVersions.id, versionId))
    .returning();

  return updated;
}

// ==========================================
// Model Endpoints
// ==========================================

export async function createModelEndpoint({
  versionId,
  providerName,
  transportType,
  adapterType = "chat_completions",
  endpointUrl,
  capabilitiesVerified = {},
  privacyReview = {},
  endpointState = LIFECYCLE_STATES.CANDIDATE,
  sortPriority = 10,
} = {}, executor = null) {
  if (!versionId) {
    throw new ModelRegistryValidationError("versionId is required", "missing_version_id");
  }
  if (!providerName || typeof providerName !== "string") {
    throw new ModelRegistryValidationError("providerName is required", "missing_provider_name");
  }
  if (!transportType || typeof transportType !== "string") {
    throw new ModelRegistryValidationError("transportType is required", "missing_transport_type");
  }
  if (!endpointUrl || typeof endpointUrl !== "string") {
    throw new ModelRegistryValidationError("endpointUrl is required", "missing_endpoint_url");
  }

  // Sanitization check: Ensure no API keys or tokens are passed into the URL or review object
  if (/[?&](?:key|token|secret|password)=/i.test(endpointUrl)) {
    throw new ModelRegistryValidationError("Credentials must never be stored in endpoint URL", "credential_storage_prohibited");
  }

  const sanitizedPrivacyReview = {
    privacyApproved: Boolean(privacyReview?.privacyApproved === true),
    trainingPolicy: privacyReview?.trainingPolicy || "unknown",
    dataRetentionDays: Number.isInteger(privacyReview?.dataRetentionDays) ? privacyReview.dataRetentionDays : null,
    zeroDataRetention: Boolean(privacyReview?.zeroDataRetention === true),
    auditRef: privacyReview?.auditRef ? String(privacyReview.auditRef).slice(0, 200) : null,
    reviewedBy: privacyReview?.reviewedBy ? String(privacyReview.reviewedBy).slice(0, 100) : null,
    reviewedAt: privacyReview?.privacyApproved ? (privacyReview.reviewedAt || new Date().toISOString()) : null,
    scope: privacyReview?.scope ? String(privacyReview.scope).slice(0, 100) : "default",
    expiresAt: privacyReview?.expiresAt ? new Date(privacyReview.expiresAt).toISOString() : null,
    revoked: Boolean(privacyReview?.revoked === true),
    revokedAt: privacyReview?.revokedAt ? new Date(privacyReview.revokedAt).toISOString() : null,
    revocationReason: privacyReview?.revocationReason ? String(privacyReview.revocationReason).slice(0, 250) : null,
  };

  const db = executor || (await getDefaultDb());
  const [row] = await db
    .insert(modelEndpoints)
    .values({
      versionId,
      providerName: providerName.trim(),
      transportType: transportType.trim(),
      adapterType: adapterType.trim(),
      endpointUrl: endpointUrl.trim(),
      capabilitiesVerified: capabilitiesVerified || {},
      privacyReview: sanitizedPrivacyReview,
      endpointState: Object.values(LIFECYCLE_STATES).includes(endpointState) ? endpointState : LIFECYCLE_STATES.CANDIDATE,
      sortPriority: Math.max(0, Number(sortPriority) || 10),
    })
    .onConflictDoUpdate({
      target: [modelEndpoints.versionId, modelEndpoints.providerName, modelEndpoints.transportType],
      set: {
        adapterType: adapterType.trim(),
        endpointUrl: endpointUrl.trim(),
        capabilitiesVerified: capabilitiesVerified || {},
        sortPriority: Math.max(0, Number(sortPriority) || 10),
        updatedAt: new Date(),
      },
    })
    .returning();

  return row;
}

export async function updateEndpointPrivacyReview(
  endpointId,
  {
    privacyApproved = false,
    trainingPolicy = "unknown",
    dataRetentionDays = null,
    zeroDataRetention = false,
    auditRef = null,
    reviewedBy = null,
    scope = "default",
    expiresAt = null,
    revoked = false,
    revokedAt = null,
    revocationReason = null,
  } = {},
  executor = null,
) {
  const db = executor || (await getDefaultDb());
  const [endpoint] = await db.select().from(modelEndpoints).where(eq(modelEndpoints.id, endpointId));
  if (!endpoint) {
    throw new ModelRegistryValidationError(`Endpoint ${endpointId} not found`, "endpoint_not_found");
  }

  const updatedReview = {
    privacyApproved: Boolean(privacyApproved),
    trainingPolicy,
    dataRetentionDays: Number.isInteger(dataRetentionDays) ? dataRetentionDays : null,
    zeroDataRetention: Boolean(zeroDataRetention),
    auditRef: auditRef ? String(auditRef).slice(0, 200) : null,
    reviewedBy: reviewedBy ? String(reviewedBy).slice(0, 100) : null,
    reviewedAt: privacyApproved ? (endpoint.privacyReview?.reviewedAt || new Date().toISOString()) : null,
    scope: scope ? String(scope).slice(0, 100) : (endpoint.privacyReview?.scope || "default"),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : (endpoint.privacyReview?.expiresAt || null),
    revoked: Boolean(revoked),
    revokedAt: revokedAt ? new Date(revokedAt).toISOString() : (endpoint.privacyReview?.revokedAt || null),
    revocationReason: revocationReason ? String(revocationReason).slice(0, 250) : (endpoint.privacyReview?.revocationReason || null),
  };

  const [updated] = await db
    .update(modelEndpoints)
    .set({
      privacyReview: updatedReview,
      updatedAt: new Date(),
    })
    .where(eq(modelEndpoints.id, endpointId))
    .returning();

  return updated;
}

export async function revokeEndpointPrivacyReview(
  endpointId,
  { reason = "Administrative revocation", revokedBy = "compliance" } = {},
  executor = null,
) {
  const db = executor || (await getDefaultDb());
  const [endpoint] = await db.select().from(modelEndpoints).where(eq(modelEndpoints.id, endpointId));
  if (!endpoint) {
    throw new ModelRegistryValidationError(`Endpoint ${endpointId} not found`, "endpoint_not_found");
  }

  const current = endpoint.privacyReview || {};
  const updatedReview = {
    ...current,
    privacyApproved: false,
    revoked: true,
    revokedAt: new Date().toISOString(),
    revocationReason: String(reason).slice(0, 250),
    revokedBy: String(revokedBy).slice(0, 100),
  };

  const [updated] = await db
    .update(modelEndpoints)
    .set({
      privacyReview: updatedReview,
      endpointState: LIFECYCLE_STATES.DISABLED,
      updatedAt: new Date(),
    })
    .where(eq(modelEndpoints.id, endpointId))
    .returning();

  return updated;
}

// ==========================================
// Pricing Snapshots
// ==========================================

export async function createPricingSnapshot({
  endpointId,
  pricingVersionId,
  effectiveFrom = new Date(),
  effectiveTo = null,
  currency = "USD",
  billingUnit = "usd_per_1m_tokens",
  inputPriceMicrosPerM = null,
  outputPriceMicrosPerM = null,
  cachedReadPriceMicrosPerM = null,
  reasoningPriceMicrosPerM = null,
  reasoningIncludedInOutput = true,
  pricingConfidence = "unknown",
  provenance = "manual_entry",
} = {}, executor = null) {
  if (!endpointId) {
    throw new ModelRegistryValidationError("endpointId is required", "missing_endpoint_id");
  }
  if (!pricingVersionId) {
    throw new ModelRegistryValidationError("pricingVersionId is required", "missing_pricing_version_id");
  }

  // Negative prices are strictly prohibited
  if (
    (inputPriceMicrosPerM !== null && inputPriceMicrosPerM !== undefined && Number(inputPriceMicrosPerM) < 0) ||
    (outputPriceMicrosPerM !== null && outputPriceMicrosPerM !== undefined && Number(outputPriceMicrosPerM) < 0)
  ) {
    throw new ModelRegistryValidationError("Negative pricing is invalid", "invalid_price_rates");
  }

  // Calculate mu and consumption category deterministically
  const { calculatedMu, consumptionCategory } = calculateConsumptionScore(
    inputPriceMicrosPerM,
    outputPriceMicrosPerM,
  );

  const db = executor || (await getDefaultDb());
  const [row] = await db
    .insert(modelPricingSnapshots)
    .values({
      endpointId,
      pricingVersionId: pricingVersionId.trim(),
      effectiveFrom: new Date(effectiveFrom),
      effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
      currency: currency.trim(),
      billingUnit: billingUnit.trim(),
      inputPriceMicrosPerM: inputPriceMicrosPerM !== null && inputPriceMicrosPerM !== undefined ? Number(inputPriceMicrosPerM) : null,
      outputPriceMicrosPerM: outputPriceMicrosPerM !== null && outputPriceMicrosPerM !== undefined ? Number(outputPriceMicrosPerM) : null,
      cachedReadPriceMicrosPerM: cachedReadPriceMicrosPerM !== null && cachedReadPriceMicrosPerM !== undefined ? Number(cachedReadPriceMicrosPerM) : null,
      reasoningPriceMicrosPerM: reasoningPriceMicrosPerM !== null && reasoningPriceMicrosPerM !== undefined ? Number(reasoningPriceMicrosPerM) : null,
      reasoningIncludedInOutput: Boolean(reasoningIncludedInOutput),
      calculatedMu,
      consumptionCategory,
      pricingConfidence: pricingConfidence.trim(),
      provenance: provenance.trim(),
    })
    .returning();

  return row;
}

export async function getEffectivePricingSnapshot(endpointId, atDate = new Date(), executor = null) {
  if (!endpointId) return null;
  const db = executor || (await getDefaultDb());
  const targetTime = new Date(atDate);

  const [row] = await db
    .select()
    .from(modelPricingSnapshots)
    .where(
      and(
        eq(modelPricingSnapshots.endpointId, endpointId),
        sql`${modelPricingSnapshots.effectiveFrom} <= ${targetTime}`,
        sql`(${modelPricingSnapshots.effectiveTo} IS NULL OR ${modelPricingSnapshots.effectiveTo} > ${targetTime})`,
      ),
    )
    .orderBy(desc(modelPricingSnapshots.effectiveFrom))
    .limit(1);

  return row ?? null;
}

// ==========================================
// Eligibility and Plan Matching
// ==========================================

export async function checkModelEligibility(
  versionId,
  {
    userPlan = "free",
    requiresVision = false,
    requiresTools = false,
    requiresStreaming = false,
  } = {},
  executor = null,
) {
  const db = executor || (await getDefaultDb());
  const version = await getModelVersion(versionId, db);
  if (!version) {
    return { eligible: false, reason: "model_version_not_found" };
  }

  if (version.lifecycleState !== LIFECYCLE_STATES.ACTIVE) {
    return { eligible: false, reason: "model_not_active", state: version.lifecycleState };
  }

  // Plan level check
  const planOrder = { free: 1, plus: 2, pro: 3, max: 4 };
  const userPlanRank = planOrder[userPlan] || 1;

  if (version.planEligibility === PLAN_ELIGIBILITY.PRO_ONLY && userPlanRank < 3) {
    return { eligible: false, reason: "requires_pro_plan" };
  }
  if (version.planEligibility === PLAN_ELIGIBILITY.PAID && userPlanRank < 2) {
    const [family] = await db.select().from(modelFamilies).where(eq(modelFamilies.id, version.familyId));
    if (!isFreeIncludedFamily(family)) return { eligible: false, reason: "requires_paid_plan" };
  }

  // Documented capabilities check
  const capabilities = version.capabilitiesDocumented || {};
  if (requiresVision && capabilities.vision !== true) {
    return { eligible: false, reason: "vision_unsupported" };
  }
  if (requiresTools && capabilities.tools !== true) {
    return { eligible: false, reason: "tools_unsupported" };
  }
  if (requiresStreaming && capabilities.streaming === false) {
    return { eligible: false, reason: "streaming_unsupported" };
  }

  // Check that at least one endpoint is active, privacy-approved, and supports verified requirements
  const endpoints = await db
    .select()
    .from(modelEndpoints)
    .where(
      and(
        eq(modelEndpoints.versionId, versionId),
        eq(modelEndpoints.endpointState, LIFECYCLE_STATES.ACTIVE),
      ),
    );

  const viableEndpoint = endpoints.find((ep) => {
    if (ep.privacyReview?.privacyApproved !== true) return false;
    const verified = ep.capabilitiesVerified || {};
    if (requiresVision && verified.vision !== true) return false;
    if (requiresTools && verified.tools !== true) return false;
    if (requiresStreaming && verified.streaming !== true) return false;
    return true;
  });

  if (!viableEndpoint) {
    return { eligible: false, reason: "no_privacy_approved_endpoint_for_requirements" };
  }

  return { eligible: true, endpoint: viableEndpoint };
}

// ==========================================
// Compatibility Inventory Seeder
// ==========================================

export async function seedNativeCompatibilityInventory(executor = null, options = {}) {
  const db = executor || (await getDefaultDb());
  const inventory = buildNativeCompatibilityInventory(options);
  const results = [];

  for (const item of inventory) {
    const family = await createModelFamily(item.family, db);
    if (!item.version?.versionTag || item.version.versionTag === "unconfigured") {
      results.push({ family, version: null, endpoints: [] });
      continue;
    }

    const version = await createModelVersion({
      familyId: family.id,
      versionTag: item.version.versionTag,
      aliases: item.version.aliases,
      capabilitiesDocumented: item.version.capabilitiesDocumented,
      planEligibility: item.version.planEligibility,
      lifecycleState: item.version.lifecycleState,
      metadata: item.version.metadata,
    }, db);

    const endpoints = [];
    for (const ep of item.endpoints) {
      if (!ep.endpointUrl) continue;
      const endpoint = await createModelEndpoint({
        versionId: version.id,
        providerName: ep.providerName,
        transportType: ep.transportType,
        adapterType: ep.adapterType,
        endpointUrl: ep.endpointUrl,
        capabilitiesVerified: ep.capabilitiesVerified,
        privacyReview: ep.privacyReview,
        endpointState: ep.endpointState,
        sortPriority: ep.sortPriority,
      }, db);

      let pricingSnapshot = null;
      if (ep.pricing && ep.pricing.pricingVersionId && ep.pricing.pricingVersionId !== "unverified") {
        pricingSnapshot = await createPricingSnapshot({
          endpointId: endpoint.id,
          pricingVersionId: ep.pricing.pricingVersionId,
          currency: ep.pricing.currency,
          billingUnit: ep.pricing.billingUnit,
          inputPriceMicrosPerM: ep.pricing.inputPriceMicrosPerM,
          outputPriceMicrosPerM: ep.pricing.outputPriceMicrosPerM,
          cachedReadPriceMicrosPerM: ep.pricing.cachedReadPriceMicrosPerM,
          reasoningPriceMicrosPerM: ep.pricing.reasoningPriceMicrosPerM,
          reasoningIncludedInOutput: ep.pricing.reasoningIncludedInOutput,
          pricingConfidence: ep.pricing.pricingConfidence,
          provenance: ep.pricing.provenance,
        }, db);
      }

      endpoints.push({ endpoint, pricingSnapshot });
    }

    results.push({ family, version, endpoints });
  }

  return results;
}

