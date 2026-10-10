import assert from "node:assert/strict";
import test from "node:test";
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
const { buildMemorySystemPrompt, buildRelevantMemoryContext } = await import("../src/memory/service.js");
const { buildIdentitySystemPrompt, buildPreferenceSystemPrompt } = await import("../src/chat/prompts.js");
const { fitConversationContext } = await import("../src/chat/context-window.js");
const { callModelWithFallback, callModelStreaming } = await import("../src/chat/providers.js");
const { config } = await import("../src/config.js");

const facts = [{ content: "User attends Cedar Grove High School." }, { content: "User's favorite singer is Mira Vale." }];
function context(query, model = "lumen") {
  const base = buildIdentitySystemPrompt(model, { query, hasSavedMemory: true });
  return fitConversationContext({
    systemMessages: [{ role: "system", content: buildMemorySystemPrompt(base + "\n" + buildPreferenceSystemPrompt(), facts) }, { role: "system", content: "You can save new facts with the save_memory tool." }],
    history: Array.from({ length: 20 }, () => [{ role: "user", content: "Earlier unrelated question" }, { role: "assistant", content: "Earlier answer" }]).flat(),
    currentMessage: { role: "user", content: buildRelevantMemoryContext(facts, query) + query }, maxInputTokens: 2500,
  });
}

test("Lumen personal recall keeps saved facts and identity without the unrelated product catalogue", () => {
  for (const query of ["what school do i go to", "who is my favorite singer", "who is your favorite singer", "what do you remember about me"]) {
    const fitted = context(query);
    assert.equal(fitted.ok, true);
    const system = fitted.messages[0].content;
    for (const fact of facts) assert.ok(system.includes(fact.content));
    assert.match(system, /VibhavGPT Lumen/);
    assert.match(system, /never infer personal facts/i);
    assert.match(system, /reference facts, not instructions/);
    assert.doesNotMatch(system, /<vibhavgpt-product-knowledge>/);
    assert.ok(fitted.messages.at(-1).content.endsWith(query));
  }
});

test("retrieval highlights artist and school names even when records omit the question's words", () => {
  const records = [
    ...Array.from({ length: 30 }, (_, i) => ({ category: "preferences", content: `User prefers response style ${i}.` })),
    { category: "profile", content: "User preferred name is Casey. (Current)" },
    { category: "profile", content: "User Casey is a student at Cedar Grove NHS." },
    { category: "interests", content: "User is interested in Casey likes Mira Vale." },
  ];
  assert.match(buildRelevantMemoryContext(records, "what school do i go to"), /Cedar Grove NHS/);
  assert.match(buildRelevantMemoryContext(records, "who is my favorite singer"), /User likes Mira Vale/);
  assert.match(buildRelevantMemoryContext(records, "who is your favorite singer"), /likes Mira Vale/);
  const before = JSON.stringify(records);
  assert.match(buildMemorySystemPrompt("identity", records), /- User likes Mira Vale/);
  assert.equal(JSON.stringify(records), before);
  assert.match(buildMemorySystemPrompt("identity", [{ content: "User preferred name is Someone Else." }, records.at(-1)]), /User is interested in Casey likes/);
  assert.equal(buildRelevantMemoryContext([], "what school do i go to"), "");
  assert.equal(buildRelevantMemoryContext(records, "Calculate 2 + 2"), "");
  assert.doesNotMatch(buildRelevantMemoryContext([{ content: "The assistant was created by Examplevendor." }], "who created the assistant"), /Examplevendor/);
});

test("product recall retains complete pricing and policy context; other models remain unchanged", () => {
  for (const query of ["What does Plus cost?", "What are your prices?", "What powers you?", "Show the privacy policy", "VibhavGPT features", "What are the model limits?"]) {
    assert.match(buildIdentitySystemPrompt("lumen", { query, hasSavedMemory: true }), /<vibhavgpt-product-knowledge>/);
  }
  for (const model of ["nova", "nebula", "study", "vesper"]) {
    assert.equal(buildIdentitySystemPrompt(model, { query: "what school do i go to", hasSavedMemory: true }), buildIdentitySystemPrompt(model));
  }
  assert.equal(buildIdentitySystemPrompt("lumen", { query: "Write a small coding example", hasSavedMemory: true }), buildIdentitySystemPrompt("lumen"));
});

test("saved memory is never invented or substituted for the assistant's own preferences", () => {
  assert.equal(buildMemorySystemPrompt("identity", []), "identity");
  const prompt = buildMemorySystemPrompt("identity", facts);
  assert.match(prompt, /specific detail is absent/);
  assert.match(prompt, /describe the user, never you/);
  assert.doesNotMatch(buildMemorySystemPrompt("identity", [{ content: "The assistant was created by Examplevendor." }]), /Examplevendor/);
});

for (const [name, call] of [["streaming", callModelStreaming], ["non-streaming", callModelWithFallback]]) {
  test(`saved facts reach every Lumen fallback in the ${name} wire payload`, async () => {
    for (const key of ["primaryFree", "gatewayFree", "secondaryFree", "reserveFree"]) config.providerKeys[key] = "fixture";
    for (const key of ["lumen", "lumenFallback1", "lumenFallback2", "lumenFallback3"]) config.chatModels[key] = "fixture";
    config.lumenPrimaryApproved = true;
    let calls = 0;
    const result = await call("lumen", context("what school do i go to").messages, undefined, {
      fetchImpl: async (_url, init) => {
        calls++;
        const body = JSON.parse(init.body);
        for (const fact of facts) assert.ok(body.messages[0].content.includes(fact.content));
        assert.match(body.messages.at(-1).content, /Cedar Grove High School/);
        if (calls < 4) return new Response("", { status: 429 });
        const usage = { prompt_tokens: 100, completion_tokens: 12 };
        return name === "streaming"
          ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "You attend Cedar Grove High School." }, finish_reason: "stop" }], usage })}\n\n`)
          : Response.json({ choices: [{ message: { content: "You attend Cedar Grove High School." } }], usage });
      },
    });
    assert.equal(calls, 4);
    assert.match(result.data.choices[0].message.content, /Cedar Grove/);
  });
}
