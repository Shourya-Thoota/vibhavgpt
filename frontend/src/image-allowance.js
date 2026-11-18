// What the Image page says about a Free account's weekly images. Free gets 2 per fixed UTC week; the week starts on Monday at 00:00 UTC.
// The server counts and enforces; this only words what /api/usage reports (imagesRemaining, imageLimit, imagePeriod, imagePeriodEndsAt).

export const FREE_IMAGES_PER_WEEK = 2;

/** "Monday at 12:00 AM UTC (Sunday, 7:00 PM EST)": the reset in UTC, and in the reader's own time when that differs in wording. */
export function nextImagesWhen(endsAt, { locale, timeZone } = {}) {
  const date = new Date(endsAt);
  if (!Number.isFinite(date.getTime())) return "Monday at 12:00 AM UTC";
  const local = date.toLocaleString(locale, { weekday: "long", hour: "numeric", minute: "2-digit", timeZoneName: "short", ...(timeZone ? { timeZone } : {}) });
  return `Monday at 12:00 AM UTC (${local})`;
}

/**
 * The one line shown to a Free account in the image UI, or null for any other plan or while the numbers are not known.
 * `allowance` is { tier, remaining, limit, period, endsAt }.
 */
export function freeImageLine(allowance, options) {
  if (!allowance || allowance.tier !== "free" || allowance.period !== "week") return null;
  const limit = Number.isFinite(allowance.limit) && allowance.limit > 0 ? allowance.limit : FREE_IMAGES_PER_WEEK;
  const remaining = Math.min(limit, Math.max(0, Number(allowance.remaining)));
  if (!Number.isFinite(remaining)) return null;
  if (remaining === 0) return `You've used your ${limit} free images this week. More arrive ${nextImagesWhen(allowance.endsAt, options)}.`;
  return `${remaining} of ${limit} free images left this week. More arrive ${nextImagesWhen(allowance.endsAt, options)}.`;
}
