import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("the Writing Tools UI is native VibhavGPT: no iframes, scripts, third-party links or names", () => {
  const component = read("frontend/src/components/StudyWritingTools.jsx");
  const css = read("frontend/src/writing-tools.css");
  for (const source of [component, css]) {
    assert.doesNotMatch(source, /<iframe|<script|dangerouslySetInnerHTML|https?:\/\//i, "nothing embedded or linked out");
    assert.doesNotMatch(source, /clever|powered by/i, "no third-party names or credits");
  }
  assert.match(component, /VibhavGPT Writing Tools/);
  assert.match(component, /VibhavGPT AI Detector/);
  assert.match(component, /VibhavGPT Humanizer/);
  assert.match(component, /label: "AI Detector"[\s\S]*label: "AI Humanizer"/);
  assert.match(component, /Scan Text[\s\S]*Send to Humanizer[\s\S]*Natural[\s\S]*Academic[\s\S]*Humanize[\s\S]*Copy[\s\S]*Scan in Detector/);
  assert.match(component, /api\("\/api\/study\/detect"[\s\S]*api\("\/api\/study\/humanize"/, "only VibhavGPT's own API");
  assert.match(component, /className="btn btn--primary"/, "the app's own buttons");
  assert.match(css, /\.writing-tools \{\s*width: 100%;\s*max-width: 760px;/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "theme tokens only");
  assert.match(read("frontend/src/components/StudyWorkspace.jsx"), /view === "writing" \? <StudyWritingTools api=\{api\}/, "it lives in Study mode");
});
