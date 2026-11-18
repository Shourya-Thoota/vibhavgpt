import { eq, sql } from "drizzle-orm";
import { userProfiles } from "../db/schema.js";
import { getDefaultDb, LIFECYCLE_STATES, PLAN_ELIGIBILITY } from "./registry.js";
import { loadRegistrySnapshot } from "./decision.js";
import { isFreeIncludedFamily } from "./free-included.js";
import { CONSUMPTION_CATEGORIES } from "./consumption.js";
import { getActiveSubscription, tierForSubscription } from "../usage/service.js";
import { SEED_MODEL_REFERENCE_MATRIX } from "./seed-catalog.js";
import {
  CUSTOMER_CHAT_MODEL_IDS,
  canonicalizeCustomerModelId,
  isCustomerFacingCatalogEntry,
  toCustomerCatalogPayload,
} from "./customer-catalog.js";
import { buildPickerLineup } from "./marketplace.js";
import { config as appConfig } from "../config.js";

// The picker's lineup (Slice 7), added beside the existing fields: house models first, then each provider's listed third-party models.
const lineupFor = (plan, now) => buildPickerLineup({ plan, marketplaceEnabled: appConfig.modelMarketplaceEnabled !== false, now: now?.getTime?.() ?? Date.now() });

/**
 * Validation error for catalog preferences and inputs.
 */
export class CatalogValidationError extends Error {
  constructor(message, code = "catalog_validation_error", status = 400) {
    super(message);
    this.name = "CatalogValidationError";
    this.code = code;
    this.status = status;
  }
}

const ID_FORMAT_REGEX = /^[a-z0-9_.-]{1,64}$/i;
const MAX_PREFERENCE_LIST_LENGTH = 50;

/**
 * Validates a single preference identifier.
 */
export function isValidIdentifier(id) {
  return typeof id === "string" && ID_FORMAT_REGEX.test(id.trim());
}

/**
 * Deduplicates an array of identifiers preserving first-seen order.
 */
export function deduplicateIds(list = []) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const trimmed = typeof item === "string" ? item.trim() : "";
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * Formats a brand/group ID into an approved customer-facing display name.
 */
export function formatGroupDisplayName(groupId) {
  // Only VibhavGPT is named. Any other group is shown neutrally, never under another company's name and never by echoing its id.
  if (!groupId || typeof groupId !== "string") return "More models";
  const norm = groupId.trim().toLowerCase();
  if (norm === "native" || norm === "vibhavgpt") return "VibhavGPT";
  if (norm === "system") return "VibhavGPT";
  if (norm === "experimental") return "Experimental";
  return "More models";
}

/**
 * Derives an active pricing snapshot effective at a specific evaluation timestamp.
 */
function getActivePricingSnapshot(endpoint, now) {
  const snapshots = endpoint?.pricingSnapshots || (endpoint?.pricing ? [endpoint.pricing] : []);
  if (!snapshots.length) return null;

  const target = now.getTime();
  return (
    snapshots.find((snap) => {
      const from = new Date(snap.effectiveFrom).getTime();
      const to = snap.effectiveTo ? new Date(snap.effectiveTo).getTime() : Infinity;
      return target >= from && target < to;
    }) || null
  );
}

/**
 * Pure presentation serializer that converts internal registry records
 * into a strict allowlisted public catalog DTO.
 *
 * STRICT CONFIDENTIALITY BOUNDARY:
 * Never returns:
 * - Wholesale prices ($P_{\text{in}}$, $P_{\text{out}}$, cached read)
 * - Calculated consumption multiplier ($\mu$)
 * - Provider endpoint URLs or hostnames
 * - Internal credentials, keys, or routing chains
 * - Internal provider names
 * - Privacy audit notes, auditor identities, or diagnostic logs
 * - Marketing metrics or invented popularity counts
 */
export function serializeModelForCatalog(item, userPlan = "free", { now = new Date() } = {}) {
  const { family, version, endpoints = [] } = item;
  const plan = String(userPlan || "free").toLowerCase();

  // 1. Resolve approved public display identity
  const displayName = version.metadata?.displayName || family.displayName;
  if (!displayName || typeof displayName !== "string" || !displayName.trim()) {
    return null; // Missing approved display metadata; omit record
  }

  // 2. Resolve stable public identifier
  const id =
    version.metadata?.publicId ||
    version.metadata?.publicSlug ||
    (family.slug ? family.slug.replace("/", "-") : version.versionTag);

  // 3. Resolve group
  const groupId = (family.familyGroup || "native").trim().toLowerCase();
  const groupDisplayName = family.metadata?.groupDisplayName || formatGroupDisplayName(groupId);

  // 4. Modalities & context
  const capDoc = version.capabilitiesDocumented || {};
  const modalities = capDoc.modalities || {
    input: capDoc.vision ? ["text", "image"] : ["text"],
    output: ["text"],
  };
  const contextWindowTokens = Number(capDoc.contextWindowTokens) || 128000;
  const supportedReasoningEfforts = capDoc.reasoningSupported
    ? (Array.isArray(capDoc.reasoningModes) && capDoc.reasoningModes.length > 0
      ? [...capDoc.reasoningModes]
      : ["normal"])
    : [];

  const capabilities = {
    tools: Boolean(capDoc.tools),
    vision: Boolean(capDoc.vision),
    streaming: Boolean(capDoc.streaming ?? true),
    structuredOutputs: Boolean(capDoc.structuredOutputs ?? true),
    reasoning: Boolean(capDoc.reasoningSupported),
  };

  // 5. Evaluate Endpoints: Active status, Privacy review, Pricing
  const activeEndpoints = endpoints.filter((ep) => ep.endpointState === LIFECYCLE_STATES.ACTIVE);

  let lockType = null;
  let lockReason = null;
  let selectable = false;
  let consumptionCategory = "pending";

  const targetTime = now.getTime();

  // Step 5A: Configuration check (must have at least one active endpoint)
  if (activeEndpoints.length === 0) {
    lockType = "configuration";
    lockReason = "This model is temporarily unavailable.";
  } else {
    // Step 5B: Compliance / Privacy review check
    const compliantEndpoints = activeEndpoints.filter((ep) => {
      const priv = ep.privacyReview || {};
      if (priv.privacyApproved !== true) return false;
      if (priv.revoked === true) return false;
      if (priv.revokedAt && targetTime >= new Date(priv.revokedAt).getTime()) return false;
      if (priv.expiresAt && targetTime > new Date(priv.expiresAt).getTime()) return false;
      return true;
    });

    if (compliantEndpoints.length === 0) {
      lockType = "compliance";
      lockReason = "This model is currently unavailable pending privacy and compliance review.";
    } else {
      // Step 5C: Pricing schedule check
      const endpointsWithPricing = [];
      for (const ep of compliantEndpoints) {
        const snap = getActivePricingSnapshot(ep, now);
        if (snap) {
          endpointsWithPricing.push({ ep, snap });
        }
      }

      if (endpointsWithPricing.length === 0) {
        lockType = "pricing";
        lockReason = "Pricing rate classification is pending for this model.";
      } else {
        // Resolve primary consumption category from highest priority endpoint
        endpointsWithPricing.sort(
          (a, b) => (a.ep.sortPriority || 10) - (b.ep.sortPriority || 10),
        );
        const primaryPricing = endpointsWithPricing[0].snap;
        consumptionCategory = primaryPricing.consumptionCategory || "pending";

        // Step 5D: Rate classification review
        if (consumptionCategory === CONSUMPTION_CATEGORIES.PENDING || consumptionCategory === "pending") {
          lockType = "pricing";
          lockReason = "This model's rate classification is pending review.";
        } else {
          // Step 5E: Plan restriction check (Subscription Gating)
          // Compliance, pricing, and configuration all pass!
          // Only at this point do plan restrictions apply.
          if (plan === "pro" || plan === "max") {
            selectable = true;
          } else if (plan === "plus") {
            if (version.planEligibility === PLAN_ELIGIBILITY.PRO_ONLY) {
              lockType = "subscription";
              lockReason = "Available with Pro plan only.";
            } else if (consumptionCategory === CONSUMPTION_CATEGORIES.EXTRA_HIGH) {
              lockType = "subscription";
              lockReason = "Extra High consumption models are restricted to Pro members.";
            } else {
              selectable = true;
            }
          } else {
            // Free plan
            if (version.planEligibility === PLAN_ELIGIBILITY.PRO_ONLY) {
              lockType = "subscription";
              lockReason = "Available with Pro plan only.";
            } else if (isFreeIncludedFamily(family)) {
              selectable = true;
            } else if (version.planEligibility === PLAN_ELIGIBILITY.PAID) {
              lockType = "subscription";
              lockReason = "Available with Plus or Pro subscription.";
            } else if (consumptionCategory === CONSUMPTION_CATEGORIES.EXTRA_HIGH) {
              lockType = "subscription";
              lockReason = "Extra High consumption models are restricted to Pro members.";
            } else {
              selectable = true;
            }
          }
        }
      }
    }
  }

  const sortRank = Number(family.sortOrder) || 100;
  const developer = family.developer || version.metadata?.developer || groupDisplayName;
  const performanceCategory =
    version.performanceCategory ||
    version.metadata?.performanceCategory ||
    family.performanceCategory ||
    (consumptionCategory === "low" ? "fast" : consumptionCategory === "extra_high" ? "best_intelligence" : "balanced");

  // Construct explicit allowlisted DTO (NO spreads, NO raw registry objects)
  return {
    id,
    displayName: displayName.trim(),
    group: {
      id: groupId,
      displayName: groupDisplayName,
      developer,
    },
    developer,
    performanceCategory,
    description: (version.metadata?.description || family.description || "").trim(),
    modalities: {
      input: [...modalities.input],
      output: [...modalities.output],
    },
    contextWindowTokens,
    supportedReasoningEfforts,
    capabilities: {
      ...capabilities,
      performanceCategory,
    },
    consumptionCategory,
    sortRank,
    selectability: {
      selectable,
      locked: !selectable,
      lockReason,
      lockType,
    },
  };
}

export function buildSeedRegistrySnapshot({ customerFacingOnly = false } = {}) {
  const snapshot = [];
  const activeModels = SEED_MODEL_REFERENCE_MATRIX.filter((m) => {
    if (m.isSystem) return false;
    if (!customerFacingOnly) return true;
    return CUSTOMER_CHAT_MODEL_IDS.includes(String(m.id).toLowerCase());
  });
  for (const m of activeModels) {
    const familyGroup = m.familyGroup || "native";
    const planEligibility =
      m.plans === "Pro"
        ? PLAN_ELIGIBILITY.PRO_ONLY
        : m.plans === "Paid"
        ? PLAN_ELIGIBILITY.PAID
        : PLAN_ELIGIBILITY.ALL;
    const cat =
      m.multiplier <= 1.0
        ? CONSUMPTION_CATEGORIES.LOW
        : m.multiplier <= 2.0
        ? CONSUMPTION_CATEGORIES.MEDIUM
        : m.multiplier <= 7.0
        ? CONSUMPTION_CATEGORIES.HIGH
        : CONSUMPTION_CATEGORIES.EXTRA_HIGH;

    snapshot.push({
      family: {
        id: `fam-${m.id}`,
        slug: m.id,
        displayName: m.brand,
        familyGroup,
        developer: m.developer,
        performanceCategory: m.performanceCategory,
        description: m.notes || m.description || "",
        sortOrder: familyGroup === "vibhavgpt" ? 10 : 50,
        metadata: {
          groupDisplayName: formatGroupDisplayName(familyGroup),
        },
      },
      version: {
        id: `ver-${m.id}`,
        versionTag: m.id,
        lifecycleState: LIFECYCLE_STATES.ACTIVE,
        planEligibility,
        performanceCategory: m.performanceCategory,
        capabilitiesDocumented: {
          ...m.capabilities,
          reasoningSupported: Boolean(m.capabilities?.reasoning),
        },
        metadata: {
          publicId: m.id,
          displayName: m.modelName,
          description: m.notes || m.description || "",
          developer: m.developer,
          performanceCategory: m.performanceCategory,
        },
      },
      endpoints: [
        {
          id: `ep-${m.id}`,
          providerName: m.developer || m.familyGroup,
          transportType: "router",
          endpointState: LIFECYCLE_STATES.ACTIVE,
          capabilitiesVerified: {
            active: true,
          },
          privacyReview: {
            privacyApproved: true,
          },
          pricingSnapshots: [
            {
              pricingVersionId: `pv-${m.id}`,
              effectiveFrom: "2024-01-01T00:00:00Z",
              effectiveTo: null,
              consumptionCategory: cat,
              inputPriceMicrosPerM: Math.round((m.rawInput || 0) * 1_000_000),
              outputPriceMicrosPerM: Math.round((m.rawOutput || 0) * 1_000_000),
              calculatedMu: m.multiplier,
            },
          ],
        },
      ],
    });
  }
  return snapshot;
}

/**
 * Reads and serializes the complete model catalog for a specific user.
 * Derives subscription plan from server-side entitlement records.
 */
export async function getCatalogForUser({
  userId,
  userPlan = null,
  db = null,
  snapshot = null,
  now = new Date(),
} = {}) {
  const executor = db || (await getDefaultDb());

  // Derive plan from verified database subscription if not explicitly provided
  let plan = userPlan;
  if (!plan && userId) {
    const subscription = await getActiveSubscription(userId, executor);
    plan = tierForSubscription(subscription, now);
  }
  if (!plan) {
    plan = "free";
  }

  // Load registry snapshot
  let registrySnapshot = snapshot;
  if (!registrySnapshot) {
    try {
      registrySnapshot = await loadRegistrySnapshot(executor);
    } catch {
      registrySnapshot = null;
    }
  }
  if (!registrySnapshot || registrySnapshot.length === 0) {
    if (db) {
      return {
        models: [],
        groups: [],
        userPlan: plan,
        lineup: lineupFor(plan, now),
      };
    }
    // Customer catalog falls back to native VibhavGPT tiers only — never the
    // full internal seed matrix of third-party family cards.
    registrySnapshot = buildSeedRegistrySnapshot({ customerFacingOnly: true });
  }

  const serializedModels = [];
  const groupMap = new Map();

  for (const item of registrySnapshot) {
    // Only active versions are presented in the public catalog
    if (item.version?.lifecycleState !== LIFECYCLE_STATES.ACTIVE) {
      continue;
    }

    // Customer-facing catalog excludes third-party vendor cards and internal routes.
    // Keep only VibhavGPT chat tiers (lumen/nova/nebula/vesper), including registry
    // rows whose public ids are prefixed (e.g. vibhavgpt-lumen).
    const publicCandidates = [
      item.version?.metadata?.publicId,
      item.version?.metadata?.publicSlug,
      item.family?.slug,
      item.version?.versionTag,
    ];
    const canonicalId = publicCandidates.map(canonicalizeCustomerModelId).find(Boolean) || null;
    if (
      !canonicalId ||
      !isCustomerFacingCatalogEntry({
        id: canonicalId,
        familyGroup: item.family?.familyGroup,
        family: item.family,
        version: item.version,
        metadata: item.version?.metadata,
      })
    ) {
      continue;
    }

    const dto = serializeModelForCatalog(item, plan, { now });
    if (!dto) continue; // Omit models missing approved display identity

    // Force the customer-facing id onto the DTO before payload sanitization.
    dto.id = canonicalId;
    serializedModels.push(dto);

    if (!groupMap.has(dto.group.id)) {
      groupMap.set(dto.group.id, {
        id: dto.group.id,
        displayName: dto.group.displayName,
        sortRank: dto.sortRank,
      });
    }
  }

  // Deterministic sorting: sortRank ascending, then displayName ascending
  serializedModels.sort((a, b) => {
    if (a.sortRank !== b.sortRank) return a.sortRank - b.sortRank;
    return a.displayName.localeCompare(b.displayName);
  });

  const sortedGroups = Array.from(groupMap.values()).sort((a, b) => {
    if (a.sortRank !== b.sortRank) return a.sortRank - b.sortRank;
    return a.displayName.localeCompare(b.displayName);
  });

  return {
    ...toCustomerCatalogPayload({
      models: serializedModels,
      groups: sortedGroups,
      userPlan: plan,
    }),
    lineup: lineupFor(plan, now),
  };
}

/**
 * Sanitizes preferences object with bounded default values.
 */
export function sanitizeCatalogPreferences(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      favorites: [],
      hiddenBrands: [],
      brandOrder: [],
    };
  }

  return {
    favorites: Array.isArray(raw.favorites)
      ? deduplicateIds(raw.favorites.filter(isValidIdentifier)).slice(0, MAX_PREFERENCE_LIST_LENGTH)
      : [],
    hiddenBrands: Array.isArray(raw.hiddenBrands)
      ? deduplicateIds(raw.hiddenBrands.filter(isValidIdentifier)).slice(0, MAX_PREFERENCE_LIST_LENGTH)
      : [],
    brandOrder: Array.isArray(raw.brandOrder)
      ? deduplicateIds(raw.brandOrder.filter(isValidIdentifier)).slice(0, MAX_PREFERENCE_LIST_LENGTH)
      : [],
  };
}

/**
 * Reads account-scoped catalog preferences for a verified user.
 */
export async function getCatalogPreferences(userId, db = null) {
  if (!userId) return sanitizeCatalogPreferences(null);
  const executor = db || (await getDefaultDb());

  const [profile] = await executor
    .select({ catalogPreferences: userProfiles.catalogPreferences })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);

  return sanitizeCatalogPreferences(profile?.catalogPreferences);
}

/**
 * Updates account-scoped catalog preferences with strict validation and non-destructive merge.
 */
export async function updateCatalogPreferences(userId, patch, db = null) {
  if (!userId) {
    throw new CatalogValidationError("User ID is required.", "missing_user_id", 401);
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new CatalogValidationError("Preferences payload must be an object.", "invalid_payload", 400);
  }

  // Validate array fields
  const validateListField = (field, name) => {
    if (patch[field] === undefined) return;
    if (!Array.isArray(patch[field])) {
      throw new CatalogValidationError(`${name} must be an array of strings.`, "invalid_field_type", 400);
    }
    if (patch[field].length > MAX_PREFERENCE_LIST_LENGTH) {
      throw new CatalogValidationError(
        `Too many items in ${name} (maximum ${MAX_PREFERENCE_LIST_LENGTH}).`,
        "bounds_exceeded",
        400,
      );
    }
    for (const item of patch[field]) {
      if (!isValidIdentifier(item)) {
        throw new CatalogValidationError(
          `Invalid identifier format in ${name}: "${String(item).slice(0, 30)}".`,
          "invalid_id_format",
          400,
        );
      }
    }
  };

  validateListField("favorites", "favorites");
  validateListField("hiddenBrands", "hiddenBrands");
  validateListField("brandOrder", "brandOrder");

  const executor = db || (await getDefaultDb());

  // Atomic JSONB merge: preserves unrelated keys even under rapid concurrent updates
  const updates = {};
  if (patch.favorites !== undefined) updates.favorites = deduplicateIds(patch.favorites);
  if (patch.hiddenBrands !== undefined) updates.hiddenBrands = deduplicateIds(patch.hiddenBrands);
  if (patch.brandOrder !== undefined) updates.brandOrder = deduplicateIds(patch.brandOrder);

  const updatesJson = JSON.stringify(updates);

  const [row] = await executor
    .insert(userProfiles)
    .values({
      userId,
      catalogPreferences: updates,
      thinkingEffort: "low",
    })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: {
        catalogPreferences: sql`coalesce(${userProfiles.catalogPreferences}, '{}'::jsonb) || ${updatesJson}::jsonb`,
        updatedAt: new Date(),
      },
    })
    .returning({ catalogPreferences: userProfiles.catalogPreferences });

  return sanitizeCatalogPreferences(row?.catalogPreferences);
}
