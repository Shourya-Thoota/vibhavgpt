// The VibhavGPT image watermark (owner policy, 2026-11-16, superseding the removal in #70).
//
// Policy, enforced here on the server (the Settings switch only shows it):
// - Free plan: every generated picture is delivered with the mark. It cannot be turned off.
// - Paid plans (Plus, Pro, Max, and complimentary accounts, which carry a paid plan): optional, off unless the person turns it on.
// - If the plan or the choice cannot be read, the picture is marked: the Free rule must not fail open.
//
// Where: on delivery. Every route that hands out a generated picture (view, download, Library, export) goes through
// src/library/delivery.js, which marks it here when the policy says so. The stored original is never changed, so the choice and the plan
// apply to every picture, old and new, wherever it is opened. A picture marked with the earlier blue mark is not marked twice.
//
// The mark: a monochrome black-and-white VibhavGPT logo and name on a transparent background (assets/vibhavgpt-watermark.png, built by
// scripts/build-watermark-asset.mjs), scaled to the picture, in the bottom-right corner with padding, in the picture's own format.
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { getCurrentUsage } from "../usage/service.js";
import { loadPreferences } from "../profile/preferences.js";

const MARK = readFileSync(new URL("./assets/vibhavgpt-watermark.png", import.meta.url));

// Proportions: the mark spans 22% of the picture's width (at least 96 px, at most 560 px, never more than half the width), sits a padding
// of 2.5% of the shorter side (at least 8 px) from the right and bottom edges, and is drawn at 88% opacity.
export const WATERMARK_LAYOUT = Object.freeze({ widthShare: 0.22, minWidth: 96, maxWidth: 560, maxShare: 0.5, paddingShare: 0.025, minPadding: 8, opacity: 0.88 });

export const watermarkRequiredForTier = (tier) => !tier || tier === "free";

/** Whether this account's pictures are delivered with the mark now. */
export async function shouldWatermark(userId, { tierOf = async (id) => (await getCurrentUsage(id)).tier, preferencesOf = loadPreferences } = {}) {
  try {
    const tier = await tierOf(userId);
    if (watermarkRequiredForTier(tier)) return true;
    const row = await preferencesOf(userId);
    return row?.imageWatermark === true;
  } catch {
    return true;
  }
}

const OUTPUT = { "image/png": (s) => s.png(), "image/jpeg": (s) => s.jpeg({ quality: 92, mozjpeg: true }), "image/webp": (s) => s.webp({ quality: 92 }) };

/** Draws the mark onto a picture: { buffer, mimeType } in the picture's own format (PNG for any other). */
export async function applyWatermark(input, mimeType = "image/png") {
  const image = sharp(input, { failOn: "error" }).rotate();
  const { width, height } = await image.metadata().then((m) => (m.orientation >= 5 ? { width: m.height, height: m.width } : m));
  if (!width || !height) throw new Error("The picture has no size.");
  const L = WATERMARK_LAYOUT;
  const markWidth = Math.max(1, Math.round(Math.min(width * L.maxShare, Math.max(L.minWidth, Math.min(L.maxWidth, width * L.widthShare)))));
  const resized = await sharp(MARK).resize({ width: markWidth, kernel: "lanczos3" }).ensureAlpha().toBuffer({ resolveWithObject: true });
  // Opacity: the mark's own transparency, scaled.
  const faded = await sharp(resized.data)
    .composite([{ input: Buffer.from([255, 255, 255, Math.round(255 * L.opacity)]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: "dest-in" }])
    .png().toBuffer();
  const markHeight = resized.info.height;
  const padding = Math.max(L.minPadding, Math.round(Math.min(width, height) * L.paddingShare));
  const left = Math.max(0, width - markWidth - padding);
  const top = Math.max(0, height - markHeight - padding);
  const type = OUTPUT[mimeType] ? mimeType : "image/png";
  const buffer = await OUTPUT[type](image.composite([{ input: faded, left, top }])).toBuffer();
  return { buffer, mimeType: type, box: { left, top, width: markWidth, height: markHeight, padding } };
}
