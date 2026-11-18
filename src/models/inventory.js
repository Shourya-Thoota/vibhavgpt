import { calculateConsumptionScore } from "./consumption.js";

/**
 * Source categories for model compatibility inventory.
 */
export const INVENTORY_SOURCES = Object.freeze({
  PRODUCTION_OBSERVED: "production_observed",
  LOCAL_CONFIGURATION: "local_configuration",
  REPOSITORY_DEFAULTS: "repository_defaults",
  TEST_FIXTURE: "test_fixture",
});

/**
 * Statically documented architecture metadata for the 5 native families.
 * Family metadata contains NO runtime endpoints, NO credentials, and NO invented model pins.
 */
export const NATIVE_FAMILY_ARCHITECTURES = Object.freeze({
  lumen: {
    slug: "vibhavgpt/lumen",
    displayName: "VibhavGPT Lumen",
    familyGroup: "native",
    description: "Lightweight, simple tasks with independent multi-stage reserve fallback.",
    sortOrder: 10,
    planEligibility: "free",
    documentedCapabilities: {
      vision: false,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      contextWindowTokens: 131_072,
      maxOutputTokens: 8_192,
      reasoningSupported: false,
    },
    aliases: ["spark", "lumen"],
  },
  nova: {
    slug: "vibhavgpt/nova",
    displayName: "VibhavGPT Nova",
    familyGroup: "native",
    description: "Fast, general-purpose help with balanced reasoning capacity.",
    sortOrder: 20,
    planEligibility: "free",
    documentedCapabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 65_536,
      reasoningSupported: true,
      reasoningModes: ["low", "normal"],
    },
    aliases: ["nova"],
  },
  study: {
    slug: "vibhavgpt/study",
    displayName: "VibhavGPT Study",
    familyGroup: "native",
    description: "Specialized academic, research, and analysis workflows with direct enterprise inference.",
    sortOrder: 30,
    planEligibility: "paid",
    documentedCapabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
      reasoningSupported: false,
    },
    aliases: ["study"],
  },
  nebula: {
    slug: "vibhavgpt/nebula",
    displayName: "VibhavGPT Nebula",
    familyGroup: "native",
    description: "Demanding, high-complexity reasoning and analytical work.",
    sortOrder: 40,
    planEligibility: "paid",
    documentedCapabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      reasoningSupported: true,
      reasoningModes: ["low", "normal", "high"],
    },
    aliases: ["ultra", "nebula"],
  },
  vesper: {
    slug: "vibhavgpt/vesper",
    displayName: "VibhavGPT Vulcan",
    familyGroup: "native",
    description: "Flagship assistant with highest reasoning capacity for complex problems.",
    sortOrder: 50,
    planEligibility: "pro_only",
    documentedCapabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 64_000,
      reasoningSupported: true,
      reasoningModes: ["low", "normal", "high"],
    },
    aliases: ["vesper"],
  },
});

/**
 * Verified production configuration observation snapshot.
 * Observed via read-only allowlisted Railway environment inspection.
 * Stated observation timestamp: 2026-10-29T17:20:04-04:00 (2026-10-29T21:20:04Z).
 * Contains strictly non-secret model identities, base URLs, and approval pins.
 */
export const VERIFIED_PRODUCTION_OBSERVATION = Object.freeze({
  source: INVENTORY_SOURCES.PRODUCTION_OBSERVED,
  observationTime: "2026-10-29T17:20:04-04:00",
  verifiedBy: "railway_service_inspection:vibhavgpt",
  models: Object.freeze({
    lumenPrimary: "openai/gpt-oss-20b",
    lumenFallback1: "qwen/qwen3.7-flash",
    lumenFallback2: "Qwen/Qwen3-4B",
    lumenFallback3: "gemini-3.5-flash-lite",
    nova: "deepseek/deepseek-v4.1-flash",
    study: "gpt-6-luna",
    nebula: "moonshotai/kimi-k2.6",
    vesperDirect: "gpt-6.1-terra",
    vesperRouter: "x-ai/grok-4.7",
  }),
  endpoints: Object.freeze({
    primaryFree: "https://api.groq.com/openai/v1",
    gatewayFree: "https://api.bazaarlink.ai/v1",
    secondaryFree: "https://api.bytez.com/models/v2/openai/v1",
    reserveFree: "https://generativelanguage.googleapis.com/v1beta/openai",
    novaRouter: "https://openrouter.ai/api/v1",
    studyDirect: "https://api.openai.com/v1",
    nebulaRouter: "https://openrouter.ai/api/v1",
    vesperDirect: "https://api.openai.com/v1",
    vesperRouter: "https://openrouter.ai/api/v1",
  }),
  approvals: Object.freeze({
    lumenPrimary: Object.freeze({ approved: true, pinnedModel: "openai/gpt-oss-20b" }),
    lumenGateway: Object.freeze({ approved: true, pinnedModel: "qwen/qwen3.7-flash" }),
    lumenSecondary: Object.freeze({ approved: false, pinnedModel: "Qwen/Qwen3-4B" }),
    lumenReserve: Object.freeze({ approved: false, pinnedModel: null }),
    novaRouteProviders: Object.freeze([
      "decart/fp4",
      "inference-net",
      "sail-research/fp4",
      "morph/fp8",
      "deepinfra/fp8",
    ]),
    studyDirectContract: Object.freeze({ approved: true, directOnly: true }),
    nebulaVerified: true,
    nebulaRouteProviders: Object.freeze([
      "inceptron/int4",
      "digitalocean",
      "decart/fp4",
      "streamlake/fp8",
      "coreweave/fp4",
    ]),
    vesperTransport: "direct",
    vesperDataPolicyVerified: true,
  }),
});

/**
 * Normalizes and validates an explicit configuration snapshot.
 * Ensures credentials and secrets are stripped and source boundaries are enforced.
 */
export function createConfigurationSnapshot(raw = {}, {
  source = INVENTORY_SOURCES.LOCAL_CONFIGURATION,
  observationTime = null,
} = {}) {
  const models = raw.models || raw.chatModels || {};
  const endpoints = raw.endpoints || raw.providerBaseUrls || {};
  const approvals = raw.approvals || {};

  return {
    source,
    observationTime: observationTime || (source === INVENTORY_SOURCES.PRODUCTION_OBSERVED ? new Date().toISOString() : null),
    models: {
      lumenPrimary: models.lumenPrimary || models.lumen || null,
      lumenFallback1: models.lumenFallback1 || null,
      lumenFallback2: models.lumenFallback2 || null,
      lumenFallback3: models.lumenFallback3 || null,
      nova: models.nova || null,
      study: models.study || null,
      nebula: models.nebula || null,
      vesperDirect: models.vesperDirect || null,
      vesperRouter: models.vesper || null,
    },
    endpoints: {
      primaryFree: endpoints.primaryFree || null,
      gatewayFree: endpoints.gatewayFree || null,
      secondaryFree: endpoints.secondaryFree || null,
      reserveFree: endpoints.reserveFree || null,
      novaRouter: endpoints.novaRouter || endpoints.paid || null,
      studyDirect: endpoints.studyDirect || endpoints.study || null,
      nebulaRouter: endpoints.nebulaRouter || endpoints.paid || null,
      vesperDirect: endpoints.vesperDirect || endpoints.direct || null,
      vesperRouter: endpoints.vesperRouter || endpoints.paid || null,
    },
    approvals: {
      lumenPrimary: {
        approved: Boolean(approvals.lumenPrimary?.approved ?? raw.lumenPrimaryApproved),
        pinnedModel: approvals.lumenPrimary?.pinnedModel ?? raw.lumenApprovals?.primaryModel ?? null,
      },
      lumenGateway: {
        approved: Boolean(approvals.lumenGateway?.approved ?? raw.lumenApprovals?.gateway?.approved),
        pinnedModel: approvals.lumenGateway?.pinnedModel ?? raw.lumenApprovals?.gateway?.model ?? null,
      },
      lumenSecondary: {
        approved: Boolean(approvals.lumenSecondary?.approved ?? raw.lumenApprovals?.secondary?.approved),
        pinnedModel: approvals.lumenSecondary?.pinnedModel ?? raw.lumenApprovals?.secondary?.model ?? null,
      },
      lumenReserve: {
        approved: Boolean(approvals.lumenReserve?.approved ?? raw.lumenApprovals?.reserve?.approved),
        pinnedModel: approvals.lumenReserve?.pinnedModel ?? raw.lumenApprovals?.reserve?.model ?? null,
      },
      novaRouteProviders: approvals.novaRouteProviders || raw.routeProviders?.nova || [],
      studyDirectContract: approvals.studyDirectContract || { approved: Boolean(models.study && endpoints.studyDirect) },
      nebulaVerified: Boolean(approvals.nebulaVerified ?? raw.nebulaDataPolicyVerified),
      nebulaRouteProviders: approvals.nebulaRouteProviders || raw.routeProviders?.nebula || [],
      vesperTransport: String(approvals.vesperTransport || raw.vesperTransport || "direct").toLowerCase(),
      vesperDataPolicyVerified: Boolean(approvals.vesperDataPolicyVerified ?? raw.vesperDataPolicyVerified),
    },
  };
}

/**
 * Builds the compatibility inventory for the 5 native model families.
 *
 * Strict Grounding & Source Isolation Rules:
 * 1. Accepts an explicit configuration snapshot. Does NOT silently read test/setup-env.js or process.env.
 * 2. Missing values remain missing (null). No invented fallback strings.
 * 3. Configured approval flags do NOT automatically become registry privacy approvals.
 * 4. Vulcan direct and router configurations are selectable alternatives; router is NOT an automatic fallback.
 * 5. Fixtures are explicitly identified as fixtures.
 */
export function buildNativeCompatibilityInventory(options = {}) {
  let snapshot;
  let source;

  if (options.snapshot) {
    source = options.source || options.snapshot.source || INVENTORY_SOURCES.LOCAL_CONFIGURATION;
    snapshot = options.snapshot;
  } else if (options.source === INVENTORY_SOURCES.PRODUCTION_OBSERVED) {
    source = INVENTORY_SOURCES.PRODUCTION_OBSERVED;
    snapshot = VERIFIED_PRODUCTION_OBSERVATION;
  } else if (options.isFixture || options.source === INVENTORY_SOURCES.TEST_FIXTURE) {
    source = INVENTORY_SOURCES.TEST_FIXTURE;
    snapshot = createConfigurationSnapshot(options.rawConfig || {}, {
      source: INVENTORY_SOURCES.TEST_FIXTURE,
      observationTime: options.observationTime || new Date().toISOString(),
    });
  } else {
    source = options.source || INVENTORY_SOURCES.REPOSITORY_DEFAULTS;
    snapshot = createConfigurationSnapshot({}, { source });
  }

  const observationTime = options.observationTime || snapshot.observationTime || null;
  const isFixture = source === INVENTORY_SOURCES.TEST_FIXTURE;

  const baseEvidence = {
    source,
    observationTime,
    configuredIsNotLiveTested: true,
    approvalFlagsAreConfigOnly: true,
    repositoryPricesUnverified: true,
    isFixture,
    fixturesExcluded: !isFixture,
  };

  // 1. Lumen (Lightweight, multi-stage reserve fallback across 4 independent providers)
  const lumenPrimaryModel = snapshot.models.lumenPrimary;
  const lumenPrimaryPinned = snapshot.approvals.lumenPrimary?.pinnedModel;
  const lumenPrimaryPinMatch = Boolean(
    lumenPrimaryModel && (!lumenPrimaryPinned || lumenPrimaryPinned === lumenPrimaryModel),
  );
  const lumenPrimaryConfigApproved = Boolean(
    snapshot.approvals.lumenPrimary?.approved && lumenPrimaryPinMatch,
  );

  const lumenGatewayModel = snapshot.models.lumenFallback1;
  const lumenGatewayPinned = snapshot.approvals.lumenGateway?.pinnedModel;
  const lumenGatewayPinMatch = Boolean(
    lumenGatewayModel && lumenGatewayPinned && lumenGatewayPinned === lumenGatewayModel,
  );
  const lumenGatewayConfigApproved = Boolean(
    snapshot.approvals.lumenGateway?.approved && lumenGatewayPinMatch,
  );

  const lumenSecondaryModel = snapshot.models.lumenFallback2;
  const lumenSecondaryPinned = snapshot.approvals.lumenSecondary?.pinnedModel;
  const lumenSecondaryPinMatch = Boolean(
    lumenSecondaryModel && lumenSecondaryPinned && lumenSecondaryPinned === lumenSecondaryModel,
  );
  const lumenSecondaryConfigApproved = Boolean(
    snapshot.approvals.lumenSecondary?.approved && lumenSecondaryPinMatch,
  );

  const lumenReserveModel = snapshot.models.lumenFallback3;
  const lumenReservePinned = snapshot.approvals.lumenReserve?.pinnedModel;
  const lumenReservePinMatch = Boolean(
    lumenReserveModel && lumenReservePinned && lumenReservePinned === lumenReserveModel,
  );
  const lumenReserveConfigApproved = Boolean(
    snapshot.approvals.lumenReserve?.approved && lumenReservePinMatch,
  );

  const lumenFamily = {
    family: {
      slug: NATIVE_FAMILY_ARCHITECTURES.lumen.slug,
      displayName: NATIVE_FAMILY_ARCHITECTURES.lumen.displayName,
      familyGroup: NATIVE_FAMILY_ARCHITECTURES.lumen.familyGroup,
      description: NATIVE_FAMILY_ARCHITECTURES.lumen.description,
      sortOrder: NATIVE_FAMILY_ARCHITECTURES.lumen.sortOrder,
    },
    version: {
      versionTag: lumenPrimaryModel || "unconfigured",
      aliases: NATIVE_FAMILY_ARCHITECTURES.lumen.aliases,
      capabilitiesDocumented: NATIVE_FAMILY_ARCHITECTURES.lumen.documentedCapabilities,
      planEligibility: NATIVE_FAMILY_ARCHITECTURES.lumen.planEligibility,
      lifecycleState: "candidate",
      metadata: { evidence: baseEvidence },
    },
    endpoints: [
      {
        providerName: "primaryFree",
        transportType: "primaryFree",
        adapterType: "chat_completions",
        endpointUrl: snapshot.endpoints.primaryFree,
        model: lumenPrimaryModel,
        capabilitiesVerified: { streaming: true, tools: false, vision: false },
        operatorConfig: {
          configuredFlag: snapshot.approvals.lumenPrimary?.approved === true,
          pinnedModel: lumenPrimaryPinned,
          pinMatches: lumenPrimaryPinMatch,
          scope: "environment_variable",
        },
        privacyReview: {
          privacyApproved: false, // Registry approval requires audited verification, not environment config flag
          trainingPolicy: "unknown",
          dataRetentionDays: null,
          zeroDataRetention: false,
          auditRef: "env:CHAT_LUMEN_PRIMARY_APPROVED",
          reviewedBy: "operator_configuration_flag",
          registryApprovalState: "pending_audit",
        },
        endpointState: "candidate",
        sortPriority: 1,
        pricing: {
          pricingVersionId: "unverified",
          currency: "USD",
          billingUnit: "usd_per_1m_tokens",
          inputPriceMicrosPerM: null,
          outputPriceMicrosPerM: null,
          calculatedMu: null,
          consumptionCategory: "pending",
          pricingConfidence: "unknown",
          provenance: "unverified",
        },
      },
      {
        providerName: "gatewayFree",
        transportType: "gatewayFree",
        adapterType: "chat_completions",
        endpointUrl: snapshot.endpoints.gatewayFree,
        model: lumenGatewayModel,
        capabilitiesVerified: { streaming: true, tools: false, vision: false },
        operatorConfig: {
          configuredFlag: snapshot.approvals.lumenGateway?.approved === true,
          pinnedModel: lumenGatewayPinned,
          pinMatches: lumenGatewayPinMatch,
          scope: "environment_variable",
        },
        privacyReview: {
          privacyApproved: false,
          trainingPolicy: "unknown",
          dataRetentionDays: null,
          zeroDataRetention: false,
          auditRef: "env:CHAT_LUMEN_GATEWAY_APPROVED",
          reviewedBy: "operator_configuration_flag",
          registryApprovalState: "pending_audit",
        },
        endpointState: "candidate",
        sortPriority: 2,
        pricing: {
          pricingVersionId: "unverified",
          currency: "USD",
          billingUnit: "usd_per_1m_tokens",
          inputPriceMicrosPerM: null,
          outputPriceMicrosPerM: null,
          calculatedMu: null,
          consumptionCategory: "pending",
          pricingConfidence: "unknown",
          provenance: "unverified",
        },
      },
      {
        providerName: "secondaryFree",
        transportType: "secondaryFree",
        adapterType: "chat_completions",
        endpointUrl: snapshot.endpoints.secondaryFree,
        model: lumenSecondaryModel,
        capabilitiesVerified: { streaming: true, tools: false, vision: false },
        operatorConfig: {
          configuredFlag: snapshot.approvals.lumenSecondary?.approved === true,
          pinnedModel: lumenSecondaryPinned,
          pinMatches: lumenSecondaryPinMatch,
          scope: "environment_variable",
        },
        privacyReview: {
          privacyApproved: false,
          trainingPolicy: "unknown",
          dataRetentionDays: null,
          zeroDataRetention: false,
          auditRef: "env:CHAT_LUMEN_SECONDARY_APPROVED",
          reviewedBy: null,
          registryApprovalState: "unapproved", // Explicitly unapproved in production
        },
        endpointState: "disabled",
        sortPriority: 3,
        pricing: {
          pricingVersionId: "unverified",
          currency: "USD",
          billingUnit: "usd_per_1m_tokens",
          inputPriceMicrosPerM: null,
          outputPriceMicrosPerM: null,
          calculatedMu: null,
          consumptionCategory: "pending",
          pricingConfidence: "unknown",
          provenance: "unverified",
        },
      },
      {
        providerName: "reserveFree",
        transportType: "reserveFree",
        adapterType: "chat_completions",
        endpointUrl: snapshot.endpoints.reserveFree,
        model: lumenReserveModel,
        capabilitiesVerified: { streaming: true, tools: false, vision: false },
        operatorConfig: {
          configuredFlag: snapshot.approvals.lumenReserve?.approved === true,
          pinnedModel: lumenReservePinned,
          pinMatches: lumenReservePinMatch,
          scope: "environment_variable",
        },
        privacyReview: {
          privacyApproved: false,
          trainingPolicy: "unknown",
          dataRetentionDays: null,
          zeroDataRetention: false,
          auditRef: "env:CHAT_LUMEN_RESERVE_APPROVED",
          reviewedBy: null,
          registryApprovalState: "unapproved", // Explicitly unapproved in production
        },
        endpointState: "disabled",
        sortPriority: 4,
        pricing: {
          pricingVersionId: "unverified",
          currency: "USD",
          billingUnit: "usd_per_1m_tokens",
          inputPriceMicrosPerM: null,
          outputPriceMicrosPerM: null,
          calculatedMu: null,
          consumptionCategory: "pending",
          pricingConfidence: "unknown",
          provenance: "unverified",
        },
      },
    ],
  };

  // 2. Nova (Fast general-purpose assistant via Router allowlist)
  const novaModel = snapshot.models.nova;
  const novaAllowlist = snapshot.approvals.novaRouteProviders || [];
  const novaFamily = {
    family: {
      slug: NATIVE_FAMILY_ARCHITECTURES.nova.slug,
      displayName: NATIVE_FAMILY_ARCHITECTURES.nova.displayName,
      familyGroup: NATIVE_FAMILY_ARCHITECTURES.nova.familyGroup,
      description: NATIVE_FAMILY_ARCHITECTURES.nova.description,
      sortOrder: NATIVE_FAMILY_ARCHITECTURES.nova.sortOrder,
    },
    version: {
      versionTag: novaModel || "unconfigured",
      aliases: NATIVE_FAMILY_ARCHITECTURES.nova.aliases,
      capabilitiesDocumented: NATIVE_FAMILY_ARCHITECTURES.nova.documentedCapabilities,
      planEligibility: NATIVE_FAMILY_ARCHITECTURES.nova.planEligibility,
      lifecycleState: "candidate",
      metadata: { evidence: baseEvidence },
    },
    endpoints: [
      {
        providerName: "paid",
        transportType: "router",
        adapterType: "chat_completions",
        endpointUrl: snapshot.endpoints.novaRouter,
        model: novaModel,
        capabilitiesVerified: { streaming: true, tools: true, vision: true, reasoningSupported: true },
        operatorConfig: {
          configuredFlag: novaAllowlist.length > 0,
          allowlistCount: novaAllowlist.length,
          allowlist: [...novaAllowlist],
          scope: "router_policy_allowlist",
        },
        privacyReview: {
          privacyApproved: false,
          trainingPolicy: "denied",
          dataRetentionDays: null,
          zeroDataRetention: false,
          auditRef: "env:CHAT_NOVA_ROUTE_PROVIDERS",
          reviewedBy: "router_policy_allowlist",
          registryApprovalState: "pending_audit",
        },
        endpointState: "candidate",
        sortPriority: 1,
        pricing: {
          pricingVersionId: "unverified",
          currency: "USD",
          billingUnit: "usd_per_1m_tokens",
          inputPriceMicrosPerM: null,
          outputPriceMicrosPerM: null,
          calculatedMu: null,
          consumptionCategory: "pending",
          pricingConfidence: "unknown",
          provenance: "unverified",
        },
      },
    ],
  };

  // 3. Study (Specialized academic/analysis workflows via Direct endpoint)
  const studyModel = snapshot.models.study;
  const studyDirectUrl = snapshot.endpoints.studyDirect;
  const studyFamily = {
    family: {
      slug: NATIVE_FAMILY_ARCHITECTURES.study.slug,
      displayName: NATIVE_FAMILY_ARCHITECTURES.study.displayName,
      familyGroup: NATIVE_FAMILY_ARCHITECTURES.study.familyGroup,
      description: NATIVE_FAMILY_ARCHITECTURES.study.description,
      sortOrder: NATIVE_FAMILY_ARCHITECTURES.study.sortOrder,
    },
    version: {
      versionTag: studyModel || "unconfigured",
      aliases: NATIVE_FAMILY_ARCHITECTURES.study.aliases,
      capabilitiesDocumented: NATIVE_FAMILY_ARCHITECTURES.study.documentedCapabilities,
      planEligibility: NATIVE_FAMILY_ARCHITECTURES.study.planEligibility,
      lifecycleState: "candidate",
      metadata: { evidence: baseEvidence },
    },
    endpoints: [
      {
        providerName: "study",
        transportType: "direct", // Direct endpoint connection, NOT router
        adapterType: "chat_completions",
        endpointUrl: studyDirectUrl,
        model: studyModel,
        capabilitiesVerified: { streaming: true, tools: true, vision: true, reasoningSupported: false },
        operatorConfig: {
          configuredFlag: Boolean(studyModel && studyDirectUrl),
          scope: "direct_enterprise_contract",
        },
        privacyReview: {
          privacyApproved: false,
          trainingPolicy: "training_excluded",
          dataRetentionDays: 30,
          zeroDataRetention: false,
          auditRef: "env:INFERENCE_DIRECT_BASE_URL",
          reviewedBy: "operator_configured",
          registryApprovalState: "pending_audit",
        },
        endpointState: "candidate",
        sortPriority: 1,
        pricing: {
          pricingVersionId: "unverified",
          currency: "USD",
          billingUnit: "usd_per_1m_tokens",
          inputPriceMicrosPerM: null,
          outputPriceMicrosPerM: null,
          calculatedMu: null,
          consumptionCategory: "pending",
          pricingConfidence: "unknown",
          provenance: "unverified",
        },
      },
    ],
  };

  // 4. Nebula (Demanding reasoning workflows via Router allowlist)
  const nebulaModel = snapshot.models.nebula;
  const nebulaAllowlist = snapshot.approvals.nebulaRouteProviders || [];
  const nebulaVerified = snapshot.approvals.nebulaVerified === true;
  const nebulaFamily = {
    family: {
      slug: NATIVE_FAMILY_ARCHITECTURES.nebula.slug,
      displayName: NATIVE_FAMILY_ARCHITECTURES.nebula.displayName,
      familyGroup: NATIVE_FAMILY_ARCHITECTURES.nebula.familyGroup,
      description: NATIVE_FAMILY_ARCHITECTURES.nebula.description,
      sortOrder: NATIVE_FAMILY_ARCHITECTURES.nebula.sortOrder,
    },
    version: {
      versionTag: nebulaModel || "unconfigured",
      aliases: NATIVE_FAMILY_ARCHITECTURES.nebula.aliases,
      capabilitiesDocumented: NATIVE_FAMILY_ARCHITECTURES.nebula.documentedCapabilities,
      planEligibility: NATIVE_FAMILY_ARCHITECTURES.nebula.planEligibility,
      lifecycleState: "candidate",
      metadata: { evidence: baseEvidence },
    },
    endpoints: [
      {
        providerName: "paid",
        transportType: "router",
        adapterType: "chat_completions",
        endpointUrl: snapshot.endpoints.nebulaRouter,
        model: nebulaModel,
        capabilitiesVerified: { streaming: true, tools: true, vision: true, reasoningSupported: true },
        operatorConfig: {
          configuredFlag: Boolean(nebulaVerified && nebulaAllowlist.length > 0),
          dataPolicyVerified: nebulaVerified,
          allowlistCount: nebulaAllowlist.length,
          allowlist: [...nebulaAllowlist],
          scope: "router_policy_allowlist",
        },
        privacyReview: {
          privacyApproved: false,
          trainingPolicy: "denied",
          dataRetentionDays: null,
          zeroDataRetention: false,
          auditRef: "env:CHAT_NEBULA_DATA_POLICY_VERIFIED",
          reviewedBy: "router_policy_allowlist",
          registryApprovalState: "pending_audit",
        },
        endpointState: "candidate",
        sortPriority: 1,
        pricing: {
          pricingVersionId: "unverified",
          currency: "USD",
          billingUnit: "usd_per_1m_tokens",
          inputPriceMicrosPerM: null,
          outputPriceMicrosPerM: null,
          calculatedMu: null,
          consumptionCategory: "pending",
          pricingConfidence: "unknown",
          provenance: "unverified",
        },
      },
    ],
  };

  // 5. Vulcan (Flagship assistant with explicit transport selection: direct vs router)
  const vesperSelectedTransport = snapshot.approvals.vesperTransport || "direct";
  const vesperDirectModel = snapshot.models.vesperDirect;
  const vesperRouterModel = snapshot.models.vesperRouter;
  const vesperPrimaryTag = vesperSelectedTransport === "direct"
    ? (vesperDirectModel || vesperRouterModel || "unconfigured")
    : (vesperRouterModel || vesperDirectModel || "unconfigured");

  const vesperFamily = {
    family: {
      slug: NATIVE_FAMILY_ARCHITECTURES.vesper.slug,
      displayName: NATIVE_FAMILY_ARCHITECTURES.vesper.displayName,
      familyGroup: NATIVE_FAMILY_ARCHITECTURES.vesper.familyGroup,
      description: NATIVE_FAMILY_ARCHITECTURES.vesper.description,
      sortOrder: NATIVE_FAMILY_ARCHITECTURES.vesper.sortOrder,
    },
    version: {
      versionTag: vesperPrimaryTag,
      aliases: NATIVE_FAMILY_ARCHITECTURES.vesper.aliases,
      capabilitiesDocumented: NATIVE_FAMILY_ARCHITECTURES.vesper.documentedCapabilities,
      planEligibility: NATIVE_FAMILY_ARCHITECTURES.vesper.planEligibility,
      lifecycleState: "candidate",
      metadata: {
        evidence: baseEvidence,
        transportIsolation: {
          activeSelectedTransport: vesperSelectedTransport,
          selectableTransports: ["direct", "router"],
          crossTransportFallback: false, // Explicitly false: no automatic failover between transports!
        },
      },
    },
    endpoints: [
      // Direct Transport (OpenAI Responses API)
      {
        providerName: "direct",
        transportType: "direct",
        adapterType: "responses",
        endpointUrl: snapshot.endpoints.vesperDirect,
        model: vesperDirectModel,
        isSelectedTransport: vesperSelectedTransport === "direct",
        capabilitiesVerified: { streaming: true, tools: true, vision: true, reasoningSupported: true },
        operatorConfig: {
          configuredFlag: snapshot.approvals.vesperDataPolicyVerified === true,
          scope: "direct_enterprise_contract",
          sharingOptionsOff: "api_io,eval_finetuning,playground",
        },
        privacyReview: {
          privacyApproved: false,
          trainingPolicy: "training_excluded",
          dataRetentionDays: 30,
          zeroDataRetention: false,
          auditRef: "owner_confirmed_sharing_options_off:api_io,eval_finetuning,playground",
          reviewedBy: "operator_confirmed_setting",
          registryApprovalState: "pending_audit",
        },
        endpointState: "candidate",
        sortPriority: 1,
        pricing: {
          pricingVersionId: "unverified",
          currency: "USD",
          billingUnit: "usd_per_1m_tokens",
          inputPriceMicrosPerM: null,
          outputPriceMicrosPerM: null,
          calculatedMu: null,
          consumptionCategory: "pending",
          pricingConfidence: "unknown",
          provenance: "unverified",
        },
      },
      // Router Transport (OpenRouter - alternate selectable configuration, NOT automatic fallback)
      {
        providerName: "paid",
        transportType: "router",
        adapterType: "chat_completions",
        endpointUrl: snapshot.endpoints.vesperRouter,
        model: vesperRouterModel,
        isSelectedTransport: vesperSelectedTransport === "router",
        capabilitiesVerified: { streaming: true, tools: true, vision: true, reasoningSupported: true },
        operatorConfig: {
          configuredFlag: false,
          scope: "router_policy",
          role: "alternate_selectable_transport", // NOT automatic fallback
        },
        privacyReview: {
          privacyApproved: false,
          trainingPolicy: "denied",
          dataRetentionDays: null,
          zeroDataRetention: false,
          auditRef: "alternate_selectable_configuration",
          reviewedBy: null,
          registryApprovalState: "unapproved",
        },
        endpointState: "candidate",
        sortPriority: 2,
        pricing: {
          pricingVersionId: "unverified",
          currency: "USD",
          billingUnit: "usd_per_1m_tokens",
          inputPriceMicrosPerM: null,
          outputPriceMicrosPerM: null,
          calculatedMu: null,
          consumptionCategory: "pending",
          pricingConfidence: "unknown",
          provenance: "unverified",
        },
      },
    ],
  };

  return [lumenFamily, novaFamily, studyFamily, nebulaFamily, vesperFamily];
}
