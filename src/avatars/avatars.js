import { createHash } from "node:crypto";
import { and, asc, count, eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../db/client.js";
import { savedAvatars } from "../db/schema.js";
import { PictureError, sniffImageType } from "../profile/picture.js";

// Saved avatars: reference photos a person keeps to use when making images. They are separate from the one profile picture and are
// never used for anything unless the person picks one for an image, or explicitly sets one as their profile picture.
//
// What is stored is the server's own copy: decoded (so an invalid or hostile file is refused), turned upright, limited to 1536 px on
// its longer side, and written out again with no metadata (no location, camera or timestamps). Only that copy is kept. Nothing here
// computes or keeps a face template or any embedding: a picture is bytes and a name, and nothing more.

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_MAX_COUNT = 10;
export const AVATAR_MAX_SIDE = 1536;
export const AVATAR_MIN_SIDE = 64;
const MAX_INPUT_PIXELS = 40_000_000;
export const AVATAR_NAME_MAX = 40;

export const cleanAvatarName = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, AVATAR_NAME_MAX);

export async function processAvatar(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  if (!bytes.length) throw new PictureError("Choose a picture to upload.", 400, "empty");
  if (bytes.length > AVATAR_MAX_BYTES) throw new PictureError("That picture is over 5 MB. Choose a smaller one.", 413, "too_large");
  const type = sniffImageType(bytes);
  if (!type) throw new PictureError("Use a JPEG, PNG or WebP picture.", 415, "unsupported_type");
  try {
    const image = sharp(bytes, { animated: false, limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
    const meta = await image.metadata();
    if (meta.format !== type) throw new PictureError("That file is not a valid image.", 400, "invalid_image");
    if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < AVATAR_MIN_SIDE) {
      throw new PictureError(`That picture is too small. Use one at least ${AVATAR_MIN_SIDE} pixels wide and tall.`, 400, "too_small");
    }
    const upright = image.rotate().resize(AVATAR_MAX_SIDE, AVATAR_MAX_SIDE, { fit: "inside", withoutEnlargement: true });
    // Pictures with transparency stay PNG; everything else becomes a JPEG, which is much smaller for photographs.
    const { data, info } = meta.hasAlpha
      ? await upright.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
      : await upright.jpeg({ quality: 90, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    return {
      data, contentType: meta.hasAlpha ? "image/png" : "image/jpeg", width: info.width, height: info.height, byteSize: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  } catch (error) {
    if (error instanceof PictureError) throw error;
    if (/pixel limit/i.test(String(error?.message))) throw new PictureError("That picture is too large in pixels. Choose a smaller one.", 413, "too_many_pixels");
    throw new PictureError("That file is not a valid image.", 400, "invalid_image");
  }
}

const listColumns = { id: savedAvatars.id, name: savedAvatars.name, contentType: savedAvatars.contentType, width: savedAvatars.width, height: savedAvatars.height, byteSize: savedAvatars.byteSize, sha256: savedAvatars.sha256, createdAt: savedAvatars.createdAt };

export const listAvatars = (userId, database = db) => database.select(listColumns).from(savedAvatars).where(eq(savedAvatars.userId, userId)).orderBy(asc(savedAvatars.createdAt), asc(savedAvatars.id));

export async function loadAvatar(userId, id, database = db) {
  const [row] = await database.select().from(savedAvatars).where(and(eq(savedAvatars.id, id), eq(savedAvatars.userId, userId))).limit(1);
  return row ? { ...row, data: Buffer.from(row.data) } : null;
}

// The count and the insert are one statement, so two uploads at once cannot both slip under the limit.
export async function addAvatar(userId, name, processed, database = db) {
  return database.transaction(async (tx) => {
    const [{ value }] = await tx.select({ value: count() }).from(savedAvatars).where(eq(savedAvatars.userId, userId));
    if (value >= AVATAR_MAX_COUNT) throw new PictureError(`You can keep up to ${AVATAR_MAX_COUNT} saved avatars. Delete one to add another.`, 409, "limit_reached");
    const [row] = await tx.insert(savedAvatars).values({ userId, name, contentType: processed.contentType, width: processed.width, height: processed.height, byteSize: processed.byteSize, sha256: processed.sha256, data: processed.data }).returning(listColumns);
    return row;
  });
}

export const renameAvatar = async (userId, id, name, database = db) => (await database.update(savedAvatars).set({ name, updatedAt: new Date() }).where(and(eq(savedAvatars.id, id), eq(savedAvatars.userId, userId))).returning(listColumns))[0] ?? null;
export const deleteAvatar = async (userId, id, database = db) => (await database.delete(savedAvatars).where(and(eq(savedAvatars.id, id), eq(savedAvatars.userId, userId))).returning({ id: savedAvatars.id })).length > 0;

// For the account export: every saved avatar with its picture as base64, so the export stays one JSON file.
export async function avatarsForExport(userId, database = db) {
  const rows = await database.select().from(savedAvatars).where(eq(savedAvatars.userId, userId)).orderBy(asc(savedAvatars.createdAt));
  return rows.map((row) => ({ name: row.name, contentType: row.contentType, width: row.width, height: row.height, createdAt: row.createdAt, dataBase64: Buffer.from(row.data).toString("base64") }));
}
