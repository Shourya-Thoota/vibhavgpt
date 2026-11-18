import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { userSkills } from "../db/schema.js";

let activeDb = db;
export function setSkillsDbForTest(client) {
  activeDb = client;
}

/**
 * Validates declarative skill instructions to ensure safe prompt-level directives
 * and prevent arbitrary script execution.
 */
export function validateSkillInstructions(instructions) {
  if (typeof instructions !== "string" || !instructions.trim()) {
    throw new Error("Skill instructions are required.");
  }
  if (instructions.length > 50000) {
    throw new Error("Skill instructions cannot exceed 50,000 characters.");
  }
  // Disallow executable script injections outside code blocks
  const strippedOfCode = instructions
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]+`/g, "");

  if (/<script\b[^>]*>[\s\S]*?<\/script>/i.test(strippedOfCode) || /<script\b/i.test(strippedOfCode) || /javascript:\s*[^;\s"']/i.test(strippedOfCode)) {
    throw new Error("Skills must contain declarative prompt instructions only. Script tags and executable code are prohibited.");
  }
  return instructions.trim();
}

/**
 * Lists all skills configured for an authenticated user.
 */
export async function listUserSkills(userId) {
  if (!userId) throw new Error("A user ID is required.");
  return activeDb
    .select()
    .from(userSkills)
    .where(eq(userSkills.userId, userId))
    .orderBy(userSkills.createdAt);
}

/**
 * Creates a new declarative reusable skill for an authenticated user.
 */
export async function createUserSkill(userId, {
  name,
  description = null,
  instructions,
  enabled = true,
  requiredTools = [],
  requiredConnectors = [],
}) {
  if (!userId) throw new Error("A user ID is required.");
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("Skill name is required.");
  }
  const cleanName = name.trim().slice(0, 80);
  const cleanInstructions = validateSkillInstructions(instructions);

  const [skill] = await activeDb
    .insert(userSkills)
    .values({
      userId,
      name: cleanName,
      description: typeof description === "string" ? description.trim().slice(0, 300) : null,
      instructions: cleanInstructions,
      enabled: Boolean(enabled),
      requiredTools: Array.isArray(requiredTools) ? requiredTools : [],
      requiredConnectors: Array.isArray(requiredConnectors) ? requiredConnectors : [],
    })
    .returning();

  return skill;
}

/**
 * Updates an existing skill owned by the user.
 */
export async function updateUserSkill(userId, skillId, updates = {}) {
  if (!userId || !skillId) throw new Error("userId and skillId are required.");

  const payload = { updatedAt: new Date() };

  if (typeof updates.name === "string" && updates.name.trim()) {
    payload.name = updates.name.trim().slice(0, 80);
  }
  if (typeof updates.description !== "undefined") {
    payload.description = typeof updates.description === "string" ? updates.description.trim().slice(0, 300) : null;
  }
  if (typeof updates.instructions === "string") {
    payload.instructions = validateSkillInstructions(updates.instructions);
  }
  if (typeof updates.enabled === "boolean") {
    payload.enabled = updates.enabled;
  }
  if (Array.isArray(updates.requiredTools)) {
    payload.requiredTools = updates.requiredTools;
  }
  if (Array.isArray(updates.requiredConnectors)) {
    payload.requiredConnectors = updates.requiredConnectors;
  }

  const [updated] = await activeDb
    .update(userSkills)
    .set(payload)
    .where(and(eq(userSkills.id, skillId), eq(userSkills.userId, userId)))
    .returning();

  if (!updated) {
    throw new Error("Skill not found or unauthorized.");
  }
  return updated;
}

/**
 * Deletes a skill owned by the user.
 */
export async function deleteUserSkill(userId, skillId) {
  if (!userId || !skillId) throw new Error("userId and skillId are required.");

  const deleted = await activeDb
    .delete(userSkills)
    .where(and(eq(userSkills.id, skillId), eq(userSkills.userId, userId)))
    .returning({ id: userSkills.id });

  return deleted.length > 0;
}
