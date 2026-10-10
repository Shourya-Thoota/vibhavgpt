import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
const { CHAT_TOOLS, rawToolCalls, structuredToolCalls } = await import("../src/chat/tool-calls.js");
const { MEMORY_TOOL_CATEGORIES, closestFact } = await import("../src/memory/service.js");

const tool = CHAT_TOOLS.find((entry) => entry.function.name === "save_memory");

test("the assistant has a save_memory tool using the import's categories", () => {
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.properties.category.enum, MEMORY_TOOL_CATEGORIES);
  assert.deepEqual(MEMORY_TOOL_CATEGORIES, ["preferences", "profile", "academics", "interests", "recent_work", "tools", "area"]);
  assert.deepEqual(tool.function.parameters.properties.action.enum, ["create", "update"]);
});

test("structured and raw tool calls both carry the memory fields", () => {
  const structured = structuredToolCalls({ choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "save_memory", arguments: JSON.stringify({ action: "create", content: "User prefers metric units.", category: "preferences" }) } }] } }] }, "remember I use metric")[0];
  assert.equal(structured.name, "save_memory");
  assert.equal(structured.arguments.content, "User prefers metric units.");
  assert.equal(structured.arguments.category, "preferences");
  const raw = rawToolCalls('<tool_call>{"name":"remember","arguments":{"action":"update","content":"User lives in Denver.","category":"profile","replaces":"User lives in Boston."}}</tool_call>', "x")[0];
  assert.equal(raw.name, "save_memory");
  assert.equal(raw.arguments.action, "update");
  assert.equal(raw.arguments.replaces, "User lives in Boston.");
});

test("updates find the memory being changed, and only a real match", () => {
  const facts = [{ id: "a", content: "User lives in Boston." }, { id: "b", content: "User prefers concise answers." }];
  assert.equal(closestFact(facts, "User lives in Boston.").id, "a");
  assert.equal(closestFact(facts, "lives in Boston").id, "a");
  assert.equal(closestFact(facts, "User owns a cat."), null);
});

test("after saving, the assistant is told to confirm what it saved in plain words", async () => {
  const source = readFileSync(new URL("../src/chat/router.js", import.meta.url), "utf8");
  assert.match(source, /Saved to the user's memory under \$\{result\.label\}/);
  assert.match(source, /Don't tell them you can't, and don't send them to the Memory page to do it\./);
  assert.match(source, /extractAndSaveFacts\(userId, content, memoryWrites\.length \? await getFacts\(userId\) : facts\)/);
  // The read path is unchanged: the same memory prompt, built the same way.
  assert.match(source, /const memorySystemPrompt = buildMemorySystemPrompt\(baseSystemPrompt, facts\);/);
  assert.doesNotMatch(source.match(/function memoryToolResult[\s\S]*?\r?\n}\r?\n/)[0], /\u2014|\u2013/);
});
