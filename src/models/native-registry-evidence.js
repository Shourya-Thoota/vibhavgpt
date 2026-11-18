import {
  buildNativeCompatibilityInventory,
  INVENTORY_SOURCES,
} from "./inventory.js";

/**
 * Researched evidence for the five native tiers, layered on the repository's own
 * production-observed inventory (non-secret model ids, endpoint hosts, pinned
 * sub-provider lists). Everything here is PENDING: it prepares registry records and
 * prices, and approves nothing.
 *
 * What a date here means: SOURCE_RETRIEVED_AT is when a public page or API was read.
 * It is not a privacy-approval date, not a vendor effective date, and not a review.
 * Reviewer identities, approval dates, expiries and account entitlements are never
 * set here; they only come from the owner's evidence (see OWNER_EVIDENCE_REQUIRED).
 */

export const SOURCE_RETRIEVED_AT = "2026-10-31";
export const OPENROUTER_RETRIEVED_AT = "2026-10-31T00:23:23Z";
export const PRICING_VERSION_PREFIX = "native_2026_10_31";

const OPENROUTER_ENDPOINTS = (model) => `https://openrouter.ai/api/v1/models/${model}/endpoints`;
const OPENROUTER_PROVIDERS = "https://openrouter.ai/api/v1/providers";
const OPENROUTER_ROUTING_DOC = "https://openrouter.ai/docs/guides/routing/provider-selection";
const OPENROUTER_LOGGING_DOC = "https://openrouter.ai/docs/guides/privacy/logging";
const OPENROUTER_USAGE_DOC = "https://openrouter.ai/docs/guides/administration/usage-accounting";
const OPENAI_PRICING = "https://developers.openai.com/api/docs/pricing";
const OPENAI_DATA = "https://developers.openai.com/api/docs/guides/your-data";
const GROQ_MODELS = "https://console.groq.com/docs/models";
const GROQ_DATA = "https://console.groq.com/docs/your-data";
const GROQ_LIMITS = "https://console.groq.com/docs/rate-limits";

const usd = (value) => Math.round(Number(value) * 1_000_000);

/**
 * Sub-provider list prices (USD per 1M tokens) for the pinned router routes, read from
 * the router vendor's public endpoint listing on OPENROUTER_RETRIEVED_AT. The reservation
 * snapshot uses the highest price among the pinned providers; settlement uses the
 * provider-reported cost of each request, so the ceiling is never what a customer pays.
 */
const NOVA_SUB_PROVIDERS = Object.freeze({
  "morph/fp8": { input: 0.022, output: 0.192, cachedRead: 0.004 },
  "decart/fp4": { input: 0.09, output: 0.18, cachedRead: 0.018 },
  "sail-research/fp4": { input: 0.09, output: 0.25, cachedRead: 0.006 },
  "inference-net": { input: 0.174, output: 0.586, cachedRead: 0.006 },
  "deepinfra/fp8": { input: 0.14, output: 0.42, cachedRead: 0.0042 },
});
const NEBULA_SUB_PROVIDERS = Object.freeze({
  digitalocean: { input: 0.57, output: 2.4, cachedRead: 0.114 },
  "streamlake/fp8": { input: 0.5985, output: 2.52, cachedRead: 0.1008 },
  "coreweave/fp4": { input: 0.65, output: 3.41, cachedRead: 0.15 },
  "inceptron/int4": { input: 0.6825, output: 3.5, cachedRead: 0.1365 },
});
const ceilingOf = (table) => ({
  input: Math.max(...Object.values(table).map((rate) => rate.input)),
  output: Math.max(...Object.values(table).map((rate) => rate.output)),
  cachedRead: Math.max(...Object.values(table).map((rate) => rate.cachedRead)),
});

const NOVA_CEILING = ceilingOf(NOVA_SUB_PROVIDERS);
const NEBULA_CEILING = ceilingOf(NEBULA_SUB_PROVIDERS);

/**
 * Facts only the account owner can establish. Each names the exact setting, the tier it
 * affects and where to find it. Nothing here is guessed or filled in.
 */
export const OWNER_EVIDENCE_REQUIRED = Object.freeze([
  {
    id: "groq_plan_and_terms",
    tiers: ["lumen"],
    fact: "Which Groq plan the Lumen primary-stage key belongs to (Free or paid), and that the plan's terms allow serving customers.",
    where: "Groq console > Settings > Billing (plan), and the terms shown for that plan.",
    why: "Public docs do not state Free-plan billing or restrictions, so a zero platform cost for Lumen cannot be verified from them.",
  },
  {
    id: "groq_zero_data_retention",
    tiers: ["lumen"],
    fact: "Whether Zero Data Retention is switched on for the organization that owns the key (it is optional; default is no retention of inference requests).",
    where: "Groq console > Data Controls.",
    why: "Groq's retention page states ZDR is an organization setting; training use is not stated on that page.",
  },
  {
    id: "lumen_gateway_provider",
    tiers: ["lumen"],
    fact: "The gateway stage provider's published price and its training and retention terms for the pinned model.",
    where: "The gateway provider's dashboard or terms for the account in use.",
    why: "Its public site could not be read, so there is no source for either its price or its privacy terms.",
  },
  {
    id: "openai_data_controls",
    tiers: ["study", "vesper"],
    fact: "The Data controls state of the OpenAI organization or project whose key is used: whether Zero Data Retention or Modified Abuse Monitoring is approved and applied, and that sharing options stay off.",
    where: "OpenAI platform > Settings > Organization > Data controls (and the project's setting).",
    why: "OpenAI states ZDR needs prior approval and is configured per organization or project, so the live state cannot be read from public pages.",
  },
  {
    id: "openrouter_account_privacy",
    tiers: ["nova", "nebula"],
    fact: "The router account's privacy settings: the training opt-out for paid models, and whether prompt and response logging is on.",
    where: "OpenRouter > Settings > Privacy.",
    why: "These are account settings. Per-request routing uses data_collection: deny, but the vendor's own prompt logging is not described in its public docs.",
  },
]);

const owned = (ids) => OWNER_EVIDENCE_REQUIRED.filter((item) => ids.includes(item.id)).map((item) => item.id);

function pricingFrom({ tier, endpointKey, rates, basis, sources, limitations, confidence, effectiveFrom = `${SOURCE_RETRIEVED_AT}T00:00:00Z`, verifiedContextTokens = null }) {
  return {
    endpointKey,
    pricingVersionId: `${PRICING_VERSION_PREFIX}_${tier}`,
    effectiveFrom,
    currency: "USD",
    billingUnit: "usd_per_1m_tokens",
    inputPriceMicrosPerM: usd(rates.input),
    outputPriceMicrosPerM: usd(rates.output),
    cachedReadPriceMicrosPerM: usd(rates.cachedRead ?? rates.input),
    reasoningIncludedInOutput: true,
    pricingConfidence: confidence,
    provenance: `${basis}; sources: ${sources.join(" | ")}; retrieved ${SOURCE_RETRIEVED_AT}${verifiedContextTokens ? `; verified for context up to ${verifiedContextTokens} tokens` : ""}; limitations: ${limitations.join(" ")}`,
  };
}

const TIER_EVIDENCE = {
  lumen: {
    pricing: [
      pricingFrom({
        tier: "lumen",
        endpointKey: "primaryFree|primaryFree",
        rates: { input: 0, output: 0, cachedRead: 0 },
        basis: "owner_policy_customer_rate_zero (APPROVED_FREE_MODEL_GROUP); upstream list price is not a customer charge",
        sources: [GROQ_MODELS],
        confidence: "owner_policy",
        limitations: ["The customer rate is zero by owner policy, not by vendor pricing.", "Upstream list price for openai/gpt-oss-20b is $0.075 input and $0.30 output per 1M tokens; whether the account pays it depends on its plan (owner evidence groq_plan_and_terms)."],
      }),
    ],
    evidence: {
      sources: [
        { url: GROQ_MODELS, retrievedAt: SOURCE_RETRIEVED_AT, facts: "openai/gpt-oss-20b list price $0.075 input and $0.30 output per 1M tokens; context 131,072; max completion 65,536; cached input price not stated; Developer plan limits shown, free plan limits not stated." },
        { url: GROQ_DATA, retrievedAt: SOURCE_RETRIEVED_AT, facts: "By default no retention of inference requests; usage metadata kept and holds no inputs or outputs; reliability and abuse logs up to 30 days; Zero Data Retention can be enabled by organization admins in Data Controls; training use not stated on the page." },
        { url: GROQ_LIMITS, retrievedAt: SOURCE_RETRIEVED_AT, facts: "Free and Developer plans exist; Free-plan billing and restrictions are not stated in the retrieved content." },
      ],
      limitations: ["Only the primary stage is priced. The gateway stage has no readable price or privacy source, and the secondary and reserve stages are not approved by the owner's configuration, so they are disabled and unpriced."],
      ownerEvidenceRequired: owned(["groq_plan_and_terms", "groq_zero_data_retention", "lumen_gateway_provider"]),
    },
  },
  nova: {
    pricing: [
      pricingFrom({
        tier: "nova",
        endpointKey: "paid|router",
        rates: NOVA_CEILING,
        basis: "official_published_rates; reservation ceiling = highest list price among the pinned sub-providers",
        sources: [OPENROUTER_ENDPOINTS("deepseek/deepseek-v4.1-flash"), OPENROUTER_USAGE_DOC],
        confidence: "verified_ceiling",
        limitations: ["Prices are list prices at retrieval time; the vendor's effective date is not published.", "The served sub-provider varies per request (sorted by price within the pinned list), so settlement uses the provider-reported cost of each request.", "deepinfra/fp8 lists a 0.3 discount field; the list price is used as the conservative ceiling."],
      }),
    ],
    evidence: {
      sources: [
        { url: OPENROUTER_ENDPOINTS("deepseek/deepseek-v4.1-flash"), retrievedAt: OPENROUTER_RETRIEVED_AT, facts: "Per-sub-provider list prices (see subProviderRates); a bare slug such as inference-net matches both its listed variants at the same price." },
        { url: OPENROUTER_PROVIDERS, retrievedAt: OPENROUTER_RETRIEVED_AT, facts: "Each provider's privacy policy and terms URLs." },
        { url: OPENROUTER_ROUTING_DOC, retrievedAt: SOURCE_RETRIEVED_AT, facts: "data_collection: deny means use only providers which do not collect user data (default allow); a bare provider slug matches all of that provider's variants." },
        { url: OPENROUTER_LOGGING_DOC, retrievedAt: SOURCE_RETRIEVED_AT, facts: "Account setting controls routing to training providers; the vendor's own prompt logging is not described." },
        { url: OPENROUTER_USAGE_DOC, retrievedAt: SOURCE_RETRIEVED_AT, facts: "usage.cost (credits) is included in every response and in the last streaming message; cached and reasoning token details are included." },
      ],
      subProviderRates: NOVA_SUB_PROVIDERS,
      limitations: ["Vendor-published provider data policies behind data_collection: deny are not independently audited here."],
      ownerEvidenceRequired: owned(["openrouter_account_privacy"]),
    },
  },
  nebula: {
    pricing: [
      pricingFrom({
        tier: "nebula",
        endpointKey: "paid|router",
        rates: NEBULA_CEILING,
        basis: "official_published_rates; reservation ceiling = highest list price among the pinned sub-providers that list this model",
        sources: [OPENROUTER_ENDPOINTS("moonshotai/kimi-k2.6"), OPENROUTER_USAGE_DOC],
        confidence: "verified_ceiling",
        limitations: ["Prices are list prices at retrieval time; the vendor's effective date is not published.", "The pinned provider decart/fp4 lists no endpoint for this model, so it can never serve it.", "streamlake/fp8 lists a 0.37 discount field; the list price is used as the conservative ceiling.", "The served sub-provider varies per request, so settlement uses the provider-reported cost."],
      }),
    ],
    evidence: {
      sources: [
        { url: OPENROUTER_ENDPOINTS("moonshotai/kimi-k2.6"), retrievedAt: OPENROUTER_RETRIEVED_AT, facts: "Per-sub-provider list prices (see subProviderRates)." },
        { url: OPENROUTER_PROVIDERS, retrievedAt: OPENROUTER_RETRIEVED_AT, facts: "Each provider's privacy policy and terms URLs." },
        { url: OPENROUTER_ROUTING_DOC, retrievedAt: SOURCE_RETRIEVED_AT, facts: "data_collection: deny means use only providers which do not collect user data." },
        { url: OPENROUTER_USAGE_DOC, retrievedAt: SOURCE_RETRIEVED_AT, facts: "usage.cost is included in every response." },
      ],
      subProviderRates: NEBULA_SUB_PROVIDERS,
      limitations: ["Vendor-published provider data policies behind data_collection: deny are not independently audited here."],
      ownerEvidenceRequired: owned(["openrouter_account_privacy"]),
    },
  },
  study: {
    pricing: [
      pricingFrom({
        tier: "study",
        endpointKey: "study|direct",
        rates: { input: 0.1, output: 0.5, cachedRead: 0.01 },
        basis: "official_published_rates (standard tier)",
        sources: [OPENAI_PRICING],
        confidence: "verified",
        verifiedContextTokens: 272_000,
        limitations: ["Rates are stated for context up to 272K tokens; longer contexts are not covered.", "The page does not say whether reasoning tokens are billed as output; they are counted inside output tokens here.", "Batch, flex and fast tiers differ and are not used (no service tier is requested).", "Regional endpoints carry a 10% uplift for models released on or after 2026-03-05; whether this model falls under it is not stated, and regional endpoints are not used."],
      }),
    ],
    evidence: {
      sources: [
        { url: OPENAI_PRICING, retrievedAt: SOURCE_RETRIEVED_AT, facts: "gpt-6-luna standard: $0.10 input, $0.01 cached input, $0.50 output per 1M tokens (short context up to 272K)." },
        { url: OPENAI_DATA, retrievedAt: SOURCE_RETRIEVED_AT, facts: "API data is not used to train models by default; abuse-monitoring logs are kept up to 30 days; Zero Data Retention needs prior approval and is set per organization or project; with ZDR the store parameter is treated as false." },
      ],
      limitations: [],
      ownerEvidenceRequired: owned(["openai_data_controls"]),
    },
  },
  vesper: {
    pricing: [
      pricingFrom({
        tier: "vesper",
        endpointKey: "direct|direct",
        rates: { input: 1.0, output: 5.0, cachedRead: 0.05 },
        basis: "official_published_rates (standard tier)",
        sources: [OPENAI_PRICING],
        confidence: "verified",
        verifiedContextTokens: 272_000,
        limitations: ["Rates are stated for context up to 272K tokens; longer contexts are not covered.", "The page does not say whether reasoning tokens are billed as output; they are counted inside output tokens here.", "Batch, flex and fast tiers differ and are not used (no service tier is requested).", "The same regional-endpoint uplift note applies and regional endpoints are not used."],
      }),
    ],
    evidence: {
      sources: [
        { url: OPENAI_PRICING, retrievedAt: SOURCE_RETRIEVED_AT, facts: "gpt-6.1-terra standard: $1.00 input, $0.05 cached input, $5.00 output per 1M tokens (short context up to 272K)." },
        { url: OPENAI_DATA, retrievedAt: SOURCE_RETRIEVED_AT, facts: "Same data controls as above; requests use store=false." },
      ],
      limitations: ["The alternate router route for this tier is disabled and unpriced: the configured transport is direct, and the router is never an automatic fallback."],
      ownerEvidenceRequired: owned(["openai_data_controls"]),
    },
  },
};

const ENDPOINT_KEY = (endpoint) => `${endpoint.providerName}|${endpoint.transportType}`;

/**
 * The desired registry: the repository inventory (pending by construction) plus the
 * researched pricing snapshots and evidence. Approval fields are forced to a neutral
 * pending shape; nothing is carried over from configuration flags as an approval.
 */
export function buildDesiredNativeRegistry({ inventory = null } = {}) {
  const base = inventory ?? buildNativeCompatibilityInventory({ source: INVENTORY_SOURCES.PRODUCTION_OBSERVED });
  return base.map((item) => {
    const tier = item.family.slug.split("/").pop();
    const evidence = TIER_EVIDENCE[tier];
    return {
      family: { ...item.family },
      version: {
        ...item.version,
        lifecycleState: "candidate",
        metadata: {
          ...(item.version.metadata ?? {}),
          pricingEvidence: evidence ? { retrievedAt: SOURCE_RETRIEVED_AT, sources: evidence.sources, limitations: evidence.limitations, subProviderRates: evidence.subProviderRates ?? null } : null,
          ownerEvidenceRequired: evidence?.ownerEvidenceRequired ?? [],
          approvalStatus: "pending_owner_evidence",
        },
      },
      endpoints: item.endpoints.map((endpoint) => {
        const { pricing, privacyReview, endpointState, ...rest } = endpoint;
        return {
          ...rest,
          // Pending shape. A configuration flag is not a review, so no reviewer or audit
          // reference is recorded, and training policy stays unknown until the owner's evidence.
          privacyReview: { privacyApproved: false, trainingPolicy: "unknown", dataRetentionDays: null, zeroDataRetention: false, auditRef: null, reviewedBy: null, scope: "default" },
          endpointState: endpointState === "disabled" ? "disabled" : "candidate",
          pricingSnapshots: (evidence?.pricing ?? []).filter((snapshot) => snapshot.endpointKey === ENDPOINT_KEY(endpoint)),
        };
      }),
    };
  });
}
