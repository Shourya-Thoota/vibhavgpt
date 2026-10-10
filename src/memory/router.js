import { randomUUID } from "node:crypto";
import path from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { Router } from "express";
import { accessPayload } from "../../frontend/src/access-status.js";
import multer from "multer";
import { requireSession } from "../middleware/require-session.js";
import { clearFacts, createFact, deleteFact, getFacts, importFactCandidates, importFacts, isMemoryEnabled, parseImportedFacts, setMemoryEnabled, updateFact } from "./service.js";
import { UploadError, canonicalDocumentType, extractText, incomingDirectory, normalizedExtractedText, ensureUploadDirectories } from "../uploads/service.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const memoryRouter = Router();
memoryRouter.use(requireSession);

const memoryImportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

memoryRouter.get("/", async (req, res, next) => {
  try {
    const userId = req.authSession.user.id;
    const [facts, enabled] = await Promise.all([getFacts(userId), isMemoryEnabled(userId)]);
    return res.json({ facts, enabled });
  } catch (error) {
    return next(error);
  }
});

// The Settings switch: off means chats neither read nor save memory.
memoryRouter.put("/settings", async (req, res, next) => {
  try {
    if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "Choose on or off." });
    return res.json({ enabled: await setMemoryEnabled(req.authSession.user.id, req.body.enabled) });
  } catch (error) { return next(error); }
});

// Clear all memory.
memoryRouter.delete("/", async (req, res, next) => {
  try {
    return res.json({ deleted: await clearFacts(req.authSession.user.id) });
  } catch (error) { return next(error); }
});

memoryRouter.post("/", async (req, res, next) => {
  try {
    const fact = await createFact(req.authSession.user.id, req.body?.content, "manual", {
      category: req.body?.category,
      area: req.body?.area,
    });
    if (!fact) return res.status(400).json({ error: "That memory entry is invalid or already saved." });
    return res.status(201).json({ fact });
  } catch (error) {
    return next(error);
  }
});

memoryRouter.post("/import", async (req, res, next) => {
  try {
    const input = typeof req.body?.text === "string" ? req.body.text : "";
    if (!input.trim()) return res.status(400).json({ error: "Paste an export from another assistant first." });
    if (input.length > 30000) return res.status(413).json({ error: "That import is too large. Please keep it under 30,000 characters." });
    const result = await importFacts(req.authSession.user.id, input);
    // Nothing recognisable is an error to fix, not a silent "Added 0".
    if (!result.candidates) return res.status(422).json({ error: "We couldn't find any memory facts in that text. Put each fact on its own line under a heading such as Profile or Preferences, then try again." });
    return res.status(201).json(result);
  } catch (error) { return next(error); }
});

memoryRouter.post("/import/preview", (req, res, next) => {
  memoryImportUpload.single("file")(req, res, (error) => {
    if (error) return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: "Choose a Markdown or PDF file up to 5 MB." });
    return next();
  });
}, async (req, res, next) => {
  let temporaryPath;
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Choose a Markdown or PDF file first." });
    const extension = path.extname(file.originalname || "").toLowerCase();
    if (![".md", ".pdf"].includes(extension)) return res.status(415).json({ error: "Memory imports support .md and .pdf files only." });
    await ensureUploadDirectories();
    temporaryPath = path.join(incomingDirectory, `${randomUUID()}${extension}`);
    await writeFile(temporaryPath, file.buffer);
    const type = await canonicalDocumentType(temporaryPath, file.originalname);
    const extracted = normalizedExtractedText(await extractText(temporaryPath, type.extension), type.extension);
    const facts = parseImportedFacts(extracted.text);
    if (!facts.length) return res.status(422).json({ error: "We couldn't find durable, bullet-style memory facts in that file." });
    return res.json({ sourceName: file.originalname, extractedText: extracted.text, truncated: extracted.truncated, facts });
  } catch (error) {
    if (error instanceof UploadError) return res.status(error.status).json(accessPayload(error));
    return next(error);
  } finally {
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => {});
  }
});

memoryRouter.post("/import/confirm", async (req, res, next) => {
  try {
    const facts = Array.isArray(req.body?.facts) ? req.body.facts.slice(0, 40) : [];
    if (!facts.length) return res.status(400).json({ error: "Review and keep at least one memory fact before importing." });
    return res.status(201).json(await importFactCandidates(req.authSession.user.id, facts));
  } catch (error) { return next(error); }
});

memoryRouter.patch("/:id", async (req, res, next) => {
  try {
    if (!UUID_PATTERN.test(req.params.id)) return res.status(400).json({ error: "Invalid memory entry." });
    const fact = await updateFact(req.authSession.user.id, req.params.id, req.body?.content, {
      category: req.body?.category,
      area: req.body?.area,
    });
    if (!fact) return res.status(404).json({ error: "Memory entry not found or invalid." });
    return res.json({ fact });
  } catch (error) {
    return next(error);
  }
});

memoryRouter.delete("/:id", async (req, res, next) => {
  try {
    if (!UUID_PATTERN.test(req.params.id)) return res.status(400).json({ error: "Invalid memory entry." });
    const deleted = await deleteFact(req.authSession.user.id, req.params.id);
    return deleted ? res.status(204).end() : res.status(404).json({ error: "Memory entry not found." });
  } catch (error) {
    return next(error);
  }
});
