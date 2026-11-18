import { db } from "../db/client.js";
import { readLocation } from "./router.js";

// The line of context a model is given about where the person is, while the setting is on. Nothing is returned (so nothing is
// sent) when it is off, when the conversation is a protected one, or when no place is stored. It names a city, region and
// country and a timezone only, and tells the model to use it only when it helps the question.

export function locationContextLine(location) {
  if (!location || location.mode === "off" || !location.city) return "";
  const where = [location.city, location.region, location.country].filter(Boolean).join(", ");
  return `The user chose to share an approximate location: ${where}${location.timezone ? ` (timezone ${location.timezone})` : ""}. Use it only when it is relevant to what they ask, such as local weather, time, events or places. Do not mention it otherwise, and do not guess a street address.`;
}

export async function locationContext(userId, { protectedConversation = false, database = db } = {}) {
  if (protectedConversation) return "";
  try { return locationContextLine(await readLocation(userId, database)); } catch { return ""; }
}
