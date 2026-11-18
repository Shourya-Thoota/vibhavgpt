import { TOKEN_QUOTAS } from "./token-quotas.js";
import { normalizeCarryMode } from "./credits-policy.js";
import { creditsAllowanceGroup } from "./credits-copy.js";
import { IMAGES_PER_MONTH, IMAGES_PER_WEEK, countText } from "./plan-entitlements.js";

// The rows of the pricing page's comparison table. Plus and Pro token
// allowances come straight from TOKEN_QUOTAS. Free is not those token caps:
// the enforced Free allowance is up to 15 counted AI requests in any rolling 24-hour period
// and $0.25 each UTC calendar month, shared by Lumen and Study.
// Generation and upload limits mirror the
// plan features in product-knowledge.js (test/plan-comparison.test.js checks
// they agree).
//
// Max is the fourth column, with full access to every model, 1,500 image
// generations per month, unlimited document generations, 80 MB document
// uploads, and 20 MB image uploads. Every image number below comes from
// plan-entitlements.js, which the server's enforcement is tested against.
// The table's columns, in order, and the name each plan is shown under. The model showcase reads both, so its plan lines cannot
// drift from this table.
export const PLAN_IDS = Object.freeze(["free", "plus", "pro", "max"]);
export const PLAN_NAMES = Object.freeze({ free: "Free", plus: "Plus", pro: "Pro", max: "Max" });

export function compactTokens(value) {
  if (!value) return null;
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  return `${Math.round(value / 1_000)}K`;
}

const FREE_SHARED_ALLOWANCE = "Up to 15 AI requests in any 24 hours and $0.25 each UTC calendar month, shared";

function freeAllowanceCell(model) {
  if (model === "lumen" || model === "nova") return FREE_SHARED_ALLOWANCE;
  if (model === "study") return "Shares the Free allowance above";
  return compactTokens(TOKEN_QUOTAS.free[model].monthly);
}

const tokenRow = (label, ...models) => ({
  label,
  note: "tokens per month on Plus and Pro",
  values: [
    freeAllowanceCell(models[0]),
    compactTokens(TOKEN_QUOTAS.plus[models[0]].monthly),
    compactTokens(TOKEN_QUOTAS.pro[models[0]].monthly),
    "Included",
  ],
});

export const COMPARISON_GROUPS = [
  {
    title: "Monthly allowance",
    rows: [
      tokenRow("Lumen", "lumen"),
      tokenRow("Study", "study"),
      tokenRow("Vulcan", "vesper"),
      // Zenith (Slice 7): Max only at launch. Third-party models are metered per turn, so they are not rows here.
      { label: "Zenith", note: "the flagship, on Max", values: [null, null, null, "Included"] },
    ],
  },
  {
    title: "Making things",
    rows: [
      { label: "Image generations", values: [`${countText(IMAGES_PER_WEEK.free)} per week`, `${countText(IMAGES_PER_MONTH.plus)} per billing month`, `${countText(IMAGES_PER_MONTH.pro)} per month`, `${countText(IMAGES_PER_MONTH.max)} per month`] },
      { label: "Image watermark", values: ["Always on", "Optional (off by default)", "Optional (off by default)", "Optional (off by default)"] },
      { label: "Document generations", values: [null, "20 per billing month", "Unlimited", "Unlimited"] },
      { label: "Library of what you make", values: [null, "Included", "Included", "Included"] },
      { label: "Saved reference photos for images", values: [null, "Up to 10", "Up to 10", "Included"] },
    ],
  },
  {
    title: "Files",
    rows: [
      { label: "Document uploads", values: ["5 MB", "25 MB", "80 MB", "80 MB"] },
      { label: "Image uploads", values: ["5 MB", "10 MB", "20 MB", "20 MB"] },
    ],
  },
  {
    title: "Every plan",
    rows: [
      { label: "Diagrams in replies", values: [true, true, true, true] },
      { label: "Projects", values: [true, true, true, true] },
      { label: "Memory you can turn off or delete", values: [true, true, true, true] },
      { label: "Search your past chats", values: [true, true, true, true] },
      { label: "Optional location for local answers", values: [true, true, true, true] },
      { label: "Dictation in supported browsers", values: [true, true, true, true] },
      { label: "The VibhavGPT Guarantee", values: [true, true, true, true] },
    ],
  },
];

// The groups for a credits mode ("expiry" or "carry"), or the existing groups
// when there is none. Only the allowance group is replaced; model access in it is
// still read from the same plan table, and every other group is shared.
export function comparisonGroupsFor(creditsMode = null) {
  if (!normalizeCarryMode(creditsMode)) return COMPARISON_GROUPS;
  return COMPARISON_GROUPS.map((group) => (group.title === "Monthly allowance" ? creditsAllowanceGroup() : group));
}

// "$49.99" over twelve months, for the yearly view's monthly equivalent.
export function monthlyEquivalent(yearly) {
  const amount = Number.parseFloat(String(yearly).replace(/[^0-9.]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? `$${(amount / 12).toFixed(2)}` : null;
}

// Whole-percent saving of a yearly price against twelve monthly payments.
export function yearlySaving(monthly, yearly) {
  const month = Number.parseFloat(String(monthly).replace(/[^0-9.]/g, ""));
  const year = Number.parseFloat(String(yearly).replace(/[^0-9.]/g, ""));
  if (!(month > 0 && year > 0)) return null;
  return Math.round((1 - year / (month * 12)) * 100);
}
