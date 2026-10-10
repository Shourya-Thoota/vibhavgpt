import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
const { documentFormatFromRequest, isDocumentGenerationRequest, structuredToolCalls } = await import("../src/chat/tool-calls.js");
const { buildDocumentPlan, isConversionRequest, parseJsonObject, planFromLastReply } = await import("../src/generation/document-plan.js");

const reply = (content, finish_reason = "stop") => ({ data: { choices: [{ message: { content }, finish_reason }], usage: {} } });
const HISTORY = [
  { role: "user", content: "Explain photosynthesis" },
  { role: "assistant", content: "## Photosynthesis\n\nPlants turn **light** into chemical energy in their leaves.\n\n### Inputs\n- Carbon dioxide\n- Water\n- Light" },
];

test("a Google Docs request is a Word .docx export, and only an actual request", () => {
  for (const text of ["put it in a google docs format", "can you put this in google doc format", "export to gdocs"]) {
    assert.equal(documentFormatFromRequest(text), "docx", text);
    assert.equal(isDocumentGenerationRequest(text), true, text);
  }
  assert.equal(isDocumentGenerationRequest("what is google docs?"), false);
  const call = structuredToolCalls({ choices: [{ message: { tool_calls: [{ function: { name: "generate_document", arguments: JSON.stringify({ format: "google_docs", prompt: "the summary" }) } }] } }] }, "x")[0];
  assert.equal(call.arguments.format, "docx");
});

test("model JSON is accepted with fences, surrounding text, or raw newlines in strings", () => {
  const parsed = parseJsonObject('Here it is:\n```json\n{"title":"T","sections":[{"heading":"H","body":"line one\nline two"}]}\n```\nDone.');
  assert.equal(parsed.sections[0].body, "line one\nline two");
  assert.throws(() => parseJsonObject("no json here"), /no JSON object/);
});

test("converting the last reply makes the file from it directly, with no model call", async () => {
  for (const text of ["put it in a google docs format", "can you put this in google doc format?", "Convert this to a PDF.", "save that as a word doc", "give me your last answer as a pdf"]) {
    assert.equal(isConversionRequest(text), true, text);
  }
  for (const text of ["make a google doc about photosynthesis", "make a word doc", "put this in a pdf but shorter", "Make that a study guide", "make a document with this info: dogs bark"]) {
    assert.equal(isConversionRequest(text), false, text);
  }
  let calls = 0;
  const callModel = async () => { calls += 1; throw new Error("should not be called"); };
  const { plan, usage } = await buildDocumentPlan({ prompt: "put it in a google docs format", format: "docx", history: HISTORY }, { callModel });
  assert.equal(calls, 0);
  assert.deepEqual(usage, {});
  assert.equal(plan.title, "Photosynthesis");
  // A new attachment makes "convert this" mean the file, so the writer runs.
  await buildDocumentPlan({ prompt: "convert this to a pdf", format: "pdf", history: HISTORY, reuseLastReply: false }, { callModel });
  assert.equal(calls, 2);
});

test("a writer that keeps failing falls back to the previous answer instead of erroring", async () => {
  let calls = 0;
  const { plan } = await buildDocumentPlan({ prompt: "make a google doc of our photosynthesis chat", format: "docx", history: HISTORY }, {
    callModel: async () => { calls += 1; throw new Error("provider-invalid-json"); },
  });
  assert.equal(calls, 2);
  assert.equal(plan.title, "Photosynthesis");
  assert.deepEqual(plan.sections.map((section) => section.heading), ["Overview", "Inputs"]);
  assert.match(plan.sections[1].body, /Carbon dioxide/);
  assert.doesNotMatch(plan.sections[0].body, /\*\*/);
});

test("an unreadable review doesn't sink a valid document; an explicit rejection retries", async () => {
  const doc = JSON.stringify({ title: "Photosynthesis", sections: [{ heading: "Overview", body: "Plants turn light into chemical energy using chlorophyll in their leaves." }] });
  let n = 0;
  const unreadable = await buildDocumentPlan({ prompt: "make a word doc about photosynthesis", format: "docx" }, {
    callModel: async () => (n++ % 2 === 0 ? reply(doc) : reply("not json at all")),
  });
  assert.equal(unreadable.plan.title, "Photosynthesis");
  let writes = 0;
  await assert.rejects(buildDocumentPlan({ prompt: "make a word doc", format: "docx" }, {
    callModel: async (_model, messages) => (messages[0].content.startsWith("Review") ? reply('{"valid":false,"reason":"off topic"}') : (writes += 1, reply(doc))),
  }), /could not be generated/);
  assert.equal(writes, 2);
  assert.equal(planFromLastReply([], "x"), null);
});

test("the writer streams without hidden reasoning inside one bounded budget", async () => {
  const plan = readFileSync(new URL("../src/generation/document-plan.js", import.meta.url), "utf8");
  assert.match(plan, /callModel === callModelWithFallback \? callModelStreaming : callModel/);
  assert.match(plan, /reasoning: false, idleTimeoutMs: 25_000/);
  assert.match(plan, /const PLAN_BUDGET_MS = 120_000;/);
  // A slow provider: the second draft is skipped when under 45s remain.
  let clock = 0;
  let writes = 0;
  await assert.rejects(buildDocumentPlan({ prompt: "make a word doc", format: "docx" }, {
    now: () => clock,
    callModel: async () => { writes += 1; clock += 100_000; throw new Error("provider-timeout"); },
  }), /could not be generated/);
  assert.equal(writes, 1);
  const providers = readFileSync(new URL("../src/chat/providers.js", import.meta.url), "utf8");
  assert.match(providers, /if \(timeoutSignal\.aborted \|\| error\?\.name === "TimeoutError" \|\| error\?\.name === "AbortError"\) \{\s*(?:throw new ProviderStageError|throw Object\.assign\(new ProviderStageError)\("provider-timeout"/);
});

test("chat and Study send images to their own vision-capable route", () => {
  const router = readFileSync(new URL("../src/chat/router.js", import.meta.url), "utf8");
  assert.doesNotMatch(router, /readImagesForTextModel|IMAGE_READING_TIERS/);
  assert.match(router, /imageInput: hasImageAttachments\(attachedFiles\)/);
  assert.doesNotMatch(router, /study-documents-only/);
});
