import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("deleting a chat removes its stored files after the rows are deleted", () => {
  const repo = read("../src/chat/repository.js");
  assert.match(repo, /import \{ removeFiles \} from "\.\.\/uploads\/service\.js";/);
  assert.match(repo, /eq\(attachments\.conversationId, conversationId\), eq\(attachments\.userId, userId\)/);
  assert.match(repo, /if \(deleted\.length && files\.length\) await removeFiles\(files\);/);
});

test("memory can be switched off and cleared, and chat honours the switch", () => {
  const router = read("../src/memory/router.js");
  assert.match(router, /memoryRouter\.put\("\/settings"/);
  assert.match(router, /memoryRouter\.delete\("\/"/);
  const migration = read("../drizzle/0022_memory_enabled.sql");
  assert.match(migration, /"memory_enabled" boolean DEFAULT true NOT NULL/);
  const chat = read("../src/chat/router.js");
  assert.match(chat, /memoryEnabled: userProfiles\.memoryEnabled/);
  assert.match(chat, /const recapFacts = memoryEnabled && recapIds\.length/);
  assert.match(chat, /const facts = memoryEnabled \? await getFacts\(userId\) : \[\];/);
  assert.match(chat, /memoryEnabled \|\| tool\.function\.name !== "save_memory"/);
  assert.match(chat, /if \(memoryEnabled\) \{\s*void \(async \(\) => extractAndSaveFacts/);
});

test("the admin dashboard is gone: route, page, link and endpoint", () => {
  assert.equal(existsSync(new URL("../src/admin/router.js", import.meta.url)), false);
  assert.doesNotMatch(read("../src/server.js"), /adminRouter|\/api\/admin/);
  const app = read("../frontend/src/App.jsx");
  assert.doesNotMatch(app, /function Admin\(|\/api\/admin|isAdmin|page === "admin"/);
  assert.doesNotMatch(read("../frontend/src/components/Sidebar.jsx"), /isAdmin|LayoutDashboard|"admin"/);
});

test("Memory Edit and Delete are visible without hovering", () => {
  const css = read("../frontend/src/styles.css");
  assert.match(css, /\.memory-fact \.fact__actions \{ flex: 0 0 auto; \}/);
  assert.doesNotMatch(css, /\.memory-fact:hover \.fact__actions/);
});
