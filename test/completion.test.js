import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
process.env.BETTER_AUTH_SECRET = "a".repeat(48);

const { buildActivitySummary, buildStructuredToolExchange, completeResponse, normalizeModelKey, visibleReply } = await import("../src/chat/router.js");
const { assistantMessageMetadata, messageActivityMetadata } = await import("../src/chat/repository.js");

test("Vesper is normalized as Vesper instead of falling back to Lumen", () => {
  assert.equal(normalizeModelKey("vesper"), "vesper");
});

test("Lumen is canonical and the legacy Spark key normalizes to it", () => {
  for (const key of [undefined, "lumen", "spark", "SPARK"]) assert.equal(normalizeModelKey(key), "lumen");
  assert.equal(normalizeModelKey("nova"), "nova");
});

test("the retired qwen key gets the same Lumen fallback as any unknown key a client sends", () => {
  for (const key of ["qwen", "QWEN", "not-a-model", ""]) assert.equal(normalizeModelKey(key), "lumen");
});

test("a token-limit response is rewritten before it can reach the chat", async () => {
  const calls = [];
  const result = await completeResponse(
    "lumen",
    [{ role: "user", content: "Give me a long answer" }],
    { choices: [{ message: { content: "1. A partial list item" }, finish_reason: "length" }], usage: { total_tokens: 10 } },
    {
      callModel: async (_model, messages, _tools, options) => {
        calls.push({ messages, options });
        return { data: { choices: [{ message: { content: "A concise complete answer." }, finish_reason: "stop" }], usage: { total_tokens: 5 } } };
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.maxTokens, 4096);
  assert.match(calls[0].messages.at(-1).content, /Rewrite the answer/i);
  assert.equal(result.choices[0].message.content, "A concise complete answer.");
  assert.equal(result.usage.total_tokens, 15);
});

test("cut-off code rewrites expand their budget but stop after two accounted attempts", async () => {
  const budgets = [];
  await assert.rejects(completeResponse("nebula", [{ role: "user", content: "Write a small HTML game" }],
    { choices: [{ message: { content: "<html>partial" }, finish_reason: "length" }], usage: { total_tokens: 2048 } },
    { providerOptions: { maxTokens: 2048 }, callModel: async (_model, _messages, _tools, options) => {
      budgets.push(options.maxTokens);
      return { data: { choices: [{ message: { content: "still partial" }, finish_reason: "length" }], usage: { total_tokens: options.maxTokens } } };
    } }), (error) => error.code === "completion-token-limit");
  assert.deepEqual(budgets, [4096, 8192]);
});

test("tool artifacts and punctuation-only replies never become visible messages", () => {
  assert.equal(visibleReply('<tool_call> function=search> </function> </tool_call> "'), "");
  assert.equal(visibleReply('"'), "");
  assert.equal(visibleReply("A real response."), "A real response.");
});

test("structured tool history contains only the executed call and a matching result id", () => {
  const history = buildStructuredToolExchange({
    id: "call-weather-1",
    name: "weather",
    originalName: "weather",
    arguments: { location: "Boston", unexpected: "discarded" },
  }, "weather", "Sunny, 72 F");
  assert.equal(history.length, 2);
  assert.deepEqual(history[0].tool_calls.map((call) => call.id), ["call-weather-1"]);
  assert.equal(history[1].tool_call_id, history[0].tool_calls[0].id);
  assert.deepEqual(JSON.parse(history[0].tool_calls[0].function.arguments), { location: "Boston" });
  assert.equal(history[1].content, "Sunny, 72 F");
});

test("Google tool follow-ups preserve the opaque signature and exact signed arguments", () => {
  const raw = { id: "signed-weather", function: { name: "weather", arguments: '{ "location": "London" }' }, extra_content: { google: { thought_signature: "opaque-signature" } } };
  const history = buildStructuredToolExchange({ id: raw.id, name: "weather", arguments: { location: "London" }, raw }, "weather", "Sunny");
  assert.equal(history[0].tool_calls[0].function.arguments, raw.function.arguments);
  assert.deepEqual(history[0].tool_calls[0].extra_content, raw.extra_content);
  assert.equal(history[1].tool_call_id, raw.id);
});

test("completed-message activity summaries describe only safe, observable work", () => {
  assert.deepEqual(
    buildActivitySummary({ query: "Find the latest answer", actions: { attachedDocuments: true, webSearch: true, currentSources: true, currentTime: true } }),
    ["Reviewed attached documents", "Searched the web", "Reviewed current sources", "Checked the current date and time", "Prepared response"],
  );
  assert.deepEqual(buildActivitySummary({ query: "Create an image", actions: { imageGenerated: true } }), ["Created the requested image"]);
});

test("activity summaries persist with a completed message alongside sources", () => {
  const metadata = assistantMessageMetadata({
    sources: [{ title: "NASA", url: "https://www.nasa.gov/" }],
    activitySummary: ["Searched the web", "Prepared response"],
  });
  assert.deepEqual(messageActivityMetadata(metadata), {
    sources: [{ title: "NASA", url: "https://www.nasa.gov/" }],
    activitySummary: ["Searched the web", "Prepared response"],
  });
});

test("code requests start with a larger bounded output budget without changing effort levels", async () => {
  const { responseTokenBudget } = await import("../src/chat/router.js");
  assert.equal(responseTokenBudget("normal", "can you give me the code for a small html pacman game"), 4096);
  assert.equal(responseTokenBudget("normal", "What is 2 + 2?"), 2048);
  assert.equal(responseTokenBudget("high", "hello"), 4096);
  assert.equal(responseTokenBudget("max", "write code"), 8192);
});
