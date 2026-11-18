import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { requireSession } from "../middleware/require-session.js";
import {
  listUserSkills,
  createUserSkill,
  updateUserSkill,
  deleteUserSkill,
} from "./service.js";
import {
  parseMarkdownSkill,
  parseZipSkill,
  checkSkillConflict,
} from "./importer.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
});

export const skillsRouter = Router();

// All skills operations require an authenticated session
skillsRouter.use(requireSession);

/**
 * GET /api/skills
 * Returns all custom skills created by the current user.
 */
skillsRouter.get("/", async (req, res, next) => {
  try {
    const skills = await listUserSkills(req.user.id);
    res.json({ skills });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/skills
 * Creates a new skill.
 */
skillsRouter.post("/", async (req, res, next) => {
  try {
    const { name, description, instructions, enabled, requiredTools, requiredConnectors } = req.body || {};
    const skill = await createUserSkill(req.user.id, {
      name,
      description,
      instructions,
      enabled,
      requiredTools,
      requiredConnectors,
    });
    res.status(201).json({ skill });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/skills/upload-preview
 * Inspects and parses an uploaded .md or .zip skill package without persisting it,
 * returning validation status, instructions preview, resources, and name conflict info.
 */
skillsRouter.post("/upload-preview", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No file was uploaded." });
    }

    const filename = req.file.originalname || "skill.md";
    const ext = path.extname(filename).toLowerCase();

    let parsed;
    if (ext === ".zip") {
      parsed = await parseZipSkill(req.file.buffer);
    } else if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
      parsed = parseMarkdownSkill(req.file.buffer, filename);
    } else {
      return res.status(400).json({
        error: "Unsupported file format. Please upload a .md file or a .zip skill package.",
      });
    }

    const conflict = await checkSkillConflict(req.user.id, parsed.name);

    res.json({
      success: true,
      name: parsed.name,
      description: parsed.description,
      instructions: parsed.instructions,
      requiredConnectors: parsed.requiredConnectors,
      resources: parsed.resources,
      conflict,
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to inspect skill package." });
  }
});

/**
 * POST /api/skills/import
 * Confirms and persists an imported skill with explicit conflict handling (rename / overwrite).
 */
skillsRouter.post("/import", async (req, res, next) => {
  try {
    const {
      name,
      description,
      instructions,
      requiredConnectors,
      overwrite = false,
      skillId,
    } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Skill name is required." });
    }

    let finalName = name.trim();
    const conflict = await checkSkillConflict(req.user.id, finalName);

    if (conflict) {
      if (overwrite) {
        const targetId = skillId || conflict.existingId;
        const updated = await updateUserSkill(req.user.id, targetId, {
          name: finalName,
          description,
          instructions,
          requiredConnectors,
        });
        return res.json({ skill: updated, updated: true });
      }
      // If not overwrite, auto-rename to avoid collision
      finalName = `${finalName} (Imported)`.slice(0, 80);
    }

    const skill = await createUserSkill(req.user.id, {
      name: finalName,
      description,
      instructions,
      requiredConnectors,
      enabled: true,
    });

    res.status(201).json({ skill, created: true });
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to import skill." });
  }
});

/**
 * PUT /api/skills/:id
 * Updates an existing skill.
 */
skillsRouter.put("/:id", async (req, res, next) => {
  try {
    const skill = await updateUserSkill(req.user.id, req.params.id, req.body || {});
    res.json({ skill });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/skills/:id
 * Deletes a skill.
 */
skillsRouter.delete("/:id", async (req, res, next) => {
  try {
    const success = await deleteUserSkill(req.user.id, req.params.id);
    if (!success) {
      return res.status(404).json({ error: "Skill not found." });
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});
