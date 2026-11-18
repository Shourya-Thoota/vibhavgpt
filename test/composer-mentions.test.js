import test from "node:test";
import assert from "node:assert/strict";

import {
  connectorsFromMentions, deleteWholeMention, detectMentionTrigger, draftSegments, insertMention, isIntact, mentionToken, reconcileMentions, serializeDraft,
} from "../frontend/src/composer-mentions.js";

// Inline @mentions: the text shows "@YouTube" in the sentence, a record beside it says which connector that is, and only the record routes.

const YOUTUBE = { id: "youtube", label: "YouTube" };
const DRIVE = { id: "googledrive", label: "Google Drive" };
const empty = (text = "") => ({ text, mentions: [] });
const typed = (state, text) => ({ text, mentions: reconcileMentions(state.text, state.mentions, text) });

// "Find @yo|" with the caret at the end, as the person typed it, then YouTube chosen from the list.
function chosen(before, query, connector, after = "") {
  const text = `${before}@${query}${after}`;
  const trigger = { replaceStart: before.length, replaceEnd: before.length + 1 + query.length };
  return insertMention(empty(text), trigger, connector);
}

test("choosing a connector puts @Name in the sentence at the caret, keeps the text on both sides, and puts the caret after it", () => {
  const result = chosen("Show my latest ", "yo", YOUTUBE, " videos please");
  assert.equal(result.text, "Show my latest @YouTube videos please");
  assert.equal(result.caret, "Show my latest @YouTube ".length, "the caret is after the mention and its space, ready to keep typing");
  assert.deepEqual(result.mentions, [{ id: "youtube", label: "YouTube", start: 15, end: 23 }]);
  assert.equal(result.text.slice(15, 23), mentionToken("YouTube"));
});

test("a space is added after the mention unless one is already there", () => {
  assert.equal(chosen("", "yo", YOUTUBE).text, "@YouTube ");
  assert.equal(chosen("", "yo", YOUTUBE, " and more").text, "@YouTube and more");
  assert.equal(chosen("use ", "", YOUTUBE).text, "use @YouTube ");
});

test("the mention is part of the sentence: no separate row, and the connector's name is the only thing added to the text", () => {
  const result = chosen("Search ", "", DRIVE);
  assert.equal(result.text, "Search @Google Drive ");
  assert.equal(serializeDraft(result).content, "Search @Google Drive");
});

test("several mentions: each is recorded, each moves with edits before it, and they come out in the order mentioned", () => {
  let state = chosen("Compare ", "yo", YOUTUBE);
  state = { text: `${state.text}with @dr`, mentions: state.mentions };
  const second = insertMention(state, { replaceStart: state.text.length - 3, replaceEnd: state.text.length }, DRIVE);
  assert.equal(second.text, "Compare @YouTube with @Google Drive ");
  assert.deepEqual(second.mentions.map((m) => m.id), ["youtube", "googledrive"]);
  // Typing at the front shifts both ranges by the same amount.
  const shifted = typed(second, `Please ${second.text}`);
  assert.deepEqual(shifted.mentions.map((m) => [m.id, shifted.text.slice(m.start, m.end)]), [["youtube", "@YouTube"], ["googledrive", "@Google Drive"]]);
  assert.deepEqual(connectorsFromMentions(shifted.mentions), [{ id: "youtube", name: "YouTube" }, { id: "googledrive", name: "Google Drive" }]);
});

test("a mention inserted before an existing one moves the existing one and keeps it intact", () => {
  const first = chosen("end: ", "dr", DRIVE);
  const inserted = insertMention({ text: `@yo ${first.text}`, mentions: first.mentions.map((m) => ({ ...m, start: m.start + 4, end: m.end + 4 })) }, { replaceStart: 0, replaceEnd: 3 }, YOUTUBE);
  assert.deepEqual(inserted.mentions.map((m) => [m.id, inserted.text.slice(m.start, m.end)]), [["youtube", "@YouTube"], ["googledrive", "@Google Drive"]]);
});

test("editing text after, before or between mentions leaves them recorded and correctly placed", () => {
  const base = chosen("Find ", "yo", YOUTUBE, " clips");
  for (const edit of ["Find @YouTube clips now", "Please find @YouTube clips", "Find  @YouTube clips", "Find @YouTube, clips"]) {
    const next = typed(base, edit);
    assert.equal(next.mentions.length, 1, edit);
    assert.equal(next.text.slice(next.mentions[0].start, next.mentions[0].end), "@YouTube", edit);
  }
});

test("changing a mention in any way removes it, and with it the routing", () => {
  const base = chosen("Find ", "yo", YOUTUBE, " clips");
  assert.equal(typed(base, "Find @YouTub clips").mentions.length, 0, "a letter deleted from the end");
  assert.equal(typed(base, "Find @ouTube clips").mentions.length, 0, "a letter deleted from the start");
  assert.equal(typed(base, "Find @YouXTube clips").mentions.length, 0, "a letter typed inside");
  assert.equal(typed(base, "Find @Youtube clips").mentions.length, 0, "a letter's case changed");
  assert.equal(typed(base, "Find  clips").mentions.length, 0, "all of it deleted");
  assert.equal(typed(base, "Find @YouTube2 clips".replace(" ", " ")).mentions.length, 0, "run into a following word character");
  assert.equal(typed(base, "FindX @YouTube clips").mentions.length, 1, "a change that stops before it leaves it alone");
  assert.equal(connectorsFromMentions(typed(base, "Find @YouTub clips").mentions).length, 0, "nothing is left to route to");
});

test("typing against a mention so that it becomes part of a longer word removes it", () => {
  const base = chosen("", "yo", YOUTUBE);
  assert.equal(typed(base, "@YouTube s").mentions.length, 1, "a space after it is fine");
  assert.equal(typed(base, "@YouTubes").mentions.length, 0);
  assert.equal(typed({ text: "x @YouTube", mentions: [{ id: "youtube", label: "YouTube", start: 2, end: 10 }] }, "xy@YouTube").mentions.length, 0, "joined to a word on the left");
});

test("selecting across a mention and replacing it, or pasting over it, removes only that mention", () => {
  let state = chosen("Compare ", "yo", YOUTUBE);
  state = typed(state, `${state.text}with @dr`);
  state = insertMention(state, { replaceStart: state.text.length - 3, replaceEnd: state.text.length }, DRIVE);
  const replaced = typed(state, state.text.replace("@YouTube", "videos"));
  assert.deepEqual(replaced.mentions.map((m) => m.id), ["googledrive"]);
  assert.equal(replaced.text.slice(replaced.mentions[0].start, replaced.mentions[0].end), "@Google Drive");
});

test("Backspace at the end of a mention, or Delete at its start, removes the whole mention and puts the caret where it was", () => {
  const base = chosen("Hello ", "yo", YOUTUBE, " world");
  const mention = base.mentions[0];
  const backward = deleteWholeMention(base, mention.end, "backward");
  assert.equal(backward.text, "Hello  world");
  assert.equal(backward.caret, mention.start);
  assert.deepEqual(backward.mentions, []);
  const forward = deleteWholeMention(base, mention.start, "forward");
  assert.equal(forward.text, "Hello  world");
  assert.equal(deleteWholeMention(base, mention.end + 2, "backward"), null, "elsewhere the key does its ordinary thing");
  assert.equal(deleteWholeMention(base, mention.start, "backward"), null, "Backspace at the start is not at the end of anything");
});

test("typing '@YouTube' by hand, pasting it, or restoring it from an old draft records nothing and routes nothing", () => {
  assert.deepEqual(serializeDraft(typed(empty(), "ask @YouTube about it")), { content: "ask @YouTube about it", selectedConnectors: [] });
  const pasted = typed(empty("start "), "start @YouTube @Google Drive");
  assert.deepEqual(pasted.mentions, []);
  assert.deepEqual(serializeDraft(pasted).selectedConnectors, []);
});

test("serialization sends the text as written and the structured ids, once each, in order", () => {
  let state = chosen("Use ", "yo", YOUTUBE, " and ");
  state = typed(state, `${state.text}@dr`);
  state = insertMention(state, { replaceStart: state.text.length - 3, replaceEnd: state.text.length }, DRIVE);
  state = typed(state, `${state.text}then @YouTube again`);
  assert.deepEqual(serializeDraft(state), { content: "Use @YouTube and @Google Drive then @YouTube again", selectedConnectors: ["youtube", "googledrive"] });
});

test("serialization ignores a mention whose text no longer matches, even if a stale record remains", () => {
  const stale = { text: "see @YouTub", mentions: [{ id: "youtube", label: "YouTube", start: 4, end: 12 }] };
  assert.deepEqual(serializeDraft(stale).selectedConnectors, []);
  assert.equal(isIntact(stale.text, stale.mentions[0]), false);
});

test("clearing the draft after a send clears every mention", () => {
  const state = chosen("Find ", "yo", YOUTUBE);
  assert.deepEqual(typed(state, "").mentions, []);
  assert.deepEqual(typed(chosen("", "yo", YOUTUBE), "Hello").mentions, []);
});

test("input composition (IME) that rewrites text next to a mention keeps or drops it correctly at every step", () => {
  const base = chosen("", "yo", YOUTUBE);
  // The composition candidates replace the text after the mention; the mention is untouched throughout.
  let state = base;
  for (const step of ["@YouTube に", "@YouTube にほ", "@YouTube にほん", "@YouTube 日本"]) state = typed(state, step);
  assert.equal(state.mentions.length, 1);
  assert.equal(state.text.slice(state.mentions[0].start, state.mentions[0].end), "@YouTube");
  // Composing in front of it moves it.
  state = typed(state, `か${state.text}`);
  assert.equal(state.text.slice(state.mentions[0].start, state.mentions[0].end), "@YouTube");
});

test("emoji and other astral characters before a mention do not misplace it", () => {
  const base = chosen("😀 look ", "yo", YOUTUBE);
  assert.equal(base.text.slice(base.mentions[0].start, base.mentions[0].end), "@YouTube");
  const next = typed(base, `🎉🎉${base.text}`);
  assert.equal(next.text.slice(next.mentions[0].start, next.mentions[0].end), "@YouTube");
});

test("a long draft that wraps keeps every mention in place", () => {
  const filler = "word ".repeat(120);
  let state = chosen(filler, "yo", YOUTUBE, " end");
  state = typed(state, `intro ${state.text}`);
  assert.equal(state.text.slice(state.mentions[0].start, state.mentions[0].end), "@YouTube");
  assert.equal(state.mentions.length, 1);
});

test("segments split the draft into plain runs and mentions for drawing the highlight, and agree with the text", () => {
  const state = chosen("Find ", "yo", YOUTUBE, " clips");
  const segments = draftSegments(state.text, state.mentions);
  assert.deepEqual(segments, [{ text: "Find " }, { text: "@YouTube", mention: { id: "youtube" } }, { text: " clips" }]);
  assert.equal(segments.map((s) => s.text).join(""), state.text);
  assert.deepEqual(draftSegments("plain text", []), [{ text: "plain text" }]);
  assert.deepEqual(draftSegments("", []), []);
  // A record that no longer matches is not drawn.
  assert.deepEqual(draftSegments("see @YouTub", [{ id: "youtube", label: "YouTube", start: 4, end: 12 }]), [{ text: "see @YouTub" }]);
});

test("the picker opens for a new @, not inside a mention that is already in the sentence", () => {
  const state = chosen("Find ", "yo", YOUTUBE, " clips");
  const inside = detectMentionTrigger(state.text, 9, { mentions: state.mentions });
  assert.equal(inside, null, "the caret inside @YouTube does not reopen the list");
  const fresh = detectMentionTrigger("Find @YouTube clips @dr", 23, { mentions: state.mentions });
  assert.equal(fresh?.kind, "connector");
  assert.equal(fresh?.query, "dr");
  assert.equal(detectMentionTrigger("Find @yo", 8, { mentions: [] })?.query, "yo");
});
