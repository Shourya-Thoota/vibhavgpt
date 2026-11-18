// /api/build: the signed-in person's Build projects (src/build/projects.js). Every route names the session's account; another person's
// project is reported as not found. Files are only ever downloaded: served as attachments, as bytes, with nosniff and a sandboxing CSP, so a
// generated HTML file never runs as a page on the app's origin.
import { Router } from "express";
import express from "express";
import { requireSession } from "../middleware/require-session.js";
import { uploadLimitsForUser } from "../uploads/service.js";
import * as esbuild from "esbuild";
import { BuildProjectError, projectForConversation, restoreRevision, revisionFile, revisionFiles, revisionZip } from "./projects.js";
import { PREVIEW_RUNTIME_MARKER, PreviewError, buildPreviewDocument } from "../../frontend/src/build-preview.js";

// The live preview's bundling (owner request, 2026-11-15). The browser cannot run the bundler: the app's Content-Security-Policy does not
// allow WebAssembly, and it is not loosened for this. So the API bundles a version's files here with esbuild, which reads and joins them but
// never runs them (its only plugin serves the project's own files); the result is returned as text, and only the browser's sandboxed,
// opaque-origin iframe runs it. Bounded: at most two bundles at a time on this server and 15 seconds each.
const PREVIEW_TIMEOUT_MS = 15_000;
const PREVIEW_CONCURRENCY = 2;
let previewsRunning = 0;

const noStore = (res) => res.set({ "Cache-Control": "private, no-store", Vary: "Cookie" });
const NOT_FOUND = { error: "That build was not found.", code: "build_not_found" };
const attachmentName = (name) => String(name).split("/").pop().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "file";

export function createBuildRouter({ session = requireSession, limitsFor = uploadLimitsForUser } = {}) {
  const router = Router();
  router.use(session);
  router.use(express.json({ limit: "2kb" }));

  router.get("/conversations/:conversationId/project", async (req, res, next) => {
    try {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.conversationId)) return noStore(res).status(404).json(NOT_FOUND);
      const project = await projectForConversation(req.authSession.user.id, req.params.conversationId);
      return noStore(res).status(200).json({ project });
    } catch (error) { return next(error); }
  });

  router.get("/projects/:projectId/revisions/:revision/file", async (req, res, next) => {
    try {
      const file = await revisionFile(req.authSession.user.id, req.params.projectId, req.params.revision, req.query.path);
      if (!file) return noStore(res).status(404).json(NOT_FOUND);
      noStore(res).set({
        "Content-Type": req.query.view === "1" ? "text/plain; charset=utf-8" : "application/octet-stream",
        "Content-Disposition": `${req.query.view === "1" ? "inline" : "attachment"}; filename="${attachmentName(file.path)}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
      return res.status(200).send(Buffer.from(file.content, "utf8"));
    } catch (error) { return next(error); }
  });

  router.get("/projects/:projectId/revisions/:revision/preview", async (req, res, next) => {
    try {
      const version = await revisionFiles(req.authSession.user.id, req.params.projectId, req.params.revision);
      if (!version) return noStore(res).status(404).json(NOT_FOUND);
      if (previewsRunning >= PREVIEW_CONCURRENCY) return noStore(res).status(429).json({ error: "Previews are busy right now. Try again in a moment.", code: "preview_busy" });
      previewsRunning += 1;
      let timer;
      try {
        const html = await Promise.race([
          buildPreviewDocument(version, { esbuild, loadRuntime: async () => PREVIEW_RUNTIME_MARKER }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new PreviewError("The preview took too long to build. Download the ZIP to run the project yourself.")), PREVIEW_TIMEOUT_MS); }),
        ]);
        noStore(res).set({ "X-Content-Type-Options": "nosniff" });
        return res.status(200).json({ revision: version.revision, html, runtime: html.includes(PREVIEW_RUNTIME_MARKER) });
      } finally {
        clearTimeout(timer);
        previewsRunning -= 1;
      }
    } catch (error) {
      if (error instanceof PreviewError) return noStore(res).status(422).json({ error: error.message, code: "preview_failed" });
      return next(error);
    }
  });

  router.get("/projects/:projectId/revisions/:revision/zip", async (req, res, next) => {
    try {
      const zip = await revisionZip(req.authSession.user.id, req.params.projectId, req.params.revision);
      if (!zip) return noStore(res).status(404).json(NOT_FOUND);
      noStore(res).set({
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${attachmentName(zip.name)}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
      return res.status(200).send(zip.buffer);
    } catch (error) { return next(error); }
  });

  router.post("/projects/:projectId/restore", async (req, res, next) => {
    try {
      const revision = Number(req.body?.revision);
      if (!Number.isSafeInteger(revision) || revision < 1) return noStore(res).status(400).json({ error: "Choose a version to restore.", code: "bad_request" });
      const { accountBytes } = await limitsFor(req.authSession.user.id);
      const restored = await restoreRevision(req.authSession.user.id, req.params.projectId, revision, { accountBytes });
      return noStore(res).status(200).json(restored);
    } catch (error) {
      if (error instanceof BuildProjectError) return noStore(res).status(error.status).json({ error: error.message, code: error.code });
      return next(error);
    }
  });

  return router;
}
