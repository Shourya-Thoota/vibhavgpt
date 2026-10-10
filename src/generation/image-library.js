import { and, asc, desc, eq, isNull, lt, or } from "drizzle-orm";
import { attachments, imageFolders } from "../db/schema.js";

const PAGE_SIZE = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failure = (status, message) => Object.assign(new Error(message), { status });

export function requireImageId(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw failure(400, "Invalid image or folder.");
  return value;
}

function folderName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) {
    throw failure(400, "Use a folder name between 1 and 120 characters.");
  }
  return value.trim();
}

export function imageAttachmentView(attachment) {
  return {
    id: attachment.id, name: attachment.originalName, displayName: attachment.displayName ?? null,
    folderId: attachment.folderId ?? null, mimeType: attachment.mimeType, kind: attachment.kind,
    sizeBytes: attachment.sizeBytes, prompt: attachment.prompt, parentAttachmentId: attachment.parentAttachmentId,
    meta: attachment.generationMeta, createdAt: attachment.createdAt,
    downloadUrl: `/api/uploads/${attachment.id}/download`, previewUrl: `/api/uploads/${attachment.id}/preview`,
  };
}

// The injected database lets integration tests exercise the same queries against
// isolated Postgres. All operations derive ownership from the authenticated user.
export function createImageLibrary(db) {
  const ownedImage = (userId, id) => and(eq(attachments.userId, userId), eq(attachments.id, id), eq(attachments.kind, "generated-image"));
  async function getFolder(userId, id) {
    requireImageId(id);
    const [folder] = await db.select().from(imageFolders).where(and(eq(imageFolders.userId, userId), eq(imageFolders.id, id))).limit(1);
    if (!folder) throw failure(404, "Folder not found.");
    return folder;
  }
  return {
    async listFolders(userId) {
      return db.select().from(imageFolders).where(eq(imageFolders.userId, userId)).orderBy(asc(imageFolders.name), asc(imageFolders.id));
    },
    async createFolder(userId, name) {
      const [folder] = await db.insert(imageFolders).values({ userId, name: folderName(name) }).returning();
      return folder;
    },
    async renameFolder(userId, id, name) {
      requireImageId(id);
      const [folder] = await db.update(imageFolders).set({ name: folderName(name), updatedAt: new Date() })
        .where(and(eq(imageFolders.userId, userId), eq(imageFolders.id, id))).returning();
      if (!folder) throw failure(404, "Folder not found.");
      return folder;
    },
    async updateImage(userId, id, body) {
      requireImageId(id);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw failure(400, "Choose a name or folder to update.");
      const change = {};
      if (Object.hasOwn(body, "displayName")) {
        if (body.displayName !== null && (typeof body.displayName !== "string" || body.displayName.trim().length > 160)) {
          throw failure(400, "Use an image name of 160 characters or fewer.");
        }
        change.displayName = body.displayName?.trim() || null;
      }
      if (Object.hasOwn(body, "folderId")) {
        if (body.folderId !== null) await getFolder(userId, body.folderId);
        change.folderId = body.folderId;
      }
      if (!Object.keys(change).length) throw failure(400, "Choose a name or folder to update.");
      const [image] = await db.update(attachments).set({ ...change, updatedAt: new Date() }).where(ownedImage(userId, id)).returning();
      if (!image) throw failure(404, "Image not found.");
      return image;
    },
    async listImages(userId, { folder, cursor } = {}) {
      const conditions = [eq(attachments.userId, userId), eq(attachments.kind, "generated-image")];
      if (folder === "unfiled") conditions.push(isNull(attachments.folderId));
      else if (folder != null && folder !== "all") {
        await getFolder(userId, folder);
        conditions.push(eq(attachments.folderId, folder));
      }
      if (cursor != null) {
        requireImageId(cursor);
        const [anchor] = await db.select({ createdAt: attachments.createdAt, id: attachments.id }).from(attachments)
          .where(and(...conditions, eq(attachments.id, cursor))).limit(1);
        if (!anchor) throw failure(400, "This gallery changed. Refresh it and try again.");
        // The UUID tie-breaker keeps images from the same generation batch from
        // disappearing between pages when their creation timestamps match.
        conditions.push(or(lt(attachments.createdAt, anchor.createdAt), and(eq(attachments.createdAt, anchor.createdAt), lt(attachments.id, anchor.id))));
      }
      const rows = await db.select().from(attachments).where(and(...conditions))
        .orderBy(desc(attachments.createdAt), desc(attachments.id)).limit(PAGE_SIZE + 1);
      const images = rows.slice(0, PAGE_SIZE);
      return { images, nextCursor: rows.length > PAGE_SIZE ? images.at(-1).id : null };
    },
  };
}
