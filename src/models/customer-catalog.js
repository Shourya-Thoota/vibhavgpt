import { HOUSE_INTELLIGENCE, isThirdPartyModel } from "../../frontend/src/model-marketplace.js";

/**
 * Customer-facing model selection contract.
 *
 * Public chat choices are limited to VibhavGPT-branded tiers.
 * Underlying vendor/model IDs stay internal and must not appear in
 * customer catalog API payloads or customer UI lists.
 *
 * Study remains a dedicated product mode (not a catalog card).
 */

export const CUSTOMER_CHAT_MODEL_IDS = Object.freeze(["lumen", "vesper", "zenith", "tecton"]);

/** Aliases that resolve to a customer chat model. */
export const CUSTOMER_MODEL_ALIASES = Object.freeze({
  spark: "lumen",
  lumen: "lumen",
  vesper: "vesper",
  zenith: "zenith",
  tecton: "tecton",
  vulcan: "vesper",
});

/**
 * House tiers that have been retired (owner decision, 2026-11-14), by key, with the name they were shown under. A request that names one
 * is refused before inference or any credit hold (model_retired); it is never sent to another tier. Replies they wrote keep their names.
 * "ultra" was Nebula's earlier key.
 */
export const RETIRED_HOUSE_MODELS = Object.freeze({ nova: "Nova", nebula: "Nebula", ultra: "Nebula" });
export const isRetiredHouseModel = (value) => Object.prototype.hasOwnProperty.call(RETIRED_HOUSE_MODELS, String(value ?? "").trim().toLowerCase());

/** Dedicated product modes that are not catalog cards. */
export const CUSTOMER_PRODUCT_MODES = Object.freeze(["study", "image"]);

/** Router / auto selection keys accepted in chat but not catalog cards. */
export const CUSTOMER_ROUTER_KEYS = Object.freeze(["auto"]);

export const CUSTOMER_FACING_FAMILY_GROUPS = Object.freeze(["vibhavgpt", "native"]);

/**
 * Strip optional vibhavgpt/ native prefixes from a registry public id.
 */
export function canonicalizeCustomerModelId(value) {
  if (!value) return null;
  let norm = String(value).trim().toLowerCase();
  if (CUSTOMER_MODEL_ALIASES[norm]) return CUSTOMER_MODEL_ALIASES[norm];
  if (norm.startsWith("vibhavgpt/")) norm = norm.slice("vibhavgpt/".length);
  if (norm.startsWith("vibhavgpt-")) norm = norm.slice("vibhavgpt-".length);
  if (CUSTOMER_CHAT_MODEL_IDS.includes(norm)) return norm;
  return null;
}

/**
 * Returns the canonical customer chat model id, or null if not a customer model.
 */
export function resolveCustomerChatModel(value) {
  return canonicalizeCustomerModelId(value);
}

/**
 * True when the key is a selectable customer chat model (aliases allowed).
 */
export function isCustomerChatModel(value) {
  return resolveCustomerChatModel(value) != null;
}

/**
 * True when the key is allowed for new customer selections
 * (chat models + product modes + auto).
 */
export function isCustomerSelectableModel(value) {
  if (!value) return false;
  const norm = String(value).trim().toLowerCase();
  // A third-party model (Slice 7) is a valid choice by name; whether it can run now is the marketplace listing's decision.
  if (isThirdPartyModel(norm)) return true;
  if (CUSTOMER_PRODUCT_MODES.includes(norm)) return true;
  if (CUSTOMER_ROUTER_KEYS.includes(norm)) return true;
  return isCustomerChatModel(norm);
}

/**
 * True when a seed/registry entry belongs in the customer-facing catalog.
 */
export function isCustomerFacingCatalogEntry(entry) {
  if (!entry) return false;
  const candidates = [
    entry.id,
    entry.versionTag,
    entry.version?.versionTag,
    entry.family?.slug,
    entry.metadata?.publicId,
    entry.version?.metadata?.publicId,
    entry.version?.metadata?.publicSlug,
  ];
  for (const candidate of candidates) {
    if (canonicalizeCustomerModelId(candidate)) return true;
  }

  const familyGroup = String(
    entry.familyGroup ||
      entry.family?.familyGroup ||
      entry.group?.id ||
      ""
  ).toLowerCase();
  return CUSTOMER_FACING_FAMILY_GROUPS.includes(familyGroup);
}

/**
 * Filters a catalog response down to customer-facing models/groups only.
 * Strips vendor-identifying fields from remaining entries.
 */
export function toCustomerCatalogPayload(catalog) {
  const models = [];
  const seen = new Set();

  for (const model of catalog?.models || []) {
    const canonicalId = canonicalizeCustomerModelId(model.id);
    if (!canonicalId || seen.has(canonicalId)) continue;
    // Study/image/product modes and non-tier registry entries stay out of the catalog cards.
    if (!CUSTOMER_CHAT_MODEL_IDS.includes(canonicalId)) continue;
    seen.add(canonicalId);

    models.push({
      id: canonicalId,
      displayName: model.displayName?.replace(/^VibhavGPT\s+/i, "") || canonicalId,
      group: {
        id: "vibhavgpt",
        displayName: "VibhavGPT",
      },
      developer: "VibhavGPT",
      performanceCategory: model.performanceCategory,
      description: model.description || "",
      modalities: model.modalities,
      contextWindowTokens: model.contextWindowTokens,
      supportedReasoningEfforts: model.supportedReasoningEfforts || [],
      capabilities: {
        tools: Boolean(model.capabilities?.tools),
        vision: Boolean(model.capabilities?.vision),
        streaming: Boolean(model.capabilities?.streaming ?? true),
        structuredOutputs: Boolean(model.capabilities?.structuredOutputs ?? true),
        reasoning: Boolean(model.capabilities?.reasoning),
        performanceCategory: model.performanceCategory,
      },
      consumptionCategory: model.consumptionCategory,
      sortRank: model.sortRank,
      selectability: model.selectability,
      // A house model carries its place on the one intelligence scale. No model is badged "Recommended".
      house: true,
      intelligence: HOUSE_INTELLIGENCE[canonicalId] ?? null,
    });
  }

  models.sort((a, b) => {
    const ai = CUSTOMER_CHAT_MODEL_IDS.indexOf(String(a.id).toLowerCase());
    const bi = CUSTOMER_CHAT_MODEL_IDS.indexOf(String(b.id).toLowerCase());
    if (ai !== bi) return ai - bi;
    return a.displayName.localeCompare(b.displayName);
  });

  return {
    models,
    groups: models.length
      ? [{ id: "vibhavgpt", displayName: "VibhavGPT", sortRank: 10 }]
      : [],
    userPlan: catalog?.userPlan || "free",
  };
}

/**
 * Explicit unavailability result for retired / non-customer model keys.
 * Used instead of silent substitution to a different model.
 */
export function retiredModelUnavailable(modelKey) {
  const key = String(modelKey || "").trim();
  if (isRetiredHouseModel(key)) {
    return {
      available: false,
      code: "model_retired",
      modelKey: key.toLowerCase(),
      message: `VibhavGPT ${RETIRED_HOUSE_MODELS[key.toLowerCase()]} has been retired. Choose an available model to continue.`,
    };
  }
  return {
    available: false,
    code: "model_unavailable",
    modelKey: key || null,
    message: key
      ? `"${key}" is no longer available. Choose an available model to continue.`
      : "That model is no longer available. Choose an available model to continue.",
  };
}
