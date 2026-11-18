import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { db } from "../db/client.js";
import { requireSession } from "../middleware/require-session.js";
import { PictureError, processPicture, savePicture } from "../profile/picture.js";
import { AVATAR_MAX_BYTES, AVATAR_MAX_COUNT, AVATAR_NAME_MAX, addAvatar, cleanAvatarName, deleteAvatar, listAvatars, loadAvatar, processAvatar, renameAvatar } from "./avatars.js";

// /api/avatars: the signed-in person's saved reference photos, and nobody else's. No account id appears in any path, query or body.
// Pictures are served only to their owner, with private cache headers. There is no listing of anyone else's, and nothing here is
// public.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = (res) => res.set({ "Cache-Control": "private, no-store", Vary: "Cookie" });
const view = (row) => ({ id: row.id, name: row.name, width: row.width, height: row.height, sizeBytes: row.byteSize, createdAt: row.createdAt, imageUrl: `/api/avatars/${row.id}/image?v=${String(row.sha256).slice(0, 12)}` });

export function createAvatarRouter({ database = db, session = requireSession, writeLimit = 20 } = {}) {
  const router = Router();
  router.use(session);

  // Decoding images is the costly part, so uploads and changes are limited per account.
  const writeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: writeLimit,
    keyGenerator: (req) => `avatars:${req.authSession.user.id}`,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "You have changed your avatars several times. Please wait a few minutes and try again.", code: "rate_limited" },
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 2, parts: 4 } }).single("avatar");
  const receive = (req, res, next) => upload(req, res, (error) => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") return next(new PictureError("That picture is over 5 MB. Choose a smaller one.", 413, "too_large"));
    return next(new PictureError("Upload one picture, in a form field named avatar.", 400, "bad_upload"));
  });

  router.get("/", async (req, res, next) => {
    try {
      const rows = await listAvatars(req.authSession.user.id, database);
      return noStore(res).status(200).json({ avatars: rows.map(view), limit: AVATAR_MAX_COUNT });
    } catch (error) { return next(error); }
  });

  router.get("/:id/image", async (req, res, next) => {
    try {
      if (!UUID.test(req.params.id)) return noStore(res).status(404).json({ error: "Not found." });
      const row = await loadAvatar(req.authSession.user.id, req.params.id, database);
      if (!row) return noStore(res).status(404).json({ error: "Not found." });
      const etag = `"${row.sha256}"`;
      res.set({ "Cache-Control": "private, no-cache", ETag: etag, Vary: "Cookie", "Content-Type": row.contentType, "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-site" });
      if (req.headers["if-none-match"] === etag) return res.status(304).end();
      return res.status(200).end(row.data);
    } catch (error) { return next(error); }
  });

  router.post("/", writeLimiter, receive, async (req, res, next) => {
    try {
      if (!req.file) throw new PictureError("Choose a picture to upload.", 400, "empty");
      const name = cleanAvatarName(req.body?.name) || cleanAvatarName(String(req.file.originalname ?? "").replace(/\.[^.]+$/, "")) || "Avatar";
      const processed = await processAvatar(req.file.buffer);
      const row = await addAvatar(req.authSession.user.id, name, processed, database);
      return noStore(res).status(201).json({ avatar: view(row) });
    } catch (error) { return next(error); }
  });

  router.patch("/:id", writeLimiter, express.json({ limit: "2kb" }), async (req, res, next) => {
    try {
      if (!UUID.test(req.params.id)) return noStore(res).status(404).json({ error: "Not found." });
      const name = cleanAvatarName(req.body?.name);
      if (!name) return noStore(res).status(400).json({ error: `Give it a name of up to ${AVATAR_NAME_MAX} characters.`, code: "bad_name" });
      const row = await renameAvatar(req.authSession.user.id, req.params.id, name, database);
      if (!row) return noStore(res).status(404).json({ error: "Not found." });
      return noStore(res).status(200).json({ avatar: view(row) });
    } catch (error) { return next(error); }
  });

  router.delete("/:id", writeLimiter, async (req, res, next) => {
    try {
      if (!UUID.test(req.params.id)) return noStore(res).status(404).json({ error: "Not found." });
      const removed = await deleteAvatar(req.authSession.user.id, req.params.id, database);
      return noStore(res).status(removed ? 204 : 404).end();
    } catch (error) { return next(error); }
  });

  // Only ever on the person's explicit request. The profile picture is made the way an uploaded one is: decoded again, cropped square,
  // 256 px, no metadata. The saved avatar itself is unchanged.
  router.post("/:id/use-as-profile-picture", writeLimiter, async (req, res, next) => {
    try {
      if (!UUID.test(req.params.id)) return noStore(res).status(404).json({ error: "Not found." });
      const userId = req.authSession.user.id;
      const row = await loadAvatar(userId, req.params.id, database);
      if (!row) return noStore(res).status(404).json({ error: "Not found." });
      const saved = await savePicture(userId, await processPicture(row.data), database);
      return noStore(res).status(200).json({ picture: { version: saved.version } });
    } catch (error) { return next(error); }
  });

  router.use((error, _req, res, next) => {
    if (error instanceof PictureError) return noStore(res).status(error.status).json({ error: error.message, code: error.code });
    if (error?.type === "entity.parse.failed" || error?.type === "entity.too.large") return noStore(res).status(400).json({ error: "Send a small JSON object.", code: "bad_request" });
    return next(error);
  });

  return router;
}
