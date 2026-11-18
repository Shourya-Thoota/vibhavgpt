import { Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { db } from "../db/client.js";
import { requireSession } from "../middleware/require-session.js";
import { PICTURE_MAX_BYTES, PictureError, deletePicture, loadPicture, pictureVersion, processPicture, savePicture } from "./picture.js";

// /api/profile/picture: the signed-in person's own picture, and nobody else's. There is no user id in any path, query or body:
// the account is always the verified session's, so one person cannot read, replace or remove another's picture, and there is no
// listing. The picture is served only to its owner, with private cache headers.

const noStore = (res) => res.set({ "Cache-Control": "private, no-store", Vary: "Cookie" });

export function createPictureRouter({ database = db, session = requireSession, writeLimit = 10 } = {}) {
  const router = Router();
  router.use(session);

  // Changing a picture is rare, so a handful of changes in a quarter of an hour is plenty; this also bounds how much work
  // decoding images can ask of the server. It counts attempts, failed ones included, and is per account.
  const writeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: writeLimit,
    keyGenerator: (req) => `picture:${req.authSession.user.id}`,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "You have changed your picture several times. Please wait a few minutes and try again.", code: "rate_limited" },
  });

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: PICTURE_MAX_BYTES, files: 1, fields: 0, parts: 2 } }).single("picture");
  const receive = (req, res, next) => upload(req, res, (error) => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") return next(new PictureError("That picture is over 5 MB. Choose a smaller one.", 413, "too_large"));
    return next(new PictureError("Upload one picture, in a form field named picture.", 400, "bad_upload"));
  });

  router.get("/", async (req, res, next) => {
    try {
      const row = await loadPicture(req.authSession.user.id, database);
      if (!row) return noStore(res).status(404).json({ error: "No profile picture.", code: "none" });
      const etag = `"${row.sha256}"`;
      // Private, and revalidated every time: a changed picture shows at once, and an unchanged one costs a 304.
      res.set({
        "Cache-Control": "private, no-cache",
        ETag: etag,
        Vary: "Cookie",
        "Content-Type": row.contentType,
        "Content-Disposition": 'inline; filename="profile-picture.webp"',
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-site",
      });
      if (req.headers["if-none-match"] === etag) return res.status(304).end();
      return res.status(200).end(row.data);
    } catch (error) {
      return next(error);
    }
  });

  router.put("/", writeLimiter, receive, async (req, res, next) => {
    try {
      if (!req.file) throw new PictureError("Choose a picture to upload.", 400, "empty");
      const processed = await processPicture(req.file.buffer);
      const saved = await savePicture(req.authSession.user.id, processed, database);
      return noStore(res).status(200).json({ picture: { version: saved.version, updatedAt: saved.updatedAt } });
    } catch (error) {
      return next(error);
    }
  });

  router.delete("/", writeLimiter, async (req, res, next) => {
    try {
      await deletePicture(req.authSession.user.id, database);
      return noStore(res).status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  // A picture's own errors are safe to show; anything else goes to the app's error handler, which says nothing about the file.
  router.use((error, _req, res, next) => {
    if (error instanceof PictureError) return noStore(res).status(error.status).json({ error: error.message, code: error.code });
    return next(error);
  });

  return router;
}

export { pictureVersion };
