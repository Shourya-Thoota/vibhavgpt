import { randomUUID } from "node:crypto";
import path from "node:path";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Router } from "express";
import { accessPayload } from "../../frontend/src/access-status.js";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import multer from "multer";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { attachments } from "../db/schema.js";
import { loadOptionalSession, requireSession } from "../middleware/require-session.js";
import { getCurrentUsage } from "../usage/service.js";
import {
  UploadError,
  assertUploadQuota,
  cleanupUnattachedUploads,
  ensureUploadDirectories,
  incomingDirectory,
  persistUploadedFile,
  removeFiles,
  uploadRoot,
  uploadLimitsForUser,
} from "./service.js";

const absoluteMaxFileBytes = 80 * 1024 * 1024;
export const UPLOAD_REQUEST_LIMITS = { free: 8, plus: 25, pro: 60 };
export const UNAUTHENTICATED_UPLOAD_REQUEST_LIMIT = 30;

const unauthenticatedUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: UNAUTHENTICATED_UPLOAD_REQUEST_LIMIT,
  // A session is loaded before this limiter. Authenticated callers use only
  // their tier-specific bucket below; anonymous traffic remains IP-bounded.
  skip: (req) => Boolean(req.authSession),
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Please wait before uploading more files." },
});

async function resolveUploadRequestTier(req, _res, next) {
  try {
    const usage = await getCurrentUsage(req.authSession.user.id);
    req.uploadRequestTier = usage.tier;
    return next();
  } catch (error) {
    return next(error);
  }
}

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: (req) => UPLOAD_REQUEST_LIMITS[req.uploadRequestTier] ?? UPLOAD_REQUEST_LIMITS.free,
  keyGenerator: (req) => ["plus", "pro"].includes(req.uploadRequestTier)
    ? `user:${req.authSession.user.id}`
    : ipKeyGenerator(req.ip),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Please wait before uploading more files." },
});

const storage = multer.diskStorage({
  destination: async (_req, _file, callback) => {
    try {
      await ensureUploadDirectories();
      callback(null, incomingDirectory);
    } catch (error) {
      callback(error);
    }
  },
  filename: (_req, file, callback) => callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
});
const upload = multer({ storage, limits: { files: 3, fileSize: absoluteMaxFileBytes, fields: 0, parts: 4 } });

export const uploadRouter = Router();
uploadRouter.use(loadOptionalSession, unauthenticatedUploadLimiter);
uploadRouter.use(requireSession);

uploadRouter.get("/limits", async (req, res, next) => {
  try {
    const limits = await uploadLimitsForUser(req.authSession.user.id);
    return res.json(limits);
  } catch (error) {
    return next(error);
  }
});

// Browsing a gallery or opening materials must not spend the upload budget.
uploadRouter.post("/", resolveUploadRequestTier, uploadLimiter, (req, res, next) => {
  upload.array("files", 3)(req, res, (error) => {
    if (error) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({ error: error.code === "LIMIT_FILE_SIZE" ? "A file exceeds the 80 MB maximum." : "We couldn't upload those files." });
    }
    return next();
  });
}, async (req, res, next) => {
  const files = Array.isArray(req.files) ? req.files : [];
  let saved = [];
  try {
    const userId = req.authSession.user.id;
    const limits = await uploadLimitsForUser(userId);
    await assertUploadQuota(userId, files, limits);
    for (const file of files) saved.push(await persistUploadedFile({ userId, file, limits }));
    await cleanupUnattachedUploads().catch(() => {});
    return res.status(201).json({
      attachments: saved.map((file) => ({ id: file.id, name: file.originalName, mimeType: file.mimeType, kind: file.kind, sizeBytes: file.sizeBytes, status: file.extractionStatus })),
      limits,
    });
  } catch (error) {
    await removeFiles(files.map((file) => ({ storedName: path.basename(file.path) })));
    await removeFiles(saved);
    for (const file of saved) await db.delete(attachments).where(eq(attachments.id, file.id));
    if (error instanceof UploadError) return res.status(error.status).json(accessPayload(error));
    return next(error);
  }
});

uploadRouter.get("/:id/download", async (req, res, next) => {
  try {
    const [record] = await db.select().from(attachments).where(and(eq(attachments.id, req.params.id), eq(attachments.userId, req.authSession.user.id))).limit(1);
    if (!record) return res.status(404).json({ error: "File not found." });
    res.attachment(record.originalName);
    res.type(record.mimeType || "application/octet-stream");
    return createReadStream(path.join(uploadRoot, record.storedName)).on("error", next).pipe(res);
  } catch (error) { return next(error); }
});

// Generated images are private, but chat needs a display-safe inline URL. A
// separate endpoint keeps downloads as attachments while never making uploads
// publicly addressable.
uploadRouter.get("/:id/preview", async (req, res, next) => {
  try {
    const [record] = await db.select().from(attachments).where(and(eq(attachments.id, req.params.id), eq(attachments.userId, req.authSession.user.id))).limit(1);
    if (!record || record.kind !== "generated-image" || !record.mimeType.startsWith("image/")) return res.status(404).json({ error: "Image preview not found." });
    res.type(record.mimeType);
    return createReadStream(path.join(uploadRoot, record.storedName)).on("error", next).pipe(res);
  } catch (error) {
    return next(error);
  }
});

uploadRouter.delete("/:id", async (req, res, next) => {
  try {
    // Pending files can safely be removed before they are sent. Attached files
    // are managed with their conversation/account so past chat history stays coherent.
    const [record] = await db.select().from(attachments).where(and(eq(attachments.id, req.params.id), eq(attachments.userId, req.authSession.user.id), isNull(attachments.messageId))).limit(1);
    if (!record) return res.status(404).json({ error: "File not found." });
    await rm(path.join(uploadRoot, record.storedName), { force: true });
    await db.delete(attachments).where(eq(attachments.id, record.id));
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});
