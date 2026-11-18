/**
 * Prepare a Google Drive create/upload payload from a tool call.
 * Text the user already owns (chat body or an extracted attachment) only.
 * Never fetches a URL the model supplies.
 */

export const DRIVE_UPLOAD_MAX_BYTES = 1_500_000;

const DRIVE_UPLOAD_REQUEST = /\b(?:push|upload|save|put|send|add|move|copy)\b[\s\S]{0,80}\b(?:google\s*drive|gdrive|my drive)\b|\b(?:google\s*drive|gdrive)\b[\s\S]{0,40}\b(?:upload|push|save|put|file)\b|\b(?:save|put|add|upload|send|copy|move)\s+(?:it|this|that|them)\s+(?:in|into|on|to)\s+(?:my\s+)?drive\b/i;
// A question about Drive is not a request to put something there.
const DRIVE_QUESTION = /^\s*(?:how|what|why|where|when|which|who|is|are|does|do|did)\b/i;
const DRIVE_DENIAL = /can(?:not|'t)\s+upload|install python|oauth credential|google cloud console|client_secret|set up oauth/i;

/** The user asked to put something in Drive, not to discuss Drive. */
export function isDriveUploadRequest(text) {
  const value = String(text || "");
  return DRIVE_UPLOAD_REQUEST.test(value) && !DRIVE_QUESTION.test(value);
}

/** A model refusal or setup tutorial must not stand in for an available Drive action. */
export function isDriveDenialReply(text) {
  return DRIVE_DENIAL.test(String(text || ""));
}

export function fileNameFromDriveRequest(text) {
  const named = String(text || "").match(/\b(?:named|called|as)\s+["']?([\w .()-]{1,80}\.[A-Za-z0-9]{1,8})["']?/i);
  return named?.[1]?.trim() || null;
}

/** User-facing text for a prepared Drive action. This does not claim the upload finished. */
export function driveActionReply(result) {
  if (result?.kind === "pending_approval") {
    const payload = result.pendingAction?.payload || {};
    // A file this conversation made: the card names the exact file, folder and account. Nothing has been uploaded yet.
    if (payload.attachmentId && result.pendingAction?.actionDescription) {
      return `${result.pendingAction.actionDescription}. Approve the card to upload it; nothing has been uploaded yet.`;
    }
    const name = payload.fileName || "the file";
    const folder = payload.folderName || "My Drive";
    return `Ready to upload “${name}” to Google Drive (${folder}). Confirm the card to create the file. Nothing has been uploaded yet.`;
  }
  return result?.content || "Google Drive could not prepare that upload.";
}

const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;

/** A Drive folder id. Names such as "My Drive" are not ids. */
export function isDriveFolderId(value) {
  return DRIVE_ID.test(String(value || ""));
}

/**
 * Arguments for GOOGLEDRIVE_CREATE_FILE_FROM_TEXT.
 * Only the documented fields are sent. A folder name is not a parent id;
 * "My Drive" means the root and is omitted.
 */
export function toDriveCreateArguments(parameters = {}) {
  const fileName = parameters.file_name || parameters.fileName || parameters.title || parameters.name;
  const text = parameters.text_content ?? parameters.content ?? parameters.body ?? parameters.text;
  const mime = parameters.mime_type || parameters.mimeType || "text/plain";
  const parent = parameters.parent_id || parameters.folder_id || parameters.parent_folder_id;
  const folderName = parameters.folderName || parameters.folder_name || "";
  const args = {};
  if (fileName) args.file_name = String(fileName).slice(0, 180);
  if (typeof text === "string") args.text_content = text;
  if (mime) args.mime_type = String(mime).slice(0, 80);
  if (isDriveFolderId(parent)) args.parent_id = String(parent);
  else if (folderName && !/^(my drive|root)$/i.test(String(folderName).trim()) && isDriveFolderId(folderName)) {
    args.parent_id = String(folderName);
  }
  return args;
}

/** True when a named folder cannot be represented as a Drive parent id. */
export function driveFolderNeedsResolution(parameters = {}) {
  const folderName = String(parameters.folderName || parameters.folder_name || "").trim();
  if (!folderName || /^(my drive|root)$/i.test(folderName)) return false;
  return !isDriveFolderId(parameters.parent_id) && !isDriveFolderId(folderName);
}

export function buildDriveUploadPayload({ fileName, content, folderName, mimeType } = {}) {
  const name = String(fileName || "").trim().slice(0, 180);
  const body = typeof content === "string" ? content : "";
  if (!name) return { ok: false, code: "missing_name", message: "What should the Drive file be named?" };
  const trimmed = body.trim();
  if (!trimmed) {
    return { ok: false, code: "missing_content", message: "Which text or file should I put in Google Drive?" };
  }
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    return { ok: false, code: "url_rejected", message: "I can upload text you already have in this chat, not a web address." };
  }
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > DRIVE_UPLOAD_MAX_BYTES) {
    return { ok: false, code: "too_large", message: "That file is too large to upload from chat. Use a smaller text file." };
  }
  return {
    ok: true,
    payload: {
      fileName: name,
      content: body,
      folderName: String(folderName || "My Drive").trim().slice(0, 180) || "My Drive",
      mimeType: String(mimeType || "text/plain").slice(0, 80),
    },
  };
}

/**
 * When the model didn't include a body, use the single owned text attachment.
 * Multiple or zero sources ask one clarification instead of guessing.
 */
export function resolveDriveSourceContent({ content, attachments = [], priorMessages = [] } = {}) {
  if (typeof content === "string" && content.trim()) return { content };
  const texts = attachments.filter((file) => typeof file?.extractedText === "string" && file.extractedText.trim());
  if (texts.length > 1) {
    return { clarify: "Which of the attached files should I upload to Google Drive?" };
  }
  const lastAssistant = [...priorMessages].reverse().find((message) =>
    message?.role === "assistant" && String(message.content || "").trim().length > 20,
  );
  if (texts.length === 1 && lastAssistant) {
    return { clarify: "Should I upload the attached file, or the last reply?" };
  }
  if (texts.length === 1) {
    return { content: texts[0].extractedText, fileName: texts[0].originalName || texts[0].name || null };
  }
  if (lastAssistant) return { content: String(lastAssistant.content), fileName: null };
  return { clarify: "Which text or file should I put in Google Drive?" };
}
