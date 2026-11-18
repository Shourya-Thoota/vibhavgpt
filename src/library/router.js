import { access, rm } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { and, desc, eq, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { attachments, conversations } from "../db/schema.js";
import { requireSession } from "../middleware/require-session.js";
import { uploadRoot } from "../uploads/service.js";
import { isGeneratedImage, sendStoredFile } from "./delivery.js";

// /api/library: the documents and pictures VibhavGPT made for the signed-in person, and nobody else's.
//
// - Every query is scoped to the session's account in the SQL. There is no account id in any path, query or body.
// - Only generated files are listed (kind generated-file, generated-image). Files a person uploaded are theirs and stay with the
//   message they were sent with; they are not part of the Library.
// - The list is paged by a cursor (newest first), so a long history is never loaded at once.
// - Deleting removes the stored file and its record, everywhere. The conversation it came from keeps its words; the file is gone
//   from it as well, and the confirmation says so.

const KINDS = { documents: ["generated-file"], images: ["generated-image"], all: ["generated-file", "generated-image"] };
export const LIBRARY_PAGE = 24;
export const LIBRARY_MAX_PAGE = 60;

const noStore = (res) => res.set({ "Cache-Control": "private, no-store", Vary: "Cookie" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The cursor is the last item's time and id, opaque to the caller. A damaged cursor is rejected, never trusted.
const encodeCursor = (row) => Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id])).toString("base64url");
function decodeCursor(value) {
  try {
    const [at, id] = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    const when = new Date(at);
    if (Number.isNaN(when.getTime()) || !UUID.test(id)) return null;
    return { when, id };
  } catch {
    return null;
  }
}

const escapeLike = (text) => text.replace(/[\\%_]/g, (character) => `\\${character}`);

const view = (row, available) => ({
  id: row.id,
  name: row.displayName || row.originalName,
  kind: row.kind === "generated-image" ? "image" : "document",
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  createdAt: row.createdAt.toISOString(),
  prompt: row.kind === "generated-image" ? row.prompt : null,
  previewText: row.extractedText ? row.extractedText.slice(0, 300) : null,
  available,
  conversation: row.conversationId ? { id: row.conversationId, title: row.conversationTitle ?? "Conversation", mode: row.conversationMode ?? "chat" } : null,
  // Same-origin, owner-only addresses. Nothing here is a public link.
  previewUrl: row.kind === "generated-image" ? `/api/library/${row.id}/preview` : null,
  downloadUrl: `/api/library/${row.id}/download`,
});

export function createLibraryRouter({ database = db, session = requireSession, root = uploadRoot, deliver = sendStoredFile, removeFile = (file) => rm(file, { force: true }), perMinute = 120 } = {}) {
  const router = Router();
  router.use(session);
  router.use(rateLimit({
    windowMs: 60 * 1000,
    limit: perMinute,
    keyGenerator: (req) => `library:${req.authSession.user.id}`,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests. Please wait a moment.", code: "rate_limited" },
  }));

  const owned = (userId, id) => database.select().from(attachments).where(and(eq(attachments.id, id), eq(attachments.userId, userId), inArray(attachments.kind, KINDS.all))).limit(1).then((rows) => rows[0] ?? null);

  router.get("/", async (req, res, next) => {
    try {
      const userId = req.authSession.user.id;
      const kinds = KINDS[req.query.type] ?? KINDS.all;
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || LIBRARY_PAGE, 1), LIBRARY_MAX_PAGE);
      const filters = [eq(attachments.userId, userId), inArray(attachments.kind, kinds)];
      if (req.query.cursor) {
        const cursor = decodeCursor(req.query.cursor);
        if (!cursor) return noStore(res).status(400).json({ error: "That page is not valid.", code: "bad_cursor" });
        filters.push(or(lt(attachments.createdAt, cursor.when), and(eq(attachments.createdAt, cursor.when), lt(attachments.id, cursor.id))));
      }
      const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
      if (q) filters.push(or(ilike(attachments.originalName, `%${escapeLike(q)}%`), ilike(attachments.displayName, `%${escapeLike(q)}%`), ilike(attachments.prompt, `%${escapeLike(q)}%`)));
      // Files and images from a temporary chat are not kept in the Library: they go when the chat is deleted after 24 hours.
      filters.push(or(isNull(conversations.id), eq(conversations.temporary, false)));
      const rows = await database
        .select({
          id: attachments.id, displayName: attachments.displayName, originalName: attachments.originalName, kind: attachments.kind, mimeType: attachments.mimeType,
          sizeBytes: attachments.sizeBytes, createdAt: attachments.createdAt, prompt: attachments.prompt, extractedText: attachments.extractedText, storedName: attachments.storedName, conversationId: attachments.conversationId,
          conversationTitle: conversations.title, conversationMode: conversations.mode,
        })
        .from(attachments)
        .leftJoin(conversations, and(eq(conversations.id, attachments.conversationId), eq(conversations.userId, userId)))
        .where(and(...filters))
        .orderBy(desc(attachments.createdAt), desc(attachments.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      // A record whose file is no longer on disk is shown as unavailable rather than offered as a download that fails.
      const items = await Promise.all(page.map(async (row) => view(row, await access(path.join(root, row.storedName)).then(() => true, () => false))));
      return noStore(res).status(200).json({ items, nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/:id/preview", async (req, res, next) => {
    try {
      if (!UUID.test(req.params.id)) return noStore(res).status(404).json({ error: "Not found." });
      const record = await owned(req.authSession.user.id, req.params.id);
      if (!record || !isGeneratedImage(record)) return noStore(res).status(404).json({ error: "Not found." });
      return deliver(res, next, record, req.authSession.user.id, { disposition: "inline", root });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/:id/download", async (req, res, next) => {
    try {
      if (!UUID.test(req.params.id)) return noStore(res).status(404).json({ error: "Not found." });
      const record = await owned(req.authSession.user.id, req.params.id);
      if (!record) return noStore(res).status(404).json({ error: "Not found." });
      return deliver(res, next, record, req.authSession.user.id, { disposition: "attachment", root });
    } catch (error) {
      return next(error);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      if (!UUID.test(req.params.id)) return noStore(res).status(404).json({ error: "Not found." });
      const userId = req.authSession.user.id;
      const record = await owned(userId, req.params.id);
      if (!record) return noStore(res).status(404).json({ error: "Not found." });
      // The record first, then the file: a file left behind is harmless and swept later; a record left pointing at nothing is not.
      await database.delete(attachments).where(and(eq(attachments.id, record.id), eq(attachments.userId, userId)));
      await removeFile(path.join(root, record.storedName)).catch(() => {});
      return noStore(res).status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
