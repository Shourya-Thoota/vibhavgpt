import { Router } from "express";
import express from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { accountPreferences } from "../db/schema.js";
import { requireSession } from "../middleware/require-session.js";
import { getCurrentUsage } from "../usage/service.js";

// /api/me/preferences: the settings that follow a person between devices (the accent colour, the sidebar, and the image watermark).
// The account is always the verified session's; nothing in a request can name another. Reads and writes touch only this
// person's one row.

export const ACCENT_IDS = ["cerulean", "nebula", "pine", "ember", "amber"];
// The sidebar items a person may hide (Settings > Sidebar). New chat, search and the account menu always stay, so the app stays usable.
export const SIDEBAR_ITEM_IDS = ["library", "memory", "billing", "extensions", "apps", "sources", "merch", "projects"];
const sidebarHidden = (value) => (Array.isArray(value) ? [...new Set(value.filter((id) => SIDEBAR_ITEM_IDS.includes(id)))] : []);

const noStore = (res) => res.set({ "Cache-Control": "private, no-store", Vary: "Cookie" });

export async function loadPreferences(userId, database = db) {
  const [row] = await database.select().from(accountPreferences).where(eq(accountPreferences.userId, userId)).limit(1);
  return row ?? null;
}

// The image watermark (src/generation/watermark.js): always on for the Free plan, which cannot change it; optional and off by default on
// paid plans. The response says which, so Settings shows a locked switch on Free; delivery enforces it either way.
export const watermarkLocked = (tier) => !tier || tier === "free";

export const preferencesResponse = (row, tier = "free") => ({
  accent: ACCENT_IDS.includes(row?.accent) ? row.accent : null,
  sidebarHidden: sidebarHidden(row?.sidebarHidden),
  imageWatermark: { enabled: watermarkLocked(tier) ? true : row?.imageWatermark === true, locked: watermarkLocked(tier) },
});

export function createPreferencesRouter({ database = db, session = requireSession, tierOf = async (userId) => (await getCurrentUsage(userId)).tier } = {}) {
  const tierFor = (userId) => Promise.resolve().then(() => tierOf(userId)).catch(() => "free");
  const router = Router();
  router.use(session);
  router.use(express.json({ limit: "2kb" }));

  router.get("/", async (req, res, next) => {
    try {
      const userId = req.authSession.user.id;
      const [row, tier] = await Promise.all([loadPreferences(userId, database), tierFor(userId)]);
      return noStore(res).status(200).json({ preferences: preferencesResponse(row, tier) });
    } catch (error) {
      return next(error);
    }
  });

  router.patch("/", async (req, res, next) => {
    try {
      const userId = req.authSession.user.id;
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const changes = {};
      if ("accent" in body) {
        if (body.accent !== null && !ACCENT_IDS.includes(body.accent)) return noStore(res).status(400).json({ error: "That accent is not available.", code: "bad_accent" });
        changes.accent = body.accent;
      }
      if ("sidebarHidden" in body) {
        if (!Array.isArray(body.sidebarHidden) || body.sidebarHidden.some((id) => !SIDEBAR_ITEM_IDS.includes(id))) return noStore(res).status(400).json({ error: "That sidebar item is not available.", code: "bad_sidebar_item" });
        changes.sidebarHidden = sidebarHidden(body.sidebarHidden);
      }
      const tier = await tierFor(userId);
      if ("imageWatermark" in body) {
        if (typeof body.imageWatermark !== "boolean") return noStore(res).status(400).json({ error: "Send true or false.", code: "bad_watermark" });
        if (watermarkLocked(tier)) {
          if (body.imageWatermark === false) return noStore(res).status(403).json({ error: "Images on the Free plan always carry the VibhavGPT mark.", code: "watermark_required" });
        } else {
          changes.imageWatermark = body.imageWatermark;
        }
      }
      if (!Object.keys(changes).length) {
        if ("imageWatermark" in body) return noStore(res).status(200).json({ preferences: preferencesResponse(await loadPreferences(userId, database), tier) });
        return noStore(res).status(400).json({ error: "Nothing to change.", code: "empty" });
      }
      const [row] = await database
        .insert(accountPreferences)
        .values({ userId, ...changes })
        .onConflictDoUpdate({ target: accountPreferences.userId, set: { ...changes, updatedAt: new Date() } })
        .returning();
      return noStore(res).status(200).json({ preferences: preferencesResponse(row, tier) });
    } catch (error) {
      return next(error);
    }
  });

  // A body that is not valid JSON, or too large, is the sender's mistake, not a server fault.
  router.use((error, _req, res, next) => {
    if (error?.type === "entity.parse.failed" || error?.type === "entity.too.large") return noStore(res).status(400).json({ error: "Send a small JSON object.", code: "bad_request" });
    return next(error);
  });

  return router;
}
