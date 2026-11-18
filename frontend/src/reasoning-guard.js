import { createThoughtFilter } from "./thought-filter.js";

// The live text of a reply, through the same filter the server uses (thought-filter.js is its client copy). The server already filters
// what it sends and tells the app to withdraw text it later finds was reasoning; this is the second line, for anything that reaches the
// page with a reasoning tag still in it:
// - ordinary text passes through in the same call, so a normal reply is not delayed at all;
// - a possible start of a tag at the end of a chunk ("<th") is held only until the next chunk decides it, so a tag split across
//   chunks never shows;
// - a closing tag with no opening one means everything before it was reasoning: discardEarlier says to clear what was shown.
// What cannot be known early: plain text that is reasoning but has no tag yet looks like any other text until its closing tag arrives.
// That text is shown until then and withdrawn at once when the tag does (here, or by the server), and it is never saved.
export function createReplyStreamGuard() {
  let filter = createThoughtFilter();
  return {
    /** { text, discardEarlier } for one chunk of reply text. */
    push(chunk) { return filter.push(chunk); },
    /** The reply ended or failed: whatever was held is judged now, then the guard starts clean. */
    end() { const result = filter.end(); filter = createThoughtFilter(); return result; },
    /** The reply started over (another model call): nothing carries across. */
    reset() { filter = createThoughtFilter(); },
  };
}
