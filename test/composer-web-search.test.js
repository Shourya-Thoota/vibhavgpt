import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The composer has no manual web search switch: the assistant searches the
// web by itself when a question needs current information, and shows
// "Searching the web" while it does.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the composer shows no Web toggle, chip or switch, and sends no webSearch flag", () => {
  const app = read("frontend/src/App.jsx");
  assert.doesNotMatch(app, /setWebSearch|webToggle|const \[webSearch/);
  assert.doesNotMatch(app, /<span>Web<\/span>|aria-label="Web search"|aria-label="Turn off web search"|Web search<small>/);
  const payload = app.slice(app.indexOf("const reply = await streamChat("), app.indexOf("const reply = await streamChat(") + 900);
  assert.doesNotMatch(payload, /\bwebSearch\b/);
  for (const sheet of ["styles.css", "mobile.css", "planetary.css"]) {
    assert.doesNotMatch(read(`frontend/src/${sheet}`), /pill-toggle|composer__tools?\b|add-sheet__switch/, `${sheet} keeps no styles for the removed controls`);
  }
});

test("searching still starts on its own, and the live status still says so", async () => {
  const { requiresFreshWebSearch } = await import("../src/chat/web-search.js");
  assert.equal(requiresFreshWebSearch("What is the latest news on the Mars mission today?"), true);
  assert.equal(requiresFreshWebSearch("Explain photosynthesis"), false);
  const router = read("src/chat/router.js");
  assert.match(router, /const useWebSearch = !weatherRequest && \(req\.body\?\.webSearch === true \|\| requiresFreshWebSearch\(content\) \|\| searchPlan\.continuationNeedsSearch\);/);
  const { CHAT_TOOLS } = await import("../src/chat/tool-calls.js");
  assert.ok(CHAT_TOOLS.some((tool) => tool.function.name === "web_search"), "the model can also ask for a search");
  assert.match(read("frontend/src/App.jsx"), /const next = phase === "searching" \? "Searching the web"/);
});
