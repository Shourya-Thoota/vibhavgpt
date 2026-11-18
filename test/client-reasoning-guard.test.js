import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createThoughtFilter as serverFilter, stripThoughts as serverStrip } from "../src/chat/thought-filter.js";
import { createThoughtFilter as clientFilter, stripThoughts as clientStrip } from "../frontend/src/thought-filter.js";
import { createReplyStreamGuard } from "../frontend/src/reasoning-guard.js";
import { interruptedStreamMessage } from "../frontend/src/stream-recovery.js";

// The page must never show or keep a model's reasoning that reached it as reply text. The server filters and withdraws; the page runs the
// same filter as a second line, live and on the partial text it saves when a stream breaks. These tests are about the page's side.
const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// What the page shows after each chunk, applying the guard the way App.jsx does.
function render(chunks) {
  const guard = createReplyStreamGuard();
  let visible = "";
  const shown = [];
  for (const chunk of chunks) {
    const { text, discardEarlier } = guard.push(chunk);
    if (discardEarlier) visible = "";
    visible += text;
    shown.push(visible);
  }
  const tail = guard.end();
  if (tail.discardEarlier) visible = "";
  visible += tail.text;
  return { shown, final: visible };
}
const chars = (text) => [...text];

// ---- The client copy is the server's filter ---------------------------------------------------------------------------

const CORPUS = [
  "A plain answer with the word think in it, and thinking, and a thought.",
  "<think>private notes</think>The answer is 42.",
  "<thinking>x</thinking>Hello <thought>y</thought>there <reasoning>z</reasoning>!",
  "Let me work out the units first.\nThe user wants a table.</think>Here is the table.",
  "Before <think>hidden and never closed",
  "```html\n<think>kept, it is code</think>\n```\nAfter the code.",
  "<|channel|>analysis<|message|>chain of thought<|end|><|start|>assistant<|channel|>final<|message|>The final answer.",
  "5 < 6 and 7 > 3, so <b>bold</b> is fine, and a < b.",
  "<th", "</", "<", "I <3 this", "`", "``` a", "<think>a</think><think>b</think>c",
];
function run(factory, chunks) {
  const filter = factory();
  const out = [];
  for (const chunk of chunks) out.push(filter.push(chunk));
  out.push(filter.end());
  return out;
}
const splits = (text) => {
  const all = [[text], chars(text)];
  for (let i = 1; i < text.length; i += 1) all.push([text.slice(0, i), text.slice(i)]);
  for (let i = 1; i + 2 < text.length; i += 3) all.push([text.slice(0, i), text.slice(i, i + 2), text.slice(i + 2)]);
  return all;
};

test("the client's filter gives exactly the server's output, for every chunking of a corpus of replies", () => {
  for (const text of CORPUS) {
    assert.equal(clientStrip(text), serverStrip(text), `whole: ${JSON.stringify(text)}`);
    for (const chunks of splits(text)) {
      assert.deepEqual(run(clientFilter, chunks), run(serverFilter, chunks), `${JSON.stringify(text)} as ${JSON.stringify(chunks.slice(0, 3))}`);
    }
  }
});

test("the client copy is the first half of the server file, byte for byte", () => {
  const server = read("src/chat/thought-filter.js");
  const client = read("frontend/src/thought-filter.js");
  const half = server.slice(0, server.indexOf("/* Meta-deliberation in streamed thinking.")).trimEnd();
  assert.ok(client.includes(half), "if the server's filter changes, the client copy has to change with it");
});

// ---- The three cases: closing tag only, a tag split across chunks, and a normal reply that says "think" -------------------

test("a closing tag with no opening one: what came before it is withdrawn and never kept", () => {
  const { shown, final } = render(["Let me think about this carefully.", " The user wants a table.</think>", "Here is ", "the table."]);
  assert.equal(shown[0], "Let me think about this carefully.", "until the closing tag arrives there is no way to tell, so it shows");
  assert.equal(shown[1], "", "and the moment the tag arrives, it is cleared");
  assert.equal(final, "Here is the table.");
  assert.doesNotMatch(final, /think about|user wants/i);
  // The same text arriving a character at a time.
  assert.equal(render(chars("Let me think.</think>Answer.")).final, "Answer.");
});

test("a tag split across chunks never shows, however it is cut", () => {
  const text = "Hi <think>secret plan</think>there";
  for (const chunks of splits(text)) {
    const { shown, final } = render(chunks);
    assert.equal(final, "Hi there", JSON.stringify(chunks));
    for (const state of shown) assert.doesNotMatch(state, /<th|<\/th|secret|plan/, `never on screen: ${JSON.stringify(chunks)} -> ${JSON.stringify(state)}`);
  }
  // An opening tag cut in two, and a closing one cut in two.
  assert.deepEqual(render(["Answer: <th", "ink>x</thi", "nk>done"]).shown.map((s) => s.includes("<")), [false, false, false]);
  assert.equal(render(["<thi", "nk>planning</th", "ink>The reply."]).final, "The reply.");
});

test("a normal reply that contains the word think is untouched, and is not held back at all", () => {
  const guard = createReplyStreamGuard();
  for (const chunk of ["I think ", "this works. ", "Think about it, thinking is fine; a thought: ", "5 < 6, so a < b."]) {
    const { text, discardEarlier } = guard.push(chunk);
    assert.equal(text, chunk, "returned in the same call: no delay");
    assert.equal(discardEarlier, false);
  }
  const tail = guard.end();
  assert.equal(tail.text, "");
  assert.equal(render(["I think the plan <b>works</b>.", " Think again."]).final, "I think the plan <b>works</b>. Think again.");
});

test("a held start of a tag is released as soon as the next chunk shows it is ordinary text", () => {
  const guard = createReplyStreamGuard();
  assert.equal(guard.push("2 <").text, "2 ", "the '<' alone could start a tag");
  assert.equal(guard.push(" 3 is true").text, "< 3 is true", "and is returned the moment it is clear it does not");
  const ending = createReplyStreamGuard();
  assert.equal(ending.push("a <th").text, "a ");
  assert.equal(ending.end().text, "<th", "at the end of the reply a held start that never became a tag is returned");
});

test("starting over (another model call) drops anything held from before", () => {
  const guard = createReplyStreamGuard();
  guard.push("text <thi");
  guard.reset();
  assert.equal(guard.push("nk>").text, "nk>", "the held '<thi' did not carry across");
});

// ---- The partial text saved when a stream breaks -----------------------------------------------------------------------------

test("a stream that stops mid-reasoning leaves no reasoning in the conversation", () => {
  // Only unfinished reasoning: nothing is saved.
  assert.equal(interruptedStreamMessage("<think>I should work out the units first and then", "nova"), null);
  assert.equal(interruptedStreamMessage("<thinking>step one", "nova"), null);
  assert.equal(interruptedStreamMessage("<think>", "nova"), null);
  assert.equal(interruptedStreamMessage("<thi", "nova").content, "<thi", "a lone start of a tag is not reasoning yet");
  // Reasoning that closed with no opener, and nothing after it: nothing is saved.
  assert.equal(interruptedStreamMessage("Let me think about the request.</think>", "nova"), null);
  // An answer so far, then reasoning begins: the answer is kept and the reasoning is not.
  const partial = interruptedStreamMessage("Here is what I have so far. <think>now let me consider the system prompt", "nova");
  assert.equal(partial.content.trim(), "Here is what I have so far.");
  assert.doesNotMatch(partial.content, /system prompt|consider|<think>/);
  // A finished reasoning block followed by part of the answer: only the answer.
  assert.equal(interruptedStreamMessage("<think>private</think>The first half of the answ", "nova").content, "The first half of the answ");
  // Ordinary partial text is kept exactly as before, marked incomplete.
  assert.deepEqual(interruptedStreamMessage("The answer is 4", "nova"), { role: "assistant", content: "The answer is 4", model: "nova", incomplete: true, fresh: false });
  assert.equal(interruptedStreamMessage("   ", "nova"), null);
  assert.equal(interruptedStreamMessage("", "nova"), null);
  assert.equal(interruptedStreamMessage(undefined, "nova"), null);
  // Code that shows the tags is not reasoning.
  assert.match(interruptedStreamMessage("Use it like ```<think>x</think>``` in code", "nova").content, /<think>x<\/think>/);
});

test("the app runs live text and the saved partial through the guard", () => {
  const app = read("frontend/src/App.jsx");
  assert.match(app, /import \{ createReplyStreamGuard \} from "\.\/reasoning-guard\.js";/);
  assert.match(app, /const thoughtGuard = createReplyStreamGuard\(\);/);
  assert.match(app, /const guarded = thoughtGuard\.push\(delta\.text\);/);
  assert.match(app, /if \(guarded\.discardEarlier\) \{ visibleStream = ""; previousStream = ""; setStreamText\(""\); \}/);
  assert.match(app, /visibleStream \+= guarded\.text;/);
  assert.match(app, /thoughtGuard\.reset\(\);/, "a new model call starts clean");
  assert.match(app, /const partial = interruptedStreamMessage\(visibleStream \|\| previousStream, streamingModel \?\? sentModel\);/);
  assert.match(read("frontend/src/stream-recovery.js"), /stripThoughts\(text\)/);
});
