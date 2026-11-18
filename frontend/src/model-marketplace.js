import { DEFAULT_UNIFIED_LEVEL, UNIFIED_LEVELS, providerLevelFor } from "./thinking-levels.js";
// The model picker's lineup, shared by the server and the browser: the house models (VibhavGPT's own tiers, always listed first) and
// the third-party models, shown under their makers' real names and billed per turn at the provider's cost plus 10%. Nothing here says
// what powers a house model; that stays on the server (src/models/marketplace.js). Real brand and model names appear only for the
// third-party models, never for a house tier.
//
// Every model carries one label from one ordered intelligence scale. House tiers keep their established order; a third-party model is
// placed by its maker's own ladder and its live price (docs/models/marketplace-evidence.md records the basis).

export const INTELLIGENCE_LEVELS = Object.freeze(["fast", "balanced", "smart", "advanced", "best"]);
export const INTELLIGENCE_LABELS = Object.freeze({ fast: "Fast", balanced: "Balanced", smart: "Smart", advanced: "Advanced", best: "Best" });
// The picker's existing badge tones, reused (styles.css: entry, balanced, premium, top-tier).
export const INTELLIGENCE_TONES = Object.freeze({ fast: "entry", balanced: "balanced", smart: "premium", advanced: "premium", best: "top-tier" });
export const intelligenceRank = (level) => INTELLIGENCE_LEVELS.indexOf(level);

// The house lineup, in ladder order. Study is a mode, not a picker row, and is unchanged.
// Nova and Nebula were retired on 2026-11-14 (owner decision): they are not offered, not chosen by Auto, and a request naming them is
// refused before inference. Replies they wrote keep their names (RETIRED_HOUSE_NAMES).
export const HOUSE_MODEL_IDS = Object.freeze(["lumen", "vesper", "zenith"]);
export const HOUSE_INTELLIGENCE = Object.freeze({ lumen: "fast", vesper: "advanced", zenith: "best" });
// The least plan that includes each house model (Free and Plus: Lumen; Pro: Vulcan too; Max: Zenith too).
export const HOUSE_MIN_PLAN = Object.freeze({ lumen: "free", vesper: "pro", zenith: "max" });
export const HOUSE_PLAN_COPY = Object.freeze({ lumen: null, vesper: "Available with Pro or Max.", zenith: "Available with Max." });
export const RETIRED_HOUSE_NAMES = Object.freeze({ nova: "Nova", nebula: "Nebula", ultra: "Nebula" });
export const isRetiredHouseKey = (key) => Object.prototype.hasOwnProperty.call(RETIRED_HOUSE_NAMES, String(key ?? "").trim().toLowerCase());
// What each house model is for, as the picker says it. Zenith is the flagship; Vulcan stays the top reasoning tier below it.
export const HOUSE_MODELS = Object.freeze([
  Object.freeze({ id: "lumen", name: "Lumen", vision: false, description: "Fastest. Good for everyday questions." }),
  Object.freeze({ id: "vesper", name: "Vulcan", vision: true, description: "Top-tier reasoning for difficult problems. Reads images." }),
  Object.freeze({ id: "zenith", name: "Zenith", vision: true, description: "Flagship. Our most capable model, for the hardest problems. Reads images." }),
]);
export const PLAN_ORDER = Object.freeze(["free", "plus", "pro", "max"]);
// "paid" is the legacy name of Pro; anything unknown is Free.
const planRank = (plan) => {
  const value = String(plan || "free").toLowerCase();
  return PLAN_ORDER.indexOf(value === "paid" ? "pro" : PLAN_ORDER.includes(value) ? value : "free");
};
/** Whether a plan includes a house model. */
export const planIncludesHouseModel = (plan, id) => !isRetiredHouseKey(id) && planRank(plan) >= PLAN_ORDER.indexOf(HOUSE_MIN_PLAN[id] ?? "max");

// The copy a locked row shows, by the least plan it needs.
export const PLAN_FLOOR_COPY = Object.freeze({ plus: "Available with Plus, Pro, or Max.", pro: "Available with Pro or Max.", max: "Available with Max." });

// Third-party providers, in the order their groups appear under the house models. A provider appears only while at least one of its
// models is listed (the server lists a model only once its privacy terms are verified and a live price is known).
// `name` is the group label the picker shows; `maker` is the company that makes the models; `logo` is the bundled brand mark
// (frontend/src/assets/brands). A group with `headerMinEntries` shows its label only when at least that many of its models are listed.
// Cohere: cut, pending an enterprise zero-retention agreement (its only host keeps prompts for 30 days).
export const THIRD_PARTY_PROVIDERS = Object.freeze([
  Object.freeze({ id: "glm", name: "GLM", maker: "Z.AI", logo: "zai", headerMinEntries: 1 }),
  Object.freeze({ id: "gpt-6", name: "GPT-6", maker: "OpenAI", logo: "openai", headerMinEntries: 2 }),
  // Gemini 4 (owner request, 2026-11-16), on Google's own Gemini API with the owner's paid key.
  Object.freeze({ id: "gemini-4", name: "Gemini 4", maker: "Google", logo: "gemini", headerMinEntries: 2 }),
]);
export const providerMaker = (id) => THIRD_PARTY_PROVIDERS.find((provider) => provider.id === id)?.maker ?? null;
export const providerLogo = (id) => THIRD_PARTY_PROVIDERS.find((provider) => provider.id === id)?.logo ?? null;
// The model picker's sections, in the owner's order: VibhavGPT's own models, then OpenAI, then Z.AI.
export const PICKER_SECTIONS = Object.freeze([
  Object.freeze({ id: "house", label: "VibhavGPT" }),
  ...["gpt-6", "gemini-4", "glm"].map((id) => Object.freeze({ id, label: providerMaker(id) })),
]);
// The makers' official marks: local files (frontend/public/brand/providers), never hotlinked. They are single-colour (black on
// transparent), so the dark sky draws them in white.
export const PROVIDER_MARK_FILES = Object.freeze(Object.fromEntries(THIRD_PARTY_PROVIDERS.map((provider) => [provider.logo, `/brand/providers/${provider.logo}.png`])));
// Marks shown in their own colours in both themes, never inverted to white: Google's Gemini star (owner-supplied reference, 2026-11-16;
// scripts/build-gemini-mark.mjs).
export const COLOR_MARKS = Object.freeze(["gemini"]);

// The third-party models, in picker order within a provider. `description` is one line on what the model is for, and says honestly
// whether it reads images; `vision` is the verified capability. `minPlan` is the least plan that may use it (comp accounts are Max).
// GLM 5.3 replaces GLM-5V Turbo and GLM 5.3 Flash replaces GLM-5.3 FlashX. GLM 5.3 does not read images (the owner approved that for
// this one entry), and its line says so. GLM 5.3 Flash passes the live privacy check on Z.AI's own host (zero retention, no training);
// an earlier failure was another host's record being read as Z.AI's (route-policy-guard.js, docs/models/marketplace-evidence.md).
export const THIRD_PARTY_MODELS = Object.freeze([
  Object.freeze({ id: "glm-5.3", provider: "glm", name: "GLM 5.3", intelligence: "smart", vision: false, minPlan: "plus", description: "Text only. Strong reasoning and tools, with a very long context." }),
  Object.freeze({ id: "glm-5.3-flash", provider: "glm", name: "GLM 5.3 Flash", intelligence: "balanced", vision: true, minPlan: "plus", description: "Quick and inexpensive, with a very long context. Reads images." }),
  Object.freeze({ id: "gpt-6-luna", provider: "gpt-6", name: "GPT-6 Luna", intelligence: "balanced", vision: true, minPlan: "plus", description: "Fast and inexpensive, with a very long context. Reads images." }),
  Object.freeze({ id: "gpt-6.1-terra", provider: "gpt-6", name: "GPT-6.1 Terra", intelligence: "smart", vision: true, minPlan: "pro", description: "Deeper reasoning for everyday work. Reads images." }),
  Object.freeze({ id: "gpt-6.2-sol", provider: "gpt-6", name: "GPT-6.2 Sol", intelligence: "advanced", vision: true, minPlan: "max", description: "Strong reasoning for complex work and coding. Reads images." }),
  Object.freeze({ id: "gpt-6.2-astra", provider: "gpt-6", name: "GPT-6.2 Astra", intelligence: "best", vision: true, minPlan: "max", description: "The most capable GPT-6.2, for the hardest problems. Reads images." }),
  // Gemini 4 (owner request, 2026-11-16): Google's model ids and names, as listed by the Gemini API for the owner's key. All three read
  // images and take a 1M-token context. Plan floors follow GPT-6's: the everyday model from Plus, the efficient frontier model from Pro, the
  // most capable on Max.
  Object.freeze({ id: "gemini-4-hydrogen", provider: "gemini-4", name: "Gemini 4 Hydrogen", intelligence: "balanced", vision: true, minPlan: "plus", description: "Fast everyday coding and agent work, with a very long context. Reads images." }),
  Object.freeze({ id: "gemini-4-argon", provider: "gemini-4", name: "Gemini 4 Argon", intelligence: "advanced", vision: true, minPlan: "pro", description: "Frontier reasoning with faster replies than Carbon. Reads images." }),
  Object.freeze({ id: "gemini-4-carbon", provider: "gemini-4", name: "Gemini 4 Carbon", intelligence: "best", vision: true, minPlan: "max", description: "Google's most capable reasoning model, for the hardest problems. Reads images." }),
]);

// Thinking levels for each third-party model, as each maker documents them for that exact model (checked 2026-11-14):
//   GPT-6 Luna, GPT-6.1 Terra: reasoning.effort none, low, medium (default), high, xhigh, max (OpenAI model pages).
//   GPT-6.1 Sol (replaces GPT-6 Sol, 2026-11-15): low, medium (default), high, xhigh, max; "none" and "minimal" are not supported, and
//     OpenAI's migration guide says to use low where GPT-6 Sol used none (developers.openai.com/api/docs/guides/latest-model).
//   GPT-6 Astra: low, medium, high, xhigh, max; "none" is refused with HTTP 400. No documented default; OpenAI's guide starts at medium.
//   Gemini 4 Carbon, Gemini 4 Argon: low, medium (default), high (Google AI Studio model pages, checked 2026-11-16).
//   Gemini 4 Hydrogen: low, medium, high (default), xhigh; "minimal" is rejected (Google AI Studio, checked 2026-11-16).
//   GLM 5.3, GLM 5.3 Flash: thinking cannot be turned off; low, high, max, default max (Z.AI deep-thinking docs). Offered here: low and
//     high only. They are reached through the router, and that it passes "max" through to Z.AI is not yet verified live.
// The value is sent exactly as listed (Responses API reasoning.effort; the router's reasoning.effort). Unlisted combinations are refused
// before inference or billing. Private reasoning is never requested back.
export const THINKING_LEVEL_LABELS = Object.freeze({ none: "Off", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" });
const GPT6_FULL = Object.freeze({ levels: Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]), default: "medium" });
export const MARKETPLACE_THINKING = Object.freeze({
  "gpt-6-luna": GPT6_FULL,
  "gpt-6.1-terra": GPT6_FULL,
  // GPT-6.2 Sol and Astra (2026-11-17) replace GPT-6.1 Sol and GPT-6 Astra. OpenAI's model pages say both reject "none"; the accepted list
  // low, medium, high, xhigh, max is GPT-6.1 Sol's documented list and is stated for GPT-6.2 Sol by secondary sources. Not yet confirmed
  // against the API for 6.2 (a bounded live check is pending owner approval): until then High (max) is the one unverified mapping.
  "gpt-6.2-sol": Object.freeze({ levels: Object.freeze(["low", "medium", "high", "xhigh", "max"]), default: "medium" }),
  "gpt-6.2-astra": Object.freeze({ levels: Object.freeze(["low", "medium", "high", "xhigh", "max"]), default: "medium" }),
  "gemini-4-hydrogen": Object.freeze({ levels: Object.freeze(["low", "medium", "high", "xhigh"]), default: "high" }),
  "gemini-4-argon": Object.freeze({ levels: Object.freeze(["low", "medium", "high"]), default: "medium" }),
  "gemini-4-carbon": Object.freeze({ levels: Object.freeze(["low", "medium", "high"]), default: "medium" }),
  "glm-5.3": Object.freeze({ levels: Object.freeze(["low", "high"]), default: "high" }),
  "glm-5.3-flash": Object.freeze({ levels: Object.freeze(["low", "high"]), default: "high" }),
});
/** A third-party model's thinking options, or null when its thinking is not adjustable. */
export const marketplaceThinking = (key) => MARKETPLACE_THINKING[currentThirdPartyKey(key)] ?? null;
/**
 * The provider level a turn uses. The app sends one of the three unified levels (Low, Medium, High; thinking-levels.js), which becomes the
 * model's own level; an exact level the model documents (from an older client) is still accepted as it is. Nothing given: Medium.
 * Null and invalid when the model has no adjustable thinking, or the value is neither.
 */
export function resolveMarketplaceThinking(key, requested) {
  const options = marketplaceThinking(key);
  if (!options) return requested == null || requested === "" ? { level: null, valid: true } : { level: null, valid: false };
  if (requested == null || requested === "") return { level: providerLevelFor(options.levels, DEFAULT_UNIFIED_LEVEL), valid: true };
  const level = String(requested).toLowerCase();
  if (UNIFIED_LEVELS.includes(level)) return { level: providerLevelFor(options.levels, level), valid: true };
  return options.levels.includes(level) ? { level, valid: true } : { level: null, valid: false };
}

// Ids that were once in the lineup, mapped to the closest model listed now. A stored selection, preference or old client that names one
// is read as its replacement; nothing stored is rewritten.
// GPT-6.2 Sol and Astra (2026-11-17): GPT-6 Sol, GPT-6.1 Sol and GPT-6 Astra are read as their 6.2 successors (one hop each).
export const RETIRED_THIRD_PARTY_IDS = Object.freeze({ "glm-5v-turbo": "glm-5.3", "glm-5.3-flashx": "glm-5.3-flash", "gpt-6-sol": "gpt-6.2-sol", "gpt-6.1-sol": "gpt-6.2-sol", "gpt-6-astra": "gpt-6.2-astra" });
// A reply keeps the name of the model that actually wrote it, so replies saved under a retired id are still labelled with its own name.
export const RETIRED_THIRD_PARTY_NAMES = Object.freeze({ "glm-5v-turbo": "GLM-5V Turbo", "glm-5.3-flashx": "GLM-5.3 FlashX", "gpt-6-sol": "GPT-6 Sol", "gpt-6.1-sol": "GPT-6.1 Sol", "gpt-6-astra": "GPT-6 Astra" });
// A thinking level remembered for a retired model that its replacement does not offer, as the maker's migration guide maps it.
export const RETIRED_THINKING_LEVELS = Object.freeze({ "gpt-6-sol": Object.freeze({ none: "low", minimal: "low" }) });
/** For a retired id: what replaced it ({ from, to, fromName, toName }), so a moved selection can be said rather than done silently. */
export function thirdPartyReplacement(key) {
  const from = String(key ?? "").trim().toLowerCase();
  const to = RETIRED_THIRD_PARTY_IDS[from];
  if (!to) return null;
  return { from, to, fromName: RETIRED_THIRD_PARTY_NAMES[from] ?? from, toName: THIRD_PARTY_MODELS.find((model) => model.id === to)?.name ?? to };
}
/** The level a replacement model starts at from what was remembered for the model it replaced: kept if offered, else mapped, else null. */
export function inheritedThinkingLevel(fromKey, level) {
  const from = String(fromKey ?? "").trim().toLowerCase();
  const to = RETIRED_THIRD_PARTY_IDS[from];
  if (!to || level == null) return null;
  const options = MARKETPLACE_THINKING[to];
  const value = String(level).toLowerCase();
  if (options?.levels.includes(value)) return value;
  const mapped = RETIRED_THINKING_LEVELS[from]?.[value];
  return mapped && options?.levels.includes(mapped) ? mapped : null;
}
/** The current id for a third-party key (a retired id becomes its replacement); any other value is returned trimmed and lower-cased. */
export const currentThirdPartyKey = (key) => {
  const norm = String(key ?? "").trim().toLowerCase();
  return RETIRED_THIRD_PARTY_IDS[norm] ?? norm;
};

const THIRD_PARTY_IDS = new Set(THIRD_PARTY_MODELS.map((model) => model.id));
export const isThirdPartyModel = (key) => THIRD_PARTY_IDS.has(currentThirdPartyKey(key));
export const thirdPartyModel = (key) => THIRD_PARTY_MODELS.find((model) => model.id === currentThirdPartyKey(key)) ?? null;
export const providerName = (id) => THIRD_PARTY_PROVIDERS.find((provider) => provider.id === id)?.name ?? null;

/** The least plan a third-party model needs (unknown: Max, so nothing unlisted is ever opened by accident). */
export const thirdPartyMinPlan = (key) => thirdPartyModel(key)?.minPlan ?? "max";
/** Whether a plan includes a third-party model. Each plan sees everything at or below its floor; comp accounts resolve to Max. */
export const planIncludesThirdPartyModel = (plan, key) => planRank(plan) >= PLAN_ORDER.indexOf(thirdPartyMinPlan(key));
/** What a locked third-party row says. */
export const thirdPartyPlanCopy = (key) => PLAN_FLOOR_COPY[thirdPartyMinPlan(key)] ?? null;
/** The plan names a refusal gives ("Plus, Pro, or Max"). */
export const plansFrom = (floor) => PLAN_ORDER.slice(Math.max(1, PLAN_ORDER.indexOf(floor))).map((plan) => plan[0].toUpperCase() + plan.slice(1)).join(", ").replace(/, ([^,]+)$/, PLAN_ORDER.indexOf(floor) <= 1 ? ", or $1" : " or $1");

// The one line on how third-party models are billed. Shown on Pricing and in the credits copy (and the Terms); not in the picker.
export const THIRD_PARTY_BILLING_NOTE = "Third-party models are billed per turn at the provider's cost plus 10%, in credits.";
