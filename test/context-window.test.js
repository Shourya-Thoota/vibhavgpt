import assert from "node:assert/strict";
import test from "node:test";
import { estimateChatMessageTokens, fitConversationContext } from "../src/chat/context-window.js";

test("long histories stay inside budget and preserve the latest exchange", () => {
  const history = Array.from({ length: 30 }, (_, index) => [
    { role: "user", content: `Question ${index}: ${"older context ".repeat(20)}` },
    { role: "assistant", content: `Answer ${index}: ${"previous answer ".repeat(20)}` },
  ]).flat();
  const result = fitConversationContext({
    systemMessages: [{ role: "system", content: "Be helpful." }],
    history,
    currentMessage: { role: "user", content: "What did we conclude most recently?" },
    maxInputTokens: 1_100,
  });

  assert.equal(result.ok, true);
  assert.ok(result.estimatedTokens <= 1_100);
  assert.deepEqual(result.messages.at(-1), { role: "user", content: "What did we conclude most recently?" });
  assert.ok(result.historySummarized);
  assert.ok(result.keptHistoryMessages < history.length);
});

test("five- and ten-exchange conversations retain their complete recent context", () => {
  for (const exchangeCount of [5, 10]) {
    const history = Array.from({ length: exchangeCount }, (_, index) => [
      { role: "user", content: `Question ${index}` },
      { role: "assistant", content: `Answer ${index}` },
    ]).flat();
    const result = fitConversationContext({ history, currentMessage: { role: "user", content: "Follow up" } });
    assert.equal(result.ok, true);
    assert.equal(result.keptHistoryMessages, history.length);
    assert.equal(result.historySummarized, false);
  }
});

test("saved history is normalized so orphan tool calls and tool messages are excluded", () => {
  const result = fitConversationContext({
    history: [
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer", tool_calls: [{ id: "orphan" }] },
      { role: "tool", tool_call_id: "missing", content: "orphan tool result" },
    ],
    currentMessage: { role: "user", content: "Continue" },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.messages.map(({ role, content }) => [role, content]), [
    ["user", "Earlier question"],
    ["assistant", "Earlier answer"],
    ["user", "Continue"],
  ]);
  assert.equal("tool_calls" in result.messages[1], false);
});

test("image payload estimates do not count base64 bytes as text tokens", () => {
  const small = estimateChatMessageTokens({ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] });
  const large = estimateChatMessageTokens({ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(1_000_000)}` } }] });
  assert.equal(small, large);
  assert.equal(small, 4_104);
});

test("an oversized current request gets a clear size result rather than silently dropping it", () => {
  const result = fitConversationContext({
    systemMessages: [{ role: "system", content: "Important instruction" }],
    currentMessage: { role: "user", content: "Do not discard this. ".repeat(400) },
    maxInputTokens: 100,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "current-turn-too-large");
});
