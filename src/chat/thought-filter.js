// Removes a model's private reasoning from the text a user sees.
//
// Some models and endpoints return their reasoning inside the reply text
// instead of a separate field: as <think>...</think>, <thinking>, <thought>
// or <reasoning> blocks, as the gpt-oss "analysis" channel, or (common with
// Qwen3 chat templates that supply the opening tag themselves) as plain text
// ending in an orphan </think>. That text can restate system instructions and
// saved memory, so none of it may reach the user, live or saved.
//
// createThoughtFilter() works on a stream: push() each chunk and send what it
// returns. Ordinary text is returned at once; only a possible start of a tag
// at the end of a chunk ("<th") is held until the next chunk decides it. A
// block split across chunks is still removed, an unclosed block is dropped
// when the stream ends, and text inside ``` code fences is never touched, so
// an answer that shows such tags in code keeps them.

const NAMES = "think|thinking|thought|reasoning";
const OPEN = new RegExp(`<(${NAMES})(?:\\s[^<>]*)?>`, "i");
const CLOSE_ANY = new RegExp(`</(${NAMES})\\s*>`, "i");
const closeFor = (name) => new RegExp(`</${name}\\s*>`, "i");
// gpt-oss "harmony" output, when an endpoint does not parse it: the analysis
// channel is reasoning; the final channel's markers are not text.
const HARMONY_OPEN = /<\|channel\|>\s*analysis\s*<\|message\|>/i;
const HARMONY_CLOSE = /<\|end\|>/i;
const HARMONY_MARKERS = /<\|start\|>\s*assistant|<\|channel\|>\s*final\s*<\|message\|>|<\|(?:end|return|message|channel|start)\|>/gi;
const FENCE = "```";
// The longest tag or marker the filter recognises; a partial one at the end
// of a chunk is held at most this long.
const MAX_HOLD = 40;

// Could `tail` (which starts with "<" or "`") still grow into something the
// filter acts on? If not, it is plain text and is sent now.
function couldBecomeToken(tail) {
  if (tail.startsWith("`")) return /^`{1,2}$/.test(tail);
  if (tail.length > MAX_HOLD) return false;
  // "<", "</", or the start of a tag name ("<th", "</thou").
  if (/^<\/?[a-z]*$/i.test(tail)) {
    const name = tail.replace(/^<\/?/, "").toLowerCase();
    return NAMES.split("|").some((candidate) => candidate.startsWith(name));
  }
  // A full tag name still waiting for its ">" (attributes may follow).
  if (/^<\/?(?:think|thinking|thought|reasoning)(?:\s[^<>]*)?$/i.test(tail)) return true;
  // A harmony marker sequence in progress ("<|", "<|channel|>anal").
  return /^<\|[a-z|<>\s]*$/i.test(tail);
}

// Index where an incomplete token may begin at the end of `text`, or -1.
function heldTailStart(text) {
  const from = Math.max(0, text.length - MAX_HOLD);
  for (let index = from; index < text.length; index += 1) {
    if ((text[index] === "<" || text[index] === "`") && couldBecomeToken(text.slice(index))) return index;
  }
  return -1;
}

function firstMatch(text, patterns) {
  let best = null;
  for (const [kind, pattern] of patterns) {
    const match = pattern.exec(text);
    if (match && (best === null || match.index < best.index)) best = { kind, index: match.index, length: match[0].length, name: match[1]?.toLowerCase() };
  }
  return best;
}

export function createThoughtFilter() {
  let pending = "";
  let mode = "visible"; // visible | hidden | fence
  let closer = null; // what ends the hidden block
  let emitted = false; // any visible text returned so far
  // After a block that came before any answer, the line breaks that follow it
  // are not part of the answer, even when they arrive in a later chunk.
  let trimLeading = false;

  function run(input, final) {
    let text = pending + input;
    pending = "";
    let out = "";
    let discardEarlier = false;
    for (;;) {
      if (mode === "fence") {
        const end = text.indexOf(FENCE);
        if (end === -1) {
          if (final) { out += text; return { text: out, discardEarlier }; }
          // Keep a possible partial closing fence.
          const keep = text.endsWith("``") ? 2 : text.endsWith("`") ? 1 : 0;
          out += text.slice(0, text.length - keep);
          pending = text.slice(text.length - keep);
          return { text: out, discardEarlier };
        }
        out += text.slice(0, end + FENCE.length);
        text = text.slice(end + FENCE.length);
        mode = "visible";
        continue;
      }
      if (mode === "hidden") {
        const match = closer.exec(text);
        if (!match) {
          // Drop the hidden text, but keep what may be the start of its close.
          const tail = text.lastIndexOf("<");
          pending = !final && tail !== -1 && text.length - tail <= MAX_HOLD ? text.slice(tail) : "";
          return { text: out, discardEarlier };
        }
        text = text.slice(match.index + match[0].length);
        mode = "visible";
        closer = null;
        if (!out && !emitted) trimLeading = true;
        continue;
      }
      // visible
      if (trimLeading) {
        text = text.replace(/^\s+/, "");
        if (!text) return { text: out, discardEarlier };
        trimLeading = false;
      }
      const next = firstMatch(text, [["open", OPEN], ["orphan", CLOSE_ANY], ["harmony", HARMONY_OPEN], ["fence", /```/]]);
      if (!next) {
        const hold = final ? -1 : heldTailStart(text);
        const visible = hold === -1 ? text : text.slice(0, hold);
        out += visible.replace(HARMONY_MARKERS, "");
        pending = hold === -1 ? "" : text.slice(hold);
        if (out) emitted = true;
        return { text: out, discardEarlier };
      }
      const before = text.slice(0, next.index).replace(HARMONY_MARKERS, "");
      if (next.kind === "fence") {
        out += before + FENCE;
        if (out) emitted = true;
        text = text.slice(next.index + next.length);
        mode = "fence";
        continue;
      }
      if (next.kind === "orphan") {
        // A close with no open: everything before it was reasoning whose
        // opening tag the model's template supplied. What was already sent
        // must be withdrawn (discardEarlier), and nothing before it is kept.
        if (emitted || before) discardEarlier = true;
        out = "";
        emitted = false;
        text = text.slice(next.index + next.length);
        trimLeading = true;
        continue;
      }
      out += before;
      if (out) emitted = true;
      text = text.slice(next.index + next.length);
      mode = "hidden";
      closer = next.kind === "harmony" ? HARMONY_CLOSE : closeFor(next.name);
    }
  }

  return {
    // Returns { text, discardEarlier }. discardEarlier means everything
    // returned before this call was reasoning and must be withdrawn.
    push(chunk) { return run(typeof chunk === "string" ? chunk : "", false); },
    // Ends the stream: an unclosed block is dropped; held text that never
    // became a tag is returned.
    end() {
      const result = run("", true);
      mode = "visible";
      closer = null;
      return result;
    },
  };
}

// The same filter over a whole reply.
export function stripThoughts(content) {
  if (typeof content !== "string" || !content) return "";
  const filter = createThoughtFilter();
  let text = "";
  for (const part of [filter.push(content), filter.end()]) {
    if (part.discardEarlier) text = "";
    text += part.text;
  }
  return text;
}
