import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { conversations } from "../src/db/schema.js";
import { createConversationGroups, projectSystemPrompt } from "../src/chat/groups.js";

// In-memory Postgres: never reads DATABASE_URL or touches a real account.
async function fixture() {
  const client = new PGlite();
  for (const name of ["0000_zippy_rawhide_kid", "0013_study_mode", "0024_conversation_groups"]) {
    await client.exec(await readFile(new URL(`../drizzle/${name}.sql`, import.meta.url), "utf8"));
  }
  const db = drizzle(client);
  const [chat] = await db.insert(conversations).values({ userId: "owner", title: "Thesis outline", model: "nova", mode: "chat" }).returning();
  const [study] = await db.insert(conversations).values({ userId: "owner", title: "Cell biology", model: "study", mode: "study" }).returning();
  const [foreign] = await db.insert(conversations).values({ userId: "other", title: "Private", model: "nova", mode: "chat" }).returning();
  return { client, db, chat, study, foreign };
}

test("projects and folders on isolated Postgres", async (t) => {
  const { client, db, chat, study, foreign } = await fixture();
  t.after(() => client.close());
  const groups = createConversationGroups(db);
  let project;
  let folder;

  await t.test("creates a project with instructions and a folder inside it", async () => {
    project = await groups.createGroup("owner", { kind: "project", mode: "chat", name: "  Thesis  ", instructions: " Cite sources in APA. " });
    assert.equal(project.name, "Thesis");
    assert.equal(project.instructions, "Cite sources in APA.");
    folder = await groups.createGroup("owner", { kind: "folder", mode: "chat", name: "Drafts", parentId: project.id });
    assert.equal(folder.parentId, project.id);
    assert.equal((await groups.listGroups("owner", "chat")).length, 2);
    assert.deepEqual(await groups.listGroups("owner", "study"), []);
    assert.deepEqual(await groups.listGroups("other", "chat"), []);
  });

  await t.test("rejects bad names, nesting, and cross-workspace parents", async () => {
    for (const name of [" ", "x".repeat(81), null]) await assert.rejects(groups.createGroup("owner", { name }), { status: 400 });
    await assert.rejects(groups.createGroup("owner", { kind: "folder", name: "Nested", parentId: folder.id }), { status: 400 });
    await assert.rejects(groups.createGroup("owner", { kind: "folder", mode: "study", name: "Wrong", parentId: project.id }), { status: 400 });
    await assert.rejects(groups.updateGroup("owner", project.id, { parentId: folder.id }), { status: 400 });
    await assert.rejects(groups.updateGroup("owner", folder.id, { instructions: "No" }), { status: 400 });
  });

  await t.test("files chats only into the owner's groups of the same workspace", async () => {
    const moved = await groups.moveConversation("owner", chat.id, folder.id);
    assert.equal(moved.groupId, folder.id);
    await assert.rejects(groups.moveConversation("owner", study.id, folder.id), { status: 400 });
    await assert.rejects(groups.moveConversation("owner", foreign.id, folder.id), { status: 404 });
    await assert.rejects(groups.moveConversation("other", chat.id, null), { status: 404 });
    const stranger = await groups.createGroup("other", { kind: "folder", name: "Theirs" });
    await assert.rejects(groups.moveConversation("owner", chat.id, stranger.id), { status: 404 });
    await assert.rejects(groups.updateGroup("other", project.id, { name: "Stolen" }), { status: 404 });
  });

  await t.test("a chat in a project's folder gets the project's instructions", async () => {
    const found = await groups.projectFor("owner", folder.id);
    assert.equal(found.id, project.id);
    assert.match(projectSystemPrompt(found), /<project-instructions>Cite sources in APA\.<\/project-instructions>/);
    assert.equal(await groups.projectFor("other", folder.id), null);
    assert.equal(projectSystemPrompt(null), "");
  });

  await t.test("deleting a project keeps its chats and removes its folders", async () => {
    const result = await groups.deleteGroup("owner", project.id);
    assert.deepEqual(new Set(result.deleted), new Set([project.id, folder.id]));
    const [kept] = await db.select().from(conversations).where(eq(conversations.id, chat.id));
    assert.equal(kept.title, "Thesis outline");
    assert.equal(kept.groupId, null);
    assert.deepEqual(await groups.listGroups("owner", "chat"), []);
  });
});
