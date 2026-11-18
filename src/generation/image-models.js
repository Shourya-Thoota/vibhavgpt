// Image mode's models (owner request, 2026-11-15), by their branded names only. Prism is the default and keeps exactly its current engine,
// request and route. Aura is an optional choice, approved by the owner on 2026-11-15: it runs only while its route passes the strict privacy
// gate (route-inventory.js "image-aura": pinned to its one host, no training, no publishing, prompt retention stated and at most 30 days, as
// the privacy policy says). IMAGE_AURA_ENABLED=false switches it off. Nothing ever falls back from one model to the other.
import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { AURA_IMAGE_ENGINE, routeAllowed, routeInventory } from "../chat/route-inventory.js";

export const AURA_ENGINE = AURA_IMAGE_ENGINE;

export const IMAGE_MODELS = Object.freeze({
  prism: Object.freeze({
    id: "prism",
    name: "VibhavGPT Prism",
    route: "image-generation",
    engine: () => config.imageGenerationModel,
    // Prism's request is unchanged: no provider routing fields are added to it.
    providerRouting: null,
    maxReferences: 1,
    // Prism keeps its existing evidence gate.
    requireVerifiedRoute: false,
    enabled: () => Boolean(config.imageGenerationModel),
  }),
  aura: Object.freeze({
    id: "aura",
    name: "VibhavGPT Aura",
    route: "image-aura",
    engine: () => AURA_ENGINE,
    providerRouting: Object.freeze({ allow_fallbacks: false, data_collection: "deny" }),
    // Its host asks for an end-user id to police abuse: it gets a pseudonymous one (userHashFor), never a name, email or account id.
    sendsUserId: true,
    maxReferences: 3,
    // Aura opens only on a route that is checked AND verified: a route that cannot be checked (a base URL that isn't the router) is closed,
    // where routeAllowed alone would let it through.
    requireVerifiedRoute: true,
    enabled: () => config.imageAuraEnabled === true,
  }),
});

export const DEFAULT_IMAGE_MODEL = "prism";

/** A stable, pseudonymous id for one account on one model's host: not reversible without the server secret, and used nowhere else. */
export function imageUserHash(modelId, userId) {
  if (!userId || !config.authSecret) return null;
  return `u_${createHmac("sha256", config.authSecret).update(`image-${modelId}-user:${userId}`).digest("hex").slice(0, 32)}`;
}

/** May a request go to this model now? Its flag, then its route's privacy gate (strictly, for a model that needs a verified route). */
export function imageModelOpen(model) {
  if (!model?.enabled()) return false;
  if (model.requireVerifiedRoute) {
    const route = routeInventory().find((entry) => entry.route === model.route);
    if (!route || !route.verifiable || route.gate !== "strict") return false;
  }
  return routeAllowed(model.route);
}

export class ImageModelError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

/** The model a request asked for (Prism when it named none). Unknown or unavailable models are refused, never swapped for another. */
export function resolveImageModel(requested) {
  const key = requested === undefined || requested === null || requested === "" ? DEFAULT_IMAGE_MODEL : String(requested).toLowerCase();
  // Own keys only: "__proto__" or "constructor" must be refused as unknown, not resolve to an inherited object.
  const model = Object.hasOwn(IMAGE_MODELS, key) ? IMAGE_MODELS[key] : null;
  if (!model) throw new ImageModelError("Choose an image model from the list.", 400, "image_model_unknown");
  if (!imageModelOpen(model)) throw new ImageModelError(`${model.name} isn't available right now.`, 403, "image_model_unavailable");
  return model;
}

/** The models the person can choose now, for the composer's dropdown. An unavailable model is not listed at all. */
export function availableImageModels() {
  return Object.values(IMAGE_MODELS)
    .filter((model) => imageModelOpen(model))
    .map((model) => ({ id: model.id, name: model.name, default: model.id === DEFAULT_IMAGE_MODEL, maxReferences: model.maxReferences }));
}
