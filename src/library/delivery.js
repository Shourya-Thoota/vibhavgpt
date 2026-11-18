import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { uploadRoot } from "../uploads/service.js";
import { applyWatermark, shouldWatermark } from "../generation/watermark.js";

// Sends a stored file to its owner. Every route that hands out a generated picture (view, download, Library) goes through here, so there
// is one rule for the watermark (src/generation/watermark.js): a generated picture is marked on the way out when the account's plan
// requires it (Free) or the person chose it (paid plans). The stored original is never changed. A picture that already carries the
// earlier mark (generationMeta.watermarked) is not marked twice. If a picture that must be marked cannot be, it is not delivered.

export const isGeneratedImage = (record) => record?.kind === "generated-image" && String(record.mimeType ?? "").startsWith("image/");

// disposition: "attachment" for a download, "inline" for showing it in the page.
export async function needsMarkingNow(record, userId, { mustMark = shouldWatermark } = {}) {
  if (!isGeneratedImage(record)) return false;
  if (record.generationMeta?.watermarked === true) return false;
  return mustMark(userId);
}

export async function sendStoredFile(res, next, record, userId, { disposition = "attachment", root = uploadRoot, mustMark = shouldWatermark, mark = applyWatermark } = {}) {
  try {
    const file = path.join(root, record.storedName);
    const exists = await access(file).then(() => true, () => false);
    if (!exists) {
      return res.status(404).json({ error: "This file is no longer stored.", code: "file_missing" });
    }
    res.set({ "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" });
    if (disposition === "attachment") res.attachment(record.originalName);
    if (await needsMarkingNow(record, userId, { mustMark })) {
      let marked;
      try {
        marked = await mark(await readFile(file), record.mimeType);
      } catch {
        return res.status(500).json({ error: "This picture couldn't be prepared. Try again.", code: "watermark_failed" });
      }
      res.type(marked.mimeType);
      return res.status(200).end(marked.buffer);
    }
    res.type(record.mimeType || "application/octet-stream");
    return createReadStream(file).on("error", next).pipe(res);
  } catch (error) {
    return next(error);
  }
}
