import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

// VibhavGPT Writing Tools in Study mode: the AI Detector and the Humanizer.
// Every request here goes to fakes; no model or upstream service is called.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-secret-for-writing-tools-0123456789";
const { config } = await import("../src/config.js");
config.chatModels.study ||= "fixture/study";
const { detectAiWriting, humanizeText, sanitizeRewrite, splitSentences, upstreamConfig } = await import("../src/study/writing-tools.js");
const { createStudyRouter } = await import("../src/study/router.js");

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const AI_TEXT = "In today's fast-paced world, technology plays a crucial role in shaping how students learn. Moreover, digital tools foster collaboration and unlock new opportunities for growth. Furthermore, the landscape of education continues to evolve in transformative ways. It is important to note that these changes underscore the need for a holistic approach. In conclusion, embracing innovation is a testament to our commitment to a vibrant future.";
const HUMAN_TEXT = "I failed my first chem test. Badly. My teacher, Mr. Ortiz, handed it back with a 54 circled in red and said we should talk after class. I was sure he'd tell me to drop the course. Instead he asked how I studied, and I admitted I mostly reread my notes the night before. He laughed (kindly) and showed me how to do practice problems from chapter 3 instead. Two weeks later I got an 81, which honestly felt like a miracle?";
const BRANDING = /clever|powered by|humani[sz]ed by|vendor|watermark|[​-‏﻿]/i;

function fakeModel(reply = "Tech shapes how students learn today. Digital tools help them work together and open new doors.") {
  const calls = [];
  const callModel = async (modelKey, messages, tools, options) => {
    calls.push({ modelKey, messages, options });
    await options.usageTracker?.beforeCall(messages, tools, options.maxTokens);
    await options.usageTracker?.record({ prompt_tokens: 100, completion_tokens: 80 });
    return { data: { choices: [{ message: { content: reply } }] } };
  };
  return { calls, callModel };
}

function fakeMeter() {
  const events = [];
  return { events, createTracker: () => ({
    beforeCall: async () => events.push("reserve"),
    record: async (usage) => events.push(["record", usage.prompt_tokens > 0, usage.completion_tokens > 0]),
    release: async () => events.push("release"),
  }) };
}

async function server(t, deps) {
  const app = express();
  app.use(express.json());
  app.use("/api/study", createStudyRouter({
    sessionMiddleware: (req, _res, next) => { req.authSession = { user: { id: "learner" } }; next(); },
    moderate: async () => ({ flagged: false }),
    limiter: (_req, _res, next) => next(),
    ...deps,
  }));
  const listener = app.listen(0);
  t.after(() => listener.close());
  const base = `http://127.0.0.1:${listener.address().port}/api/study`;
  return async (path, body) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), raw: response };
  };
}

test("the detector separates machine-even writing from a human voice, sentence by sentence", () => {
  const ai = detectAiWriting(AI_TEXT);
  const human = detectAiWriting(HUMAN_TEXT);
  assert.ok(ai.aiScore >= 70, `AI-style text scores ${ai.aiScore}% AI`);
  assert.ok(human.humanScore >= 70, `the personal text scores ${human.humanScore}% human`);
  assert.equal(ai.aiScore + ai.humanScore, 100);
  assert.equal(ai.sentences.length, 5);
  const moreover = ai.sentences[1];
  assert.ok(moreover.aiProbability >= 0.6);
  assert.match(moreover.reason, /Stock AI phrasing: "moreover"/);
  assert.ok(human.sentences.every((sentence) => sentence.aiProbability < 0.6), "no human sentence is flagged");
  assert.deepEqual(splitSentences("We met at noon. He said hi! Was it 3 p.m.? Yes."), ["We met at noon.", "He said hi!", "Was it 3 p.m.?", "Yes."]);
});

test("both tools need 30 to 3,000 words", async (t) => {
  const post = await server(t, { callModel: fakeModel().callModel, createTracker: fakeMeter().createTracker, upstream: () => null });
  assert.equal((await post("/detect", { text: "Too short to judge." })).status, 400);
  assert.match((await post("/detect", { text: "Too short to judge." })).body.error, /at least 30 words/);
  assert.match((await post("/humanize", { text: "word ".repeat(3001) })).body.error, /under 3,000 words/);
  assert.equal((await post("/detect", {})).status, 400);
});

test("POST /api/study/detect returns only the scores and sentences, with nothing branded", async (t) => {
  const post = await server(t, { callModel: fakeModel().callModel, createTracker: fakeMeter().createTracker, upstream: () => null });
  const { status, body } = await post("/detect", { text: AI_TEXT });
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["aiScore", "humanScore", "sentences"]);
  assert.deepEqual(Object.keys(body.sentences[0]).sort(), ["aiProbability", "reason", "text"]);
  assert.doesNotMatch(JSON.stringify(body), BRANDING);
});

test("without an upstream key the Humanizer uses the native Study model and is metered", async (t) => {
  assert.equal(upstreamConfig({}), null, "no key, no upstream");
  assert.equal(upstreamConfig({ CLEVER_AI_API_KEY: "k" }), null, "a key without an endpoint isn't enough");
  const model = fakeModel("Tech shapes how students learn.​\n\nPowered by SomeVendor");
  const meter = fakeMeter();
  const post = await server(t, { callModel: model.callModel, createTracker: meter.createTracker, upstream: () => null, fetchImpl: () => assert.fail("no upstream call") });
  const { status, body } = await post("/humanize", { text: AI_TEXT, tone: "academic" });
  assert.equal(status, 200);
  assert.deepEqual(body, { text: "Tech shapes how students learn.", tone: "academic" }, "only the text and tone come back, sanitized");
  assert.equal(model.calls[0].modelKey, "study");
  assert.match(model.calls[0].messages[0].content, /Preserve 100% of the factual content/);
  assert.match(model.calls[0].messages[0].content, /Academic tone/);
  assert.match(model.calls[0].messages[1].content, /^<text>\n/);
  assert.deepEqual(meter.events, ["reserve", ["record", true, true]], "billed to the Study allowance");
});

test("an upstream service is used headlessly: only its text comes back, stripped of its branding", async (t) => {
  const model = fakeModel();
  const meter = fakeMeter();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({
      data: { humanized: "Technology shapes how students learn today, and digital tools help them work together.​‍ Teachers now have to rethink how they teach.\n\nHumanized by Clever AI · clever.ai", vendor: "Clever AI", watermark: "cai-123", credits_left: 41 },
      powered_by: "Clever AI",
    }), { headers: { "content-type": "application/json" } });
  };
  const post = await server(t, { callModel: model.callModel, createTracker: meter.createTracker, fetchImpl, upstream: () => ({ key: "upstream-key", url: "https://upstream.test/v1/humanize" }) });
  const { status, body, raw } = await post("/humanize", { text: AI_TEXT, tone: "natural" });
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["text", "tone"]);
  assert.equal(body.text, "Technology shapes how students learn today, and digital tools help them work together. Teachers now have to rethink how they teach.");
  assert.doesNotMatch(JSON.stringify(body), BRANDING);
  assert.equal([...raw.headers.keys()].some((name) => /clever|vendor|upstream/i.test(name)), false, "no upstream headers are passed through");
  assert.equal(seen[0].init.headers.Authorization, "Bearer upstream-key", "the key stays server to server");
  assert.deepEqual(JSON.parse(seen[0].init.body), { text: AI_TEXT, tone: "natural" });
  assert.equal(model.calls.length, 0, "the native model isn't needed");
  assert.deepEqual(meter.events, ["reserve", ["record", true, true]], "upstream use is metered too");
});

test("an unreachable or empty upstream falls back to the native rewrite and refunds its hold", async (t) => {
  for (const fetchImpl of [async () => { throw new Error("ECONNREFUSED"); }, async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }), async () => new Response("down", { status: 503 })]) {
    const model = fakeModel("A clear native rewrite.");
    const meter = fakeMeter();
    const result = await humanizeText(AI_TEXT, "natural", {
      upstream: { key: "k", url: "https://upstream.test" }, fetchImpl, callModel: model.callModel, usageTracker: meter.createTracker(), log: { warn() {} },
      upstreamMeter: { before: async () => meter.events.push("hold"), settle: async () => meter.events.push("settle"), release: async () => meter.events.push("refund") },
    });
    assert.deepEqual(result, { text: "A clear native rewrite.", tone: "natural" });
    assert.deepEqual(meter.events.slice(0, 2), ["hold", "refund"]);
    assert.equal(model.calls.length, 1);
  }
});

test("sanitizing keeps the writer's own words, including a vendor name they used themselves", () => {
  assert.equal(sanitizeRewrite("Here is the rewritten text:\n<text>\nClean prose.\n</text>"), "Clean prose.");
  assert.equal(sanitizeRewrite("I compared Clever AI with others.", { original: "I compared Clever AI with others in class.", vendorTerms: ["Clever AI"] }), "I compared Clever AI with others.");
  assert.equal(sanitizeRewrite("Good point (Clever AI).", { original: "Good point.", vendorTerms: ["Clever AI"] }), "Good point.");
  assert.equal(sanitizeRewrite("Line one.\n— Powered by Acme Rewriter"), "Line one.");
});

// The Writing Tools screen embeds Clever AI's Detector and Humanizer as
// sandboxed frames, compiled with the frontend's esbuild and rendered here.
async function renderTools(props = {}) {
  const require = createRequire(new URL("../frontend/package.json", import.meta.url));
  const esbuild = require("esbuild");
  const result = await esbuild.build({
    stdin: {
      contents: `import { renderToStaticMarkup } from "react-dom/server";
        import StudyWritingTools, { WIDGETS, embedUrl } from "./components/StudyWritingTools.jsx";
        export { WIDGETS, embedUrl };
        export const render = (props) => renderToStaticMarkup(<StudyWritingTools {...props} />);`,
      resolveDir: new URL("../frontend/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      loader: "jsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", loader: { ".css": "empty" }, logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const dir = mkdtempSync(join(tmpdir(), "writing-tools-"));
  try {
    const file = join(dir, "tools.cjs");
    writeFileSync(file, result.outputFiles[0].text);
    const module = createRequire(import.meta.url)(file);
    return { ...module, html: module.render(props) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DETECTOR_URL = "https://widgets.cleverhumanizer.ai/embed/95f9d2d141d74ec580880c266b813f7b?theme=light";
const HUMANIZER_URL = "https://widgets.cleverhumanizer.ai/embed/1e5f37671c4f49c696409a6a12345c5f?theme=light";
const frames = (html) => [...html.matchAll(/<div class="writing-tools-widget-wrapper" style="display:(block|none)" data-tab="(\w+)"><iframe ([^>]*)><\/iframe><\/div>/g)]
  .map(([, display, tab, attributes]) => ({ display, tab, attributes }));

test("both Clever AI tools are sandboxed frames on their exact light-theme embed URLs", async () => {
  const { html, WIDGETS, embedUrl } = await renderTools();
  assert.deepEqual(WIDGETS.map((widget) => embedUrl(widget.id)), [DETECTOR_URL, HUMANIZER_URL]);
  const [detector, humanizer] = frames(html);
  assert.equal(detector.tab, "detector");
  assert.equal(humanizer.tab, "humanizer");
  assert.ok(detector.attributes.includes(`src="${DETECTOR_URL}"`), "the Detector frame's URL");
  assert.ok(humanizer.attributes.includes(`src="${HUMANIZER_URL}"`), "the Humanizer frame's URL");
  for (const { attributes } of [detector, humanizer]) {
    assert.match(attributes, /loading="lazy"/);
    assert.match(attributes, /sandbox="allow-scripts allow-same-origin allow-forms allow-popups"/);
    assert.doesNotMatch(attributes, /allow-top-navigation|allow-modals/, "nothing more than the four permissions");
    assert.match(attributes, /style="width:100%;height:600px;border:none;display:block"/);
  }
  assert.match(detector.attributes, /title="AI Detector"/);
  assert.match(humanizer.attributes, /title="AI Humanizer"/);
});

test("switching tabs only hides a frame: both stay mounted, so nothing reloads or loses its text", async () => {
  const { html } = await renderTools();
  assert.deepEqual(frames(html).map(({ tab, display }) => `${tab}:${display}`), ["detector:block", "humanizer:none"], "the active tab's frame shows, the other is mounted but hidden");
  const component = read("frontend/src/components/StudyWritingTools.jsx");
  assert.match(component, /\{WIDGETS\.map\(\(widget\) => <WidgetFrame key=\{widget\.tab\} widget=\{widget\} visible=\{tab === widget\.tab\} \/>\)\}/, "every frame always renders; only visibility follows the tab");
  assert.match(component, /style=\{\{ display: visible \? "block" : "none" \}\}/);
});

test("Clever AI's script never runs on the page; only verified resize messages from its frames are accepted", () => {
  const component = read("frontend/src/components/StudyWritingTools.jsx");
  assert.doesNotMatch(component, /widget\.js|<script|createElement\(["']script|dangerouslySetInnerHTML/, "no third-party code on the page");
  assert.match(component, /event\.source !== node\.contentWindow \|\| event\.origin !== WIDGET_ORIGIN \|\| event\.data\?\.channel !== channel \|\| event\.data\?\.type !== "clever:resize"/);
  assert.match(component, /postMessage\(\{ type: "clever:init", channel, scheme: "light" \}, WIDGET_ORIGIN\)/, "the init message goes only to the widget's origin");
  assert.match(component, /next >= 100 && next <= 20000/, "heights are bounded");
});

test("the screen keeps the VibhavGPT header and tells people Clever AI handles their text", async () => {
  const { html } = await renderTools({ onBack: () => {} });
  assert.match(html, /Back to Study<\/button>/);
  assert.match(html, /VibhavGPT Writing Tools/);
  assert.match(html, /<span>AI Detector<\/span>[\s\S]*<span>AI Humanizer<\/span>/);
  assert.match(html, /<p class="writing-tools__notice">Writing tools run via Clever AI\. Text processed through these tools is handled according to provider guidelines and does not affect your VibhavGPT chat history\.<\/p>/);
  assert.doesNotMatch(html, /VibhavGPT AI Detector|VibhavGPT Humanizer/, "Clever's tools aren't presented as VibhavGPT's own");
  assert.match(read("frontend/src/App.jsx"), /writingToolsOpen \? <StudyWritingTools api=\{api\}/, "it lives in Study mode");
});

test("the Privacy Policy discloses that Clever AI processes Writing Tools text", () => {
  const knowledge = read("frontend/src/product-knowledge.js");
  assert.match(knowledge, /The Writing Tools in Study \(the AI Detector and the AI Humanizer\) are provided by Clever AI and run in a window served by Clever AI: text you enter in them goes directly to Clever AI, is processed under Clever AI's own data policies, and is not saved with your VibhavGPT conversations or chat history\./);
});

test("each frame sits in a white card that never clips it, so the widget's footer shows", () => {
  const css = read("frontend/src/writing-tools.css");
  assert.match(css, /\.writing-tools-widget-wrapper \{[^}]*max-width: 820px;[^}]*border-radius: 16px;[^}]*border: 1px solid rgba\(0, 0, 0, 0\.08\);[^}]*background: #ffffff;[^}]*box-shadow: 0 4px 20px rgba\(0, 0, 0, 0\.06\);/);
  assert.match(css, /\.writing-tools__notice \{[^}]*margin: 14px auto 0;[^}]*font-size: 13px;[^}]*line-height: 1\.5;[^}]*color: var\(--color-muted\);[^}]*text-align: center;/);
  assert.doesNotMatch(css, /position: absolute|pointer-events: none|::after|::before/, "no overlay or mask over the frame");
  assert.match(css, /@media \(max-width: 640px\)/, "it adapts to phones");
});
