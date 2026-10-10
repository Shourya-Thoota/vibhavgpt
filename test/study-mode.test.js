import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { studyPrompt, isStudyQuickAction } from "../src/chat/study.js";
import { productModeFromPath, productPath, STUDY_ACTIONS } from "../frontend/src/product-modes.js";
import { normalizeTexDelimiters, protectPlainDollarSigns } from "../frontend/src/markdown.js";
test("worked examples render TeX delimiters without rewriting code or currency", () => {
  assert.equal(normalizeTexDelimiters("\\[18 \\div 2 = 9\\]"), "$18 \\div 2 = 9$");
  assert.equal(normalizeTexDelimiters("`\\(code\\)`"), "`\\(code\\)`");
  assert.equal(protectPlainDollarSigns(normalizeTexDelimiters("$4.99 or $12.99")), "\\$4.99 or \\$12.99");
});
test("Study routes round-trip without changing conversation identity", () => {
  assert.equal(productModeFromPath("/app/study"), "study");
  assert.equal(productModeFromPath("/app"), "chat");
  assert.equal(productPath("study", "abc"), "/app/study?conversation=abc");
  assert.equal(productPath("chat"), "/app/chat");
});
test("Study instructions are server-side, source-grounded, and absent from normal chat", () => {
  assert.equal(studyPrompt("chat"), "");
  assert.equal(studyPrompt("image"), "");
  assert.match(studyPrompt("study"), /wait for the learner/);
  assert.match(studyPrompt("study"), /Never invent/);
  const router = readFileSync(new URL("../src/chat/router.js", import.meta.url), "utf8");
  assert.match(router, /conversationMode = existing.conversation.mode/);
  assert.match(router, /studyPrompt\(conversationMode\)/);
});
test("Each study quick action has a distinct useful prompt", () => {
  assert.equal(STUDY_ACTIONS.length, 5);
  assert.equal(new Set(STUDY_ACTIONS.map((a) => a.prompt)).size, 5);
  assert.match(STUDY_ACTIONS.find((a) => a.label === "Quiz me").prompt, /wait for my answer/);
  assert.equal(isStudyQuickAction("study", "Make flashcards"), true);
  assert.equal(isStudyQuickAction("chat", "Make flashcards"), false);
  assert.equal(isStudyQuickAction("study", "unknown"), false);
});
test("Study documents are excluded from unattached-file cleanup", () => {
  const service = readFileSync(new URL("../src/uploads/service.js", import.meta.url), "utf8");
  assert.match(service, /isNull\(attachments.messageId\), isNull\(attachments.conversationId\)/);
});

test("the shared exchange path persists Study mode on creation and preserves mode on later turns", async (t) => {
  process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
  const { db } = await import("../src/db/client.js");
  const { saveExchange } = await import("../src/chat/repository.js");
  const inserts = [];
  const updates = [];
  const transaction = {
    insert: () => ({ values: (value) => {
      inserts.push(value);
      return { returning: async () => Array.isArray(value) ? [{ id: "user", role: "user" }, { id: "reply", role: "assistant" }] : [{ id: "study-conversation" }] };
    } }),
    update: () => ({ set: (value) => { updates.push(value); return { where: async () => [] }; } }),
  };
  t.mock.method(db, "transaction", async (fn) => fn(transaction));
  const exchange = { userId: "test", modelKey: "lumen", userContent: "Explain atoms", reply: "Let's work through it.", mode: "study" };
  const first = await saveExchange(exchange);
  assert.equal(first.conversationId, "study-conversation");
  assert.equal(inserts[0].mode, "study");
  await saveExchange({ ...exchange, conversationId: first.conversationId, mode: "chat" });
  assert.equal(Object.hasOwn(updates[0], "mode"), false);
});
