import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { accountPreferences } from "../db/schema.js";
import { requireSession } from "../middleware/require-session.js";
import { loadPreferences } from "../profile/preferences.js";
import { SEARCH_MAX_LENGTH, nearestPlace, placeById, publicPlace, searchPlaces } from "./lookup.js";

// /api/me/location: the optional place that gives answers local context. Off unless the person turns it on.
//
// - What is kept is a place only: city, region, country and timezone. Coordinates are never stored. A device position arrives in the
//   body of one request, is turned into the nearest listed place, and is dropped when the request ends.
// - Nothing in a request is logged: not the typed text, not a position, not the place.
// - The place comes from the local list (GeoNames data), by its id, never from text the client sends. No other service is called.
// - The account is always the verified session's.

const noStore = (res) => res.set({ "Cache-Control": "private, no-store", Vary: "Cookie" });
const stored = (row) => (row && row.locationMode !== "off" && row.locationCity ? { mode: row.locationMode, city: row.locationCity, region: row.locationRegion, country: row.locationCountry, timezone: row.locationTimezone } : { mode: "off", city: null, region: null, country: null, timezone: null });

export async function setLocation(userId, place, mode, database = db) {
  const values = { locationMode: mode, locationCity: place?.name ?? null, locationRegion: place?.region || null, locationCountry: place?.country ?? null, locationTimezone: place?.timezone ?? null };
  const [row] = await database.insert(accountPreferences).values({ userId, ...values }).onConflictDoUpdate({ target: accountPreferences.userId, set: { ...values, updatedAt: new Date() } }).returning();
  return stored(row);
}
export const clearLocation = (userId, database = db) => setLocation(userId, null, "off", database);
export const readLocation = async (userId, database = db) => stored(await loadPreferences(userId, database));

export function createLocationRouter({ database = db, session = requireSession, perMinute = 60 } = {}) {
  const router = Router();
  router.use(session);
  router.use(express.json({ limit: "1kb" }));
  router.use(rateLimit({
    windowMs: 60 * 1000,
    limit: perMinute,
    keyGenerator: (req) => `location:${req.authSession.user.id}`,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests. Please wait a moment.", code: "rate_limited" },
  }));

  router.get("/", async (req, res, next) => {
    try { return noStore(res).status(200).json({ location: await readLocation(req.authSession.user.id, database) }); } catch (error) { return next(error); }
  });

  // Matches for a typed city, from the local list. A POST so the text is in the body and never in a URL.
  router.post("/search", (req, res) => {
    const q = typeof req.body?.q === "string" ? req.body.q : "";
    if (q.length > SEARCH_MAX_LENGTH * 2) return noStore(res).status(400).json({ error: "That is too long.", code: "too_long" });
    return noStore(res).status(200).json({ places: searchPlaces(q).map(publicPlace) });
  });

  // Turn it on with a place chosen from the list.
  router.put("/", async (req, res, next) => {
    try {
      const rawId = req.body?.placeId;
      const placeId = rawId != null && rawId !== "" ? String(rawId) : null;
      if (req.body?.mode !== "city" || !placeId) return noStore(res).status(400).json({ error: "Choose a city from the list.", code: "bad_request" });
      const place = placeById(placeId);
      if (!place) return noStore(res).status(400).json({ error: "Choose a city from the list.", code: "unknown_place" });
      return noStore(res).status(200).json({ location: await setLocation(req.authSession.user.id, place, "city", database) });
    } catch (error) { return next(error); }
  });

  // Turn it on from a device position, which the person has just allowed in their browser. The position is not kept.
  router.post("/resolve", async (req, res, next) => {
    try {
      const { latitude, longitude } = req.body ?? {};
      if (typeof latitude !== "number" || typeof longitude !== "number") return noStore(res).status(400).json({ error: "Send a position.", code: "bad_request" });
      const place = nearestPlace(latitude, longitude);
      if (!place) return noStore(res).status(422).json({ error: "No city was found near that position. Enter a city instead.", code: "no_place" });
      return noStore(res).status(200).json({ location: await setLocation(req.authSession.user.id, place, "device", database) });
    } catch (error) { return next(error); }
  });

  router.delete("/", async (req, res, next) => {
    try { await clearLocation(req.authSession.user.id, database); return noStore(res).status(204).end(); } catch (error) { return next(error); }
  });

  router.use((error, _req, res, next) => {
    if (error?.type === "entity.parse.failed" || error?.type === "entity.too.large") return noStore(res).status(400).json({ error: "Send a small JSON object.", code: "bad_request" });
    return next(error);
  });
  return router;
}
