import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serve, CONVERSATION_ID, STUDY_ID } from "../scripts/design-capture.mjs";

// A non-empty thread must hide the Study starter chips while keeping the
// existing composer, thread scroll and focus behaviour untouched. The chips
// live below the composer and the Chat | Study control only on an empty
// Study home; nothing here imposes a new positioning scheme.
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("../frontend/src/App.jsx");
const styles = read("../frontend/src/styles.css");
const mobile = read("../frontend/src/mobile.css");
const chatRef = read("../frontend/src/chat-reference.css");

test("the chips exist only in the empty branch, below the composer and the Chat | Study control", () => {
  assert.match(app, /const empty = !loadingConversation && messages\.length === 0;/);
  assert.match(app, /const startRows = empty && !loadingConversation && studyMode \? \(/);
  assert.match(app, /<div className="study-starters" role="group" aria-label="Study tools">/);
  // The only empty-gated render sites are the context line and the block
  // under the composer; the composer form itself is never gated on empty.
  const gates = app.match(/\{empty && !loadingConversation && \(/g) ?? [];
  assert.equal(gates.length, 2, "only the context line and the start-below block are empty-gated");
  assert.match(
    app,
    /\{empty && !loadingConversation && \(\s*<div className="start-below">\s*\{tabsBelow && <div className="start-below__tabs">\{tabsBelow\}<\/div>\}\s*\{startRows\}\s*<\/div>\s*\)\}/,
    "the Chat | Study control renders first, then the chips, inside the composer wrap",
  );
  assert.doesNotMatch(app, /\{empty[^{}]*<form className="composer"/, "the composer is not empty-gated");
});

test("the design fixture serves a non-empty thread in the app's own message shape", async () => {
  const server = serve({ signedIn: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [id, mode] of [[STUDY_ID, "study"], [CONVERSATION_ID, "chat"]]) {
      const res = await fetch(`${base}/api/chat/conversations/${id}`);
      assert.equal(res.status, 200, `${mode} history answers`);
      const body = await res.json();
      assert.ok(Array.isArray(body.history) && body.history.length > 0, `${mode} thread is non-empty`);
      for (const message of body.history) {
        assert.equal(typeof message.id, "string", "messages carry the saved id the list keys on");
        assert.ok(message.role === "user" || message.role === "assistant", "roles are the app's own user/assistant shape");
        assert.equal(typeof message.content, "string", "content is the string the thread renders");
        assert.ok(message.content.length > 0, "every message has something to show");
      }
      // With messages present, `empty` is false, so both gates above stay
      // shut: no .study-starters, no .start-below, while the thread renders.
      const empty = body.history.length === 0;
      assert.equal(empty, false, `${mode}: a loaded thread is never the empty state`);
      const last = body.history.at(-1);
      assert.ok(last.content.length > 0, `${mode}: the final message is reachable content, not a stub`);
      assert.ok(!("clientKey" in last) || typeof last.id === "string", "saved rows key by id, never by position");
    }
  } finally {
    server.close();
  }
});

test("an empty thread still resolves through the same fixture, so the gate is the only difference", async () => {
  const server = serve({ signedIn: true, emptyLibrary: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/chat/conversations`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.conversations, [], "the empty fixture has no conversations to load");
  } finally {
    server.close();
  }
});

test("the thread keeps one contained scroller: no nested trap, no repinned composer", () => {
  assert.match(
    styles,
    /\.chat__scroll \{ flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; \}/,
    "the thread scrolls inside its own pane",
  );
  assert.match(
    styles,
    /\.chat:has\(> \.chat__scroll\[data-empty\]\) > \.chat__scroll \{ flex: 0 0 auto; overflow: visible; \}/,
    "overflow: visible is an empty-state rule only",
  );
  assert.match(styles, /\.composer-wrap \{\s*position: sticky;\s*bottom: 0;/, "the composer's own sticky rule is preserved, not re-architected");
  assert.doesNotMatch(styles, /\.composer-wrap[^}]*position:\s*fixed/, "no fixed positioning is imposed on the composer");
  assert.doesNotMatch(chatRef.replace(/\/\*[\s\S]*?\*\//g, ""), /\.composer-wrap[^}]*position:\s*fixed/, "reference skin adds no fixed composer either");
  assert.match(app, /<div ref=\{endRef\} \/>/, "the thread keeps its end anchor so the final message stays reachable");
  assert.match(app, /data-empty=\{empty \|\| undefined\}/, "only the empty state opts into the centred rules");
});

test("composer behaviour, focus and phone safe areas are unchanged", () => {
  assert.match(app, /placeholder="Ask VibhavGPT"/, "the composer keeps its label in both states");
  assert.match(app, /\{STUDY_STARTERS\.map\(\(label\) => <button type="button"[^>]*onClick=\{\(\) => \{ setDraft\(label\); inputRef\.current\?\.focus\(\); \}\}/, "a chip fills the box and returns focus instead of sending");
  assert.match(
    app,
    /inputRef\.current\?\.closest\("\.composer"\)\?\.scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\);/,
    "focusing the box never yanks the page",
  );
  assert.match(mobile, /\.composer-wrap \{\s*padding: 4px 12px max\(12px, var\(--safe-bottom\)\);/, "the phone composer clears the gesture bar");
  assert.match(chatRef, /env\(safe-area-inset-bottom\)/, "empty-state padding respects the safe area too");
});
