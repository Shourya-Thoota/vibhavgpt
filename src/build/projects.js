// Build's projects (owner request, 2026-11-15): one project per Build conversation, saved as numbered versions of validated files
// (src/build/artifacts.js). Every read and write names the signed-in person; another person's project is never found. Files are data:
// they are listed, shown as text, downloaded and zipped, never executed. Versions count towards the person's file storage.
import JSZip from "jszip";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { attachments, buildProjects, buildRevisions, conversations } from "../db/schema.js";
import { ARTIFACT_LIMITS, safeProjectPath } from "./artifacts.js";

let activeDb = db;
export function setBuildDbForTest(client) { activeDb = client; }

export class BuildProjectError extends Error {
  constructor(message, status = 400, code = "build_project") { super(message); this.status = status; this.code = code; }
}

const MAX_BRIEF = 4000;

/** Bytes a person's Build versions take, for the storage allowance (uploads add theirs; see src/uploads/service.js). */
export async function buildStoredBytes(userId, executor = activeDb) {
  const [row] = await executor.select({ total: sql`coalesce(sum(${buildRevisions.totalBytes}), 0)::bigint` }).from(buildRevisions).where(eq(buildRevisions.userId, userId));
  return Number(row?.total ?? 0);
}

async function uploadedBytes(userId, executor) {
  const [row] = await executor.select({ total: sql`coalesce(sum(${attachments.sizeBytes}), 0)::bigint` }).from(attachments).where(eq(attachments.userId, userId));
  return Number(row?.total ?? 0);
}

/**
 * Saves a validated set of files as the conversation's next version. The conversation must be the person's own Build conversation, and
 * the version must fit their storage allowance (accountBytes); otherwise nothing is stored. Keeps the newest ARTIFACT_LIMITS.keepRevisions.
 */
export async function saveRevision({ userId, conversationId, messageId = null, kind, entry, files, totalBytes, brief = "", title = "Build", accountBytes }) {
  return activeDb.transaction(async (tx) => {
    const [conversation] = await tx.select({ id: conversations.id, mode: conversations.mode, title: conversations.title })
      .from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId))).limit(1);
    if (!conversation || conversation.mode !== "build") throw new BuildProjectError("That build was not found.", 404, "build_not_found");
    if (Number.isFinite(accountBytes)) {
      const used = (await uploadedBytes(userId, tx)) + (await buildStoredBytes(userId, tx));
      if (used + totalBytes > accountBytes) {
        throw new BuildProjectError("Your file storage is full, so this version of the project was not saved. Delete older files, chats or builds, then ask again.", 413, "storage-limit");
      }
    }
    let [project] = await tx.select().from(buildProjects).where(and(eq(buildProjects.conversationId, conversationId), eq(buildProjects.userId, userId))).limit(1);
    if (!project) {
      [project] = await tx.insert(buildProjects).values({ userId, conversationId, title: String(conversation.title || title).slice(0, 120), kind, brief: String(brief).slice(0, MAX_BRIEF) }).returning();
    }
    const number = project.currentRevision + 1;
    await tx.insert(buildRevisions).values({ projectId: project.id, userId, number, kind, entry, files, totalBytes, messageId });
    await tx.update(buildProjects).set({ currentRevision: number, kind, updatedAt: new Date() }).where(eq(buildProjects.id, project.id));
    // Older versions past the limit are removed (their storage is freed); the newest are kept for rollback.
    const old = await tx.select({ id: buildRevisions.id }).from(buildRevisions).where(eq(buildRevisions.projectId, project.id))
      .orderBy(desc(buildRevisions.number)).offset(ARTIFACT_LIMITS.keepRevisions);
    if (old.length) await tx.delete(buildRevisions).where(inArray(buildRevisions.id, old.map((row) => row.id)));
    return { projectId: project.id, revision: number };
  });
}

const manifest = (revision) => ({
  revision: revision.number,
  kind: revision.kind,
  entry: revision.entry,
  totalBytes: revision.totalBytes,
  restoredFrom: revision.restoredFrom ?? null,
  createdAt: revision.createdAt,
  files: (revision.files ?? []).map((file) => ({ path: file.path, bytes: file.bytes, type: file.type })),
});

async function ownedProject(userId, projectId) {
  if (typeof projectId !== "string" || !/^[0-9a-f-]{36}$/i.test(projectId)) return null;
  const [project] = await activeDb.select().from(buildProjects).where(and(eq(buildProjects.id, projectId), eq(buildProjects.userId, userId))).limit(1);
  return project ?? null;
}

async function ownedRevision(userId, projectId, number) {
  const project = await ownedProject(userId, projectId);
  if (!project) return null;
  const wanted = number === "current" ? project.currentRevision : Number(number);
  if (!Number.isSafeInteger(wanted) || wanted < 1) return null;
  const [revision] = await activeDb.select().from(buildRevisions)
    .where(and(eq(buildRevisions.projectId, project.id), eq(buildRevisions.userId, userId), eq(buildRevisions.number, wanted))).limit(1);
  return revision ? { project, revision } : null;
}

/** The person's project for a conversation: its versions and the current version's file list (no contents), or null. */
export async function projectForConversation(userId, conversationId) {
  const [project] = await activeDb.select().from(buildProjects).where(and(eq(buildProjects.conversationId, conversationId), eq(buildProjects.userId, userId))).limit(1);
  if (!project) return null;
  const revisions = await activeDb.select().from(buildRevisions).where(eq(buildRevisions.projectId, project.id)).orderBy(asc(buildRevisions.number));
  const current = revisions.find((revision) => revision.number === project.currentRevision) ?? revisions.at(-1) ?? null;
  return {
    id: project.id,
    title: project.title,
    kind: project.kind,
    currentRevision: project.currentRevision,
    revisions: revisions.map((revision) => ({ revision: revision.number, createdAt: revision.createdAt, totalBytes: revision.totalBytes, files: (revision.files ?? []).length, restoredFrom: revision.restoredFrom ?? null })),
    current: current ? manifest(current) : null,
  };
}

/** One file of one of the person's versions, or null. */
export async function revisionFile(userId, projectId, number, filePath) {
  const found = await ownedRevision(userId, projectId, number);
  const wanted = safeProjectPath(filePath);
  if (!found || !wanted) return null;
  const file = (found.revision.files ?? []).find((entry) => entry.path === wanted);
  return file ? { path: file.path, content: file.content, type: file.type, revision: found.revision.number } : null;
}

/** All files of one of the person's versions, for the preview: { kind, entry, files }, or null. */
export async function revisionFiles(userId, projectId, number) {
  const found = await ownedRevision(userId, projectId, number);
  if (!found) return null;
  const files = (found.revision.files ?? []).filter((file) => safeProjectPath(file.path)).map((file) => ({ path: file.path, content: file.content }));
  return { kind: found.revision.kind, entry: found.revision.entry, files, revision: found.revision.number };
}

/** The whole version as a ZIP: exactly its files, under one folder named for the project, nothing added. */
export async function revisionZip(userId, projectId, number) {
  const found = await ownedRevision(userId, projectId, number);
  if (!found) return null;
  const folder = (found.project.title || "build").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "build";
  const zip = new JSZip();
  for (const file of found.revision.files ?? []) {
    const filePath = safeProjectPath(file.path);
    if (filePath) zip.file(`${folder}/${filePath}`, file.content);
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer, name: `${folder}-v${found.revision.number}.zip` };
}

/** Restores an earlier version as a new version (history is never rewritten). Counts towards storage like any version. */
export async function restoreRevision(userId, projectId, number, { accountBytes } = {}) {
  const found = await ownedRevision(userId, projectId, number);
  if (!found) throw new BuildProjectError("That version was not found.", 404, "build_not_found");
  const { project, revision } = found;
  return saveRevision({ userId, conversationId: project.conversationId, kind: revision.kind, entry: revision.entry, files: revision.files, totalBytes: revision.totalBytes, accountBytes })
    .then(async (saved) => {
      await activeDb.update(buildRevisions).set({ restoredFrom: revision.number }).where(and(eq(buildRevisions.projectId, project.id), eq(buildRevisions.number, saved.revision)));
      return { ...saved, restoredFrom: revision.number };
    });
}

/**
 * The current project, for Tecton's context on a follow-up: the brief and the files, within a budget. A project too large to send whole
 * sends its file list and the entry file, and says so, so Tecton never edits blind.
 */
export async function projectContext(userId, conversationId, { maxBytes = 36 * 1024 } = {}) {
  const [project] = await activeDb.select().from(buildProjects).where(and(eq(buildProjects.conversationId, conversationId), eq(buildProjects.userId, userId))).limit(1);
  if (!project || !project.currentRevision) return null;
  const found = await ownedRevision(userId, project.id, project.currentRevision);
  if (!found) return null;
  const { revision } = found;
  const files = revision.files ?? [];
  const whole = revision.totalBytes <= maxBytes;
  const included = whole ? files : files.filter((file) => file.path === revision.entry);
  const lines = [
    `The current project (version ${revision.number}, kind "${revision.kind}", entry "${revision.entry}"). Change it rather than starting again, and write the complete project back in the file format.`,
    project.brief ? `The request that started it: ${project.brief}` : "",
    `Files: ${files.map((file) => file.path).join(", ")}.`,
    whole ? "" : "The project is too large to show whole here: only its entry file is below. Keep the other files as they are unless asked.",
    ...included.map((file) => `<<<FILE path="${file.path}">>>\n${file.content}\n<<<END FILE>>>`),
  ].filter(Boolean);
  return { text: lines.join("\n"), revision: revision.number, whole };
}
