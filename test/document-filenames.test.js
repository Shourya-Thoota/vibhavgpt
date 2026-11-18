process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";

import test from "node:test";
import assert from "node:assert/strict";

// Every generated file is named for what it is. An explicit name from the person wins; otherwise the document's own title; otherwise its
// subject from the request; and only when none of those say anything is the plain fallback used. The extension always matches the real file.

const { documentFilename, artifactFilename, requestedFilename, FILENAME_FALLBACK } = await import("../src/generation/document-filename.js");
const { generateDocument } = await import("../src/generation/service.js");

const FORMATS = { pdf: ".pdf", docx: ".docx", pptx: ".pptx", md: ".md", txt: ".txt", csv: ".csv", json: ".json", html: ".html" };

test("the document's own title names the file, for every supported format", () => {
  for (const [, extension] of Object.entries(FORMATS)) {
    assert.equal(artifactFilename({ plan: { title: "Biology Revision Guide" }, extension }), `biology-revision-guide${extension}`);
  }
});

test("an explicit name from the person wins over the title, and keeps the real extension", () => {
  assert.equal(artifactFilename({ plan: { title: "Photosynthesis" }, prompt: "make a pdf about plants and call it Plant Notes", extension: ".pdf" }), "plant-notes.pdf");
  assert.equal(artifactFilename({ plan: { title: "Photosynthesis" }, prompt: "create a word doc named lab-report-3.docx", extension: ".docx" }), "lab-report-3.docx");
  // The person typed .pdf but the file is a deck: the name is theirs, the extension is the truth.
  assert.equal(artifactFilename({ plan: { title: "X" }, prompt: "make slides, save as quarterly.pdf", extension: ".pptx" }), "quarterly.pptx");
  assert.equal(artifactFilename({ plan: { title: "Photosynthesis" }, prompt: 'make a pdf, filename "Midterm Review!"', extension: ".pdf" }), "midterm-review.pdf");
});

test("words that name a format are not mistaken for a filename", () => {
  assert.equal(requestedFilename("save it as a word doc"), null);
  assert.equal(requestedFilename("save it as a PDF please"), null);
  assert.equal(requestedFilename("call it a document"), null);
  assert.equal(requestedFilename("make me a pdf about the French Revolution"), null);
});

test("the explicit name stops where the rest of the request begins", () => {
  assert.equal(requestedFilename("make a study guide called Cell Biology Basics and add it to my drive"), "cell-biology-basics");
  assert.equal(requestedFilename("name it Weekly Plan, then email it"), "weekly-plan");
});

test("with no title, the subject of the request names the file", () => {
  assert.equal(artifactFilename({ plan: { title: "Document" }, prompt: "Create a PDF about photosynthesis", extension: ".pdf" }), "photosynthesis.pdf");
  assert.equal(artifactFilename({ plan: { title: "Overview", sections: [{ heading: "Contour Maps" }] }, extension: ".pdf" }), "contour-maps.pdf");
});

test("a generic or missing title falls back to the plain name, with the right extension", () => {
  assert.equal(artifactFilename({ plan: { title: "???" }, prompt: "save it as a word doc", extension: ".docx" }), `${FILENAME_FALLBACK}.docx`);
  assert.equal(artifactFilename({ plan: null, extension: ".pdf" }), `${FILENAME_FALLBACK}.pdf`);
  assert.equal(artifactFilename({ plan: { title: "Untitled Document" }, extension: ".csv" }), `${FILENAME_FALLBACK}.csv`);
});

test("unsafe input cannot escape the folder, hide the file, or hit a reserved name", () => {
  assert.equal(artifactFilename({ plan: { title: "../../etc/passwd" }, extension: ".pdf" }), "etc-passwd.pdf");
  assert.equal(artifactFilename({ plan: { title: "..\\..\\Windows\\System32" }, extension: ".pdf" }), "windows-system32.pdf");
  assert.equal(artifactFilename({ plan: { title: "CON" }, extension: ".pdf" }), "document-con.pdf");
  assert.equal(artifactFilename({ plan: { title: "nul" }, extension: ".txt" }), "document-nul.txt");
  assert.equal(artifactFilename({ plan: { title: "report\u0000\u001f‮.exe" }, extension: ".pdf" }), "report-exe.pdf");
  assert.equal(artifactFilename({ plan: { title: ".htaccess" }, extension: ".txt" }), "htaccess.txt");
  assert.equal(artifactFilename({ plan: { title: "Résumé: Solar Energy / 2026?" }, extension: ".pdf" }), "resume-solar-energy-2026.pdf");
  assert.equal(artifactFilename({ plan: { title: "x" }, prompt: "make a pdf called ../../secret/key", extension: ".pdf" }), "secret-key.pdf");
});

test("a long name is bounded, never ends in a dash, and is never cut mid-extension", () => {
  const name = artifactFilename({ plan: { title: "Long topic ".repeat(40) }, extension: ".pdf" });
  assert.ok(name.length <= 64, `bounded (${name.length})`);
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*\.pdf$/);
  const explicit = artifactFilename({ plan: { title: "t" }, prompt: `make a pdf called ${"abc ".repeat(60)}`, extension: ".pdf" });
  assert.ok(explicit.length <= 64);
  assert.ok(explicit.endsWith(".pdf") && !explicit.includes("--"));
});

test("a name that is only symbols or only non-Latin letters still gets a safe file name", () => {
  assert.equal(artifactFilename({ plan: { title: "日本語のレポート" }, extension: ".pdf" }), `${FILENAME_FALLBACK}.pdf`);
  assert.equal(artifactFilename({ plan: { title: "!!!***" }, extension: ".md" }), `${FILENAME_FALLBACK}.md`);
});

test("the original docx helper behaves as before", () => {
  assert.equal(documentFilename({ title: "Earth and Space Sciences Study Guide" }), "earth-and-space-sciences-study-guide.docx");
  assert.equal(documentFilename(null), `${FILENAME_FALLBACK}.docx`);
});

test("shared generation names every format from its content, from one place", async () => {
  const plan = { title: "Biology Revision Guide", sections: [{ heading: "Cells", body: "Cells are the basic units of life. Every living thing is made of one or more cells, and each cell carries out the work that keeps the organism alive." }] };
  for (const [format, extension] of Object.entries(FORMATS)) {
    const result = await generateDocument(
      { userId: "u", format, prompt: "make a revision guide", requestText: "make a revision guide" },
      { reserve: async () => ({ id: "r1" }), finalize: async () => {}, cancel: async () => {}, buildPlan: async () => ({ plan, usage: {} }) },
    );
    assert.equal(result.filename, `biology-revision-guide${extension}`, format);
    assert.ok(result.filename.endsWith(result.buffer ? extension : ""));
  }
});

test("an explicit name in the request reaches the generated file, for the download card and for uploads alike", async () => {
  const plan = { title: "Biology Revision Guide", sections: [{ heading: "Cells", body: "Cells are the basic units of life. Every living thing is made of one or more cells, and each cell carries out the work that keeps the organism alive." }] };
  const result = await generateDocument(
    { userId: "u", format: "pdf", prompt: "make a pdf called Cell Notes", requestText: "make a pdf called Cell Notes" },
    { reserve: async () => ({ id: "r1" }), finalize: async () => {}, cancel: async () => {}, buildPlan: async () => ({ plan, usage: {} }) },
  );
  assert.equal(result.filename, "cell-notes.pdf");
});

test("choosing a file name never costs a model call: the name comes from the plan the document already has", async () => {
  let planCalls = 0;
  const plan = { title: "Cell Biology", sections: [{ heading: "Cells", body: "Cells are the basic units of life. Every living thing is made of one or more cells, and each cell carries out the work that keeps the organism alive." }] };
  await generateDocument(
    { userId: "u", format: "pdf", prompt: "make a pdf", requestText: "make a pdf" },
    { reserve: async () => ({ id: "r" }), finalize: async () => {}, cancel: async () => {}, buildPlan: async () => { planCalls += 1; return { plan, usage: {} }; } },
  );
  assert.equal(planCalls, 1);
});
