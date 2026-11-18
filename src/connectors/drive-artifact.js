// Putting a file this conversation already made into the person's Google Drive.
//
// "Add it to my drive" means the document already on the screen, not a new one and not the text of the last reply. This module finds that
// file (only ever the caller's own, from this conversation), reads its stored bytes safely, binds an approval to those exact bytes, and
// resolves the folder by looking it up (never by trusting a name as an id). It touches no provider write: the approved upload itself
// runs in connectors/service.js, after the person has seen the resolved file, folder and account and approved them.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { attachments } from "../db/schema.js";
import { isDriveFolderId } from "./drive-upload.js";

// Drive's own upload tool accepts files up to 5 MB.
export const DRIVE_FILE_MAX_BYTES = 5 * 1024 * 1024;

const TEXT_TYPES = /^(?:text\/(?:plain|markdown|csv|html)|application\/json)$/i;

/** Formats Drive can create from text; every other format needs the file itself handed over. */
export function isTextArtifact(mimeType) {
  return TEXT_TYPES.test(String(mimeType ?? "").split(";")[0].trim());
}

export function artifactSha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** A short label for a card: "PDF, 120 KB". */
export function describeArtifact({ originalName, mimeType, sizeBytes }) {
  const extension = path.extname(String(originalName ?? "")).replace(".", "").toUpperCase() || String(mimeType ?? "file").split("/").pop().toUpperCase();
  const size = Number(sizeBytes) || 0;
  const readable = size >= 1_048_576 ? `${(size / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${extension}, ${readable}`;
}

/** The newest file this conversation generated for this person, or null. Never another person's file, never another conversation's. */
export async function findLatestArtifact(userId, conversationId, executor = db) {
  if (!userId || !conversationId) return null;
  const [record] = await executor
    .select()
    .from(attachments)
    .where(and(eq(attachments.userId, userId), eq(attachments.conversationId, conversationId), eq(attachments.kind, "generated-file")))
    .orderBy(desc(attachments.createdAt))
    .limit(1);
  return record ?? null;
}

/**
 * The stored bytes for one of the caller's own generated files, checked against what the approval was bound to.
 * Every refusal says what is true, so the person is told the real blocker: the file is gone, it changed, or it is too large for Drive.
 */
export async function loadArtifactForUpload(userId, attachmentId, { expectedSha256 = null, executor = db, root = path.resolve(config.uploadStoragePath) } = {}) {
  const [record] = await executor
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, String(attachmentId)), eq(attachments.userId, userId), eq(attachments.kind, "generated-file")))
    .limit(1);
  if (!record) return { ok: false, code: "artifact_missing", message: "That file is no longer in your account, so nothing was uploaded. Ask me to make it again if you still want it." };
  const stored = path.basename(String(record.storedName));
  let buffer;
  try {
    buffer = await readFile(path.join(root, stored));
  } catch {
    return { ok: false, code: "artifact_missing", message: "The file could not be read from storage, so nothing was uploaded. Ask me to make it again if you still want it." };
  }
  if (buffer.byteLength > DRIVE_FILE_MAX_BYTES) {
    return { ok: false, code: "too_large", message: "That file is larger than Google Drive accepts from chat (5 MB), so nothing was uploaded." };
  }
  if (expectedSha256 && artifactSha256(buffer) !== expectedSha256) {
    return { ok: false, code: "artifact_changed", message: "The file is not the one you approved, so nothing was uploaded." };
  }
  return { ok: true, record, buffer };
}

/** The folder a person named: "in my Biology folder", "to the Reports folder". Null when they named none, which means the top of My Drive. */
export function parseDriveFolderPhrase(text) {
  const value = String(text ?? "");
  const named = value.match(/\b(?:in|into|to|inside|under)\s+(?:my\s+|the\s+)?["“']?([\w][\w .&()'-]{0,60}?)["”']?\s+folder\b/i)
    || value.match(/\bfolder\s+(?:called|named)\s+["“']?([\w][\w .&()'-]{0,60}?)["”']?(?:\s*$|[.,;!?]|\s+(?:and|then|please)\b)/i);
  const name = named?.[1]?.trim();
  if (!name || /^(?:my|the|a|google|drive|google drive|new|shared|same|that|this|a new)$/i.test(name)) return null;
  return name;
}

/** Which folder a lookup found. Exactly one match is a destination; none or several is a question, never a guess. */
export function chooseDriveFolder(requestedName, folders) {
  const wanted = String(requestedName).trim().toLowerCase();
  const usable = (Array.isArray(folders) ? folders : []).filter((folder) => folder && isDriveFolderId(folder.id) && typeof folder.name === "string");
  const exact = usable.filter((folder) => folder.name.trim().toLowerCase() === wanted);
  const matches = exact.length ? exact : usable.filter((folder) => folder.name.toLowerCase().includes(wanted));
  if (matches.length === 1) return { kind: "found", folder: { id: matches[0].id, name: matches[0].name } };
  if (matches.length === 0) return { kind: "none" };
  return { kind: "ambiguous", options: matches.slice(0, 5).map((folder) => ({ id: folder.id, name: folder.name, modifiedTime: folder.modifiedTime ?? null })) };
}

/** The folder list inside a find-folder result, whatever the gateway calls the array. */
export function foldersFromResult(data) {
  for (const key of ["files", "folders", "items", "results"]) if (Array.isArray(data?.[key])) return data[key];
  return Array.isArray(data) ? data : [];
}

/** What the person is told when the lookup could not give a single folder. */
export function folderQuestion(requestedName, outcome) {
  if (outcome.kind === "none") {
    return `I couldn't find a folder named “${requestedName}” in your Google Drive. I won't create one without asking. Tell me another folder name, or say “My Drive” to put it at the top level.`;
  }
  const list = outcome.options.map((option) => `“${option.name}”${option.modifiedTime ? ` (changed ${String(option.modifiedTime).slice(0, 10)})` : ""}`).join(", ");
  return `You have more than one folder that matches “${requestedName}”: ${list}. Which one should I use? Say a more exact name, or “My Drive” for the top level.`;
}
