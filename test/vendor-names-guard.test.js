// No other company's model or brand name may appear in what VibhavGPT shows people. The product names its own tiers only (Lumen, Nova,
// Nebula, Vulcan, Study). Vendor names may live in server-side configuration and in internal comments, never in frontend copy.
//
// What is scanned:
// - every frontend source file that ships, with comments removed;
// - the prerendered public pages in frontend/dist, when built.
// Not scanned:
// - the development-only catalog preview and its synthetic fixtures (loaded only under import.meta.env.DEV, so never in a production
//   build);
// - the bundled error-monitoring SDK, whose AI-instrumentation identifiers are library code that is never rendered.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve("frontend/src");
const DEV_ONLY = new Set(["components/catalog/CatalogPreviewPage.jsx", "components/catalog/catalog-fixtures.js"]);
// The sub-processor list (owner request, 2026-11-16: "publish an accurate sub-processors list") must name the companies that process
// data, so it is the one place outside the picker's catalog where they appear: that file, and the Privacy page it is shown on. It names
// companies only, never which one runs which house model (checked below).
const SUBPROCESSOR_FILE = "subprocessors.js";
const SUBPROCESSOR_PAGE = "privacy.html";
const VENDOR = /\b(openai|open ai|anthropic|claude|chatgpt|gpt-[0-9o][\w.-]*|moonshot(?: ?ai)?|kimi|gemini|deepseek|qwen|alibaba|mistral|mixtral|llama|meta ai|xai|grok|nvidia|nemotron|zhipu|z\.ai|glm-[0-9][\w.-]*|xiaomi|mimo|minimax|cohere|perplexity|openrouter|bazaarlink|groq|together ai|fireworks ai)\b/i;
const stripComments = (src, ext) => ext === ".css"
  ? src.replace(/\/\*[\s\S]*?\*\//g, "")
  : src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}

// Slice 7: third-party models are shown openly under their makers' names, in the picker only. The owner approved Z.AI's GLM models
// and OpenAI's GPT-6 models (2026-11-14: picker sections VibhavGPT / OpenAI / Z.AI, with each maker's official mark). The one file that holds the picker's
// third-party catalog may name the approved makers and their models; nothing else may, and that file may name nothing else (in
// particular, never what powers a house tier).
const MARKETPLACE_FILE = "model-marketplace.js";
// Gemini 4 joined the picker on Google's own API (owner request, 2026-11-16).
const APPROVED_THIRD_PARTY = /^(?:z\.ai|glm-[0-9][\w.-]*|openai|gpt-6[\w.-]*|gemini(?:-4[\w.-]*)?)$/i;

test("no shipped frontend source names another AI company or model", () => {
  const found = [];
  for (const file of files(root).filter((f) => /\.(jsx?|tsx?|css|html)$/.test(f))) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (DEV_ONLY.has(rel) || rel === SUBPROCESSOR_FILE) continue;
    const text = stripComments(fs.readFileSync(file, "utf8"), path.extname(file));
    text.split("\n").forEach((line, i) => {
      for (const match of line.matchAll(new RegExp(VENDOR.source, "gi"))) {
        if (rel === MARKETPLACE_FILE && APPROVED_THIRD_PARTY.test(match[0])) continue;
        found.push(`${rel}:${i + 1} "${match[0]}"`);
      }
    });
  }
  assert.deepEqual(found, [], `vendor names in shipped frontend code:\n${found.join("\n")}`);
});

test("the picker's third-party catalog names only the approved makers and models, and no house tier's engine", () => {
  const text = stripComments(fs.readFileSync(path.join(root, MARKETPLACE_FILE), "utf8"), ".js");
  const names = [...text.matchAll(new RegExp(VENDOR.source, "gi"))].map((m) => m[0]);
  assert.ok(names.length > 0, "the file does name its third-party models");
  assert.deepEqual(names.filter((name) => !APPROVED_THIRD_PARTY.test(name)), []);
  assert.doesNotMatch(text, /mistral|cohere|command-a/i, "neither Zenith's engine nor a cut provider");
});

test("the dev-only catalog preview is retired: the composer's picker is the one model picker", () => {
  const app = stripComments(fs.readFileSync(path.join(root, "App.jsx"), "utf8"), ".jsx");
  assert.doesNotMatch(app, /CatalogPreviewPage|AuthenticatedCatalogModal|Browse models/);
});

test("the prerendered public pages name no other AI company or model", { skip: fs.existsSync("frontend/dist/index.html") ? false : "frontend/dist is not built" }, () => {
  const found = [];
  for (const file of fs.readdirSync("frontend/dist").filter((f) => f.endsWith(".html"))) {
    let text = fs.readFileSync(path.join("frontend/dist", file), "utf8").replace(/<script[\s\S]*?<\/script>/gi, "");
    // The Privacy page carries the sub-processor list; outside that section it is held to the same rule.
    if (file === SUBPROCESSOR_PAGE) text = text.replace(/Sub-processors[\s\S]*?We tell you here before adding or replacing one\./g, "");
    const match = text.match(VENDOR);
    if (match) found.push(`${file} "${match[0]}"`);
  }
  assert.deepEqual(found, []);
});

test("the guard catches a vendor name, so it is not vacuous", () => {
  assert.match('description: "Powered by Gemini"', VENDOR);
  assert.doesNotMatch(stripComments('// Qwen3 chat templates\nconst a = 1;', ".js"), VENDOR);
  assert.doesNotMatch("VibhavGPT Nova, Nebula, Vulcan, Lumen and Study", VENDOR);
});

// Per-model privacy or compliance claims need documented per-model evidence (the model-lineup evaluation). Until then none are shown.
test("no unverified per-model compliance labels ship in the frontend", () => {
  const found = [];
  for (const file of files(root).filter((f) => /\.(jsx?|tsx?)$/.test(f))) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (DEV_ONLY.has(rel)) continue;
    const text = stripComments(fs.readFileSync(file, "utf8"), path.extname(file));
    for (const label of ["Compliance Approved", "Exclusion Verified", "Zero Data Retention", "Audit Certification", "\"Guaranteed\""]) {
      if (text.includes(label)) found.push(`${rel}: ${label}`);
    }
  }
  assert.deepEqual(found, []);
});

test("the sub-processor list names companies, never which one runs a house model", async () => {
  const { SUBPROCESSORS_SECTION } = await import("../frontend/src/subprocessors.js");
  const [, body] = SUBPROCESSORS_SECTION;
  assert.doesNotMatch(body, /\b(Lumen|Nova|Nebula|Vulcan|Vesper|Zenith|Tecton|Prism|Aura|Study)\b/, "no house model is named, so none is tied to a provider");
  assert.doesNotMatch(body, /gpt-[0-9]|claude|gemini-[0-9]|llama|qwen|mixtral|kimi|deepseek/i, "companies, not models");
});
