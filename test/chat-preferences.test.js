import assert from "node:assert/strict";
import test from "node:test";
import { buildPreferenceSystemPrompt } from "../src/chat/prompts.js";

test("response style presets produce distinct guidance", () => {
  const concise = buildPreferenceSystemPrompt({ responseStyle: "concise" });
  const detailed = buildPreferenceSystemPrompt({ responseStyle: "detailed" });
  assert.match(concise, /concise and direct/i);
  assert.match(detailed, /thorough, well-structured/i);
  assert.notEqual(concise, detailed);
});

test("active response modes identify themselves to every model", () => {
  const concise = buildPreferenceSystemPrompt({ responseStyle: "concise" });
  const learning = buildPreferenceSystemPrompt({ responseStyle: "friendly" });
  assert.match(concise, /Active response mode: Concise/);
  assert.match(concise, /say "Concise"/);
  assert.match(learning, /Active response mode: Learning/);
  assert.match(learning, /beginner-friendly/i);
});

test("personal instructions are included in the model system prompt", () => {
  const prompt = buildPreferenceSystemPrompt({ responseStyle: "friendly", customInstructions: "Use metric units and call me Vibhav." });
  assert.match(prompt, /warm, approachable, beginner-friendly/i);
  assert.match(prompt, /Use metric units and call me Vibhav\./);
});
