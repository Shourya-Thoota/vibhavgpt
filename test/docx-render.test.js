import test from "node:test";
import assert from "node:assert/strict";
// jszip arrives with the docx package, which uses it to write the file.
import JSZip from "jszip";
import { renderDocx } from "../src/generation/docx-render.js";

const plan = {
  title: "Cellular Respiration Study Guide",
  sections: [
    { heading: "The three stages", body: "1. Glycolysis\n2. Krebs cycle\n\nKey terms:\n- ATP: energy currency\n  - nested detail\n\n3. Kept as written\n4. Also kept" },
    { heading: "Practice", body: "Answer: In the cytoplasm.\nA plain **bold** line." },
  ],
};

test("a document plan becomes a styled Word file", async () => {
  const zip = await JSZip.loadAsync(await renderDocx(plan, { date: new Date("2026-10-04T12:00:00Z") }));
  const body = await zip.file("word/document.xml").async("string");
  const styles = await zip.file("word/styles.xml").async("string");
  const numbering = await zip.file("word/numbering.xml").async("string");

  assert.match(body, /w:pStyle w:val="Title"/);
  assert.match(body, /October 4, 2026/);
  assert.match(body, /w:pStyle w:val="Heading1"/);
  assert.match(body, /w:pStyle w:val="VibhavSubheading"/, "a short line ending in a colon is a subheading");
  assert.match(styles, /Georgia/);
  assert.match(styles, /Calibri/);
  assert.match(numbering, /w:lvlText w:val="%1\."/);
  // A numbered list that starts above 1 keeps the author's numbers as text.
  assert.match(body, />3\.\t</);
  // Bullet levels: a two-space indent is a nested item.
  assert.match(body, /<w:ilvl w:val="1"\/>/);
  // Labels and **bold** become bold runs, never literal asterisks.
  assert.doesNotMatch(body, /\*\*/);
  assert.match(body, /<w:b\/>[\s\S]*?Answer: /);
  // US Letter, numbered pages, and a running header after page one.
  assert.match(body, /w:w="12240" w:h="15840"/);
  assert.match(body, /<w:titlePg\/>/);
  const footers = await Promise.all(Object.keys(zip.files).filter((name) => /word\/footer\d*\.xml/.test(name)).map((name) => zip.file(name).async("string")));
  assert.ok(footers.some((xml) => /NUMPAGES/.test(xml)));
});
