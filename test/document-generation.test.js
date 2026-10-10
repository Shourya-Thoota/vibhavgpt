import test from "node:test";
import assert from "node:assert/strict";
import { buildDocumentPlan, validateDocumentPlan } from "../src/generation/document-plan.js";
import { documentFilename } from "../src/generation/document-filename.js";
import { readFile } from "node:fs/promises";

async function generationService() {
  process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
  const { config } = await import("../src/config.js");
  config.databaseUrl ||= process.env.DATABASE_URL;
  return import("../src/generation/service.js");
}

const plan = { title: "Earth and Space Sciences Study Guide", sections: [{ heading: "Contour intervals", body: "A contour interval is the change in elevation between adjacent contour lines. Closely spaced contour lines indicate a steep slope." }] };
const response = (value, finish_reason = "stop") => ({ data: { choices: [{ finish_reason, message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.001 } } });

test("document filenames use short filesystem-safe titles and topic fallbacks", () => {
  assert.equal(documentFilename(plan), "earth-and-space-sciences-study-guide.docx");
  assert.equal(documentFilename({ title: "../Résumé: Solar Energy / 2026?" }), "resume-solar-energy-2026.docx");
  assert.equal(documentFilename({ title: "CON" }), "document-con.docx");
  const longName = documentFilename({ title: "Long topic ".repeat(30) });
  assert.match(longName, /^[a-z0-9]+(?:-[a-z0-9]+)*\.docx$/);
  assert.ok(longName.length <= 85);
  assert.equal(documentFilename({ title: "Overview", sections: [{ heading: "Contour Maps" }] }), "contour-maps.docx");
  assert.equal(documentFilename({ title: "Document" }, "Create a Word document about photosynthesis"), "photosynthesis.docx");
  assert.equal(documentFilename({ title: "???" }, "save it as a word doc"), "vibhavgpt-document.docx");
  assert.equal(documentFilename(null), "vibhavgpt-document.docx");
});

test("shared generation returns the title filename for Chat, Study and document attachments", async () => {
  const { generateDocument } = await generationService();
  const generated = await generateDocument({ userId: "test", format: "docx", prompt: "Make a study guide" }, {
    reserve: async () => ({ id: "usage" }),
    buildPlan: async () => ({ plan, usage: {} }),
    finalize: async () => {},
  });
  assert.equal(generated.filename, "earth-and-space-sciences-study-guide.docx");
  assert.equal(generated.buffer.subarray(0, 2).toString(), "PK");
  for (const [file, result] of [["../src/chat/router.js", "generated"], ["../src/generation/router.js", "rendered"]]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, new RegExp(`originalName: ${result}\\.filename`));
    assert.doesNotMatch(source, /vibhavgpt-document/);
  }
});

test("plans preserve readable titles and reject missing, coerced, clipped or prompt-only content", () => {
  assert.deepEqual(validateDocumentPlan(plan), plan);
  for (const value of [undefined, { title: "Guide", sections: [] }, { ...plan, sections: [{ heading: "A", body: {} }] },
    { ...plan, sections: [{ heading: "A", body: "a".repeat(20001) }] }]) assert.throws(() => validateDocumentPlan(value));
  assert.throws(() => validateDocumentPlan(plan, plan.sections[0].body));
});

test("additional safe text formats serialize the reviewed content without filename-style corruption", async () => {
  const { renderDocument } = await generationService();
  const formats = ["txt", "csv", "json", "html"];
  for (const format of formats) {
    const rendered = await renderDocument({ format, plan });
    assert.match(rendered.buffer.toString("utf8"), /Contour intervals/);
  }
  assert.equal((await renderDocument({ format: "txt", plan })).extension, ".txt");
  assert.equal((await renderDocument({ format: "csv", plan })).mimeType, "text/csv");
});

test("writer receives conversation and document context and requires a coherent reviewed plan", async () => {
  const calls = [];
  const result = await buildDocumentPlan({ prompt: "Make that a study guide", format: "pdf", history: [{ role: "user", content: "Study contour maps" }], sourceContext: "A is 100 m; B is 200 m." }, {
    callModel: async (_model, messages) => { calls.push(messages); return calls.length === 1 ? response(plan) : response({ valid: true }); },
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0][1].content, /Study contour maps/);
  assert.match(calls[0][1].content, /A is 100 m/);
  assert.equal(result.usage.prompt_tokens, 20);
  assert.equal(result.usage.cost, 0.002);
});

test("truncated generation retries as a fresh whole plan, never exports partial text", async () => {
  let calls = 0;
  const result = await buildDocumentPlan({ prompt: "Study guide", format: "docx" }, {
    callModel: async () => ++calls === 1 ? response(plan, "length") : calls === 2 ? response(plan) : response({ valid: true }),
  });
  assert.equal(calls, 3);
  assert.deepEqual(result.plan, plan);
});

test("incoherent model output cannot become a successful file", async () => {
  let calls = 0;
  await assert.rejects(buildDocumentPlan({ prompt: "Study guide", format: "pdf" }, {
    callModel: async () => ++calls % 2 ? response(plan) : response({ valid: false, reason: "Unrelated content" }),
  }), /could not be generated completely/);
  assert.equal(calls, 4);
});

test("failed document generation refunds its reservation and does not finalize usage", async () => {
  const { generateDocument } = await generationService();
  const events = [];
  await assert.rejects(generateDocument({ userId: "test", prompt: "Study guide", format: "pdf" }, {
    reserve: async () => ({ id: "usage", creditReservationId: "credit" }),
    buildPlan: async () => { throw new Error("malformed output"); },
    render: async () => { events.push("render"); },
    finalize: async () => { events.push("finalize"); },
    cancel: async (...ids) => { events.push(ids); },
  }), /malformed output/);
  assert.deepEqual(events, [["usage", "credit"]]);
});
