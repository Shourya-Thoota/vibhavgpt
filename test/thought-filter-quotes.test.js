import test from "node:test";
import assert from "node:assert/strict";
import { createMetaThoughtFilter, createPrivateTextIndex, isStrictMeta, stripMetaThoughts } from "../src/chat/thought-filter.js";
import { createThinkingRelay } from "../src/chat/reasoning-stream.js";

// The thinking drawer never quotes the instructions or the user's saved
// facts, and never names the model behind a tier, even one missing from
// PROVIDER_NAME_TERMS: the configured models' own names are protected too.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
const { buildIdentitySystemPrompt } = await import("../src/chat/prompts.js");
const { isSafeFact } = await import("../src/memory/service.js");
const { derivedProviderNameTerms, providerNameTerms } = await import("../src/security/provider-names.js");

const LADDER_FACT = "User operates on a model ladder (locked October 2026): Study on GPT-6 Luna, Nova on DeepSeek V4.1 Flash, Nebula on Kimi K2.6, Vesper on Grok 4.7.";
const NAME_FACT = "User wants to be addressed as Vibhav.";
const PRIVATE = [buildIdentitySystemPrompt("nebula", { query: "What model are you" }), LADDER_FACT, NAME_FACT];
const LEAK = "The user is asking \"What model are you\". " +
  "According to the identity instructions: 'If asked who you are or which model you are, identify yourself as VibhavGPT plus your current assistant name above (for example, VibhavGPT Nova).' " +
  "I am currently operating as VibhavGPT Nebula. " +
  `The saved account facts mention: '${LADDER_FACT}' ` +
  "I should not mention Kimi K2.6 or any provider. " +
  "Also the user wants to be addressed as 'Vibhav'. " +
  "So I'll answer: I'm VibhavGPT Nebula.";

function filtered(chunks, privateText = PRIVATE) {
  const filter = createMetaThoughtFilter({ privateText });
  let out = "";
  for (const chunk of chunks) out += filter.push(chunk);
  return out + filter.flush();
}
const assertAllChunkings = (input, expected, privateText) => {
  assert.equal(filtered([input], privateText), expected, "whole");
  assert.equal(filtered([...input], privateText), expected, "one character at a time");
  for (let cut = 0; cut <= input.length; cut += 9) assert.equal(filtered([input.slice(0, cut), input.slice(cut)], privateText), expected, `split at ${cut}`);
};

test("the reported Nebula thinking is stripped completely and gets no Thought for X s", () => {
  assertAllChunkings(LEAK, "");
  assert.equal(stripMetaThoughts(LEAK, { privateText: PRIVATE }), "");
  // Even with no private text to compare against, the patterns alone catch it.
  assertAllChunkings(LEAK, "", []);

  let clock = 0;
  const deltas = [];
  const relay = createThinkingRelay({ onDelta: (delta) => deltas.push(delta), onStatus: () => {}, privateText: PRIVATE, now: () => clock });
  relay.startCall();
  for (let i = 0; i < LEAK.length; i += 23) relay.reasoning(LEAK.slice(i, i + 23));
  clock = 5_000;
  relay.visible();
  relay.endCall({ answered: true });
  assert.deepEqual(deltas.filter((delta) => typeof delta.reasoning === "string"), []);
  assert.equal(relay.thoughtSeconds, null);
});

test("a sentence quoting the instructions or a saved fact is dropped anywhere, not just at the start", () => {
  const index = createPrivateTextIndex(PRIVATE);
  assert.equal(index.quotes("Recall: never use em dashes or en dashes in replies; use commas."), true);
  assert.equal(index.quotes("Nova on DeepSeek V4.1 Flash, Nebula on Kimi K2.6"), true);
  assert.equal(index.quotes("Let's factor x^2 - 5x + 6."), false);
  // A short fact is matched whole.
  assert.equal(createPrivateTextIndex(["User likes Miles Davis."]).quotes("They said: user likes Miles Davis!"), true);
  assertAllChunkings("Comparing the two options. Keep a simple recall answer: match the length of your reply to what was asked. Option B is cheaper.",
    "Comparing the two options. Option B is cheaper.");
});

test("each new kind of rule or memory recital is recognised", () => {
  for (const sentence of [
    "According to the identity instructions, I am Nebula.", "The persona rules say to be brief.", "Checking the memory guidelines.",
    "I am currently operating as VibhavGPT Nebula.", "I'm running as the Nebula tier.", "So I'll answer: I'm VibhavGPT Nebula.",
    "I should identify myself as VibhavGPT.", "The saved account facts mention a model ladder.", "Saved memory says they study physics.",
    "Also the user wants to be addressed as 'Vibhav'.", "They prefer to be called Sam.",
  ]) assert.equal(isStrictMeta(sentence), true, sentence);
});

test("genuine reasoning is preserved word for word, even with private text present", () => {
  for (const text of [
    "Let's factor the polynomial x^2 - 5x + 6. We need two numbers that multiply to 6 and add to 5: 2 and 3.",
    "**Defining the problem**\nWe need the area of a circle with radius 3.\n**Solving**\nArea = pi r^2 = 9 pi.",
    "Apply the product rule here. The rules of chess allow castling once.",
    "Memory in a computer is measured in bytes. A system of two equations has one solution here.",
  ]) assertAllChunkings(text, text);
});

test("the configured models' and providers' names are protected, our own words are not", () => {
  const source = {
    providerNameTerms: [],
    chatModels: { primaryFree: "openai/gpt-oss-20b", nova: "deepseek/deepseek-v4.1-flash", nebula: "moonshotai/kimi-k2.6", vesper: "x-ai/grok-4.7", gatewayFree: "qwen/qwen3.7-flash:free" },
    providerBaseUrls: { paid: "https://openrouter.ai/api/v1", primaryFree: "https://api.groq.com/openai/v1" },
  };
  const terms = derivedProviderNameTerms(source);
  for (const term of ["openai", "deepseek", "moonshotai", "moonshot", "kimi", "kimi-k2.6", "kimi k2.6", "x-ai", "grok", "grok-4.7", "qwen", "openrouter", "groq"]) assert.ok(terms.includes(term), term);
  for (const term of ["open", "free", "flash", "api", "nova", "nebula", "vesper", "lumen", "vibhavgpt"]) assert.ok(!terms.includes(term), term);
  assert.deepEqual(providerNameTerms({ ...source, providerNameTerms: ["Acme AI"] }).slice(0, 1), ["acme ai"]);
  assert.deepEqual(derivedProviderNameTerms({}), []);
});

test("a saved fact naming the configured models is never sent to the model", async () => {
  const { config } = await import("../src/config.js");
  const saved = { chatModels: config.chatModels };
  config.chatModels = { ...config.chatModels, nova: "deepseek/deepseek-v4.1-flash", nebula: "moonshotai/kimi-k2.6", vesper: "x-ai/grok-4.7" };
  try {
    assert.equal(isSafeFact(LADDER_FACT), false);
    assert.equal(isSafeFact("User studies physics at university."), true);
  } finally {
    config.chatModels = saved.chatModels;
  }
});
