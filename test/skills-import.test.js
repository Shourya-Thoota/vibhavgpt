import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import {
  parseSafeFrontmatter,
  sanitizeAndValidateInstructions,
  validateArchiveEntry,
  parseMarkdownSkill,
  parseZipSkill,
  checkSkillConflict,
  setImporterDbForTest,
} from "../src/skills/importer.js";

test("Skills Import: Safe YAML frontmatter parsing", () => {
  const mdWithFrontmatter = `---
name: Competitive Strategy Advisor
description: Analyzes market forces and competitive positioning
requiredConnectors:
  - web_search
  - google_workspace
---
# Instructions
When asked to evaluate a product:
1. Identify primary competitors
2. Structure output using Porter's Five Forces`;

  const { metadata, body } = parseSafeFrontmatter(mdWithFrontmatter);

  assert.equal(metadata.name, "Competitive Strategy Advisor");
  assert.equal(metadata.description, "Analyzes market forces and competitive positioning");
  assert.deepEqual(metadata.requiredConnectors, ["web_search", "google_workspace"]);
  assert.ok(body.includes("# Instructions"));
  assert.ok(body.includes("Identify primary competitors"));
});

test("Skills Import: Markdown without frontmatter extracts title from H1", () => {
  const plainMd = `# Code Review Assistant

Perform comprehensive pull request analysis focusing on memory efficiency and edge cases.`;

  const parsed = parseMarkdownSkill(Buffer.from(plainMd, "utf8"), "review.md");

  assert.equal(parsed.name, "Code Review Assistant");
  assert.equal(parsed.description, "");
  assert.ok(parsed.instructions.includes("Perform comprehensive pull request analysis"));
});

test("Skills Import: Script injection is rejected, but code blocks with 'script' are allowed", () => {
  // 1. Raw malicious script execution is rejected
  const maliciousMd = `# Malicious Skill
Here are instructions.
<script>window.location.assign('https://attacker.com/steal')</script>`;

  assert.throws(
    () => sanitizeAndValidateInstructions(maliciousMd),
    /Script tags and executable code are prohibited/
  );

  // 2. Harmless markdown code block containing 'script' is permitted
  const benignCodeMd = `# Python Script Helper
Write clean Python scripts.

\`\`\`python
# This is a harmless script example
def run_script():
    print("Executing script")
\`\`\`

Always wrap script execution in try/except.`;

  const validated = sanitizeAndValidateInstructions(benignCodeMd);
  assert.ok(validated.includes("def run_script():"));
  assert.ok(validated.includes("Always wrap script execution in try/except."));
});

test("Skills Import: Safe Zip extraction with SKILL.md and resources", async () => {
  const zip = new JSZip();

  const skillMdContent = `---
name: Data Science Helper
description: Generates data exploration workflows
---
# Data Science Instructions
Use pandas and numpy to profile uploaded datasets.`;

  const referenceDoc = `# Data Dictionary Reference
Common schema definitions for customer records.`;

  zip.file("SKILL.md", skillMdContent);
  zip.file("references/dictionary.md", referenceDoc);

  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
  const parsed = await parseZipSkill(zipBuffer);

  assert.equal(parsed.name, "Data Science Helper");
  assert.equal(parsed.description, "Generates data exploration workflows");
  assert.ok(parsed.instructions.includes("Use pandas and numpy"));
  assert.equal(parsed.resources.length, 1);
  assert.equal(parsed.resources[0].name, "dictionary.md");
});

test("Skills Import: Zip-slip path traversal is strictly rejected", async () => {
  assert.throws(
    () => validateArchiveEntry("../../evil.txt"),
    /Path traversal rejected/
  );
  assert.throws(
    () => validateArchiveEntry("../etc/passwd"),
    /Path traversal rejected/
  );
  assert.throws(
    () => validateArchiveEntry("/root/secret.txt"),
    /Path traversal rejected/
  );
  assert.throws(
    () => validateArchiveEntry("C:/Windows/System32/cmd.exe"),
    /Path traversal rejected/
  );
});

test("Skills Import: Executable files in zip are rejected", async () => {
  const zip = new JSZip();
  zip.file("SKILL.md", "# Valid Skill\nInstructions");
  zip.file("scripts/run.exe", Buffer.from("MZbinaryexecutable"));

  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

  await assert.rejects(
    async () => parseZipSkill(zipBuffer),
    /Forbidden file type in archive: run\.exe/
  );
});

test("Skills Import: Nested archives are rejected", async () => {
  const zip = new JSZip();
  zip.file("SKILL.md", "# Valid Skill\nInstructions");
  zip.file("inner.zip", Buffer.from("PKdummyzipcontent"));

  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

  await assert.rejects(
    async () => parseZipSkill(zipBuffer),
    /Forbidden file type in archive: inner\.zip/
  );
});

test("Skills Import: Decompression bomb is rejected", async () => {
  const zip = new JSZip();
  zip.file("SKILL.md", "# Valid Skill\nInstructions");

  // Create an uncompressed buffer larger than 20MB limit
  const largeBuffer = Buffer.alloc(21 * 1024 * 1024, "a");
  zip.file("large_payload.txt", largeBuffer);

  const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  await assert.rejects(
    async () => parseZipSkill(zipBuffer),
    /Extracted package exceeds the maximum limit of 20 MB/
  );
});

test("Skills Import: Conflict detection identifies existing duplicate name", async () => {
  const mockDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: "existing-uuid-123", name: "Data Science Helper" }],
        }),
      }),
    }),
  };

  setImporterDbForTest(mockDb);

  const conflict = await checkSkillConflict("user-456", "Data Science Helper");
  assert.ok(conflict);
  assert.equal(conflict.existingId, "existing-uuid-123");
  assert.equal(conflict.existingName, "Data Science Helper");

  const noConflictMock = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  };

  setImporterDbForTest(noConflictMock);
  const result = await checkSkillConflict("user-456", "Completely Unique Skill");
  assert.equal(result, null);
});

test("Skills Import: Symlinks and raw binary executable headers are rejected", async () => {
  // Test binary ELF header rejection even with harmless extension
  const elfZip = new JSZip();
  elfZip.file("SKILL.md", "# Valid Skill\nInstructions");
  elfZip.file("data/doc.txt", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01, 0x01]));
  const elfBuffer = await elfZip.generateAsync({ type: "nodebuffer" });

  await assert.rejects(
    async () => parseZipSkill(elfBuffer),
    /Executable binary header rejected/
  );

  // Test symlink permissions rejection
  const symlinkZip = new JSZip();
  symlinkZip.file("SKILL.md", "# Valid Skill\nInstructions");
  symlinkZip.file("pointer.txt", "/etc/passwd", {
    unixPermissions: 0o120777, // S_IFLNK symlink mode
  });
  const symlinkBuffer = await symlinkZip.generateAsync({ type: "nodebuffer", platform: "UNIX" });

  await assert.rejects(
    async () => parseZipSkill(symlinkBuffer),
    /Symlinks are not permitted in skill packages/
  );

  // Test null-byte path rejection
  assert.throws(
    () => validateArchiveEntry("file.txt\0.exe"),
    /Null byte in path rejected/
  );
});
