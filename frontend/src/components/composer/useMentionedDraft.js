import { useCallback, useRef, useState } from "react";
import { deleteWholeMention, insertMention as insertMentionInto, reconcileMentions } from "../../composer-mentions.js";

// The composer's draft and the mentions inside it, kept together. Every way the text changes goes through setDraft, so each change moves,
// keeps or drops the mentions with it (src/composer-mentions.js): typing, pasting, dictation, a starter filling the box, a retry putting a
// message back, and the box being cleared after a send. The latest state is also held in a ref, so two changes in one tick and the
// reads in an event handler see the same thing.
export function useMentionedDraft(initialText = "") {
  const [state, setState] = useState({ text: initialText, mentions: [] });
  const latest = useRef(state);
  const commit = (next) => { latest.current = next; setState(next); };

  const setDraft = useCallback((next) => {
    const current = latest.current;
    const text = typeof next === "function" ? next(current.text) : next;
    if (text === current.text) return;
    commit({ text, mentions: reconcileMentions(current.text, current.mentions, text) });
  }, []);

  /** Puts a mention of `connector` ({ id, label }) where the "@query" was, and returns where the caret goes. */
  const insertMention = useCallback((trigger, connector) => {
    const result = insertMentionInto(latest.current, trigger, connector);
    commit({ text: result.text, mentions: result.mentions });
    return result.caret;
  }, []);

  /** Backspace / Delete against a mention removes all of it. Returns the new caret, or null when the key should do its ordinary thing. */
  const deleteMention = useCallback((caret, direction) => {
    const result = deleteWholeMention(latest.current, caret, direction);
    if (!result) return null;
    commit({ text: result.text, mentions: result.mentions });
    return result.caret;
  }, []);

  const read = useCallback(() => latest.current, []);

  return { draft: state.text, mentions: state.mentions, setDraft, insertMention, deleteMention, read };
}
