import { and, asc, eq, inArray } from "drizzle-orm";
import { conversationGroups, conversations, memoryFacts } from "../db/schema.js";

// Projects and folders for Chat and Study. A project carries optional
// instructions that reach the model for every chat filed under it (or under
// one of its folders); a folder only groups. Folders nest one level, inside a
// project; projects never nest. Every query derives ownership from the
// authenticated user, and the database injection lets tests use isolated
// Postgres the same way the image library does.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ["project", "folder"];
const MODES = ["chat", "study"];
export const GROUP_NAME_MAX = 80;
export const GROUP_INSTRUCTIONS_MAX = 2000;
// Plenty for organising, and a ceiling on what one account can make the
// sidebar load.
export const GROUP_LIMIT = 200;

const failure = (status, message) => Object.assign(new Error(message), { status });

function requireId(value, message = "Invalid project or folder.") {
  if (typeof value !== "string" || !UUID.test(value)) throw failure(400, message);
  return value;
}

function cleanName(value, kind) {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > GROUP_NAME_MAX) {
    throw failure(400, `Use a ${kind === "project" ? "project" : "folder"} name between 1 and ${GROUP_NAME_MAX} characters.`);
  }
  return name;
}

function cleanInstructions(value) {
  if (value == null) return "";
  if (typeof value !== "string") throw failure(400, "Project instructions must be text.");
  const text = value.trim();
  if (text.length > GROUP_INSTRUCTIONS_MAX) throw failure(400, `Keep project instructions under ${GROUP_INSTRUCTIONS_MAX} characters.`);
  return text;
}

export function groupView(group) {
  const mode = group.mode === "study" ? "study" : "chat";
  const notebookType = mode === "study" ? "learning" : "work";
  return {
    id: group.id,
    kind: group.kind,
    mode,
    notebookType,
    parentId: group.parentId ?? null,
    name: group.name,
    instructions: group.instructions ?? "",
    // Projects only: use this project's memories in its chats, and save new ones to it.
    ...(group.kind === "project" ? { memoryUseEnabled: group.memoryUseEnabled !== false, memorySaveEnabled: group.memorySaveEnabled !== false } : {}),
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

export function createConversationGroups(db) {
  async function getGroup(userId, id) {
    requireId(id);
    const [group] = await db.select().from(conversationGroups)
      .where(and(eq(conversationGroups.userId, userId), eq(conversationGroups.id, id))).limit(1);
    if (!group) throw failure(404, "Project or folder not found.");
    return group;
  }

  // A folder may go inside a project of the same workspace, nowhere else.
  async function validParent(userId, parentId, mode) {
    if (parentId == null) return null;
    const parent = await getGroup(userId, parentId);
    if (parent.kind !== "project") throw failure(400, "Folders can only go inside a project.");
    if (parent.mode !== mode) throw failure(400, "That project belongs to a different workspace.");
    return parent.id;
  }

  return {
    getGroup,

    async listGroups(userId, mode) {
      const conditions = [eq(conversationGroups.userId, userId)];
      if (mode && mode !== "all" && MODES.includes(mode)) conditions.push(eq(conversationGroups.mode, mode));
      const rows = await db.select().from(conversationGroups).where(and(...conditions))
        .orderBy(asc(conversationGroups.name), asc(conversationGroups.id));
      return rows.map(groupView);
    },

    async createGroup(userId, body = {}) {
      const kind = KINDS.includes(body.kind) ? body.kind : "project";
      let mode = "chat";
      if (body.notebookType === "learning" || body.mode === "learning" || body.mode === "study") {
        mode = "study";
      } else if (body.notebookType === "work" || body.mode === "work" || body.mode === "chat") {
        mode = "chat";
      } else if (body.mode && !MODES.includes(body.mode)) {
        throw failure(400, "Invalid notebook type. Choose Learning or Work.");
      }
      const name = cleanName(body.name, kind);
      const instructions = kind === "project" ? cleanInstructions(body.instructions) : "";
      const parentId = kind === "folder" ? await validParent(userId, body.parentId ?? null, mode) : null;
      const existing = await db.select({ id: conversationGroups.id }).from(conversationGroups)
        .where(eq(conversationGroups.userId, userId)).limit(GROUP_LIMIT);
      if (existing.length >= GROUP_LIMIT) throw failure(409, `You can have up to ${GROUP_LIMIT} projects.`);
      const [group] = await db.insert(conversationGroups).values({ userId, kind, mode, name, instructions, parentId }).returning();
      return groupView(group);
    },

    async updateGroup(userId, id, body = {}) {
      const group = await getGroup(userId, id);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw failure(400, "Choose something to change.");
      const change = {};
      if (Object.hasOwn(body, "name")) change.name = cleanName(body.name, group.kind);
      if (Object.hasOwn(body, "instructions")) {
        if (group.kind !== "project") throw failure(400, "Only projects have instructions.");
        change.instructions = cleanInstructions(body.instructions);
      }
      for (const key of ["memoryUseEnabled", "memorySaveEnabled"]) {
        if (!Object.hasOwn(body, key)) continue;
        if (group.kind !== "project") throw failure(400, "Only projects have memory settings.");
        if (typeof body[key] !== "boolean") throw failure(400, "Choose on or off.");
        change[key] = body[key];
      }
      if (Object.hasOwn(body, "parentId")) {
        if (group.kind !== "folder") throw failure(400, "Projects can't go inside another project.");
        change.parentId = await validParent(userId, body.parentId, group.mode);
      }
      if (Object.hasOwn(body, "notebookType") || Object.hasOwn(body, "mode")) {
        const reqType = body.notebookType || body.mode;
        if (reqType === "learning" || reqType === "study") change.mode = "study";
        else if (reqType === "work" || reqType === "chat") change.mode = "chat";
      }
      if (!Object.keys(change).length) throw failure(400, "Choose something to change.");
      const [updated] = await db.update(conversationGroups).set({ ...change, updatedAt: new Date() })
        .where(and(eq(conversationGroups.userId, userId), eq(conversationGroups.id, id))).returning();
      return groupView(updated);
    },

    // Deleting a project or folder never deletes a chat: its chats (and the
    // chats in a project's folders) move back to the main list.
    async deleteGroup(userId, id) {
      const group = await getGroup(userId, id);
      const children = group.kind === "project"
        ? await db.select({ id: conversationGroups.id }).from(conversationGroups)
          .where(and(eq(conversationGroups.userId, userId), eq(conversationGroups.parentId, group.id)))
        : [];
      const ids = [group.id, ...children.map((child) => child.id)];
      await db.transaction(async (tx) => {
        await tx.update(conversations).set({ groupId: null })
          .where(and(eq(conversations.userId, userId), inArray(conversations.groupId, ids)));
        if (children.length) {
          await tx.delete(conversationGroups)
            .where(and(eq(conversationGroups.userId, userId), inArray(conversationGroups.id, children.map((child) => child.id))));
        }
        await tx.delete(conversationGroups)
          .where(and(eq(conversationGroups.userId, userId), eq(conversationGroups.id, group.id)));
        // A project's memories were only ever for it; they go with it. Chats are kept (above), memories saved to it are not.
        if (group.kind === "project") {
          await tx.delete(memoryFacts).where(and(eq(memoryFacts.userId, userId), eq(memoryFacts.scope, "project"), eq(memoryFacts.projectId, group.id)));
        }
      });
      return { deleted: ids };
    },

    // File a conversation under a project, or back in the
    // main list with null.
    async moveConversation(userId, conversationId, groupId) {
      requireId(conversationId, "Invalid conversation.");
      const [conversation] = await db.select({ id: conversations.id, mode: conversations.mode }).from(conversations)
        .where(and(eq(conversations.userId, userId), eq(conversations.id, conversationId))).limit(1);
      if (!conversation) throw failure(404, "Conversation not found.");
      if (groupId != null) {
        await getGroup(userId, groupId);
      }
      const [updated] = await db.update(conversations).set({ groupId: groupId ?? null })
        .where(and(eq(conversations.userId, userId), eq(conversations.id, conversationId)))
        .returning({ id: conversations.id, title: conversations.title, model: conversations.model, mode: conversations.mode, groupId: conversations.groupId, createdAt: conversations.createdAt, updatedAt: conversations.updatedAt });
      return updated;
    },

    // The project a chat belongs to, directly or through one of its folders,
    // with its instructions; null when it is not in a project.
    async projectFor(userId, groupId) {
      if (typeof groupId !== "string" || !UUID.test(groupId)) return null;
      const [group] = await db.select().from(conversationGroups)
        .where(and(eq(conversationGroups.userId, userId), eq(conversationGroups.id, groupId))).limit(1);
      if (!group) return null;
      if (group.kind === "project") return groupView(group);
      if (!group.parentId) return null;
      const [parent] = await db.select().from(conversationGroups)
        .where(and(eq(conversationGroups.userId, userId), eq(conversationGroups.id, group.parentId))).limit(1);
      return parent?.kind === "project" ? groupView(parent) : null;
    },
  };
}

// Project instructions sit beside the account's personal instructions in the
// system prompt, scoped to this chat. Empty when there is nothing to add.
export function projectSystemPrompt(project) {
  const instructions = String(project?.instructions ?? "").trim().slice(0, GROUP_INSTRUCTIONS_MAX);
  if (!project?.name) return "";
  return `\nThis conversation is part of the user's project "${project.name.replace(/["<>]/g, "")}".${instructions ? ` Project instructions from the account owner (follow them for this conversation when they do not conflict with higher-priority instructions):\n<project-instructions>${instructions}</project-instructions>` : ""}`;
}
