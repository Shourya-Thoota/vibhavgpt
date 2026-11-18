/**
 * Consumption Category Scoring (mu) for Milestone 2A.
 * Standardizes reference index across provider pricing structures:
 *   mu = 1.10 * [ 0.5 * (Price_in / 1.00) + 0.5 * (Price_out / 4.00) ]
 *
 * This score is solely a catalog classification index to designate visual tiers
 * (Low, Medium, High, Extra High). It is NEVER used to calculate actual billable costs
 * or multiply token counts.
 */

export const CONSUMPTION_THRESHOLDS = Object.freeze({
  LOW_MAX: 1.0,
  MEDIUM_MAX: 2.0,
  HIGH_MAX: 7.0,
});

export const CONSUMPTION_CATEGORIES = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  EXTRA_HIGH: "extra_high",
  PENDING: "pending",
});

export const CONSUMPTION_UI_METADATA = Object.freeze({
  [CONSUMPTION_CATEGORIES.LOW]: Object.freeze({
    level: "low",
    label: "Low consumption",
    dotColor: "#10b981",
    accessibleDescription: "Low compute consumption",
    allowedPlans: Object.freeze(["free", "plus", "pro"]),
  }),
  [CONSUMPTION_CATEGORIES.MEDIUM]: Object.freeze({
    level: "medium",
    label: "Standard consumption",
    dotColor: "#f59e0b",
    accessibleDescription: "Standard compute consumption",
    allowedPlans: Object.freeze(["plus", "pro"]),
  }),
  [CONSUMPTION_CATEGORIES.HIGH]: Object.freeze({
    level: "high",
    label: "High compute consumption",
    dotColor: "#f97316",
    accessibleDescription: "High compute consumption",
    allowedPlans: Object.freeze(["plus", "pro"]),
  }),
  [CONSUMPTION_CATEGORIES.EXTRA_HIGH]: Object.freeze({
    level: "extra_high",
    label: "Flagship high compute",
    dotColor: "#ef4444",
    accessibleDescription: "Flagship high compute consumption",
    allowedPlans: Object.freeze(["pro"]),
  }),
  [CONSUMPTION_CATEGORIES.PENDING]: Object.freeze({
    level: "pending",
    label: "Classification pending",
    dotColor: "#6b7280",
    accessibleDescription: "Consumption category classification pending",
    allowedPlans: Object.freeze(["pro"]),
  }),
});

/**
 * Calculates internal consumption multiplier mu and category from input/output rates.
 * Rates are provided in micro-dollars per 1,000,000 tokens (e.g. 1,000,000 micro-dollars = $1.00 USD).
 *
 * Returns { calculatedMu: number | null, consumptionCategory: string }
 */
export function calculateConsumptionScore(inputPriceMicrosPerM, outputPriceMicrosPerM) {
  if (
    inputPriceMicrosPerM === null ||
    inputPriceMicrosPerM === undefined ||
    outputPriceMicrosPerM === null ||
    outputPriceMicrosPerM === undefined
  ) {
    return {
      calculatedMu: null,
      consumptionCategory: CONSUMPTION_CATEGORIES.PENDING,
    };
  }

  const inMicros = Number(inputPriceMicrosPerM);
  const outMicros = Number(outputPriceMicrosPerM);

  if (!Number.isFinite(inMicros) || !Number.isFinite(outMicros) || inMicros < 0 || outMicros < 0) {
    return {
      calculatedMu: null,
      consumptionCategory: CONSUMPTION_CATEGORIES.PENDING,
    };
  }

  // Convert micro-dollars per 1M to USD per 1M
  const priceInUsd = inMicros / 1_000_000;
  const priceOutUsd = outMicros / 1_000_000;

  // Formula: mu = 1.10 * [ 0.5 * (Price_in / 1.00) + 0.5 * (Price_out / 4.00) ]
  //            = 1.10 * [ 0.5 * Price_in + 0.125 * Price_out ]
  const rawMu = 1.10 * (0.5 * priceInUsd + 0.125 * priceOutUsd);
  const calculatedMu = Math.round(rawMu * 10_000) / 10_000;

  let consumptionCategory;
  if (calculatedMu <= CONSUMPTION_THRESHOLDS.LOW_MAX) {
    consumptionCategory = CONSUMPTION_CATEGORIES.LOW;
  } else if (calculatedMu <= CONSUMPTION_THRESHOLDS.MEDIUM_MAX) {
    consumptionCategory = CONSUMPTION_CATEGORIES.MEDIUM;
  } else if (calculatedMu <= CONSUMPTION_THRESHOLDS.HIGH_MAX) {
    consumptionCategory = CONSUMPTION_CATEGORIES.HIGH;
  } else {
    consumptionCategory = CONSUMPTION_CATEGORIES.EXTRA_HIGH;
  }

  return { calculatedMu, consumptionCategory };
}

/**
 * Strips raw numeric mu score before sending to UI or client APIs.
 * Only returns accessible label and status indicator.
 */
export function sanitizeConsumptionForClient(consumptionCategory) {
  const meta = CONSUMPTION_UI_METADATA[consumptionCategory] || CONSUMPTION_UI_METADATA[CONSUMPTION_CATEGORIES.PENDING];
  return {
    category: meta.level,
    label: meta.label,
    dotColor: meta.dotColor,
    accessibleDescription: meta.accessibleDescription,
  };
}

