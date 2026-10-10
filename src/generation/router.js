import { canonicalModelKey } from "../../frontend/src/token-quotas.js";
import { Router } from "express";
import path from "node:path";
import { createReadStream } from "node:fs";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { attachments } from "../db/schema.js";
import { config } from "../config.js";
import { requireSession } from "../middleware/require-session.js";
import { generateDocument, generateImage, createStoredAttachment, getOwnedAttachment, documentLabel, IMAGE_ASPECT_RATIOS, composeImagePrompt } from "./service.js";
import { imageAttachmentView } from "./image-library.js";
import { createImageLibraryRouter } from "./image-library-router.js";
import { saveExchange, addAssistantReply, loadConversation } from "../chat/repository.js";
import { uploadRoot, findConversationDocuments, attachmentContext } from "../uploads/service.js";
import { readFile } from "node:fs/promises";
import { Sentry } from "../sentry.js";

export const generationRouter = Router();
generationRouter.use(requireSession);
generationRouter.use(createImageLibraryRouter(db));

function baseUrl(req) {
  return config.clientOrigins.includes(req.headers.origin) ? req.headers.origin : config.clientOrigins[0];
}

async function persistAssistantAttachment({ userId, conversationId, messageId, attachment }) {
  await db.update(attachments).set({ conversationId, messageId, updatedAt: new Date() }).where(and(eq(attachments.id, attachment.id), eq(attachments.userId, userId)));
}

generationRouter.post("/document", async (req, res, next) => {
  try {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    const format = String(req.body?.format || "md").toLowerCase();
    if (!prompt || prompt.length > 20_000) return res.status(400).json({ error: "Describe the document you want to create." });
    const userId = req.authSession.user.id;
    const conversationId = req.body?.conversationId || null;
    if (conversationId && (typeof conversationId !== "string" || !/^[0-9a-f-]{36}$/i.test(conversationId))) return res.status(400).json({ error: "Invalid conversation." });
    const existing = conversationId ? await loadConversation(userId, conversationId) : null;
    if (conversationId && !existing) return res.status(404).json({ error: "Conversation not found." });
    const documents = await findConversationDocuments(userId, conversationId);
    // Client-provided plans must not bypass generation or content validation.
    const rendered = await generateDocument({ userId, format, prompt, history: existing?.history ?? [], sourceContext: attachmentContext(documents) });
    const label = documentLabel(format);
    const saved = await saveExchange({ userId: req.authSession.user.id, conversationId: req.body?.conversationId || null, modelKey: canonicalModelKey(req.body?.model || "lumen"), userContent: prompt, reply: `I created your ${label}.` });
    const attachment = await createStoredAttachment({ userId: req.authSession.user.id, conversationId: saved.conversationId, originalName: rendered.filename, mimeType: rendered.mimeType, kind: "generated-file", buffer: rendered.buffer });
    await persistAssistantAttachment({ userId: req.authSession.user.id, conversationId: saved.conversationId, messageId: saved.messages[1].id, attachment });
    return res.status(201).json({ conversationId: saved.conversationId, message: saved.messages[1], attachment: { id: attachment.id, name: attachment.originalName, mimeType: attachment.mimeType, kind: attachment.kind, sizeBytes: attachment.sizeBytes, downloadUrl: `/api/generation/${attachment.id}/download` }, baseUrl: baseUrl(req) });
  } catch (error) { return next(error); }
});

const MAX_VARIATIONS = 4;

generationRouter.post("/image", async (req, res, next) => {
  try {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt || prompt.length > 8_000) return res.status(400).json({ error: "Describe the image you want to create." });
    if (!config.providerKeys.paid) return res.status(503).json({ error: "Image generation is temporarily unavailable. Please try again shortly." });
    const userId = req.authSession.user.id;
    const aspectRatio = Object.hasOwn(IMAGE_ASPECT_RATIOS, req.body?.aspectRatio) ? req.body.aspectRatio : "square";
    const size = typeof req.body?.size === "string" && /^\d{3,4}x\d{3,4}$/.test(req.body.size) ? req.body.size : undefined;
    const style = typeof req.body?.style === "string" ? req.body.style.trim().slice(0, 120) : "";
    const variations = Math.min(MAX_VARIATIONS, Math.max(1, Number.parseInt(req.body?.variations, 10) || 1));
    const parentAttachmentId = typeof req.body?.parentAttachmentId === "string" ? req.body.parentAttachmentId : null;
    const referenceAttachmentId = typeof req.body?.referenceAttachmentId === "string" ? req.body.referenceAttachmentId : null;

    let referenceImage = null;
    if (referenceAttachmentId) {
      const referenceRecord = await getOwnedAttachment(userId, referenceAttachmentId);
      if (!referenceRecord || !["image", "generated-image"].includes(referenceRecord.kind)) return res.status(400).json({ error: "That reference image is no longer available." });
      referenceImage = { buffer: await readFile(path.join(uploadRoot, referenceRecord.storedName)), mimeType: referenceRecord.mimeType };
    }
    if (parentAttachmentId) {
      const parentRecord = await getOwnedAttachment(userId, parentAttachmentId);
      if (!parentRecord || parentRecord.kind !== "generated-image") return res.status(400).json({ error: "That image is no longer available." });
    }

    // The stored prompt stays the user's own words; only the request to the
    // image model carries the style direction and quality brief.
    const finalPrompt = composeImagePrompt(prompt, style);
    const conversationId = req.body?.conversationId || null;
    // Set only when the dedicated Image page starts a brand-new conversation
    // (it never sends a conversationId). The in-chat "Create image" action
    // always has a conversationId already — a real chat thread the image is
    // being added to — so this never fires there, and an ongoing image
    // conversation's mode is never touched by later variations/replies
    // either way, since mode is only written on the initial INSERT.
    const standalone = req.body?.standalone === true;
    const images = [];
    let lastCost = null;
    let savedConversationId = conversationId;
    for (let index = 0; index < variations; index += 1) {
      let generated;
      try {
        generated = await generateImage({ userId, prompt: finalPrompt, aspectRatio, size, referenceImage });
      } catch (error) {
        // Later variations may fail once a plan's included quota is used up;
        // surface the images that did succeed rather than losing them.
        if (images.length) break;
        throw error;
      }
      const reply = variations > 1 ? `I created variation ${index + 1} of ${variations} for you.` : "I created this image for you.";
      // One request is one user turn, however many variations it produces.
      const saved = index === 0
        ? await saveExchange({ userId, conversationId: savedConversationId, modelKey: "image", userContent: prompt, reply, mode: standalone ? "image" : undefined })
        : await addAssistantReply({ userId, conversationId: savedConversationId, reply });
      savedConversationId = saved.conversationId;
      const assistantMessage = saved.messages[saved.messages.length - 1];
      const generationMeta = { aspectRatio, style: style || null, variationIndex: index, referenceApplied: referenceImage ? generated.referenceApplied : null };
      const attachment = await createStoredAttachment({ userId, conversationId: saved.conversationId, originalName: `vibhavgpt-image-${index + 1}.png`, mimeType: "image/png", kind: "generated-image", buffer: generated.buffer, prompt, parentAttachmentId, generationMeta });
      await persistAssistantAttachment({ userId, conversationId: saved.conversationId, messageId: assistantMessage.id, attachment });
      images.push({ ...imageAttachmentView(attachment), message: assistantMessage });
      lastCost = generated.cost;
    }
    // True only if the reference image was actually honored on every
    // generated variation; the composer shows a fallback notice otherwise.
    const referenceApplied = referenceImage ? images.every((image) => image.meta.referenceApplied) : null;
    return res.status(201).json({ conversationId: savedConversationId, images, cost: lastCost, referenceApplied });
  } catch (error) {
    if (config.sentryDsn) Sentry.captureException(error);
    return next(error);
  }
});

generationRouter.get("/:id/download", async (req, res, next) => {
  try {
    const record = await getOwnedAttachment(req.authSession.user.id, req.params.id);
    if (!record || !["generated-file", "generated-image"].includes(record.kind)) return res.status(404).json({ error: "Generated file not found." });
    // Stream generated artifacts directly. This preserves the attachment
    // filename while avoiding platform-specific sendFile path handling.
    res.attachment(record.originalName);
    res.type(record.mimeType || "application/octet-stream");
    return createReadStream(path.join(uploadRoot, record.storedName))
      .on("error", next)
      .pipe(res);
  } catch (error) { return next(error); }
});
