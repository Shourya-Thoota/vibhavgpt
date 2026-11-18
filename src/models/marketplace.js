/**
 * The model marketplace: which third-party models may be listed right now, what a third-party turn costs, and the evidence behind
 * both. Server-side only: this file names the engines behind each listed model and the candidates for Zenith.
 *
 * Two kinds of third-party route, each with the privacy standard its host can actually be held to:
 *
 *   Router routes (GLM): listed only while all three hold, each from live data:
 *     1. the route has passed the route-policy guard (route-policy-guard.js) on its pinned host, to the Lumen paid-zdr standard:
 *        training false, no publishing, zero retention. Strict: unverified, stale or failed means not listed;
 *     2. it passes the capability check on that host: reads images, can call tools, and reads long documents (a context of at least
 *        LONG_DOCUMENT_MIN_TOKENS). An entry may waive one named capability only where the owner approved it, and the picker then says
 *        so (capabilityWaivers);
 *     3. its live price on that host is known. A price that cannot be read means not listed: never a guessed price.
 *
 *   Direct routes (GPT-6): the maker's own API over Study's own direct connection (its base URL and credential, never the router's;
 *     Responses API, store: false). The
 *     router's structured policy cannot describe a direct host, so the guard does not decide these: they follow the documented
 *     manual-verification pattern in docs/security/route-data-policy.json (the maker's published API data terms: no training by
 *     default, abuse-monitoring logs kept up to 30 days), and are open only while the owner's attestation of those terms for this
 *     organization is set (CHAT_VESPER_DATA_POLICY_VERIFIED, the same one Vulcan's direct route requires). The GPT-6 routes on the
 *     router fail the guard (every OpenAI endpoint there retains prompts), so they are never registered and nothing is sent there.
 *     The capability check and the live price come from the maker's own endpoint in the router's public model metadata, read by
 *     checkMarketplaceReferences below, never guessed; a stale or failed read means not listed.
 *
 * Billing: the provider's real cost for the turn (the router's reported cost; failing that, the live per-token price times the counted
 * tokens, at the long-context rates when the prompt reaches them), plus 10%, converted to credits with the credit's one definition
 * (CREDIT_MICROS). The 10% is the ledger's existing markup (calculateUnifiedLedgerDeductionMicros), applied once, with its rounding:
 * integer micro-dollars, rounded up.
 */
import { config } from "../config.js";
import { GUARD_INTERVAL_MS, GUARD_MAX_AGE_MS, routePolicyState } from "../chat/route-policy-guard.js";
import { CREDIT_MICROS } from "../../frontend/src/credits-policy.js";
import {
  HOUSE_INTELLIGENCE, HOUSE_MODELS, HOUSE_PLAN_COPY, INTELLIGENCE_LABELS, THIRD_PARTY_MODELS, THIRD_PARTY_PROVIDERS, currentThirdPartyKey,
  planIncludesHouseModel, planIncludesThirdPartyModel, providerLogo, providerName, thirdPartyPlanCopy,
} from "../../frontend/src/model-marketplace.js";
import { calculateUnifiedLedgerDeductionMicros } from "./pricing-engine.js";

export const LONG_DOCUMENT_MIN_TOKENS = 128_000;
export const UPCHARGE_PERCENT = 10;

// Each model's route. Router routes are pinned to the maker's own first-party host, with no fallbacks. Direct routes go to the maker's
// own API; `reference` is where the live price and capabilities are read (the maker's own endpoint in the router's public metadata).
export const MARKETPLACE_ROUTES = Object.freeze({
  "glm-5.3": Object.freeze({ transport: "router", model: "z-ai/glm-5.3", hosts: Object.freeze(["Z.AI"]) }),
  "glm-5.3-flash": Object.freeze({ transport: "router", model: "z-ai/glm-5.3-flash", hosts: Object.freeze(["Z.AI"]) }),
  // GPT-6 references are read at OpenAI's standard tier ("openai"): our direct requests send no service_tier, so they are billed at the
  // standard price. The router lists the discounted Flex tier ("openai/flex") first; reading that row charged half the real cost.
  "gpt-6-luna": Object.freeze({ transport: "direct", model: "gpt-6-luna", reference: Object.freeze({ model: "openai/gpt-6-luna", host: "OpenAI", tag: "openai" }) }),
  "gpt-6.1-terra": Object.freeze({ transport: "direct", model: "gpt-6.1-terra", reference: Object.freeze({ model: "openai/gpt-6.1-terra", host: "OpenAI", tag: "openai" }) }),
  // GPT-6.2 Sol and Astra replace GPT-6.1 Sol and GPT-6 Astra (owner, 2026-11-17): OpenAI's model ids, on the same direct Responses API
  // route (store: false; tools only through Responses, which these models require). Their live prices are read at OpenAI's standard row.
  "gpt-6.2-sol": Object.freeze({ transport: "direct", model: "gpt-6.2-sol", reference: Object.freeze({ model: "openai/gpt-6.2-sol", host: "OpenAI", tag: "openai" }) }),
  "gpt-6.2-astra": Object.freeze({ transport: "direct", model: "gpt-6.2-astra", reference: Object.freeze({ model: "openai/gpt-6.2-astra", host: "OpenAI", tag: "openai" }) }),
  // Gemini 4 (owner request, 2026-11-16): Google's own Gemini API (its OpenAI-compatible chat endpoint) with the owner's paid key
  // (GEMINI_API_KEY; connection "google"). The reference is Google AI Studio's standard row ("google-ai-studio"): the router lists the
  // half-price Flex row first, and reading that would charge half the real cost (as happened once with GPT-6). The live price follows
  // Google's own changes, such as Carbon's and Argon's introductory rate ending on 2026-12-01.
  "gemini-4-hydrogen": Object.freeze({ transport: "direct", connection: "google", api: "chat", model: "gemini-4-hydrogen", reference: Object.freeze({ model: "google/gemini-4-hydrogen", host: "Google AI Studio", tag: "google-ai-studio" }) }),
  "gemini-4-argon": Object.freeze({ transport: "direct", connection: "google", api: "chat", model: "gemini-4-argon", reference: Object.freeze({ model: "google/gemini-4-argon", host: "Google AI Studio", tag: "google-ai-studio" }) }),
  "gemini-4-carbon": Object.freeze({ transport: "direct", connection: "google", api: "chat", model: "gemini-4-carbon", reference: Object.freeze({ model: "google/gemini-4-carbon", host: "Google AI Studio", tag: "google-ai-studio" }) }),
});
// Kept for the evidence tests: the router model behind each router route.
export const MARKETPLACE_ROUTER_MODELS = Object.freeze(Object.fromEntries(Object.entries(MARKETPLACE_ROUTES).filter(([, route]) => route.transport === "router").map(([id, route]) => [id, route.model])));
// Capabilities the owner approved waiving for one named entry, and only that entry. GLM 5.3 reads text only; it is listed without
// vision, says "Text only" in its line, and is never offered an image (the chat route refuses one for a model without vision).
// The privacy check is never waivable.
export const CAPABILITY_WAIVERS = Object.freeze({ "glm-5.3": Object.freeze(["vision"]) });

export const MARKETPLACE_CANDIDATES = Object.freeze(THIRD_PARTY_MODELS.map((model) => {
  const route = MARKETPLACE_ROUTES[model.id];
  return Object.freeze({
    id: model.id,
    provider: providerName(model.provider),
    transport: route.transport,
    model: route.model,
    hosts: route.hosts ? [...route.hosts] : [],
    reference: route.reference ?? null,
    connection: route.connection ?? (route.transport === "direct" ? "study" : null),
    api: route.api ?? (route.transport === "direct" ? "responses" : null),
    waivers: [...(CAPABILITY_WAIVERS[model.id] ?? [])],
  });
}));
export const ROUTER_MARKETPLACE_CANDIDATES = Object.freeze(MARKETPLACE_CANDIDATES.filter((candidate) => candidate.transport === "router"));
export const DIRECT_MARKETPLACE_CANDIDATES = Object.freeze(MARKETPLACE_CANDIDATES.filter((candidate) => candidate.transport === "direct"));

// Zenith's engine (owner decision, Slice 7), verified like every other route and recorded in docs/models/marketplace-evidence.md. It is
// the configured default (config.js ZENITH_DEFAULT_MODEL); CHAT_MODEL_ZENITH overrides it.
// Vulcan's proposed migration (Cohere Command A+) is recorded alongside it: it fails the guard (its only host retains prompts), so Vulcan
// is unchanged.
export const ZENITH_CANDIDATES = Object.freeze([
  Object.freeze({ model: "mistralai/mistral-large-4-0", hosts: ["mistral/zdr"] }),
]);
export const VESPER_MIGRATION_CANDIDATES = Object.freeze([
  Object.freeze({ model: "cohere/command-a-plus", hosts: ["Cohere"] }),
]);

export const marketplaceRoute = (id) => `market:${id}`;
export const marketplaceCandidate = (id) => MARKETPLACE_CANDIDATES.find((candidate) => candidate.id === currentThirdPartyKey(id)) ?? null;

/**
 * Vision, tool calling and long-document reading, from the model's input types and its host's own published parameters. `waive` names
 * capabilities the owner approved going without for this one entry; they are reported but do not block.
 */
export function capabilityCheck({ inputModalities = [], hostParameters = [], contextLength = 0, waive = [] } = {}) {
  const vision = inputModalities.includes("image");
  const tools = hostParameters.includes("tools");
  const longDocuments = Number(contextLength) >= LONG_DOCUMENT_MIN_TOKENS;
  const absent = [!vision && "vision", !tools && "tools", !longDocuments && "long-documents"].filter(Boolean);
  const missing = absent.filter((capability) => !waive.includes(capability));
  return { ok: missing.length === 0, vision, tools, longDocuments, contextLength: Number(contextLength) || 0, missing, waived: absent.filter((capability) => waive.includes(capability)) };
}

const perToken = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

/**
 * The live per-token price (USD) read from the host, or null when it cannot be read. Long-context rates (the host's `overrides`, each
 * from a prompt size up) come along as `tiers`, smallest threshold first; a tier whose rates cannot be read makes the price unreadable.
 */
export function livePriceFromEvidence(evidence) {
  const pricing = evidence?.endpoint?.pricing;
  const input = perToken(pricing?.prompt);
  const output = perToken(pricing?.completion);
  if (input === null || output === null) return null;
  const cacheRead = perToken(pricing?.input_cache_read);
  // Prompt-cache writes, where the host bills them separately (OpenAI's GPT-6 family: 1.25x input for the default 30 minutes). A host
  // that publishes none charges written tokens as ordinary input.
  const cacheWrite = perToken(pricing?.input_cache_write);
  const price = { inputUsdPerToken: input, outputUsdPerToken: output, cacheReadUsdPerToken: cacheRead ?? input, cacheWriteUsdPerToken: cacheWrite ?? input };
  const overrides = Array.isArray(pricing?.overrides) ? pricing.overrides : [];
  if (!overrides.length) return price;
  const tiers = [];
  for (const override of overrides) {
    const from = Number(override?.min_prompt_tokens);
    const tierInput = perToken(override?.prompt);
    const tierOutput = perToken(override?.completion);
    if (!Number.isSafeInteger(from) || from <= 0 || tierInput === null || tierOutput === null) return null;
    const tierCache = perToken(override?.input_cache_read);
    const tierWrite = perToken(override?.input_cache_write);
    tiers.push({ fromPromptTokens: from, inputUsdPerToken: tierInput, outputUsdPerToken: tierOutput, cacheReadUsdPerToken: tierCache ?? tierInput, cacheWriteUsdPerToken: tierWrite ?? tierInput });
  }
  return { ...price, tiers: tiers.sort((a, b) => a.fromPromptTokens - b.fromPromptTokens) };
}

// ---- Direct routes: the live reference read (price and capabilities, never privacy) ---------------------------------------------------

const references = new Map();
let referenceTimer = null;
const REFERENCE_FETCH_TIMEOUT_MS = 10_000;

/** The reference read for one direct route: the maker's own endpoint from the router's public model metadata. No key is sent. */
export async function checkMarketplaceReference(candidate, { fetchImpl = fetch, apiBase = "https://openrouter.ai/api/v1", log = console, now = () => Date.now() } = {}) {
  const { model, host, tag = null } = candidate.reference;
  let result;
  try {
    const response = await fetchImpl(`${apiBase}/models/${model}/endpoints`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(REFERENCE_FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const json = await response.json();
    const endpoints = Array.isArray(json?.data?.endpoints) ? json.data.endpoints : [];
    // The host's row for the tier we are billed at (reference.tag), never just the first row: a host can list several service tiers.
    const endpoint = endpoints.find((entry) => entry?.provider_name === host && (!tag || entry?.tag === tag)) ?? null;
    const inputModalities = Array.isArray(json?.data?.architecture?.input_modalities) ? json.data.architecture.input_modalities : [];
    result = endpoint ? { ok: true, reason: "read", evidence: { endpoint, inputModalities } } : { ok: false, reason: "maker-endpoint-missing", evidence: null };
  } catch (error) {
    result = { ok: false, reason: "reference-fetch-failed", evidence: { error: String(error?.message ?? error).slice(0, 200) } };
  }
  references.set(candidate.id, { ...result, checkedAt: now() });
  const price = result.ok ? livePriceFromEvidence(result.evidence) : null;
  // Names, the decision and the price read only. This is not a privacy decision: a direct route's privacy is its documented terms.
  (result.ok ? log.info : log.warn).call(log, JSON.stringify({
    event: "market_reference", route: marketplaceRoute(candidate.id), model, host, ok: result.ok, reason: result.reason, privacy: "documented-terms",
    price: price ? { input: price.inputUsdPerToken, output: price.outputUsdPerToken, cacheRead: price.cacheReadUsdPerToken, tiers: price.tiers?.length ?? 0 } : null,
  }));
  return result;
}

/** Boot: read every direct route's reference once, then hourly (the guard's own cadence). */
export async function startMarketplaceReferences(options = {}) {
  const run = () => Promise.all(DIRECT_MARKETPLACE_CANDIDATES.map((candidate) => checkMarketplaceReference(candidate, options)));
  const results = await run();
  if (referenceTimer) clearInterval(referenceTimer);
  referenceTimer = setInterval(() => { void run(); }, GUARD_INTERVAL_MS);
  referenceTimer.unref?.();
  return results;
}
export function stopMarketplaceReferences() {
  if (referenceTimer) clearInterval(referenceTimer);
  referenceTimer = null;
}
/** For tests only. */
export function setMarketplaceReferenceForTests(id, value = null) {
  if (value === null) references.delete(id);
  else references.set(id, value);
}
export function resetMarketplaceReferencesForTests() {
  references.clear();
}

/**
 * Whether a direct route's documented terms are attested and its connection is configured. OpenAI's routes reuse Study's direct
 * connection and its attestation (CHAT_VESPER_DATA_POLICY_VERIFIED). Google's routes use their own key (GEMINI_API_KEY) and their own
 * attestation (GEMINI_DATA_POLICY_VERIFIED): set only once the key is on Google's paid tier (paid use is not used to improve Google's
 * products) and the project's AI Studio logging is turned off (otherwise prompts are kept in the project's logs for up to 55 days).
 */
export function directRouteOpen(cfg = config, connection = "study") {
  if (connection === "google") return cfg.geminiDataPolicyVerified === true && Boolean(cfg.providerKeys?.google?.trim?.()) && Boolean(cfg.providerBaseUrls?.google);
  return cfg.vesperDataPolicyVerified === true && Boolean(cfg.providerKeys?.study?.trim?.()) && Boolean(cfg.providerBaseUrls?.study);
}

function directListingState(candidate, now) {
  if (!directRouteOpen(config, candidate.connection ?? "study")) return { ok: false, reason: "documented-terms-not-attested" };
  const reference = references.get(candidate.id);
  if (!reference) return { ok: false, reason: "reference-unread" };
  if (!reference.ok) return { ok: false, reason: `reference-${reference.reason}` };
  if (now - reference.checkedAt > GUARD_MAX_AGE_MS) return { ok: false, reason: "reference-stale" };
  return { ok: true, evidence: reference.evidence, checkedAt: reference.checkedAt };
}

/** Whether one third-party model may be listed now, and on what terms. */
export function marketplaceListing(id, { now = Date.now() } = {}) {
  const candidate = marketplaceCandidate(id);
  if (!candidate?.model) return { listed: false, reason: "unknown-model" };
  let evidence;
  let checkedAt;
  if (candidate.transport === "direct") {
    const state = directListingState(candidate, now);
    if (!state.ok) return { listed: false, reason: state.reason };
    ({ evidence, checkedAt } = state);
  } else {
    const state = routePolicyState(marketplaceRoute(candidate.id), { model: candidate.model, hosts: candidate.hosts, now });
    if (!state.verified) return { listed: false, reason: `policy-${state.reason}` };
    evidence = state.evidence ?? {};
    checkedAt = state.checkedAt;
  }
  const capability = capabilityCheck({ inputModalities: evidence.inputModalities ?? [], hostParameters: evidence.endpoint?.supported_parameters ?? [], contextLength: evidence.endpoint?.context_length ?? 0, waive: candidate.waivers });
  if (!capability.ok) return { listed: false, reason: `capability-${capability.missing.join("-")}` };
  const price = livePriceFromEvidence(evidence);
  if (!price) return { listed: false, reason: "price-unknown" };
  lastVerifiedPrice.set(candidate.id, price);
  return { listed: true, reason: "verified", price, capability, host: evidence.endpoint?.provider_name ?? candidate.hosts[0] ?? null, transport: candidate.transport, checkedAt };
}

// The last live price seen while a model was listed. A turn admitted while listed settles at a real price even when the check's result
// ages out during the reply; it is never used to list or admit anything.
const lastVerifiedPrice = new Map();
/** For tests only. */
export function resetMarketplacePricesForTests() {
  lastVerifiedPrice.clear();
}
export function settlementPrice(id) {
  const key = currentThirdPartyKey(id);
  const live = marketplaceListing(key);
  return live.listed ? live.price : lastVerifiedPrice.get(key) ?? null;
}

/** Every third-party model that may be listed now, in lineup order, with its live terms. */
export function listedMarketplaceModels(options = {}) {
  return THIRD_PARTY_MODELS
    .map((model) => ({ model, listing: marketplaceListing(model.id, options) }))
    .filter(({ listing }) => listing.listed)
    .map(({ model, listing }) => ({ ...model, providerLabel: providerName(model.provider), price: listing.price, contextLength: listing.capability.contextLength, vision: listing.capability.vision && model.vision }));
}

/**
 * The picker's lineup for a plan: the house models first (each with its intelligence label and whether the plan includes it), then
 * one group per provider holding its listed third-party models, each marked allowed or locked by its plan floor. A provider with
 * nothing listed has no group; `showHeader` says whether its label is drawn. No engines, routes or prices.
 */
export function buildPickerLineup({ plan = "free", marketplaceEnabled = true, now = Date.now() } = {}) {
  const house = HOUSE_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    vision: model.vision,
    house: true,
    intelligence: HOUSE_INTELLIGENCE[model.id],
    intelligenceLabel: INTELLIGENCE_LABELS[HOUSE_INTELLIGENCE[model.id]],
    allowed: planIncludesHouseModel(plan, model.id),
    lockedCopy: HOUSE_PLAN_COPY[model.id],
  }));
  const listed = marketplaceEnabled ? listedMarketplaceModels({ now }) : [];
  const providers = THIRD_PARTY_PROVIDERS
    .map((provider) => {
      const models = listed.filter((model) => model.provider === provider.id).map((model) => ({
        id: model.id,
        name: model.name,
        description: model.description,
        vision: Boolean(model.vision),
        house: false,
        provider: provider.id,
        // The maker as shown to people (a public label and the bundled logo's name, never routing data).
        providerLabel: provider.name,
        logo: providerLogo(provider.id),
        intelligence: model.intelligence,
        intelligenceLabel: INTELLIGENCE_LABELS[model.intelligence],
        minPlan: model.minPlan,
        allowed: planIncludesThirdPartyModel(plan, model.id),
        lockedCopy: thirdPartyPlanCopy(model.id),
        billing: "provider-cost-plus-10",
      }));
      return { id: provider.id, name: provider.name, logo: provider.logo, showHeader: models.length >= (provider.headerMinEntries ?? 1), models };
    })
    .filter((provider) => provider.models.length > 0);
  return { house, providers };
}

/** The rates that apply to a prompt of this size: the largest long-context tier it reaches, else the base rates. */
export function ratesForPrompt(price, inputTokens = 0) {
  if (!price) return null;
  const tier = [...(price.tiers ?? [])].reverse().find((entry) => Math.max(0, inputTokens) >= entry.fromPromptTokens);
  return tier ?? price;
}

// A per-token rate in whole pico-dollars (a published rate has at most 12 decimal places, so this is exact).
const picoPerToken = (usd) => BigInt(Math.round(Number(usd) * 1e12));
const wholeTokens = (value) => BigInt(Math.max(0, Math.floor(Number(value) || 0)));

/**
 * The provider's cost (micro-dollars) for a turn from per-token prices and the counted tokens. Cached input at its cache price. Exact:
 * the sum is taken in integer pico-dollars and rounded half up to a micro-dollar once, so a cost that lands on half a micro-dollar is
 * never rounded the wrong way by floating point (it was: $0.2133335 came out as 213,333 micro-dollars instead of 213,334).
 */
export function rawCostMicrosFromPrice(price, { inputTokens = 0, outputTokens = 0, cachedInputTokens = 0, cacheWriteInputTokens = 0 } = {}) {
  if (!price) return null;
  const rates = ratesForPrompt(price, inputTokens);
  const input = wholeTokens(inputTokens);
  const min = (a, b) => (a < b ? a : b);
  // Input splits into cache reads, cache writes and the rest (OpenAI counts both reads and writes inside input_tokens, never overlapping).
  const cached = min(input, wholeTokens(cachedInputTokens));
  const written = min(input - cached, wholeTokens(cacheWriteInputTokens));
  const uncached = input - cached - written;
  const writeRate = rates.cacheWriteUsdPerToken ?? rates.inputUsdPerToken;
  const totalPico = uncached * picoPerToken(rates.inputUsdPerToken) + cached * picoPerToken(rates.cacheReadUsdPerToken) + written * picoPerToken(writeRate) + wholeTokens(outputTokens) * picoPerToken(rates.outputUsdPerToken);
  return Number((totalPico + 500_000n) / 1_000_000n);
}

/**
 * The provider's real cost for one turn: the cost the router reports for the call when it reports one (what the provider charged),
 * otherwise the live price times the counted tokens. Null when neither is known.
 */
export function rawCostForTurn({ reportedCostUsd = null, price = null, tokens = {} } = {}) {
  const reported = Number(reportedCostUsd);
  if (reportedCostUsd !== null && reportedCostUsd !== undefined && Number.isFinite(reported) && reported >= 0) {
    return { rawCostMicros: Math.round(reported * 1_000_000), source: "provider-reported" };
  }
  const fromPrice = rawCostMicrosFromPrice(price, tokens);
  return fromPrice === null ? null : { rawCostMicros: fromPrice, source: "live-price" };
}

/** Cost plus 10%, in micro-dollars and credits. The charge is the ledger's own debit for this cost, so nothing is marked up twice. */
export function thirdPartyCharge(rawCostMicros) {
  const raw = Math.max(0, Math.round(Number(rawCostMicros) || 0));
  const chargedMicros = calculateUnifiedLedgerDeductionMicros(raw);
  return { rawCostMicros: raw, upchargeMicros: chargedMicros - raw, chargedMicros, credits: chargedMicros / CREDIT_MICROS };
}
