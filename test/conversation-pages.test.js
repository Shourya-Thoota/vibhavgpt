import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mergeOlderPage, messageKey, restoredScrollTop } from "../frontend/src/conversation-pages.js";
import { createReplyLabels } from "../frontend/src/model-labels.js";

// "Load earlier messages": an earlier page goes above what is shown, with no
// repeats, without moving the reader, and with labels and dividers intact.
const app = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
const msg = (id, role = "user", model = null) => ({ id, role, content: id, model });

test("an earlier page goes in front, in order, with no repeats and without touching the inputs", () => {
  const current = [msg("m3"), msg("m4", "assistant")];
  const page = [msg("m1"), msg("m2", "assistant")];
  const before = { current: structuredClone(current), page: structuredClone(page) };
  const merged = mergeOlderPage(current, page);
  assert.deepEqual(merged.map((message) => message.id), ["m1", "m2", "m3", "m4"]);
  assert.notEqual(merged, current, "a new array");
  assert.deepEqual({ current, page }, before, "inputs unchanged");

  assert.deepEqual(mergeOlderPage(current, [msg("m2"), msg("m3")]).map((message) => message.id), ["m2", "m3", "m4"], "a message already shown is not added again");
  assert.deepEqual(mergeOlderPage(current, []).map((message) => message.id), ["m3", "m4"], "an empty page changes nothing");
  assert.deepEqual(mergeOlderPage([], page).map((message) => message.id), ["m1", "m2"]);
  const local = { clientKey: "local-1", role: "user", content: "just sent" };
  assert.deepEqual(mergeOlderPage([msg("m3"), local], [msg("m2")]), [msg("m2"), msg("m3"), local], "messages added on this screen stay at the end");
});

test("a message is keyed by its id, then its client key, never by position", () => {
  assert.equal(messageKey({ id: "m1", clientKey: "local-1" }), "m1");
  assert.equal(messageKey({ id: null, clientKey: "local-2" }), "local-2");
  assert.equal(messageKey({ clientKey: "local-3" }), "local-3");
  assert.equal(messageKey({}), undefined);
});

test("after a page goes in above, the reader stays the same distance from the bottom", () => {
  assert.equal(restoredScrollTop({ beforeHeight: 2000, beforeTop: 40, afterHeight: 5200 }), 3240);
  assert.equal(restoredScrollTop({ beforeHeight: 900, beforeTop: 0, afterHeight: 900 }), 0);
});

test("over a merged list, a model change at the old page boundary gets its divider", () => {
  const MODELS = [
    { value: "lumen", label: "Lumen", full: "VibhavGPT Lumen" },
    { value: "nova", label: "Nova", full: "VibhavGPT Nova" },
    { value: "nebula", label: "Nebula", full: "VibhavGPT Nebula" },
  ];
  const { modelLabel, modelSwitches } = createReplyLabels(MODELS);
  const newest = [msg("m3"), msg("m4", "assistant", "nebula")];
  assert.deepEqual([...modelSwitches(newest)], [], "alone, the newest page shows no switch");
  const merged = mergeOlderPage(newest, [msg("m1"), msg("m2", "assistant", "nova")]);
  assert.deepEqual([...modelSwitches(merged)], [[2, "Nebula"]], "the divider sits above the first Nebula turn");
  assert.deepEqual(merged.map((message) => message.role === "assistant" ? modelLabel(message.model) : null), [null, "VibhavGPT Nova", null, "VibhavGPT Nebula"]);
  assert.equal(modelLabel(mergeOlderPage(newest, [msg("m2", "assistant", null)])[0].model), "VibhavGPT", "an old reply with no model still reads VibhavGPT");
});

test("the chat asks for earlier pages by cursor, one at a time, never while a reply streams", () => {
  assert.match(app, /const result = await api\(`\/api\/chat\/conversations\/\$\{encodeURIComponent\(requestedFor\)\}\?before=\$\{encodeURIComponent\(olderCursor\)\}`\);/, "before= with the cursor encoded");
  assert.match(app, /async function loadEarlier\(\) \{\s*if \(olderInFlightRef\.current \|\| !olderCursor \|\| busyRef\.current \|\| !conversationId\) return;/, "in-flight, no-cursor and streaming guards");
  assert.match(app, /olderInFlightRef\.current = true;[\s\S]*?finally \{\s*olderInFlightRef\.current = false;/, "the guard is released however the request ends");
  assert.match(app, /if \(!mountedRef\.current \|\| activeConversationRef\.current !== requestedFor\) return;/, "a reply for a conversation no longer open is dropped");
  assert.match(app, /disabled=\{loadingOlder \|\| busy\}/, "disabled while loading and while a reply streams");
  assert.match(app, /aria-busy=\{loadingOlder \|\| undefined\}/);
});

test("the control reads clearly in every state, and missing fields mean no earlier pages", () => {
  assert.match(app, /\{loadingOlder \? "Loading earlier messages…" : olderError \? "Try again" : "Load earlier messages"\}/);
  assert.match(app, /setOlderError\("Couldn't load earlier messages\."\)/);
  assert.match(app, /<p className="load-earlier__error" role="alert">\{olderError\}<\/p>/);
  assert.match(app, /\) : reachedStart \? \(\s*<p className="history-start">Start of conversation<\/p>/, "a quiet line once the first message is on screen");
  assert.match(app, /const olderCursorFrom = \(result\) => \(result\?\.hasMore === true && typeof result\.nextCursor === "string" \? result\.nextCursor : null\);/, "no hasMore, no button");
  assert.match(app, /setMessages\(\(result\.history \?\? \[\]\)\.map\(historyMessage\)\);\s*setOlderCursor\(olderCursorFrom\(result\)\);/, "the first page says whether earlier ones exist");
  assert.match(app, /setMessages\(\(current\) => mergeOlderPage\(current, \(result\.history \?\? \[\]\)\.map\(historyMessage\)\)\);/, "earlier pages are merged in front");
});

test("the reader stays put when a page goes in above, and keys never use positions", () => {
  assert.match(app, /useLayoutEffect\(\(\) => \{\s*const anchor = prependAnchorRef\.current;[\s\S]*?node\.scrollTop = restoredScrollTop\(\{ \.\.\.anchor, afterHeight: node\.scrollHeight \}\);\s*\}, \[messages\]\);/);
  assert.match(app, /prependAnchorRef\.current = node \? \{ beforeHeight: node\.scrollHeight, beforeTop: node\.scrollTop \} : null;/);
  assert.match(app, /if \(skipBottomScrollRef\.current\) \{\s*skipBottomScrollRef\.current = false;\s*return;\s*\}\s*endRef\.current\?\.scrollIntoView/, "the follow-to-bottom effect skips once after a prepend");
  assert.match(app, /<Fragment key=\{messageKey\(message\)\}>/);
  assert.doesNotMatch(app, /key=\{index\}/, "no message is keyed by its position");
  for (const added of [/clientKey: nextClientKey\(\), role: "user", content: autoPrompt\.text/, /\{ \.\.\.partial, clientKey: nextClientKey\(\) \}/, /\{\s*clientKey: nextClientKey\(\),\s*role: "user",\s*content: content \|\| "Attached file\(s\)"/, /\{ id: reply\.messageId \?\? null, clientKey: nextClientKey\(\),/]) {
    assert.match(app, added, "every message added on this screen has a stable key");
  }
  assert.match(app, /const replySwitches = useMemo\(\(\) => modelSwitches\(messages\), \[messages\]\);/, "dividers are worked out over the merged list");
});
