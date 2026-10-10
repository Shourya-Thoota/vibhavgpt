import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.UPLOAD_STORAGE_PATH ??= path.join(os.tmpdir(), "vibhavgpt-upload-tests");

const { UploadError, UPLOAD_LIMITS, attachmentContext, canonicalDocumentType, canonicalImageType, normalizedExtractedText, safeOriginalName } = await import("../src/uploads/service.js");

test("document upload type checks accept text and reject a spoofed PDF", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibhavgpt-upload-"));
  try {
    const textPath = path.join(directory, "notes.txt");
    await writeFile(textPath, "A real text document.");
    assert.deepEqual(await canonicalDocumentType(textPath, "notes.txt"), {
      extension: ".txt",
      mimeType: "text/plain",
    });

    const fakePdf = path.join(directory, "not-a-pdf.pdf");
    await writeFile(fakePdf, "not actually a PDF");
    await assert.rejects(() => canonicalDocumentType(fakePdf, "not-a-pdf.pdf"), UploadError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("image upload type checks accept a real PNG and reject a spoofed image", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibhavgpt-image-"));
  try {
    // A valid one-pixel transparent PNG.
    const pngPath = path.join(directory, "image.png");
    await writeFile(pngPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLkAAAAAElFTkSuQmCC", "base64"));
    assert.deepEqual(await canonicalImageType(pngPath, "image.png"), {
      extension: ".png",
      mimeType: "image/png",
    });

    const fakeImage = path.join(directory, "not-an-image.webp");
    await writeFile(fakeImage, "not actually an image");
    await assert.rejects(() => canonicalImageType(fakeImage, "not-an-image.webp"), UploadError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tier limits and filenames enforce the public upload policy", () => {
  assert.equal(UPLOAD_LIMITS.free.fileBytes, 5 * 1024 * 1024);
  assert.equal(UPLOAD_LIMITS.free.imageBytes, 5 * 1024 * 1024);
  assert.equal(UPLOAD_LIMITS.free.messageBytes, 10 * 1024 * 1024);
  assert.equal(UPLOAD_LIMITS.free.accountBytes, 25 * 1024 * 1024);
  assert.equal(UPLOAD_LIMITS.plus.fileBytes, 25 * 1024 * 1024);
  assert.equal(UPLOAD_LIMITS.plus.imageBytes, 10 * 1024 * 1024);
  assert.equal(UPLOAD_LIMITS.pro.fileBytes, 80 * 1024 * 1024);
  assert.equal(UPLOAD_LIMITS.pro.imageBytes, 20 * 1024 * 1024);
  assert.equal(UPLOAD_LIMITS.pro.messageBytes, 160 * 1024 * 1024);
  assert.equal(UPLOAD_LIMITS.pro.accountBytes, 250 * 1024 * 1024);
  assert.equal(safeOriginalName("../../unsafe:name?.txt"), "unsafe_name_.txt");
});

test("PDF page markers do not masquerade as extracted content", () => {
  assert.throws(
    () => normalizedExtractedText("\n-- 1 of 1 --\n", ".pdf"),
    (error) => error instanceof UploadError && error.code === "pdf-extraction-empty" && error.status === 422,
  );
});

test("persisted document text can be rebuilt as later-turn source context", () => {
  const context = attachmentContext([{ originalName: "topography.pdf", mimeType: "application/pdf", extractedText: "Point A: 320 m\nPoint B: 440 m" }]);
  assert.match(context, /topography\.pdf/);
  assert.match(context, /Point A: 320 m/);
  assert.match(context, /Point B: 440 m/);
});

test("GIF uploads are normalized to PNG for Study and chat vision", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibhavgpt-gif-test-"));
  try {
    const file = path.join(directory, "sample.gif");
    await writeFile(file, Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
    assert.deepEqual(await canonicalImageType(file, "sample.gif"), { extension: ".png", mimeType: "image/png" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
