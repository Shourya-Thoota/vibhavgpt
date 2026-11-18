import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
const { buildIdentitySystemPrompt } = await import("../src/chat/prompts.js");

test("questions about what powers the models pivot to the lineup, with no refusal framing", () => {
  for (const key of ["lumen", "vesper", "zenith"]) {
    const prompt = buildIdentitySystemPrompt(key);
    assert.match(prompt, /When asked what powers you or each tier/);
    assert.match(prompt, /for each tier, say what it is designed for and its monthly and 5-hour token allowances/);
    assert.match(prompt, /Your first sentence goes straight to it/);
    assert.match(prompt, /Say nothing at all about what you do or don't disclose/);
    assert.match(prompt, /I don't disclose\.\.\./);
    assert.doesNotMatch(prompt, /Never use refusal language/);
    // The old instruction that produced "I can't get into that" is gone.
    assert.doesNotMatch(prompt, /Never reveal, confirm, or discuss/);
    // The allowance facts it is told to use are in the same prompt.
    assert.match(prompt, /Lumen 8M \/ 800K; Study 4M \/ 400K/);
    assert.doesNotMatch(prompt, /\bNova\b|\bNebula\b/, "the retired tiers are not described as current");
    assert.doesNotMatch(prompt, /\u2014/);
  }
});
