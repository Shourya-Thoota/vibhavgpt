import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../db/client.js";
import { profilePictures } from "../db/schema.js";

// Profile pictures. What a person uploads is never stored: it is checked by what its bytes are (not by its name or the type the
// browser claims), decoded, turned the way its camera held it, cropped to a square, scaled to 256px and written out as a new WebP
// with no metadata at all (no location, no camera, no timestamps). Only that result is kept, as a few kilobytes in the database.

export const PICTURE_MAX_BYTES = 5 * 1024 * 1024;
export const PICTURE_SIZE = 256;
// A decompression-bomb guard: a small file can claim to be enormous. This is about 6,300 by 6,300 pixels, and sharp refuses beyond it.
const MAX_INPUT_PIXELS = 40_000_000;
const MIN_SIDE = 32;

export class PictureError extends Error {
  constructor(message, status = 400, code = "invalid_picture") {
    super(message);
    this.name = "PictureError";
    this.status = status;
    this.code = code;
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// What a file is, from its first bytes. Anything else (a GIF, an SVG, a PDF, a program with a .png name) is not accepted.
export function sniffImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

// Bytes in, the picture to store out: a 256 by 256 WebP and its fingerprint. Throws a PictureError that is safe to show.
export async function processPicture(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  if (!bytes.length) throw new PictureError("Choose a picture to upload.", 400, "empty");
  if (bytes.length > PICTURE_MAX_BYTES) throw new PictureError("That picture is over 5 MB. Choose a smaller one.", 413, "too_large");
  const type = sniffImageType(bytes);
  if (!type) throw new PictureError("Use a JPEG, PNG or WebP picture.", 415, "unsupported_type");
  try {
    const image = sharp(bytes, { animated: false, limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
    const meta = await image.metadata();
    // The decoder must agree with the first bytes: a file that starts like one format and decodes as another is not trusted.
    if (meta.format !== type) throw new PictureError("That file is not a valid image.", 400, "invalid_image");
    if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < MIN_SIDE) {
      throw new PictureError(`That picture is too small. Use one at least ${MIN_SIDE} pixels wide and tall.`, 400, "too_small");
    }
    const data = await image
      .rotate()
      .resize(PICTURE_SIZE, PICTURE_SIZE, { fit: "cover", position: "centre" })
      .webp({ quality: 85 })
      .toBuffer();
    return { data, contentType: "image/webp", byteSize: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  } catch (error) {
    if (error instanceof PictureError) throw error;
    if (/pixel limit/i.test(String(error?.message))) throw new PictureError("That picture is too large in pixels. Choose a smaller one.", 413, "too_many_pixels");
    throw new PictureError("That file is not a valid image.", 400, "invalid_image");
  }
}

// A short, stable name for one version of a picture: it changes when the picture does, so a screen knows when to fetch again.
export const pictureVersion = (sha256) => (sha256 ? String(sha256).slice(0, 16) : null);

export async function savePicture(userId, picture, database = db) {
  const [row] = await database
    .insert(profilePictures)
    .values({ userId, contentType: picture.contentType, byteSize: picture.byteSize, sha256: picture.sha256, data: picture.data })
    .onConflictDoUpdate({
      target: profilePictures.userId,
      set: { contentType: picture.contentType, byteSize: picture.byteSize, sha256: picture.sha256, data: picture.data, updatedAt: new Date() },
    })
    .returning({ sha256: profilePictures.sha256, updatedAt: profilePictures.updatedAt });
  return { version: pictureVersion(row.sha256), updatedAt: row.updatedAt };
}

export async function loadPicture(userId, database = db) {
  const [row] = await database.select().from(profilePictures).where(eq(profilePictures.userId, userId)).limit(1);
  return row ? { ...row, data: Buffer.from(row.data) } : null;
}

export async function deletePicture(userId, database = db) {
  const removed = await database.delete(profilePictures).where(eq(profilePictures.userId, userId)).returning({ userId: profilePictures.userId });
  return removed.length > 0;
}

// The Google photo a person signed in with, if it is one: an https address on Google's own picture host. Anything else in the
// account's image field is ignored, so no other address is ever handed to a browser to load.
export function googlePhotoUrl(image) {
  try {
    const url = new URL(String(image ?? ""));
    return url.protocol === "https:" && /(^|\.)googleusercontent\.com$/i.test(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

// The picture as the account export carries it: the stored WebP as base64, so the export stays one JSON file. Null when none.
export async function profilePictureForExport(userId, database = db) {
  const row = await loadPicture(userId, database);
  return row ? { contentType: row.contentType, byteSize: row.byteSize, updatedAt: row.updatedAt, dataBase64: row.data.toString("base64") } : null;
}
