/**
 * Every model route that can receive a person's text, what it sends to, and how strictly the shared policy guard (route-policy-guard.js)
 * holds it. Logged once at boot as "route_inventory" (route, model id, host name only, verification, decision): never keys or full URLs.
 *
 * Gates:
 *   - "strict": closed until the guard has verified it, and while the result is stale. For routes nothing else protects: Lumen (no
 *     data_collection flag, so the guard's training:false check is the protection) and the auto classifier (a free model the router may
 *     place on any host, with the account allowing free hosts that train).
 *   - "evidence": open unless the guard finds positive evidence that no compliant host exists: every host it examined is ruled out by
 *     its published policy (it trains, publishes prompts, or, where deny applies, retains them). For routes the router already protects per request: data_collection: deny (Nova, Nebula, Vulcan) or
 *     the account's exclusion of paid hosts that train (image generation). A failed fetch of the undocumented policy page does not take
 *     them down; it is logged as unverified.
 * A route whose host is not the router has no structured policy to read: it is logged "not-machine-verifiable" and left as it is. That
 * is a gap to close with the provider's documented terms, not something this guard can decide.
 */
import { config } from "../config.js";
import { routePolicyState } from "./route-policy-guard.js";
import { DIRECT_MARKETPLACE_CANDIDATES, ROUTER_MARKETPLACE_CANDIDATES, marketplaceRoute } from "../models/marketplace.js";

const ROUTER_HOST = /(^|\.)openrouter\.ai$/i;
export const AUTO_CLASSIFIER_MODEL = "google/gemini-2.5-flash:free";

// VibhavGPT Aura's engine and the longest prompt retention its route accepts (and the privacy policy states).
export const AURA_IMAGE_ENGINE = "x-ai/grok-imagine-image-2.0";
export const AURA_MAX_RETENTION_DAYS = 30;

export function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
}
const isRouter = (url) => ROUTER_HOST.test(hostOf(url) ?? "");
const freeModel = (model) => /:free$/i.test(String(model ?? ""));

/** The routes as configured now. Only routes with a model configured are listed. */
export function routeInventory(cfg = config) {
  const paid = cfg.providerBaseUrls.paid;
  const primary = cfg.providerBaseUrls.primaryFree;
  const vesperDirect = (cfg.vesperTransport || "router") === "direct";
  const routes = [
    cfg.lumenChatRoute === "paid-zdr"
      // Paid zero-retention hosts (owner-gated): pinned, and each host must not train and must not retain prompts. Strict: closed until verified.
      ? { route: "lumen", tier: "Lumen", model: cfg.lumenPaidZdrModel, base: paid, mode: "pinned", hosts: cfg.lumenPaidZdrProviders, requireZeroRetention: true, gate: "strict", active: true, event: "lumen_gateway_policy" }
      : { route: "lumen", tier: "Lumen", model: cfg.chatModels.lumenFallback1, base: paid, mode: "pinned", hosts: [cfg.lumenGatewayProvider], requireFree: true, gate: "strict", active: cfg.lumenChatRoute !== "staged", event: "lumen_gateway_policy" },
    { route: "nova", tier: "Nova", model: cfg.chatModels.nova, base: paid, mode: "pinned", hosts: cfg.routeProviders.nova ?? [], gate: "evidence" },
    { route: "nebula", tier: "Nebula", model: cfg.chatModels.nebula, base: paid, mode: "pinned", hosts: cfg.routeProviders.nebula ?? [], gate: "evidence" },
    vesperDirect
      ? { route: "vesper", tier: "Vulcan", model: cfg.chatModels.vesperDirect, base: cfg.providerBaseUrls.direct, mode: "deny", gate: "evidence" }
      : { route: "vesper", tier: "Vulcan", model: cfg.chatModels.vesper, base: paid, mode: "deny", gate: "evidence" },
    // Zenith (Slice 7): pinned to its configured hosts, no fallbacks, held to Lumen paid-zdr's standard. Strict: closed until verified.
    { route: "zenith", tier: "Zenith", model: cfg.chatModels.zenith, base: paid, mode: "pinned", hosts: cfg.zenithProviders, requireZeroRetention: true, gate: "strict" },
    // Tecton (Build): its one host, held to the same standard as Zenith. Strict: closed until verified.
    { route: "tecton", tier: "Tecton", model: cfg.chatModels.tecton, base: paid, mode: "pinned", hosts: cfg.tectonProviders ?? [], requireZeroRetention: true, gate: "strict" },
    // Third-party models on the router (Slice 7): the same standard, one route each. A model is listed only while its route is verified.
    ...(cfg.modelMarketplaceEnabled === false ? [] : ROUTER_MARKETPLACE_CANDIDATES.map((candidate) => ({
      route: marketplaceRoute(candidate.id), tier: candidate.provider, model: candidate.model, base: paid, mode: "pinned", hosts: candidate.hosts, requireZeroRetention: true, gate: "strict",
    }))),
    // Third-party models on the maker's own API (GPT-6): the direct host, like Vulcan and Study, so not machine-verifiable here. Each is
    // listed only while its documented terms are attested and its live reference read is fresh (src/models/marketplace.js).
    ...(cfg.modelMarketplaceEnabled === false ? [] : DIRECT_MARKETPLACE_CANDIDATES.map((candidate) => ({
      route: marketplaceRoute(candidate.id), tier: candidate.provider, model: candidate.model, base: cfg.providerBaseUrls[candidate.connection ?? "study"], mode: "direct", gate: "documented",
    }))),
    { route: "study", tier: "Study", model: cfg.chatModels.study, base: cfg.providerBaseUrls.study, mode: "unpinned", gate: "evidence" },
    { route: "primary-chat", tier: "Lumen (staged rollback only)", model: cfg.chatModels.lumen, base: primary, mode: "unpinned", gate: "evidence", active: cfg.lumenChatRoute === "staged" },
    { route: "memory-extraction", tier: "background", model: cfg.memoryExtractionModel, base: primary, mode: "unpinned", gate: "evidence" },
    { route: "search-intent", tier: "background", model: cfg.searchIntentModel, base: primary, mode: "unpinned", gate: "evidence" },
    { route: "moderation", tier: "background", model: cfg.moderationModel, base: cfg.moderationApiUrl, mode: "unpinned", gate: "evidence" },
    { route: "image-generation", tier: "Image", model: cfg.imageGenerationModel, base: paid, mode: "unpinned", gate: "evidence" },
    // VibhavGPT Aura (owner-approved 2026-11-15): strict and pinned to its one host, which must not train on or publish prompts, and may keep
    // them for at most 30 days, the period the privacy policy discloses. Longer or unstated retention closes the route.
    { route: "image-aura", tier: "Aura", model: AURA_IMAGE_ENGINE, base: paid, mode: "pinned", hosts: ["xai"], maxRetentionDays: AURA_MAX_RETENTION_DAYS, gate: "strict" },
    { route: "auto-classifier", tier: "Auto", model: AUTO_CLASSIFIER_MODEL, base: "https://openrouter.ai/api/v1", mode: "unpinned", gate: "strict" },
  ];
  return routes
    .filter((route) => route.model)
    .map((route) => {
      const verifiable = isRouter(route.base);
      // For unpinned models the account decides which hosts are eligible: it excludes paid hosts that train, not free ones.
      const accountExcludesTraining = !freeModel(route.model);
      // Unpinned free models on the router are only safe if every host passes; they are held strictly.
      const gate = route.mode === "unpinned" && !accountExcludesTraining ? "strict" : route.gate;
      return { active: true, ...route, gate, host: hostOf(route.base), verifiable, accountExcludesTraining };
    });
}

/** May a request go to this route now? */
export function routeAllowed(name, cfg = config) {
  const route = routeInventory(cfg).find((entry) => entry.route === name);
  if (!route) return true;
  if (!route.verifiable) return true;
  const state = routePolicyState(name, { model: route.model, hosts: route.mode === "pinned" ? route.hosts : null });
  if (route.gate === "strict") return state.verified;
  // Closed only when every host examined was ruled out by its published policy; a host name that does not match, a page that could not
  // be read or a failed fetch is logged as unverified and never takes a protected route down.
  return !(state.status === "failed" && state.positiveEvidence);
}

/** The routes the guard checks (every route on the router). */
export function guardedRoutes(cfg = config) {
  return routeInventory(cfg).filter((route) => route.verifiable).map(({ route, model, mode, hosts, requireFree, requireZeroRetention, maxRetentionDays, accountExcludesTraining, event }) => ({
    route, model, mode, hosts: mode === "pinned" ? hosts : null, requireFree: Boolean(requireFree), requireZeroRetention: Boolean(requireZeroRetention), ...(Number.isFinite(maxRetentionDays) ? { maxRetentionDays } : {}), accountExcludesTraining, ...(event ? { event } : {}),
  }));
}

/** The boot line: what every route sends to and what the guard decided. Names only. */
export function routeInventoryReport(cfg = config) {
  return {
    event: "route_inventory",
    routes: routeInventory(cfg).map((route) => {
      const state = route.verifiable ? routePolicyState(route.route, { model: route.model, hosts: route.mode === "pinned" ? route.hosts : null }) : null;
      return {
        route: route.route, tier: route.tier, active: route.active, model: route.model, host: route.host, mode: route.mode, gate: route.gate,
        verification: route.verifiable ? (state.verified ? "verified" : state.reason) : "not-machine-verifiable",
        allowedHosts: state?.allowedHosts ?? [],
        allowed: routeAllowed(route.route, cfg),
      };
    }),
  };
}
