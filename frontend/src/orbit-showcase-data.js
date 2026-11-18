// What the home page's model showcase says, and nothing else it could say.
//
// Every fact here is read from the files that already hold it, so the section cannot drift from the product:
//   * what each model is for ............ PRODUCT_KNOWLEDGE.models        (product-knowledge.js)
//   * which plans include it ............ TOKEN_QUOTAS                    (the table plan-comparison.js and the pricing page use)
//   * the allowance wording ............. comparisonGroupsFor(mode)       (plan-comparison.js, credits-copy.js)
//   * the credits wording ............... the credits mode, never a copy of it
// Only three things are written here: the colour of each model, a short "best for" list taken word for word from each model's own
// description, and the artwork. The label beside each model is the model picker's own intelligence label (model-marketplace.js,
// Slice 7), read, not copied, so the two cannot disagree. No rating, count, review or name of a person.
//
// This file is plain JavaScript with no DOM access, so the build can render the same content as static HTML for crawlers
// and for visitors without script (orbit-showcase-fallback.jsx), and the lazy section reads it in the browser.

import { PRODUCT_KNOWLEDGE } from "./product-knowledge.js";
import { TOKEN_QUOTAS } from "./token-quotas.js";
import { PLAN_IDS, PLAN_NAMES, comparisonGroupsFor } from "./plan-comparison.js";
import { normalizeCarryMode } from "./credits-policy.js";
import { HOUSE_INTELLIGENCE, INTELLIGENCE_LABELS } from "./model-marketplace.js";
import { IMAGES_PER_MONTH, IMAGES_PER_WEEK, countText } from "./plan-entitlements.js";

/** The seven models, in the order the product lists them (Zenith, the flagship, Slice 7). */
// Nova and Nebula were retired on 2026-11-14.
// Tecton (Build) and Prism (images) were added on 2026-11-14; Aura, the second image model, on 2026-11-16 (owner request).
export const ORBIT_MODEL_IDS = Object.freeze(["lumen", "vesper", "zenith", "tecton", "study", "prism", "aura"]);
// The image models: every plan includes them, counted by number of images (one allowance, shared).
const IMAGE_MODELS = new Set(["prism", "aura"]);

// Intelligence label (the picker's own) and colour per model. Study is a mode, not a picker row, so it has no label; the product says
// Study uses low-cost reasoning settings (PRODUCT_KNOWLEDGE.thinkingEffort).
const ORBIT_COLORS = Object.freeze({ lumen: "#10b981", nova: "#eab308", nebula: "#f97316", vesper: "#ef4444", zenith: "#a855f7", tecton: "#0ea5e9", prism: "#ec4899", aura: "#f59e0b" });
// Tecton and Prism are not picker rows, so they have no intelligence label: they are named for what they do.
const ORBIT_KIND = Object.freeze({ tecton: "Coding", prism: "Images", aura: "Images" });
export const ORBIT_COMPUTE = Object.freeze(Object.fromEntries(Object.entries(ORBIT_COLORS).map(([id, color]) => [id, Object.freeze({ level: ORBIT_KIND[id] ?? INTELLIGENCE_LABELS[HOUSE_INTELLIGENCE[id]], color })])));
const STUDY_ACCENT = "#6d7cff";

// Short "Best for" entries. Each is made only of words from the model's own description in PRODUCT_KNOWLEDGE.models
// (a test checks that), so it states what the product already says and adds no claim.
export const ORBIT_BEST_FOR = Object.freeze({
  lumen: Object.freeze(["Simple tasks", "Everyday tasks"]),
  nova: Object.freeze(["General-purpose help", "A strong default"]),
  nebula: Object.freeze(["Demanding work", "High-complexity reasoning"]),
  vesper: Object.freeze(["Difficult problems", "Top-tier reasoning"]),
  zenith: Object.freeze(["The hardest problems", "The most capable model"]),
  tecton: Object.freeze(["Prototypes", "The coding model"]),
  prism: Object.freeze(["Pictures from a description", "The image model"]),
  aura: Object.freeze(["Another look", "A second image model"]),
  study: Object.freeze(["Learning", "Worked examples", "Practice"]),
});

// Every plan in the comparison table, in its column order (Free, Plus, Pro, Max): generated, never a hand-written list.
const PLAN_ORDER = PLAN_IDS;

/** "Free, Plus, Pro and Max" / "Pro and Max", from the plans whose token table gives the model an allowance. */
export function plansIncluding(model) {
  // Prism is on every plan (images are counted by number, not tokens: Free by the week).
  if (IMAGE_MODELS.has(model)) return PLAN_ORDER.length > 1 ? `${PLAN_ORDER.slice(0, -1).map((plan) => PLAN_NAMES[plan]).join(", ")} and ${PLAN_NAMES[PLAN_ORDER.at(-1)]}` : PLAN_NAMES[PLAN_ORDER[0]];
  const names = PLAN_ORDER.filter((plan) => TOKEN_QUOTAS[plan][model].monthly > 0).map((plan) => PLAN_NAMES[plan]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
}

const sentence = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
const description = (name) => PRODUCT_KNOWLEDGE.models.find(([model]) => model === name)?.[1] ?? "";

// The allowance line for one model, in the wording the pricing page shows for the active credits mode.
function allowanceLine(model, mode) {
  // Prism's allowance is a number of images, from the same entitlement numbers the plans enforce.
  if (IMAGE_MODELS.has(model)) return `Free: ${countText(IMAGES_PER_WEEK.free)} images a week. Plus ${countText(IMAGES_PER_MONTH.plus)}, Pro ${countText(IMAGES_PER_MONTH.pro)} and Max ${countText(IMAGES_PER_MONTH.max)} images a month.`;
  const group = comparisonGroupsFor(mode).find((g) => g.title === "Monthly allowance");
  if (!group) return "";
  const cell = (row, plan) => row.values[PLAN_ORDER.indexOf(plan)];
  const plans = PLAN_ORDER.filter((plan) => TOKEN_QUOTAS[plan][model].monthly > 0);
  if (normalizeCarryMode(mode)) {
    const row = group.rows.find((r) => r.label === "AI credits per month");
    if (!row) return "";
    const parts = plans.map((plan) => `${PLAN_NAMES[plan]} ${cell(row, plan)}`);
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
    return `Uses your plan's AI credits: ${list} a month, ${row.note}.`;
  }
  const label = TOKEN_NAME[model];
  const row = group.rows.find((r) => r.label === label);
  // Tecton has no row in the comparison table's token allowances; its monthly caps come from the same token table the plans enforce.
  if (!row && model === "tecton") {
    const millions = (n) => `${n / 1_000_000}M`;
    return `Pro ${millions(TOKEN_QUOTAS.pro.tecton.monthly)} and Max ${millions(TOKEN_QUOTAS.max.tecton.monthly)} tokens a month.`;
  }
  if (!row) return "";
  // Study's Free cell points at the Lumen and Nova row ("Shares the Free allowance above"); out of the table, say what it shares.
  const sharedRow = group.rows.find((r) => r.label === "Lumen");
  const freeCell = /^Shares the Free allowance/.test(String(cell(row, "free"))) ? cell(sharedRow, "free") : cell(row, "free");
  const free = plans.includes("free") ? `Free: ${freeCell}. ` : "";
  const paid = plans.filter((plan) => plan !== "free");
  // A plan whose cell is a number gets the number; a plan whose cell is a word (Max: "Included") is said as a word, after them.
  const measured = paid.filter((plan) => /\d/.test(String(cell(row, plan))));
  const worded = paid.filter((plan) => !measured.includes(plan));
  const list = (items) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0]);
  // The table's note ends "... on Plus and Pro"; the plans are already named here.
  const note = String(row.note).replace(/ on Plus and Pro$/, "");
  const numbers = measured.length ? `${list(measured.map((plan) => `${PLAN_NAMES[plan]} ${cell(row, plan)}`))} ${note}` : "";
  const words = worded.length ? `${String(cell(row, worded[0])).toLowerCase()} on ${list(worded.map((plan) => PLAN_NAMES[plan]))}` : "";
  const joined = [numbers, words].filter(Boolean).join("; ");
  // A model only Max includes (Zenith) has no number to give; say which plan that is, as the pricing footnote does.
  const onlyMax = !free && !numbers && worded.length === 1 && worded[0] === "max" ? ", the plan with our highest allowances" : "";
  return `${free}${joined ? `${joined.charAt(0).toUpperCase()}${joined.slice(1)}${onlyMax}.` : ""}`.trim();
}
const TOKEN_NAME = Object.freeze({ lumen: "Lumen", nova: "Nova", study: "Study", nebula: "Nebula", vesper: "Vulcan", zenith: "Zenith", tecton: "Tecton", prism: "Prism", aura: "Aura" });

/**
 * The five slides for a credits mode ("expiry", "carry" or none). Plain data: the same object feeds the static
 * HTML and the interactive section.
 */
export function orbitSlides(creditsMode = null) {
  const mode = normalizeCarryMode(creditsMode);
  return ORBIT_MODEL_IDS.map((id) => {
    const name = TOKEN_NAME[id];
    const compute = ORBIT_COMPUTE[id];
    const summary = description(name);
    return {
      id,
      title: "VibhavGPT",
      subtitle: name,
      eyebrow: "VibhavGPT models",
      label: name,
      image: `/home/models/${id}.svg`,
      alt: ORBIT_ALT[id],
      accent: compute?.color ?? STUDY_ACCENT,
      badge: { label: compute ? compute.level : "Guided tutoring", dot: compute?.color ?? STUDY_ACCENT },
      availability: `Included in ${plansIncluding(id)}`,
      overview: sentence(summary),
      bestFor: [...ORBIT_BEST_FOR[id]],
      allowance: allowanceLine(id, mode),
    };
  });
}

// Descriptions of the artwork, for people who cannot see it.
const ORBIT_ALT = Object.freeze({
  lumen: "A softly lit green sphere with a pale halo, standing for Lumen, the lightweight everyday model.",
  nova: "A warm golden sphere with a bright rim, standing for Nova, the general-purpose model.",
  nebula: "An orange sphere with soft cloud bands and a night shadow, standing for Nebula, the reasoning model.",
  vesper: "A deep red sphere with a thin bright ring, standing for Vulcan, the top-tier reasoning model.",
  zenith: "A silver-violet sphere with a thin bright ring, standing for Zenith, the flagship model.",
  tecton: "A sky-blue sphere crossed by a faint grid of traces, standing for Tecton, the coding model in Build.",
  prism: "A pale glass sphere with a soft band of spectrum across it, standing for Prism, the image model.",
  aura: "A warm amber sphere wrapped in a soft glow, standing for Aura, the second image model.",
  study: "A blue-violet sphere with an open book across its face, standing for Study.",
});

/** The two actions under every slide. "Try it" goes where the page's own sign-up buttons go. */
export const ORBIT_ACTIONS = Object.freeze([
  Object.freeze({ id: "try", label: "Try it", href: "/signup" }),
  Object.freeze({ id: "plans", label: "See plans", href: "/pricing" }),
]);

export const ORBIT_HEADING = "Models";

// Layout numbers the page and the section share, so the space reserved before the script loads is the space the section takes.
export const ORBIT_STICKY_TOP = 72; // px below the top of the screen where the stage pins: clear of the floating bar
export const ORBIT_SCROLL_PER_SLIDE = 0.7; // stage heights of scroll for each change of slide
/** How many stage heights the whole scroll track is. */
export const orbitTrackFactor = (slides = ORBIT_MODEL_IDS.length) => 1 + Math.max(0, slides - 1) * ORBIT_SCROLL_PER_SLIDE;
