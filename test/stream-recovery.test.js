import assert from "node:assert/strict";
import test from "node:test";
import { interruptedStreamMessage } from "../frontend/src/stream-recovery.js";
test("interrupted code is kept verbatim and clearly marked unsaved and incomplete", () => {
  const text = "Here is the code:\n\n\`\`\`html\n<html>partial";
  // The chat passes the model key the reply was requested from (App.jsx).
  const message = interruptedStreamMessage(text, "vesper");
  assert.equal(message.content, text);
  assert.equal(message.incomplete, true);
  assert.equal(message.fresh, false);
  assert.equal(message.model, "vesper");
  assert.equal(interruptedStreamMessage("  ", "vesper"), null);
});

test("a real interrupted provider stream keeps the already-rendered code rather than replacing it with an error", async () => {
  const { config } = await import("../src/config.js");
  const { callModelStreaming } = await import("../src/chat/providers.js");
  config.chatModels.vesper = "fixture-vesper"; config.providerKeys.paid = "fixture-key";
  let visible = "", partial = null;
  try {
    await callModelStreaming("vesper", [{ role: "user", content: "write code" }], undefined, {
      onDelta: (text) => { visible += text; return true; },
      fetchImpl: async () => new Response([
        { choices: [{ delta: { content: "Here is your code: <html>" } }] },
        { error: { code: 503 } },
      ].map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n').join('')),
    });
    assert.fail("The interrupted stream must fail");
  } catch {
    partial = interruptedStreamMessage(visible, "VibhavGPT Vesper");
  }
  assert.equal(partial.content, "Here is your code: <html>");
  assert.equal(partial.incomplete, true);
});
