import path from "node:path";
import JSZip from "jszip";
import { and, eq, ilike } from "drizzle-orm";
import { db } from "../db/client.js";
import { userSkills } from "../db/schema.js";

let activeDb = db;
export function setImporterDbForTest(client) {
  activeDb = client;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_EXTRACTED_BYTES = 20 * 1024 * 1024; // 20 MB (decompression bomb guard)
const MAX_FILE_COUNT = 50;
const MAX_PATH_DEPTH = 5;
const MAX_INSTRUCTION_LENGTH = 50000;

const FORBIDDEN_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".bat", ".cmd", ".ps1", ".vbs", ".sh",
  ".zip", ".tar", ".gz", ".tgz", ".7z", ".rar",
]);

/**
 * Parses simple, safe YAML frontmatter without unsafe object instantiation.
 */
export function parseSafeFrontmatter(text) {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  const match = text.match(frontmatterRegex);

  if (!match) {
    return {
      metadata: {},
      body: text.trim(),
    };
  }

  const rawYaml = match[1];
  const body = text.slice(match[0].length).trim();
  const metadata = {};

  const lines = rawYaml.split(/\r?\n/);
  let currentArrayKey = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Check for list item under active key
    if (currentArrayKey && line.startsWith("- ")) {
      const val = line.slice(2).trim().replace(/^["']|["']$/g, "");
      metadata[currentArrayKey].push(val);
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      currentArrayKey = null;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const valuePart = line.slice(colonIdx + 1).trim();

    // Reject dangerous YAML tags
    if (valuePart.startsWith("!") || valuePart.startsWith("!!")) {
      currentArrayKey = null;
      continue;
    }

    if (valuePart === "" || valuePart === "[]") {
      metadata[key] = [];
      currentArrayKey = key;
    } else {
      currentArrayKey = null;
      let cleaned = valuePart.replace(/^["']|["']$/g, "");
      if (cleaned.toLowerCase() === "true") cleaned = true;
      else if (cleaned.toLowerCase() === "false") cleaned = false;
      metadata[key] = cleaned;
    }
  }

  return { metadata, body };
}

/**
 * Validates instructions text: prevents executable script injection while
 * cleanly allowing harmless code blocks and documentation containing words like "script".
 */
export function sanitizeAndValidateInstructions(rawText) {
  if (typeof rawText !== "string" || !rawText.trim()) {
    throw new Error("Skill instructions are required.");
  }

  const trimmed = rawText.trim();
  if (trimmed.length > MAX_INSTRUCTION_LENGTH) {
    throw new Error(`Skill instructions cannot exceed ${MAX_INSTRUCTION_LENGTH.toLocaleString()} characters.`);
  }

  // Reject executable script tags outside of code blocks
  // Remove markdown code blocks (```...``` and `...`) temporarily to test for malicious execution
  const strippedOfCode = trimmed
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]+`/g, "");

  if (/<script\b[^>]*>[\s\S]*?<\/script>/i.test(strippedOfCode) || /<script\b/i.test(strippedOfCode)) {
    throw new Error("Skills must contain declarative instructions only. Script tags and executable code are prohibited.");
  }

  if (/javascript:\s*[^;\s"']/i.test(strippedOfCode)) {
    throw new Error("Executable JavaScript links are not permitted in skills.");
  }

  return trimmed;
}

/**
 * Validates entry name and path to protect against directory traversal and dangerous file types.
 */
export function validateArchiveEntry(entryPath) {
  if (typeof entryPath !== "string" || !entryPath) {
    throw new Error("Invalid archive entry path.");
  }

  // Reject null bytes and URL-encoded traversal attempts
  if (entryPath.includes("\0")) {
    throw new Error(`Null byte in path rejected: ${entryPath}`);
  }
  if (/%2e%2e/i.test(entryPath) || /%2f/i.test(entryPath) || /%5c/i.test(entryPath)) {
    throw new Error(`Encoded path traversal rejected: ${entryPath}`);
  }

  const normalized = path.normalize(entryPath).replace(/\\/g, "/");

  // Zip-slip checks
  if (
    entryPath.includes("..") ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new Error(`Path traversal rejected: ${entryPath}`);
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length > MAX_PATH_DEPTH) {
    throw new Error(`Path depth exceeds limit of ${MAX_PATH_DEPTH} levels: ${entryPath}`);
  }

  const ext = path.extname(normalized).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(ext)) {
    throw new Error(`Forbidden file type in archive: ${path.basename(normalized)}`);
  }

  return normalized;
}

/**
 * Parses and validates an uploaded `.md` file.
 */
export function parseMarkdownSkill(buffer, originalFilename = "skill.md") {
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error("Uploaded markdown file exceeds 10 MB limit.");
  }

  const content = buffer.toString("utf8");
  const { metadata, body } = parseSafeFrontmatter(content);

  let name = metadata.name || metadata.title;
  if (!name) {
    const firstHeader = body.match(/^#+\s+(.+)$/m);
    name = firstHeader ? firstHeader[1].trim() : path.basename(originalFilename, path.extname(originalFilename));
  }

  const description = metadata.description || metadata.desc || "";
  const validatedInstructions = sanitizeAndValidateInstructions(body || content);

  return {
    name: String(name).slice(0, 80).trim(),
    description: String(description).slice(0, 300).trim(),
    instructions: validatedInstructions,
    requiredConnectors: Array.isArray(metadata.requiredConnectors) ? metadata.requiredConnectors : [],
    resources: [],
  };
}

/**
 * Parses and validates an uploaded `.zip` package.
 */
export async function parseZipSkill(buffer) {
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error("Uploaded zip package exceeds 10 MB limit.");
  }

  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.keys(zip.files);

  if (entries.length > MAX_FILE_COUNT) {
    throw new Error(`Archive contains too many files (${entries.length}). Maximum allowed is ${MAX_FILE_COUNT}.`);
  }

  let totalExtractedBytes = 0;
  const candidateSkills = [];
  const resources = [];

  for (const entryPath of entries) {
    const file = zip.files[entryPath];
    if (file.dir) continue;

    // Reject symbolic links in archive headers
    const unixMode = file.unixPermissions;
    if (typeof unixMode === "number" && (unixMode & 0o170000) === 0o120000) {
      throw new Error(`Symlinks are not permitted in skill packages: ${entryPath}`);
    }

    const safePath = validateArchiveEntry(entryPath);

    // Pre-decompression bounds checking to prevent zip bombs before buffer allocation
    const declaredUncompressedSize = file._data?.uncompressedSize;
    if (typeof declaredUncompressedSize === "number") {
      if (declaredUncompressedSize > MAX_EXTRACTED_BYTES || totalExtractedBytes + declaredUncompressedSize > MAX_EXTRACTED_BYTES) {
        throw new Error("Extracted package exceeds the maximum limit of 20 MB (decompression limit).");
      }
    }

    // Read file content
    const fileBuffer = await file.async("nodebuffer");
    totalExtractedBytes += fileBuffer.length;

    if (totalExtractedBytes > MAX_EXTRACTED_BYTES) {
      throw new Error("Extracted package exceeds the maximum limit of 20 MB (decompression limit).");
    }

    // Binary / executable header inspection beyond simple extension checks
    if (fileBuffer.length >= 2) {
      if (fileBuffer[0] === 0x4D && fileBuffer[1] === 0x5A) {
        throw new Error(`Executable binary header rejected: ${path.basename(safePath)}`);
      }
      if (fileBuffer.length >= 4 && fileBuffer[0] === 0x7F && fileBuffer[1] === 0x45 && fileBuffer[2] === 0x4C && fileBuffer[3] === 0x46) {
        throw new Error(`Executable binary header rejected: ${path.basename(safePath)}`);
      }
      if (fileBuffer[0] === 0x23 && fileBuffer[1] === 0x21) {
        throw new Error(`Executable script header rejected: ${path.basename(safePath)}`);
      }
    }

    const filename = path.basename(safePath).toLowerCase();
    if (filename === "skill.md") {
      candidateSkills.push({
        path: safePath,
        buffer: fileBuffer,
      });
    } else if (filename.endsWith(".md") || filename.endsWith(".txt") || filename.endsWith(".json") || filename.endsWith(".csv") || filename.endsWith(".yaml") || filename.endsWith(".yml")) {
      resources.push({
        path: safePath,
        size: fileBuffer.length,
        name: path.basename(safePath),
      });
    }
  }

  if (candidateSkills.length === 0) {
    // Check if there is a single .md file in the package
    const singleMd = Object.keys(zip.files).find((p) => !zip.files[p].dir && p.toLowerCase().endsWith(".md"));
    if (singleMd) {
      const buffer = await zip.files[singleMd].async("nodebuffer");
      candidateSkills.push({ path: singleMd, buffer });
    } else {
      throw new Error("No SKILL.md found in the package. Ensure your zip package contains a SKILL.md file.");
    }
  }

  // Reject multiple distinct skill entrypoints
  if (candidateSkills.length > 1) {
    const dirSets = new Set(candidateSkills.map((c) => path.dirname(c.path)));
    if (dirSets.size > 1) {
      throw new Error("Multiple skill entrypoints found in archive. Please package a single skill per archive.");
    }
  }

  const mainSkill = candidateSkills[0];
  const parsed = parseMarkdownSkill(mainSkill.buffer, path.basename(mainSkill.path));

  return {
    ...parsed,
    resources,
  };
}

/**
 * Checks for duplicate skill names for a given user.
 */
export async function checkSkillConflict(userId, skillName) {
  if (!userId || !skillName) return null;
  const cleanName = skillName.trim();

  const [existing] = await activeDb
    .select({ id: userSkills.id, name: userSkills.name })
    .from(userSkills)
    .where(and(eq(userSkills.userId, userId), ilike(userSkills.name, cleanName)))
    .limit(1);

  return existing ? { existingId: existing.id, existingName: existing.name } : null;
}
