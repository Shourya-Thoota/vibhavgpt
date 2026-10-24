import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { groupSources, sourceCount } from "../frontend/src/sources.js";

const app = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
const disclosure = readFileSync(new URL("../frontend/src/components/ui/sources-disclosure.jsx", import.meta.url), "utf8");

test("sources are grouped by site, counted once per URL, and only web links are kept", () => {
  const sources = [
    { title: "A", url: "https://www.example.org/a" },
    { title: "A again", url: "https://www.example.org/a" },
    { title: "B", url: "https://example.org/b" },
    { title: "C", url: "http://news.example.net/c" },
    { title: "Script", url: "javascript:alert(1)" },
    { title: "Broken", url: "not a url" },
  ];
  assert.deepEqual(groupSources(sources).map((group) => [group.host, group.sources.length]), [["example.org", 2], ["news.example.net", 1]]);
  assert.equal(sourceCount(sources), 3);
  assert.equal(sourceCount([]), 0);
  assert.equal(sourceCount(undefined), 0);
});

test("a finished reply has one thinking control at the top and no bottom Thought button", () => {
  // The saved reply: the first assistant turn, ahead of the streaming one.
  const start = app.indexOf('<article className="turn">');
  const end = app.indexOf("{busy && (", start);
  assert.ok(start > 0 && end > start, "found the finished assistant message");
  const reply = app.slice(start, end);
  assert.equal(reply.match(/<ReasoningTrace /g)?.length, 1, "one Thought for X s control");
  assert.doesNotMatch(reply, /<ThinkingTool /, "the old Thought button is gone from finished replies");
  assert.doesNotMatch(app, /state="thought"/);
  // Sources and the recorded steps stay, in their own control, after the reply.
  assert.match(reply, /<SourcesDisclosure sources=\{message\.sources \?\? \[\]\} steps=\{message\.activitySummary \?\? \[\]\} \/>/);
  assert.ok(reply.indexOf("<ReasoningTrace ") < reply.indexOf("<AssistantBody"), "thinking sits above the reply");
  assert.ok(reply.indexOf("<AssistantBody") < reply.indexOf("<SourcesDisclosure "), "sources sit below the reply");
  assert.ok(reply.indexOf("<SourcesDisclosure ") < reply.indexOf('<div className="turn__tools">'), "the copy action stays in its own row after the bubble");
});

test("the Sources control appears only with sources and never says Thought", () => {
  // What renders, without the explanatory comments.
  const code = disclosure.replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /if \(!count\) return null;/);
  assert.match(code, /Sources \(\{count\}\)/);
  assert.doesNotMatch(code, /Thought/);
  assert.doesNotMatch(disclosure, /—/, "no em dashes in UI copy");
});
