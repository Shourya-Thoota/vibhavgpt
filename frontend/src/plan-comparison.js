import { TOKEN_QUOTAS } from "./token-quotas.js";

// The rows of the pricing page's comparison table. Token allowances come
// straight from TOKEN_QUOTAS so the table cannot drift from what the limiter
// enforces; generation and upload limits mirror the plan features in
// product-knowledge.js (test/plan-comparison.test.js checks they agree).

const PLAN_IDS = ["free", "plus", "pro"];

export function compactTokens(value) {
  if (!value) return null;
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  return `${Math.round(value / 1_000)}K`;
}

const tokenRow = (label, ...models) => ({
  label,
  note: "tokens per month",
  values: PLAN_IDS.map((plan) => compactTokens(TOKEN_QUOTAS[plan][models[0]].monthly)),
});

export const COMPARISON_GROUPS = [
  {
    title: "Monthly allowance",
    rows: [
      tokenRow("Lumen and Nova", "lumen", "nova"),
      tokenRow("Study", "study"),
      tokenRow("Nebula", "nebula"),
      tokenRow("Vesper", "vesper"),
    ],
  },
  {
    title: "Making things",
    rows: [
      { label: "Image generations", values: [null, "25 per billing month", "60 per month"] },
      { label: "Document generations", values: [null, "20 per billing month", "Unlimited"] },
    ],
  },
  {
    title: "Files",
    rows: [
      { label: "Document uploads", values: ["5 MB", "25 MB", "80 MB"] },
      { label: "Image uploads", values: ["5 MB", "10 MB", "20 MB"] },
    ],
  },
  {
    title: "Every plan",
    rows: [
      { label: "Projects and folders", values: [true, true, true] },
      { label: "Memory you control", values: [true, true, true] },
      { label: "The VibhavGPT Guarantee", values: [true, true, true] },
    ],
  },
];

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
