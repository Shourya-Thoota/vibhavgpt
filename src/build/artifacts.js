// Build's project files (owner request, 2026-11-15): Tecton writes real files, not code for the person to copy by hand.
//
// The file protocol. Tecton's endpoint takes no tools, so files are not tool calls: Tecton writes them in its reply between fixed markers,
// and the server reads them only after the reply has completed:
//
//   <<<PROJECT kind="web" entry="index.html">>>
//   <<<FILE path="index.html">>>
//   ...the file's full contents...
//   <<<END FILE>>>
//
// Everything outside the markers is the short summary the person sees. The files are checked as one set before anything is stored: a
// reply cut off by the length limit, a file without its end marker, a path that is not a plain relative path, a duplicate, an unsupported
// type, or a set over the size or count limits is refused as a whole, and the previous good version stays. Contents are stored and served
// as data only: never run on the server, never served as a page from the app's origin.

import { ModelError, isModelPath, readModel } from "../../frontend/src/model3d.js";
import { ModelSpecError, generateStl, parseModelSpec } from "./model-spec.js";

// A 3D model described as JSON (src/build/model-spec.js): "model.json" or "<name>.model.json".
export const isModelSpecPath = (path) => /(?:^|\/)(?:[^/]+\.)?model\.json$/i.test(String(path));

export const ARTIFACT_LIMITS = Object.freeze({
  maxFiles: 40,
  maxFileBytes: 200 * 1024,
  maxTotalBytes: 600 * 1024,
  maxPathLength: 160,
  maxDepth: 6,
  keepRevisions: 20,
});

// "model": a 3D object, written as an ASCII STL or OBJ file (frontend/src/model3d.js), which is itself the export.
export const ARTIFACT_KINDS = Object.freeze(["web", "react", "model"]);

// Text files only, by extension. A React project's sources are kept as written (JSX is not run here).
const TEXT_TYPES = Object.freeze({
  ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
  ".jsx": "text/jsx", ".ts": "text/typescript", ".tsx": "text/tsx", ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain",
  ".svg": "image/svg+xml", ".csv": "text/csv", ".xml": "application/xml", ".webmanifest": "application/manifest+json",
  ".stl": "model/stl", ".obj": "model/obj",
});
const DOTFILES = new Set([".gitignore", ".editorconfig", ".prettierrc", ".nvmrc"]);

export function typeForPath(filePath) {
  const name = String(filePath).toLowerCase().split("/").pop();
  if (DOTFILES.has(name)) return "text/plain";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? TEXT_TYPES[name.slice(dot)] ?? null : null;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A plain relative path inside the project, or null. No "..", no absolute or drive paths, no backslashes, no hidden tricks. */
export function safeProjectPath(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > ARTIFACT_LIMITS.maxPathLength) return null;
  if (raw.startsWith("/") || raw.includes("\\") || /^[A-Za-z]:/.test(raw) || raw.includes("\0")) return null;
  const segments = raw.split("/");
  if (segments.length > ARTIFACT_LIMITS.maxDepth) return null;
  for (const segment of segments) {
    if (segment === "." || segment === ".." || !segment) return null;
    if (!SEGMENT.test(segment) && !DOTFILES.has(segment.toLowerCase())) return null;
  }
  return segments.join("/");
}

const PROJECT_LINE = /^<<<PROJECT\s+kind="([a-z]+)"\s+entry="([^"]+)">>>[ \t]*$/m;
const FILE_OPEN = /^<<<FILE\s+path="([^"]+)">>>[ \t]*\r?\n/m;
const FILE_CLOSE = /^<<<END FILE>>>[ \t]*$/m;

/**
 * Reads a completed Build reply. Returns { reply, status, ... }:
 *   status "none"     the reply has no project markers (a question, an explanation): reply is the whole text.
 *   status "files"    a valid set: { kind, entry, files: [{ path, content, bytes, type }], totalBytes }.
 *   status "invalid"  markers were present but the set cannot be accepted: { problem } says why, in plain words. Nothing is stored.
 * reply never contains file contents.
 */
export function extractBuildArtifact(text, { cutOff = false } = {}) {
  const source = String(text ?? "");
  const hasMarkers = PROJECT_LINE.test(source) || FILE_OPEN.test(source);
  if (!hasMarkers) return { status: "none", reply: source.trim() };

  const files = [];
  let rest = source;
  let summary = "";
  let problem = null;
  const project = source.match(PROJECT_LINE);
  // Walk the file blocks in order; text between them is part of the summary.
  for (;;) {
    const open = rest.match(FILE_OPEN);
    if (!open) { summary += rest; break; }
    summary += rest.slice(0, open.index);
    const bodyStart = open.index + open[0].length;
    const after = rest.slice(bodyStart);
    const close = after.match(FILE_CLOSE);
    if (!close) { problem = "The reply ended in the middle of a file, so the files were not saved."; break; }
    files.push({ rawPath: open[1], content: after.slice(0, close.index).replace(/\r?\n$/, "") });
    rest = after.slice(close.index + close[0].length);
  }
  const reply = summary.replace(PROJECT_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
  const fail = (why) => ({ status: "invalid", reply, problem: why });

  if (cutOff) return fail("The reply was cut off before it finished, so the files were not saved.");
  if (problem) return fail(problem);
  if (!project) return fail("The files came without their project line, so they were not saved.");
  const kind = project[1];
  if (!ARTIFACT_KINDS.includes(kind)) return fail(`"${kind}" is not a project type Build can save yet.`);
  if (!files.length) return fail("The project had no files, so nothing was saved.");
  if (files.length > ARTIFACT_LIMITS.maxFiles) return fail(`The project had ${files.length} files; Build keeps up to ${ARTIFACT_LIMITS.maxFiles}.`);

  const seen = new Set();
  const accepted = [];
  let totalBytes = 0;
  for (const file of files) {
    const filePath = safeProjectPath(file.rawPath);
    if (!filePath) return fail(`"${String(file.rawPath).slice(0, 80)}" is not a file path Build can save.`);
    const key = filePath.toLowerCase();
    if (seen.has(key)) return fail(`${filePath} appeared twice.`);
    seen.add(key);
    const type = typeForPath(filePath);
    if (!type) return fail(`${filePath} is not a file type Build can save (text files only, for now).`);
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > ARTIFACT_LIMITS.maxFileBytes) return fail(`${filePath} is larger than ${ARTIFACT_LIMITS.maxFileBytes / 1024} KB.`);
    // A 3D model must be real geometry before it is saved: a broken one is refused, never stored as if it were usable.
    if (isModelPath(filePath)) {
      try { readModel(file.content, filePath); } catch (error) { if (error instanceof ModelError) return fail(`${error.message} The model was not saved.`); throw error; }
    }
    totalBytes += bytes;
    accepted.push({ path: filePath, content: file.content, bytes, type });
  }
  if (totalBytes > ARTIFACT_LIMITS.maxTotalBytes) return fail(`The project is larger than ${ARTIFACT_LIMITS.maxTotalBytes / 1024} KB.`);
  let entry = safeProjectPath(project[2]);
  if (!entry || !seen.has(entry.toLowerCase())) return fail(`The project's entry file (${String(project[2]).slice(0, 80)}) is not among its files.`);
  // The 3D helper: a model described as JSON is turned into an STL here, on the server; the STL is generated, never written by the model,
  // and becomes the entry when the description was. Its size has its own cap (MODEL_SPEC_LIMITS), apart from the limits on written files.
  if (kind === "model") {
    for (const spec of accepted.filter((file) => isModelSpecPath(file.path))) {
      const stlPath = spec.path.replace(/(?:\.model)?\.json$/i, ".stl");
      if (seen.has(stlPath.toLowerCase())) return fail(`${stlPath} is generated from ${spec.path}; write only the description.`);
      let generated;
      try { generated = generateStl(parseModelSpec(spec.content)); } catch (error) { if (error instanceof ModelSpecError) return fail(`${spec.path}: ${error.message} The model was not saved.`); throw error; }
      readModel(generated.stl, stlPath); // the generated file passes the same check as a written one
      const bytes = Buffer.byteLength(generated.stl, "utf8");
      seen.add(stlPath.toLowerCase());
      accepted.push({ path: stlPath, content: generated.stl, bytes, type: "model/stl" });
      totalBytes += bytes;
      if (entry.toLowerCase() === spec.path.toLowerCase()) entry = stlPath;
    }
  }
  if (kind === "model" && !isModelPath(entry)) return fail(`A 3D model's entry must be its model.json description or its .stl or .obj file, not ${entry}.`);
  accepted.sort((a, b) => a.path.localeCompare(b.path));
  return { status: "files", reply, kind, entry, files: accepted, totalBytes };
}

/** What Tecton is told about the file protocol (appended to its identity in Build). */
export const BUILD_PROTOCOL_INSTRUCTION = [
  "You are in Build, where your files are saved as a real project the person can browse and download.",
  "If an important decision is missing for a substantial new project (what it is for, its main features, its look, phone or desktop first; for 3D, dimensions, units and use), ask at most three short questions and offer to use sensible defaults instead. Never ask about something the person already said. For a clear request or a small change, just do it.",
  "When you create or change the project, write the complete project every time, in exactly this format, with nothing else inside the markers:",
  '<<<PROJECT kind="web" entry="index.html">>>',
  '<<<FILE path="index.html">>>',
  "(the file's full contents)",
  "<<<END FILE>>>",
  'Use kind "web" for plain HTML, CSS and JavaScript (preferred: it runs as it is), or kind "react" only when asked for React; then include package.json and say how to run it.',
  'For a 3D object (to print, mill or import into a 3D app), use kind "model" with entry "model.json", and describe the object in model.json; never write triangle coordinates yourself: the server builds the STL from the description. model.json is {"format": "vibhavgpt-model/1", "name": "...", "units": "mm", "parts": [...]}. Each part has a "type" and optional "position": [x, y, z] and "rotation": [rx, ry, rz] in degrees. Types: {"type": "box", "size": [x, y, z]} (centred); {"type": "cylinder", "radius": r, "height": h} (base on z = 0); {"type": "cone", "radiusBottom": r1, "radiusTop": r2, "height": h}; {"type": "sphere", "radius": r} (centred); {"type": "torus", "majorRadius": R, "minorRadius": r}; {"type": "revolve", "profile": [[radius, z], ...]}, a side profile from the axis outward and back, turned around the Z axis, which suits plates, bowls, cups and vases. Optional "segments" (3 to 256) sets smoothness. Parts that overlap are joined by the slicer. Use millimetres unless told otherwise and add a README.md with the size and units. Say in the summary that the person should check it in their slicer or CAD app before printing: you did not test it.',
  "Use plain relative paths (letters, digits, dot, dash, underscore, at most six folders deep). Text files only. Up to 40 files and 600 KB in all. No external scripts, fonts or images from other sites: everything the project needs is in its files. Never invent a link, a repository or a download address.",
  "Outside the markers, write only a short summary (two or three sentences) of what you made or changed. Do not paste the code outside the markers. Do not say you ran, tested or deployed anything: you did not.",
].join("\n");
