// Inline @mentions in the composer.
//
// The draft is plain text in a native textarea (so the caret, selection, IME composition, undo and paste all behave as they do everywhere).
// A mention is a record kept beside the text: which connector it is, and the range of the text that shows it, such as "@YouTube". The text
// shown and the connector chosen are two different things, and only the record decides what a message is routed to:
//   - choosing a connector from the list inserts "@Name " at the caret and records the range;
//   - every change to the text moves each range with it, and a range is kept only while the text under it is still exactly "@Name" with a
//     boundary on both sides. Edit it, split it, type against it, or delete part of it, and the mention is gone, with its routing;
//   - the connectors a message is routed to are read only from the ranges that are still intact. Typing "@YouTube" yourself, pasting it, or
//     restoring it from an older draft records nothing, so it routes nothing.
// Pure functions on { text, mentions }, with no DOM, so every rule is tested directly (test/composer-mentions.test.js).

const WORD = /[A-Za-z0-9_]/;

export const mentionToken = (label) => `@${label}`;

/** A mention is intact while the text under its range is its token, not run into a neighbouring word. */
export function isIntact(text, mention) {
  if (!mention || !Number.isInteger(mention.start) || !Number.isInteger(mention.end) || mention.start < 0 || mention.end > text.length) return false;
  if (text.slice(mention.start, mention.end) !== mentionToken(mention.label)) return false;
  const before = mention.start > 0 ? text[mention.start - 1] : "";
  const after = mention.end < text.length ? text[mention.end] : "";
  return !(before && WORD.test(before)) && !(after && WORD.test(after));
}

/**
 * The mentions that survive a change of the text from `oldText` to `newText`, moved to where they now are.
 * The edit is found by comparing the two texts from both ends. A mention wholly before the edit stays, one wholly after it moves by the
 * change in length, and one the edit touches is dropped. When the same characters repeat around an edit the position can be ambiguous; that
 * can only drop a mention (never keep a wrong one), and the connector is then simply not routed.
 */
export function reconcileMentions(oldText, mentions, newText) {
  if (oldText === newText || !mentions.length) return mentions;
  const max = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < max && oldText[prefix] === newText[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < max - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix += 1;
  const editEnd = oldText.length - suffix;
  const delta = newText.length - oldText.length;
  const kept = [];
  for (const mention of mentions) {
    let next;
    if (mention.end <= prefix) next = mention;
    else if (mention.start >= editEnd) next = { ...mention, start: mention.start + delta, end: mention.end + delta };
    else continue;
    if (isIntact(newText, next)) kept.push(next);
  }
  return kept;
}

/**
 * Inserts a mention of `connector` ({ id, label }) in place of the "@query" the person typed (`trigger.replaceStart` to `replaceEnd`).
 * A space follows it unless one is already there, so the sentence carries on. Returns the new text, mentions and caret position.
 */
export function insertMention({ text, mentions }, trigger, connector) {
  const token = mentionToken(connector.label);
  const following = text[trigger.replaceEnd] ?? "";
  const insertion = token + (following && /\s/.test(following) ? "" : " ");
  const newText = text.slice(0, trigger.replaceStart) + insertion + text.slice(trigger.replaceEnd);
  const delta = insertion.length - (trigger.replaceEnd - trigger.replaceStart);
  const moved = mentions.flatMap((mention) => {
    if (mention.end <= trigger.replaceStart) return [mention];
    if (mention.start >= trigger.replaceEnd) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
    return [];
  });
  const added = { id: connector.id, label: connector.label, start: trigger.replaceStart, end: trigger.replaceStart + token.length };
  const all = [...moved, added].filter((mention) => isIntact(newText, mention)).sort((a, b) => a.start - b.start);
  // The caret goes past the space that follows (the one added, or the one already there), so the next letter typed starts a new word
  // and cannot run into the mention.
  return { text: newText, mentions: all, caret: trigger.replaceStart + token.length + 1 };
}

/**
 * Backspace at the end of a mention, or Delete at its start, removes the whole mention. Returns the new state, or null when the caret is
 * not against a mention (the key then does its ordinary thing).
 */
export function deleteWholeMention({ text, mentions }, caret, direction) {
  const mention = mentions.find((entry) => (direction === "backward" ? entry.end === caret : entry.start === caret));
  if (!mention) return null;
  const newText = text.slice(0, mention.start) + text.slice(mention.end);
  return { text: newText, mentions: reconcileMentions(text, mentions, newText), caret: mention.start };
}

/** The connectors a message is routed to: one entry per connector that still has an intact mention, in the order mentioned. */
export function connectorsFromMentions(mentions) {
  const seen = new Set();
  const out = [];
  for (const mention of mentions) {
    if (seen.has(mention.id)) continue;
    seen.add(mention.id);
    out.push({ id: mention.id, name: mention.label });
  }
  return out;
}

/** What is sent for a draft: the text as written, and the structured connector ids behind its mentions. */
export function serializeDraft({ text, mentions }) {
  return { content: text.trim(), selectedConnectors: connectorsFromMentions(mentions.filter((mention) => isIntact(text, mention))).map((entry) => entry.id) };
}

/** The draft split into plain runs and mentions, for drawing the highlight behind the text. */
export function draftSegments(text, mentions) {
  const segments = [];
  let at = 0;
  for (const mention of [...mentions].sort((a, b) => a.start - b.start)) {
    if (mention.start < at || !isIntact(text, mention)) continue;
    if (mention.start > at) segments.push({ text: text.slice(at, mention.start) });
    segments.push({ text: text.slice(mention.start, mention.end), mention: { id: mention.id } });
    at = mention.end;
  }
  if (at < text.length) segments.push({ text: text.slice(at) });
  return segments;
}

/**
 * The "@" or "/" query open at the caret, or null. An "@" that is part of a mention already in the sentence never opens the list again, so
 * moving the caret through "@YouTube" does not pop it up.
 */
export function detectMentionTrigger(text, cursor, { suppress = false, mentions = [] } = {}) {
  if (suppress || typeof text !== "string" || cursor == null) return null;
  const before = text.slice(0, cursor);

  const skill = detectSkillSlash(before, cursor);
  if (skill) return skill;

  const atIndex = before.lastIndexOf("@");
  if (atIndex < 0) return null;
  if (mentions.some((mention) => atIndex >= mention.start && atIndex < mention.end && isIntact(text, mention))) return null;
  const charBefore = atIndex > 0 ? before[atIndex - 1] : "";
  if (/[\w.-]/.test(charBefore)) return null;
  const query = before.slice(atIndex + 1);
  if (/\s/.test(query)) return null;
  return {
    kind: "connector",
    query,
    replaceStart: atIndex,
    replaceEnd: cursor,
  };
}

function detectSkillSlash(before, cursor) {
  const lastLineStart = before.lastIndexOf("\n") + 1;
  const linePrefix = before.slice(lastLineStart);
  const match = linePrefix.match(/^(\s*)\//);
  if (!match) return null;
  const slashIndex = lastLineStart + match[1].length;
  const afterSlash = before.slice(slashIndex + 1);
  if (/\s/.test(afterSlash)) return null;
  const protocolTail = linePrefix.slice(0, match[0].length - 1).trimEnd();
  if (/https?:$/i.test(protocolTail)) return null;
  return {
    kind: "skill",
    query: afterSlash,
    replaceStart: slashIndex,
    replaceEnd: cursor,
  };
}
