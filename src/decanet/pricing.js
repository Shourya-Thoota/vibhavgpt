// DECANet is paid only. One credit is one role-play.
//   Individuals: one role-play for $2.50, or five for $10.
//   Chapters buy any quantity, and the unit price drops with volume.
export const INDIVIDUAL_PACKS = {
  single: { credits: 1, cents: 250, label: "1 role-play" },
  five: { credits: 5, cents: 1000, label: "5 role-plays" },
};

// Brackets by quantity, inclusive at the bottom.
export const CHAPTER_TIERS = [
  { min: 250, centsPerCredit: 150 },
  { min: 100, centsPerCredit: 175 },
  { min: 50, centsPerCredit: 180 },
  { min: 1, centsPerCredit: 200 },
];
export const CHAPTER_MAX_CREDITS = 5000;

export function chapterQuote(quantity) {
  const credits = Number(quantity);
  if (!Number.isSafeInteger(credits) || credits < 1 || credits > CHAPTER_MAX_CREDITS) return null;
  const tier = CHAPTER_TIERS.find((entry) => credits >= entry.min);
  return { credits, centsPerCredit: tier.centsPerCredit, cents: credits * tier.centsPerCredit };
}

export function individualQuote(pack) {
  const entry = INDIVIDUAL_PACKS[pack];
  return entry ? { pack, credits: entry.credits, cents: entry.cents } : null;
}

// VibhavGPT subscribers get free DECANet credits every two months: Plus 1,
// Pro 2. A "period" is a calendar block of two months (Jan-Feb, Mar-Apr, ...)
// in UTC, so every subscriber's grant renews on the same dates.
export const SUBSCRIBER_CREDITS = { plus: 1, pro: 2 };

export function grantPeriod(date = new Date()) {
  const year = date.getUTCFullYear();
  const block = Math.floor(date.getUTCMonth() / 2);
  const startsAt = new Date(Date.UTC(year, block * 2, 1));
  const endsAt = new Date(Date.UTC(year, block * 2 + 2, 1));
  return { key: `${year}-${block + 1}`, startsAt, endsAt };
}

export function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
