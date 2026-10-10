// Uses real model inference and the application's actual planner/exporter.
// Only quota persistence is simulated; no user/database records are changed.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { buildDocumentPlan } from "../src/generation/document-plan.js";
import { generateDocument, renderDocument } from "../src/generation/service.js";

const output = path.resolve(process.argv[2] || "../document-content-verification");
await mkdir(output, { recursive: true });
const cases = [
  { name: "earth-science-study-guide", prompt: "Make me a clear 450-word New York Earth and Space Sciences study guide about topographic maps, contour intervals, and gradient. Include a worked gradient example, three practice questions and an answer key. Explain the ideas in coherent plain English. Do not claim to reproduce the official exam." },
  { name: "library-pilot-report", prompt: "Write a coherent 350-word report for a library manager about a four-week extended-hours pilot. Supplied data: 120 visits in week 1, 135 in week 2, 150 in week 3, 155 in week 4; operating cost $800 total. Calculate total visits and cost per visit, discuss limitations and recommend next steps. Do not invent survey results or pretend these data prove causation." },
  { name: "field-trip-checklist", prompt: "Create a practical school geology field-trip checklist of 15 concrete actions grouped into Before departure, In the field, and Before returning. Include safety, equipment, observation notes and cleanup. Add a short introduction. Use concise actionable language and numbered items, around 200 words." },
];
const compact = (value) => value.normalize("NFKC").replace(/\s+/g, "").replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
const report = [];
for (const item of cases) {
  const attempts = [];
  let writtenPlan, meteredUsage;
  const result = await generateDocument({ userId: "local-content-verification", prompt: item.prompt, format: "pdf" }, {
    reserve: async () => ({ id: "local-only", creditReservationId: null }),
    finalize: async (_id, usage) => { meteredUsage = usage; },
    cancel: async () => {},
    buildPlan: async (input) => {
      const generated = await buildDocumentPlan(input, { onAttempt: (record) => {
        attempts.push(record);
        console.log(JSON.stringify({ case: item.name, stage: record.stage || "writer", finishReason: record.finishReason }));
      } });
      writtenPlan = generated.plan;
      return generated;
    },
  });
  const pdfPath = path.join(output, `${item.name}.pdf`);
  await writeFile(pdfPath, result.buffer);
  const parser = new PDFParse({ data: result.buffer });
  const pdf = await parser.getText();
  // Compare page content, not pdf-parse's synthetic "-- n of total --" separators.
  const pdfText = pdf.pages.map((page) => page.text).join("\n");
  await parser.destroy();
  const docx = await renderDocument({ format: "docx", plan: writtenPlan });
  const word = await mammoth.extractRawText({ buffer: docx.buffer });
  await writeFile(path.join(output, `${item.name}.docx`), docx.buffer);
  const md = await renderDocument({ format: "md", plan: writtenPlan });
  await writeFile(path.join(output, `${item.name}.md`), md.buffer);
  const extraFormats = {};
  for (const format of ["txt", "csv", "json", "html"]) {
    const extra = await renderDocument({ format, plan: writtenPlan });
    await writeFile(path.join(output, `${item.name}${extra.extension}`), extra.buffer);
    extraFormats[format] = { extension: extra.extension, mimeType: extra.mimeType, bytes: extra.buffer.byteLength };
  }
  for (const text of [writtenPlan.title, ...writtenPlan.sections.flatMap((section) => [section.heading, section.body])]) {
    assert.ok(compact(pdfText).includes(compact(text)), `PDF lost/corrupted content in ${item.name}: ${text.slice(0, 70)}`);
    assert.ok(compact(word.value).includes(compact(text)), `DOCX lost/corrupted content in ${item.name}`);
    assert.ok(md.buffer.toString("utf8").includes(text), `Markdown lost content in ${item.name}`);
  }
  const record = { ...item, attempts, plan: writtenPlan, usage: meteredUsage, pdfPages: pdf.total, extractedPdfText: pdf.text, extractedDocxText: word.value, extraFormats, contentRoundTrip: "passed" };
  report.push(record);
  await writeFile(path.join(output, "verification.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ file: pdfPath, pages: pdf.total, title: writtenPlan.title, sections: writtenPlan.sections.length, contentRoundTrip: "passed", usage: meteredUsage }));
}
