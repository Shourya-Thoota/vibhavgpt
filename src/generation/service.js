import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pptxgen from "pptxgenjs";
import PDFDocument from "pdfkit";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { attachments } from "../db/schema.js";
import { config } from "../config.js";
import { accessError } from "../../frontend/src/access-status.js";
import { uploadRoot, ensureUploadDirectories } from "../uploads/service.js";
import { cancelUsageReservation, finalizeUsage, reserveDocumentGeneration, reserveImageGeneration } from "../usage/service.js";
import { buildDocumentPlan, validateDocumentPlan, DOCUMENT_FORMATS } from "./document-plan.js";
import { documentFilename } from "./document-filename.js";
import { renderDocx } from "./docx-render.js";

export const IMAGE_CREDIT_COST = 3;

export const DOCUMENT_TYPE_DETAILS = {
  docx: { label: "Word document", extension: ".docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  pptx: { label: "PowerPoint presentation", extension: ".pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  pdf: { label: "PDF", extension: ".pdf", mimeType: "application/pdf" },
  md: { label: "Markdown file", extension: ".md", mimeType: "text/markdown" },
  txt: { label: "text file", extension: ".txt", mimeType: "text/plain" },
  csv: { label: "CSV spreadsheet", extension: ".csv", mimeType: "text/csv" },
  json: { label: "JSON file", extension: ".json", mimeType: "application/json" },
  html: { label: "HTML file", extension: ".html", mimeType: "text/html" },
};

export function documentLabel(format) {
  return DOCUMENT_TYPE_DETAILS[format]?.label ?? "file";
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeCsv(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export const IMAGE_ASPECT_RATIOS = {
  square: "1:1",
  portrait: "9:16",
  landscape: "16:9",
};

// The Image page's style presets, written as art direction rather than a
// bare word: "watercolor" alone gets a generic wash, while the medium's
// actual traits (paper, edges, light) get a believable one. A style string
// that is not a preset id still works and is used as written.
export const IMAGE_STYLES = {
  photo: "a natural photograph with true-to-life color, soft natural light, realistic textures and a shallow depth of field",
  cinematic: "a cinematic film still with motivated dramatic lighting, wide framing, a rich color grade and atmospheric depth",
  illustration: "a polished editorial illustration with confident shapes, clean linework and a harmonious limited palette",
  watercolor: "a watercolor painting with soft layered washes, visible paper grain and gently bleeding edges",
  "3d": "a finely crafted 3D render with physically based materials, soft global illumination and subtle ambient occlusion",
  anime: "anime key art with clean cel shading, expressive faces and vivid but balanced color",
  "line-art": "minimal line art in precise, even ink strokes on a plain background with generous negative space",
  "pixel-art": "detailed pixel art with crisp square pixels, a limited palette and no smoothing or blur",
};

// Applied to every generation, from the Image page and from chat. It names
// the failure modes image models fall into most (muddled focus, broken hands
// and perspective, stray lettering) instead of stacking vague praise words.
// It is prompt text only: the image endpoint takes no extra parameters.
const IMAGE_CRAFT_BRIEF = "Render it with fine detail, one clear focal point, a balanced composition, and coherent anatomy, hands and perspective. No watermark, signature, frame or border.";
const ASKS_FOR_TEXT = /\b(text|words?|titled?|caption|lettering|typography|typographic|logo|wordmark|poster|label|sign(?:age)?|quote|headline|banner|says|reads|written)\b/i;

export function composeImagePrompt(prompt, style = "") {
  const subject = String(prompt ?? "").trim().replace(/[\s.]+$/, "");
  const key = String(style ?? "").trim().toLowerCase();
  const direction = IMAGE_STYLES[key] ?? (key ? `${String(style).trim()} style` : "");
  return [
    `${subject}.`,
    direction ? `Style: ${direction}.` : "",
    IMAGE_CRAFT_BRIEF,
    ASKS_FOR_TEXT.test(subject) ? "" : "Do not add any text, letters or numbers to the image.",
  ].filter(Boolean).join(" ");
}

function imageUnavailableError() {
  return accessError("service", { feature: "Image generation", code: "service-unavailable" });
}

export async function generateImage(
  { userId, prompt, aspectRatio, size, referenceImage },
  {
    reserve = reserveImageGeneration,
    finalize = finalizeUsage,
    cancel = cancelUsageReservation,
    fetchImpl = fetch,
    apiKey = config.providerKeys.paid,
  } = {},
) {
  const baseUrl = config.providerBaseUrls.paid;
  if (!apiKey || !baseUrl || !config.imageGenerationModel) throw imageUnavailableError();
  const reservation = await reserve(userId);
  try {
    const selectedAspectRatio = IMAGE_ASPECT_RATIOS[aspectRatio] ?? IMAGE_ASPECT_RATIOS.square;
    const request = {
      model: config.imageGenerationModel,
      prompt,
      n: 1,
      aspect_ratio: selectedAspectRatio,
      output_format: "png",
      ...(typeof size === "string" && /^\d{3,4}x\d{3,4}$/.test(size) ? { size } : {}),
      ...(referenceImage ? {
        input_references: [{
          type: "image_url",
          image_url: { url: `data:${referenceImage.mimeType};base64,${referenceImage.buffer.toString("base64")}` },
        }],
      } : {}),
    };
    const response = await fetchImpl(`${baseUrl}/images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://vibhavgpt.com", "X-Title": "VibhavGPT" },
      body: JSON.stringify(request),
    });
    const payload = await response.json().catch(() => ({}));
    const encoded = payload?.data?.[0]?.b64_json;
    if (!response.ok || !encoded) throw imageUnavailableError();
    const usage = payload?.usage || {};
    await finalize(reservation.id, { prompt_tokens: Number(usage.prompt_tokens) || 0, completion_tokens: Number(usage.completion_tokens) || 0, cost: usage.cost });
    return { buffer: Buffer.from(encoded, "base64"), cost: usage.cost ?? null, reservation, referenceApplied: Boolean(referenceImage) };
  } catch {
    await cancel(reservation.id, reservation.creditReservationId).catch(() => {});
    throw imageUnavailableError();
  }
}

export async function renderDocument({ format, plan }) {
  const normalized = validateDocumentPlan(plan);
  const plainText = `${normalized.title}\n\n${normalized.sections.map((section) => `${section.heading}\n\n${section.body}`).join("\n\n")}\n`;
  if (format === "md") {
    return { buffer: Buffer.from(`# ${normalized.title}\n\n${normalized.sections.map((section) => `## ${section.heading}\n\n${section.body}`).join("\n\n")}\n`, "utf8"), extension: ".md", mimeType: "text/markdown" };
  }
  if (format === "txt") return { buffer: Buffer.from(plainText, "utf8"), extension: ".txt", mimeType: "text/plain" };
  if (format === "json") {
    return { buffer: Buffer.from(`${JSON.stringify({ title: normalized.title, sections: normalized.sections }, null, 2)}\n`, "utf8"), extension: ".json", mimeType: "application/json" };
  }
  if (format === "csv") {
    const rows = ["section,content", ...normalized.sections.map((section) => `${escapeCsv(section.heading)},${escapeCsv(section.body)}`)];
    return { buffer: Buffer.from(`${rows.join("\r\n")}\r\n`, "utf8"), extension: ".csv", mimeType: "text/csv" };
  }
  if (format === "html") {
    const sections = normalized.sections.map((section) => `<section>\n<h2>${escapeHtml(section.heading)}</h2>\n${section.body.split(/\n{2,}/).map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`).join("\n")}\n</section>`).join("\n");
    const html = `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(normalized.title)}</title></head>\n<body>\n<main>\n<h1>${escapeHtml(normalized.title)}</h1>\n${sections}\n</main>\n</body>\n</html>\n`;
    return { buffer: Buffer.from(html, "utf8"), extension: ".html", mimeType: "text/html" };
  }
  if (format === "docx") {
    return { buffer: await renderDocx(normalized), extension: ".docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  }
  if (format === "pptx") {
    const deck = new pptxgen();
    deck.layout = "LAYOUT_WIDE";
    deck.author = "VibhavGPT";
    deck.subject = normalized.title;
    const titleSlide = deck.addSlide();
    titleSlide.addText(normalized.title, { x: 0.7, y: 2.5, w: 12, h: 0.8, fontSize: 28, bold: true, color: "1F2937" });
    for (const section of normalized.sections) {
      const slide = deck.addSlide();
      slide.addText(section.heading, { x: 0.7, y: 0.5, w: 12, h: 0.5, fontSize: 24, bold: true, color: "2563EB" });
      slide.addText(section.body, { x: 0.8, y: 1.3, w: 11.6, h: 5.3, fontSize: 18, breakLine: false, color: "1F2937", valign: "top", margin: 0.08, fit: "shrink" });
    }
    return { buffer: Buffer.from(await deck.write({ outputType: "nodebuffer" })), extension: ".pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
  }
  if (format === "pdf") {
    const chunks = [];
    const pdf = new PDFDocument({ margin: 54 });
    pdf.on("data", (chunk) => chunks.push(chunk));
    const finished = new Promise((resolve, reject) => { pdf.on("end", resolve); pdf.on("error", reject); });
    pdf.fontSize(24).fillColor("#1f2937").text(normalized.title);
    for (const section of normalized.sections) pdf.moveDown().fontSize(17).fillColor("#2563eb").text(section.heading).moveDown(0.4).fontSize(11).fillColor("#374151").text(section.body, { lineGap: 4 });
    pdf.end();
    await finished;
    return { buffer: Buffer.concat(chunks), extension: ".pdf", mimeType: "application/pdf" };
  }
  throw Object.assign(new Error("Choose a supported document type."), { status: 400 });
}

export async function generateDocument({ userId, format, prompt, history = [], sourceContext = "", requestText = prompt, reuseLastReply = true, requestId, signal }, {
  reserve = reserveDocumentGeneration, finalize = finalizeUsage, cancel = cancelUsageReservation,
  buildPlan = buildDocumentPlan, render = renderDocument,
} = {}) {
  if (!DOCUMENT_FORMATS.has(format)) throw Object.assign(new Error("Choose a supported document type."), { status: 400 });
  const reservation = await reserve(userId);
  try {
    const { plan, usage } = await buildPlan({ prompt, format, history, sourceContext, requestText, reuseLastReply, requestId, signal });
    const rendered = await render({ format, plan });
    await finalize(reservation.id, usage);
    return { ...rendered, filename: format === "docx" ? documentFilename(plan, prompt) : `vibhavgpt-document${rendered.extension}`, reservation };
  } catch (error) {
    await cancel(reservation.id, reservation.creditReservationId).catch(() => {});
    throw error;
  }
}

export async function createStoredAttachment({ userId, conversationId, originalName, mimeType, kind, buffer, prompt = null, parentAttachmentId = null, generationMeta = {} }) {
  await ensureUploadDirectories();
  const storedName = `${randomUUID()}${path.extname(originalName)}`;
  await writeFile(path.join(uploadRoot, storedName), buffer, { flag: "wx" });
  try {
    const [record] = await db.insert(attachments).values({ userId, conversationId, originalName, storedName, mimeType, kind, sizeBytes: buffer.byteLength, extractionStatus: "ready", prompt, parentAttachmentId, generationMeta }).returning();
    return record;
  } catch (error) {
    await import("node:fs/promises").then(({ rm }) => rm(path.join(uploadRoot, storedName), { force: true }));
    throw error;
  }
}

export async function getOwnedAttachment(userId, id) {
  const [record] = await db.select().from(attachments).where(and(eq(attachments.id, id), eq(attachments.userId, userId))).limit(1);
  return record ?? null;
}
