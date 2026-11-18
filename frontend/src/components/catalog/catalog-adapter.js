/**
 * Standard customer-safe consumption tier labels and visual dot color mappings.
 * Does NOT expose raw numerical multipliers or wholesale rates.
 */
export const CONSUMPTION_TIER_CONFIG = Object.freeze({
  low: {
    key: "low",
    label: "Low Consumption",
    shortLabel: "Low",
    tone: "positive",
    color: "#10b981", // Emerald green
    description: "Highly cost-effective. Ideal for high-volume, everyday interactions.",
  },
  medium: {
    key: "medium",
    label: "Medium Consumption",
    shortLabel: "Medium",
    tone: "balanced",
    color: "#3b82f6", // Sky blue
    description: "Balanced speed and analytical capacity for general-purpose work.",
  },
  high: {
    key: "high",
    label: "High Consumption",
    shortLabel: "High",
    tone: "warning",
    color: "#f59e0b", // Amber
    description: "Demanding reasoning and code synthesis requiring deeper compute.",
  },
  extra_high: {
    key: "extra_high",
    label: "Extra High Consumption",
    shortLabel: "Extra High",
    tone: "premium",
    color: "#8b5cf6", // Violet / purple
    description: "Frontier reasoning tier restricted to Pro subscribers.",
  },
  pending: {
    key: "pending",
    label: "Pending Review",
    shortLabel: "Pending",
    tone: "neutral",
    color: "#6b7280", // Slate gray
    description: "Rate schedule and compliance audit currently undergoing review.",
  },
});

/**
 * Evaluates whether a model is locked for a specific user plan.
 * Returns an object with { locked: boolean, reason: string | null }.
 */
export function evaluateModelPlanLock(fixture, userPlan = "free") {
  const plan = String(userPlan || "free").toLowerCase();
  const planEligibility = fixture.planEligibility || "paid";
  const cat = fixture.rawPricing?.consumptionCategory || "pending";
  const privacyApproved = fixture.privacyReview?.privacyApproved === true;
  const isPending = cat === "pending" || fixture.rawPricing?.calculatedMu === null;

  // 1. Compliance / Privacy Gating
  if (!privacyApproved) {
    return {
      locked: true,
      lockType: "compliance",
      reason: "Under compliance and privacy review",
    };
  }

  // 2. Pending Rate Classification Gating
  if (isPending) {
    return {
      locked: true,
      lockType: "pending_classification",
      reason: "Pending rate classification review",
    };
  }

  // 3. Pro-Only Models (e.g. Extra High or Pro-exclusive models)
  if (planEligibility === "pro_only" && plan !== "pro" && plan !== "max") {
    return {
      locked: true,
      lockType: "upgrade_pro",
      reason: "Available with Pro or Max plan",
    };
  }

  // 4. Extra High Restriction for Plus Tier (Plus excluded from mu > 7.0)
  if (cat === "extra_high" && plan === "plus") {
    return {
      locked: true,
      lockType: "upgrade_pro",
      reason: "Extra High models require a Pro or Max subscription",
    };
  }

  // 5. Paid Models requested by Free Users
  if (planEligibility === "paid" && plan === "free") {
    return {
      locked: true,
      lockType: "upgrade_plus",
      reason: "Available with Plus, Pro, or Max",
    };
  }

  return {
    locked: false,
    lockType: null,
    reason: null,
  };
}

/**
 * Pure presentation adapter.
 *
 * Responsibilities:
 * 1. Strictly filters out all raw wholesale token prices ($P_in, P_out)
 *    and internal multipliers ($\mu$).
 * 2. Deterministically sorts models within brands by internal weight,
 *    then assigns customer-safe relative ranks.
 * 3. Handles search queries, capability filters, favorites, brand reordering,
 *    and brand visibility preferences.
 * 4. Produces immutable customer-safe props for the UI.
 */
export function adaptCatalogForPresentation({
  userPlan = "free",
  rawFixtures = [],
  searchQuery = "",
  capabilityFilter = "all", // "all" | "vision" | "reasoning" | "tools" | "fast"
  favorites = [],
  brandOrder = [],
  brandVisibility = {},
} = {}) {
  const normSearch = searchQuery.trim().toLowerCase();
  const favSet = new Set(favorites);

  // 1. Transform raw fixtures into safe presentation objects
  const safeModels = rawFixtures.map((fix) => {
    const lockEvaluation = evaluateModelPlanLock(fix, userPlan);
    const catKey = fix.rawPricing?.consumptionCategory || "pending";
    const tierConfig = CONSUMPTION_TIER_CONFIG[catKey] || CONSUMPTION_TIER_CONFIG.pending;

    // Internal sorting score (kept internal, never exposed in returned object)
    const internalSortWeight =
      catKey === "pending"
        ? -1
        : Number(fix.rawPricing?.calculatedMu) || 0;

    return {
      id: fix.id,
      familySlug: fix.familySlug,
      versionTag: fix.versionTag,
      brandId: fix.brandId,
      brandName: fix.brandName,
      displayName: fix.displayName,
      shortName: fix.shortName,
      description: fix.description,
      planEligibility: fix.planEligibility,
      isNative: Boolean(fix.isNative),
      isFixture: true,
      capabilities: {
        vision: Boolean(fix.capabilities?.vision),
        tools: Boolean(fix.capabilities?.tools),
        streaming: Boolean(fix.capabilities?.streaming),
        structuredOutputs: Boolean(fix.capabilities?.structuredOutputs),
        reasoning: Boolean(fix.capabilities?.reasoning),
        reasoningModes: Array.isArray(fix.capabilities?.reasoningModes)
          ? [...fix.capabilities.reasoningModes]
          : [],
        contextWindowTokens: fix.capabilities?.contextWindowTokens || 131072,
        maxOutputTokens: fix.capabilities?.maxOutputTokens || 8192,
      },
      consumptionTier: {
        key: tierConfig.key,
        label: tierConfig.label,
        shortLabel: tierConfig.shortLabel,
        color: tierConfig.color,
        tone: tierConfig.tone,
        description: tierConfig.description,
      },
      lockState: {
        locked: lockEvaluation.locked,
        lockType: lockEvaluation.lockType,
        reason: lockEvaluation.reason,
      },
      isFavorite: favSet.has(fix.id),
      documentedStrengths: fix.documentedStrengths || "",
      _internalSortWeight: internalSortWeight, // Used for sorting, omitted in final sanitized list
    };
  });

  // 2. Filter models by search query and capability filter
  const filteredModels = safeModels.filter((model) => {
    // Search filter
    if (normSearch) {
      const matchName = model.displayName.toLowerCase().includes(normSearch);
      const matchBrand = model.brandName.toLowerCase().includes(normSearch);
      const matchDesc = model.description.toLowerCase().includes(normSearch);
      const matchShort = model.shortName.toLowerCase().includes(normSearch);
      const matchTag = model.versionTag.toLowerCase().includes(normSearch);
      if (!matchName && !matchBrand && !matchDesc && !matchShort && !matchTag) {
        return false;
      }
    }

    // Capability filter
    if (capabilityFilter === "vision" && !model.capabilities.vision) return false;
    if (capabilityFilter === "reasoning" && !model.capabilities.reasoning) return false;
    if (capabilityFilter === "tools" && !model.capabilities.tools) return false;
    if (capabilityFilter === "fast" && model.performanceCategory !== "fast") return false;
    if (capabilityFilter === "balanced" && model.performanceCategory !== "balanced") return false;
    if (capabilityFilter === "best_intelligence" && model.performanceCategory !== "best_intelligence") return false;

    return true;
  });

  // 3. Group by Brand
  const brandMap = new Map();

  for (const model of filteredModels) {
    if (!brandMap.has(model.brandId)) {
      brandMap.set(model.brandId, {
        brandId: model.brandId,
        brandName: model.brandName,
        isNative: model.isNative,
        models: [],
      });
    }
    brandMap.get(model.brandId).models.push(model);
  }

  // 4. Sort models within each brand
  // Rule: Descending consumption score mu, with alphabetical tie-breakers; pending at bottom
  for (const group of brandMap.values()) {
    group.models.sort((a, b) => {
      // Pending always goes to the bottom
      if (a.consumptionTier.key === "pending" && b.consumptionTier.key !== "pending") return 1;
      if (b.consumptionTier.key === "pending" && a.consumptionTier.key !== "pending") return -1;

      // Descending internal sort weight
      if (Math.abs(b._internalSortWeight - a._internalSortWeight) > 0.0001) {
        return b._internalSortWeight - a._internalSortWeight;
      }

      // Alphabetical name tie-breaker
      return a.displayName.localeCompare(b.displayName);
    });
  }

  // 5. Order Brands according to preference
  // Default order: vibhavgpt native first, then custom preference order, then others
  // VibhavGPT first; any other groups follow in the order they appear.
  const defaultOrder = ["vibhavgpt", "native", "experimental"];
  const resolvedBrandOrder = brandOrder.length > 0 ? brandOrder : defaultOrder;

  const orderedBrands = [];
  const processedBrandIds = new Set();

  for (const bId of resolvedBrandOrder) {
    if (brandMap.has(bId)) {
      const isVisible = brandVisibility[bId] !== false; // Default visible
      orderedBrands.push({
        ...brandMap.get(bId),
        visible: isVisible,
      });
      processedBrandIds.add(bId);
    }
  }

  // Append any brand groups not in the custom order
  for (const [bId, group] of brandMap.entries()) {
    if (!processedBrandIds.has(bId)) {
      const isVisible = brandVisibility[bId] !== false;
      orderedBrands.push({
        ...group,
        visible: isVisible,
      });
    }
  }

  // 6. Extract Favorites Group
  const favoriteModels = filteredModels
    .filter((m) => m.isFavorite)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  // 7. Sanitize: remove `_internalSortWeight` before returning to client
  const sanitizedModels = filteredModels.map(({ _internalSortWeight, ...rest }) => rest);
  const sanitizedBrands = orderedBrands.map((b) => ({
    ...b,
    models: b.models.map(({ _internalSortWeight, ...rest }) => rest),
  }));

  // 8. Auto Router Mode Item (Proposed feature demonstration)
  const autoModeItem = {
    id: "auto-proposed",
    displayName: "Auto (Intelligent Broker)",
    shortName: "Auto",
    description: "Proposed routing engine that evaluates prompt complexity to deterministically select the optimal model.",
    isAuto: true,
    isProposed: true,
    consumptionTier: {
      key: "auto",
      label: "Dynamic",
      shortLabel: "Auto",
      color: "#06b6d4", // Cyan
      tone: "entry",
      description: "Dynamically chosen based on prompt complexity and plan limits.",
    },
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningModes: ["low", "normal", "high"],
    },
    lockState: {
      locked: false,
      reason: null,
    },
  };

  return Object.freeze({
    userPlan,
    models: sanitizedModels,
    brands: sanitizedBrands,
    favorites: favoriteModels.map(({ _internalSortWeight, ...rest }) => rest),
    autoMode: autoModeItem,
    totalCount: safeModels.length,
    filteredCount: sanitizedModels.length,
  });
}

/**
 * Adapts the server-side catalog DTO (from GET /api/models/catalog)
 * together with user catalog preferences (from GET /api/models/preferences)
 * for safe, presentation-ready client rendering.
 *
 * Guaranteed properties:
 * 1. Strictly customer-safe (no raw wholesale pricing or multipliers).
 * 2. Does NOT fall back to synthetic fixtures.
 * 3. Handles search queries, capability filtering, user favorites,
 *    brand ordering, and hidden brands.
 * 4. Model execution remains disconnected (no auto router executable item).
 */
export function adaptServerCatalogForPresentation({
  catalog = { models: [], groups: [], userPlan: "free" },
  searchQuery = "",
  capabilityFilter = "all", // "all" | "vision" | "reasoning" | "tools" | "fast"
  favorites = [],
  brandOrder = [],
  hiddenBrands = [],
  isReadOnly = true,
} = {}) {
  const normSearch = searchQuery.trim().toLowerCase();
  const favSet = new Set(Array.isArray(favorites) ? favorites : []);
  const hiddenBrandSet = new Set(Array.isArray(hiddenBrands) ? hiddenBrands : []);
  const rawModels = Array.isArray(catalog?.models) ? catalog.models : [];

  // 1. Transform server DTOs into presentation model objects
  const safeModels = rawModels.map((m) => {
    const catKey = m.consumptionCategory || "pending";
    const tierConfig = CONSUMPTION_TIER_CONFIG[catKey] || CONSUMPTION_TIER_CONFIG.pending;
    const isLocked = Boolean(m.selectability?.locked);
    const lockType = m.selectability?.lockType || null;
    const lockReason = m.selectability?.lockReason || null;

    const brandId = (m.group?.id || "other").toLowerCase();
    const brandName = m.group?.displayName || formatBrandDisplayName(brandId);
    const isNative = brandId === "native" || brandId === "vibhavgpt";
    const performanceCategory =
      m.performanceCategory ||
      m.capabilities?.performanceCategory ||
      (catKey === "low" ? "fast" : catKey === "extra_high" ? "best_intelligence" : "balanced");

    return {
      id: m.id,
      brandId,
      brandName,
      displayName: m.displayName || m.id,
      shortName: m.displayName || m.id,
      developer: m.developer || m.group?.developer || brandName,
      performanceCategory,
      description: m.description || "",
      isNative,
      isFixture: false,
      isReadOnly: Boolean(isReadOnly),
      capabilities: {
        vision: Boolean(m.capabilities?.vision),
        tools: Boolean(m.capabilities?.tools),
        streaming: Boolean(m.capabilities?.streaming ?? true),
        structuredOutputs: Boolean(m.capabilities?.structuredOutputs ?? true),
        reasoning: Boolean(m.capabilities?.reasoning),
        reasoningModes: Array.isArray(m.supportedReasoningEfforts)
          ? [...m.supportedReasoningEfforts]
          : [],
        contextWindowTokens: Number(m.contextWindowTokens) || 128000,
        maxOutputTokens: Number(m.maxOutputTokens) || 8192,
      },
      consumptionTier: {
        key: tierConfig.key,
        label: tierConfig.label,
        shortLabel: tierConfig.shortLabel,
        color: tierConfig.color,
        tone: tierConfig.tone,
        description: tierConfig.description,
      },
      lockState: {
        locked: isLocked,
        lockType,
        reason: lockReason,
      },
      sortRank: Number(m.sortRank) || 100,
      isFavorite: favSet.has(m.id),
      documentedStrengths: m.description || "",
    };
  });

  // 2. Filter models by search query and capability filter
  const filteredModels = safeModels.filter((model) => {
    if (normSearch) {
      const matchName = model.displayName.toLowerCase().includes(normSearch);
      const matchBrand = model.brandName.toLowerCase().includes(normSearch);
      const matchDesc = model.description.toLowerCase().includes(normSearch);
      const matchId = model.id.toLowerCase().includes(normSearch);
      if (!matchName && !matchBrand && !matchDesc && !matchId) {
        return false;
      }
    }

    if (capabilityFilter === "vision" && !model.capabilities.vision) return false;
    if (capabilityFilter === "reasoning" && !model.capabilities.reasoning) return false;
    if (capabilityFilter === "tools" && !model.capabilities.tools) return false;
    if (capabilityFilter === "fast" && model.performanceCategory !== "fast") return false;
    if (capabilityFilter === "balanced" && model.performanceCategory !== "balanced") return false;
    if (capabilityFilter === "best_intelligence" && model.performanceCategory !== "best_intelligence") return false;

    return true;
  });

  // 3. Group by Brand
  const brandMap = new Map();

  // Pre-populate with server groups if available
  if (Array.isArray(catalog?.groups)) {
    for (const g of catalog.groups) {
      const gId = (g.id || "").toLowerCase();
      if (gId && !brandMap.has(gId)) {
        brandMap.set(gId, {
          brandId: gId,
          brandName: g.displayName || formatBrandDisplayName(gId),
          isNative: gId === "native" || gId === "vibhavgpt",
          sortRank: Number(g.sortRank) || 100,
          models: [],
        });
      }
    }
  }

  for (const model of filteredModels) {
    if (!brandMap.has(model.brandId)) {
      brandMap.set(model.brandId, {
        brandId: model.brandId,
        brandName: model.brandName,
        isNative: model.isNative,
        sortRank: model.sortRank,
        models: [],
      });
    }
    brandMap.get(model.brandId).models.push(model);
  }

  // 4. Sort models within each brand:
  // Rule: Selectable before locked, then sortRank ascending, then alphabetical name
  for (const group of brandMap.values()) {
    group.models.sort((a, b) => {
      if (a.lockState.locked !== b.lockState.locked) {
        return a.lockState.locked ? 1 : -1;
      }
      if (a.sortRank !== b.sortRank) {
        return a.sortRank - b.sortRank;
      }
      return a.displayName.localeCompare(b.displayName);
    });
  }

  // 5. Order Brands according to preference
  // VibhavGPT first; any other groups follow in the order they appear.
  const defaultOrder = ["native", "vibhavgpt", "experimental"];
  const customOrder = Array.isArray(brandOrder) && brandOrder.length > 0 ? brandOrder : defaultOrder;

  const orderedBrands = [];
  const processedBrandIds = new Set();

  for (const bId of customOrder) {
    const normBId = bId.toLowerCase();
    if (brandMap.has(normBId)) {
      const isVisible = !hiddenBrandSet.has(normBId);
      orderedBrands.push({
        ...brandMap.get(normBId),
        visible: isVisible,
      });
      processedBrandIds.add(normBId);
    }
  }

  // Append any remaining brand groups not in custom order
  for (const [bId, group] of brandMap.entries()) {
    if (!processedBrandIds.has(bId)) {
      const isVisible = !hiddenBrandSet.has(bId);
      orderedBrands.push({
        ...group,
        visible: isVisible,
      });
    }
  }

  // 6. Extract Favorites Group
  const favoriteModels = filteredModels
    .filter((m) => m.isFavorite)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return Object.freeze({
    userPlan: catalog?.userPlan || "free",
    models: filteredModels,
    brands: orderedBrands,
    favorites: favoriteModels,
    autoMode: null, // Model execution is disconnected from chat
    totalCount: safeModels.length,
    filteredCount: filteredModels.length,
  });
}

// Only VibhavGPT is named. A group from anywhere else is shown neutrally, never under another company's name, and never by echoing an
// id the server sent.
function formatBrandDisplayName(brandId) {
  switch (String(brandId || "").toLowerCase()) {
    case "vibhavgpt":
    case "native":
      return "VibhavGPT";
    case "experimental":
      return "Experimental";
    default:
      return "More models";
  }
}


