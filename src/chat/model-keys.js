import { SEED_MODEL_REFERENCE_MATRIX } from "../models/seed-catalog.js";
import { currentThirdPartyKey, isThirdPartyModel, thirdPartyModel } from "../../frontend/src/model-marketplace.js";
import { marketplaceListing } from "../models/marketplace.js";
import { config } from "../config.js";
import {
  CUSTOMER_CHAT_MODEL_IDS,
  CUSTOMER_MODEL_ALIASES,
  CUSTOMER_PRODUCT_MODES,
  CUSTOMER_ROUTER_KEYS,
  isCustomerSelectableModel,
  resolveCustomerChatModel,
  retiredModelUnavailable,
  isRetiredHouseModel,
} from "../models/customer-catalog.js";

export const MODEL_ALIASES = { ...CUSTOMER_MODEL_ALIASES };

/** Full internal seed id map — used for history labels and retired detection only. */
const INTERNAL_SEED_MODEL_ID_MAP = new Map();
for (const m of SEED_MODEL_REFERENCE_MATRIX) {
  if (m.id) {
    INTERNAL_SEED_MODEL_ID_MAP.set(m.id.toLowerCase(), m.id);
  }
}

const CUSTOMER_MODEL_ID_SET = new Set(CUSTOMER_CHAT_MODEL_IDS);

/**
 * Normalize a model key for customer chat execution.
 * Customer aliases resolve to native tiers. Unknown keys fall back to lumen.
 * Retired third-party seed ids are NOT silently remapped — callers must check
 * `isRetiredCustomerModel` / `resolveExecutableModelKey` before execution.
 */
export function normalizeModelKey(value) {
  if (!value) return "lumen";
  const norm = String(value).trim().toLowerCase();
  // A retired tier keeps its own key (its replies keep their label); it is never read as another tier. Execution refuses it.
  if (isRetiredHouseModel(norm)) return norm === "ultra" ? "nebula" : norm;
  const customer = resolveCustomerChatModel(norm);
  if (customer) return customer;
  // A retired third-party id is read as the model that replaced it (model-marketplace.js); nothing stored is rewritten.
  if (isThirdPartyModel(norm)) return currentThirdPartyKey(norm);
  if (CUSTOMER_PRODUCT_MODES.includes(norm)) return norm;
  if (CUSTOMER_ROUTER_KEYS.includes(norm)) return "lumen";
  // Preserve known retired seed ids for unavailability checks; do not map them
  // onto a different live model.
  if (INTERNAL_SEED_MODEL_ID_MAP.has(norm)) return INTERNAL_SEED_MODEL_ID_MAP.get(norm);
  return "lumen";
}

/**
 * True when the key is a known internal seed id (including retired third-party).
 */
export function isKnownCatalogModel(modelKey) {
  if (!modelKey) return false;
  const norm = String(modelKey).trim().toLowerCase();
  if (CUSTOMER_MODEL_ID_SET.has(norm) || MODEL_ALIASES[norm]) return true;
  return INTERNAL_SEED_MODEL_ID_MAP.has(norm);
}

/**
 * True when the key was a seed catalog model that is no longer customer-selectable.
 */
export function isRetiredCustomerModel(modelKey) {
  if (!modelKey) return false;
  const norm = String(modelKey).trim().toLowerCase();
  // A retired house tier (Nova, Nebula) is refused by name; it is never resolved to another tier.
  if (isRetiredHouseModel(norm)) return true;
  if (isCustomerSelectableModel(norm)) return false;
  return INTERNAL_SEED_MODEL_ID_MAP.has(norm);
}

/**
 * Resolve a model key for live execution. Retired keys return an unavailable result
 * instead of substituting another model.
 */
export function resolveExecutableModelKey(value) {
  if (!value) return { available: true, modelKey: "lumen" };
  const norm = String(value).trim().toLowerCase();
  if (isRetiredHouseModel(norm)) return retiredModelUnavailable(norm);
  if (CUSTOMER_ROUTER_KEYS.includes(norm)) {
    return { available: true, modelKey: "lumen", routedFrom: "auto" };
  }
  if (CUSTOMER_PRODUCT_MODES.includes(norm)) {
    return { available: true, modelKey: norm };
  }
  const customer = resolveCustomerChatModel(norm);
  if (customer) return { available: true, modelKey: customer };
  // A third-party model runs only while it is listed: its live privacy guard verified, capable, and its live price known.
  if (isThirdPartyModel(norm)) {
    const current = currentThirdPartyKey(norm);
    if (config.modelMarketplaceEnabled !== false && marketplaceListing(current).listed) return { available: true, modelKey: current, thirdParty: true };
    return { available: false, code: "model_unavailable", modelKey: current, message: `${thirdPartyModel(current).name} isn't available right now. Choose another model.` };
  }
  if (INTERNAL_SEED_MODEL_ID_MAP.has(norm)) {
    return retiredModelUnavailable(INTERNAL_SEED_MODEL_ID_MAP.get(norm));
  }
  return { available: true, modelKey: "lumen" };
}

export function isCustomerFacingModel(modelKey) {
  return isCustomerSelectableModel(modelKey);
}

export function vesperModelKeys() {
  const keys = new Set(["vesper"]);
  for (const [alias, canonical] of Object.entries(MODEL_ALIASES)) {
    if (canonical === "vesper") {
      keys.add(alias.toLowerCase());
    }
  }
  return [...keys];
}

export function safeNonVesperAssistantModelKeys() {
  const keys = new Set(["study", "image", ...CUSTOMER_CHAT_MODEL_IDS.filter((id) => id !== "vesper")]);
  for (const [alias, canonical] of Object.entries(MODEL_ALIASES)) {
    if (canonical !== "vesper") {
      keys.add(alias.toLowerCase());
      keys.add(canonical.toLowerCase());
    }
  }
  return [...keys];
}

export function safeNonVesperConversationModelKeys() {
  const keys = new Set(["study", ...CUSTOMER_CHAT_MODEL_IDS.filter((id) => id !== "vesper")]);
  for (const [alias, canonical] of Object.entries(MODEL_ALIASES)) {
    if (canonical !== "vesper") {
      keys.add(alias.toLowerCase());
      keys.add(canonical.toLowerCase());
    }
  }
  return [...keys];
}
