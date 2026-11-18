import "./setup-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import JSZip from "jszip";
import { createIsolatedAuthFixture } from "./helpers/auth-test-harness.js";
import { setImporterDbForTest } from "../src/skills/importer.js";
import { setSkillsDbForTest } from "../src/skills/service.js";
import { skillsRouter } from "../src/skills/router.js";

async function createTestServer(fixture) {
  const app = express();
  app.use(express.json());
  app.use(fixture.mockAuthMiddleware);
  app.use("/api/skills", skillsRouter);

  // Error handling middleware
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal server error" });
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const close = () => new Promise((resolve) => server.close(resolve));

  return { baseUrl, close };
}

test("End-to-End Skills Import: Full lifecycle with Markdown, ZIP, conflict resolution, and persistence", async (t) => {
  const fixture = await createIsolatedAuthFixture({ tier: "pro" });
  setImporterDbForTest(fixture.db);
  setSkillsDbForTest(fixture.db);

  const { baseUrl, close } = await createTestServer(fixture);
  t.after(async () => {
    await close();
    await fixture.client.close();
  });

  // 1. Initial State: skills list is empty
  const initialRes = await fetch(`${baseUrl}/api/skills`);
  assert.equal(initialRes.status, 200);
  const initialData = await initialRes.json();
  assert.deepEqual(initialData.skills, []);

  // 2. Markdown Upload Preview
  const mdContent = `---
name: Strategy Analyst
description: High-level market strategy consultant
requiredConnectors:
  - web_search
---
# Instructions
Analyze industry trends using Porter's Five Forces and BCG matrix.`;

  const mdBlob = new Blob([mdContent], { type: "text/markdown" });
  const mdFormData = new FormData();
  mdFormData.append("file", mdBlob, "strategy-analyst.md");

  const previewRes = await fetch(`${baseUrl}/api/skills/upload-preview`, {
    method: "POST",
    body: mdFormData,
  });
  assert.equal(previewRes.status, 200);
  const previewData = await previewRes.json();

  assert.equal(previewData.success, true);
  assert.equal(previewData.name, "Strategy Analyst");
  assert.equal(previewData.description, "High-level market strategy consultant");
  assert.deepEqual(previewData.requiredConnectors, ["web_search"]);
  assert.ok(previewData.instructions.includes("Porter's Five Forces"));
  assert.equal(previewData.conflict, null);

  // Verify preview did NOT persist to DB
  const intermediateListRes = await fetch(`${baseUrl}/api/skills`);
  const intermediateData = await intermediateListRes.json();
  assert.equal(intermediateData.skills.length, 0);

  // 3. Confirm Import of Markdown Skill
  const confirmRes = await fetch(`${baseUrl}/api/skills/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: previewData.name,
      description: previewData.description,
      instructions: previewData.instructions,
      requiredConnectors: previewData.requiredConnectors,
    }),
  });
  assert.equal(confirmRes.status, 201);
  const confirmData = await confirmRes.json();
  assert.equal(confirmData.created, true);
  assert.equal(confirmData.skill.name, "Strategy Analyst");
  assert.ok(confirmData.skill.id);
  const originalSkillId = confirmData.skill.id;

  // Verify persistence after reload
  const afterMdListRes = await fetch(`${baseUrl}/api/skills`);
  const afterMdData = await afterMdListRes.json();
  assert.equal(afterMdData.skills.length, 1);
  assert.equal(afterMdData.skills[0].id, originalSkillId);
  assert.equal(afterMdData.skills[0].name, "Strategy Analyst");
  assert.equal(afterMdData.skills[0].description, "High-level market strategy consultant");

  // 4. ZIP Package Upload Preview and Confirmation
  const zip = new JSZip();
  const zipSkillMd = `---
name: DevOps Automator
description: Automates CI/CD and deployment checks
requiredConnectors:
  - github
---
# Deployment Procedures
Validate docker containers and check health endpoints before routing traffic.`;

  zip.file("SKILL.md", zipSkillMd);
  zip.file("references/checklist.md", "# Pre-flight checklist\n1. Check memory limits\n2. Run migrations");
  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

  const zipBlob = new Blob([zipBuffer], { type: "application/zip" });
  const zipFormData = new FormData();
  zipFormData.append("file", zipBlob, "devops-automator.zip");

  const zipPreviewRes = await fetch(`${baseUrl}/api/skills/upload-preview`, {
    method: "POST",
    body: zipFormData,
  });
  assert.equal(zipPreviewRes.status, 200);
  const zipPreviewData = await zipPreviewRes.json();
  assert.equal(zipPreviewData.success, true);
  assert.equal(zipPreviewData.name, "DevOps Automator");
  assert.equal(zipPreviewData.resources.length, 1);
  assert.equal(zipPreviewData.resources[0].name, "checklist.md");
  assert.equal(zipPreviewData.conflict, null);

  // Confirm ZIP skill import
  const zipConfirmRes = await fetch(`${baseUrl}/api/skills/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: zipPreviewData.name,
      description: zipPreviewData.description,
      instructions: zipPreviewData.instructions,
      requiredConnectors: zipPreviewData.requiredConnectors,
    }),
  });
  assert.equal(zipConfirmRes.status, 201);
  const zipConfirmData = await zipConfirmRes.json();
  assert.equal(zipConfirmData.created, true);
  assert.equal(zipConfirmData.skill.name, "DevOps Automator");

  // Check that both skills now persist in database
  const afterZipListRes = await fetch(`${baseUrl}/api/skills`);
  const afterZipData = await afterZipListRes.json();
  assert.equal(afterZipData.skills.length, 2);

  // 5. Conflict Resolution: Auto-Rename
  // Re-uploading "Strategy Analyst" preview should detect a conflict
  const conflictPreviewRes = await fetch(`${baseUrl}/api/skills/upload-preview`, {
    method: "POST",
    body: mdFormData,
  });
  assert.equal(conflictPreviewRes.status, 200);
  const conflictPreviewData = await conflictPreviewRes.json();
  assert.ok(conflictPreviewData.conflict);
  assert.equal(conflictPreviewData.conflict.existingId, originalSkillId);
  assert.equal(conflictPreviewData.conflict.existingName, "Strategy Analyst");

  // Confirm with overwrite=false -> will auto-rename to "Strategy Analyst (Imported)"
  const renameConfirmRes = await fetch(`${baseUrl}/api/skills/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Strategy Analyst",
      description: "Imported duplicate copy",
      instructions: "New separate instructions.",
      overwrite: false,
    }),
  });
  assert.equal(renameConfirmRes.status, 201);
  const renameConfirmData = await renameConfirmRes.json();
  assert.equal(renameConfirmData.created, true);
  assert.equal(renameConfirmData.skill.name, "Strategy Analyst (Imported)");

  // 6. Conflict Resolution: Overwrite Existing
  const overwriteConfirmRes = await fetch(`${baseUrl}/api/skills/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Strategy Analyst",
      description: "Updated strategy consultant instructions",
      instructions: "Updated instructions with latest 2026 framework.",
      overwrite: true,
      skillId: originalSkillId,
    }),
  });
  assert.equal(overwriteConfirmRes.status, 200);
  const overwriteConfirmData = await overwriteConfirmRes.json();
  assert.equal(overwriteConfirmData.updated, true);
  assert.equal(overwriteConfirmData.skill.id, originalSkillId);
  assert.equal(overwriteConfirmData.skill.instructions, "Updated instructions with latest 2026 framework.");

  // Verify total count is 3 (original updated, devops, auto-renamed duplicate)
  const finalListRes = await fetch(`${baseUrl}/api/skills`);
  const finalData = await finalListRes.json();
  assert.equal(finalData.skills.length, 3);
});

test("End-to-End Skills Import: Validation and security enforcement on upload", async (t) => {
  const fixture = await createIsolatedAuthFixture({ tier: "plus" });
  setImporterDbForTest(fixture.db);
  setSkillsDbForTest(fixture.db);

  const { baseUrl, close } = await createTestServer(fixture);
  t.after(async () => {
    await close();
    await fixture.client.close();
  });

  // Malicious script injection in markdown
  const maliciousMd = `# Attack Skill\n<script>alert(document.cookie)</script>`;
  const malBlob = new Blob([maliciousMd], { type: "text/markdown" });
  const malFormData = new FormData();
  malFormData.append("file", malBlob, "exploit.md");

  const malRes = await fetch(`${baseUrl}/api/skills/upload-preview`, {
    method: "POST",
    body: malFormData,
  });
  assert.equal(malRes.status, 400);
  const malData = await malRes.json();
  assert.match(malData.error, /Script tags and executable code are prohibited/);

  // Unsupported file format
  const exeBlob = new Blob([Buffer.from("dummy binary")], { type: "application/octet-stream" });
  const exeFormData = new FormData();
  exeFormData.append("file", exeBlob, "tool.exe");

  const exeRes = await fetch(`${baseUrl}/api/skills/upload-preview`, {
    method: "POST",
    body: exeFormData,
  });
  assert.equal(exeRes.status, 400);
  const exeData = await exeRes.json();
  assert.match(exeData.error, /Unsupported file format/);

  // Empty name in import
  const emptyNameRes = await fetch(`${baseUrl}/api/skills/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "   ",
      instructions: "Valid instructions",
    }),
  });
  assert.equal(emptyNameRes.status, 400);
  const emptyNameData = await emptyNameRes.json();
  assert.match(emptyNameData.error, /Skill name is required/);
});
