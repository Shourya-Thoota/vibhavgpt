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

/* Meta-deliberation in streamed thinking.

   The thinking shown to the user should be about the user's problem, the way
   it reads in other assistants: "Defining the problem", "Checking the
   units". Models sometimes spend their thinking checking their own rules
   instead: "I identify as VibhavGPT Nova. Must not name provider or
   third-party model. Short answer, 1-3 sentences. No em dashes." None of
   that may be shown.

   createMetaThoughtFilter() judges the thinking one sentence (or line) at a
   time, at two strengths:
   - STRICT patterns are rule-checking that is never real reasoning (identity
     declarations, "no em dashes", "1-3 sentences", the system prompt or
     developer instructions, "must not name the provider"). Those sentences
     are dropped wherever they appear.
   - OPENING patterns are broader (restating the request, length and format
     rules, "my instructions", "keep it short"). They are dropped only at the
     start of a block, until the first sentence of real reasoning, so that a
     later sentence of domain reasoning is never cut ("Apply the product
     rule", "You cannot divide by zero").
   A block that is all rule-checking shows nothing at all, so no drawer
   appears for it. Text is held only until its sentence ends. */

const NAMING_VERB = String.raw`(?:nam(?:e|ing)|mention(?:ing)?|reveal(?:ing)?|disclos(?:e|ing)|confirm(?:ing)?|deny(?:ing)?|say(?:ing)?|stat(?:e|ing)|discuss(?:ing)?|expos(?:e|ing)|shar(?:e|ing))`;
const PLATFORM = String.raw`(?:provider|providers|third[- ]party|model|company|vendor|upstream|openrouter|groq|identity|architecture)`;
const STRICT_META = [
  // Identity declarations.
  /^(?:i\s+identify\s+as|i\s+am\s+(?:vibhavgpt|an\s+ai)|i'm\s+(?:vibhavgpt|an\s+ai)|as\s+(?:vibhavgpt|an\s+ai))\b/i,
  // Formatting and length rules that are never part of a problem.
  /\bno\s+(?:em|en)[\s-]?dash(?:es)?\b/i,
  /\b\d+\s*(?:-|to)\s*\d+\s+sentences?\b/i,
  // The instructions themselves.
  /\b(?:system\s+prompt|system\s+message|system\s+instructions?|developer\s+(?:message|instructions?))\b/i,
  /\bthird[- ]party\s+model\b/i,
  // "Must not name the provider", "Don't mention the model", "Never reveal upstream".
  new RegExp(String.raw`\b(?:must\s+not|mustn't|should\s+not|shouldn't|do\s+not|don't|never|can't|cannot|not\s+to)\s+${NAMING_VERB}\b[^.!?\n]{0,60}\b${PLATFORM}\b`, "i"),
  new RegExp(String.raw`^(?:not|no|never)\s+${NAMING_VERB}\b[^.!?\n]{0,60}\b${PLATFORM}\b`, "i"),
];

const OPENING_META = new RegExp([
  // Restating the request.
  String.raw`(?:the\s+)?user(?:'s)?\s+(?:is\s+|was\s+)?(?:asks?|asking|asked|wants?|wanted|says?|said|requests?|requesting|requested|would\s+like|needs?)\b`,
  String.raw`(?:the\s+)?user(?:'s)?\s+(?:query|question|request|message)\b`,
  // Talking to itself about how to answer.
  String.raw`(?:i|we)\s+(?:should|must|need\s+to|have\s+to|will|am\s+going\s+to|'m\s+going\s+to|am\s+supposed\s+to|'m\s+supposed\s+to|ought\s+to)\s+(?:answer|respond|reply|keep|stay|not|avoid|follow|comply|remember|be\s+careful|identify|introduce|mention|make\s+sure|adhere|stick|refer|present|frame|act|give|provide)\b`,
  String.raw`(?:answer|respond|reply)(?:\s+(?:directly|briefly|concisely|now|simply|plainly|shortly|warmly|politely|kindly))?\s*[.:,]`,
  String.raw`(?:give|provide)\s+(?:a|the)\s+(?:short|brief|direct|concise|simple)\s+(?:answer|reply|response)\b`,
  String.raw`(?:short|brief|concise|direct)\s+(?:answer|reply|response)\b`,
  String.raw`keep\s+(?:it|the\s+answer|the\s+reply|the\s+response|this|things)\s+(?:short|brief|concise|simple)\b`,
  String.raw`(?:no|without|avoid)\s+(?:markdown|headings?|lists?|bullets?|bullet\s+points|tables?|emojis?)\b`,
  // Its own rules and persona.
  String.raw`(?:according\s+to|per|following|based\s+on|given)\s+(?:the|my)\s+(?:system|developer|instructions?|guidelines?|rules?|persona|prompt)\b`,
  String.raw`(?:the|my|these)\s+(?:instructions?|guidelines?|rules|persona|constraints?)\b`,
  String.raw`(?:considering|reviewing|checking|recalling|following|re-?reading|weighing)\s+(?:the|my)\s+(?:instructions?|guidelines?|rules?|system|persona|constraints?|identity)\b`,
  String.raw`let\s+me\s+(?:check|recall|review|consider|re-?read)\s+(?:the|my)\s+(?:instructions?|guidelines?|rules?|system|persona)\b`,
  String.raw`(?:memory|identity)\s+(?:rules?|instructions?|directives?|constraints?)\b`,
  String.raw`(?:must\s+not|mustn't|should\s+not|shouldn't|do\s+not|don't|never|cannot|can't)\s+(?:disclose|mention|reveal|name|share|discuss|expose|use\s+(?:em|en)\s+dash|use\s+markdown)\b`,
  String.raw`(?:upstream|openrouter|groq)\b`,
].map((pattern) => `(?:${pattern})`).join("|"), "i");
// Marks a whole sentence as rule-checking wherever it appears in the opening.
const OPENING_ANYWHERE = /\b(?:my\s+instructions|the\s+instructions\s+say|persona\s+(?:rules|boundaries)|memory\s+(?:rules|directives|constraints)|guidelines\s+say)\b/i;
const OPENING_MARKUP = /^[\s>*_#-]*(?:\d+[.)]\s*)?/;

const bare = (sentence) => String(sentence ?? "").replace(OPENING_MARKUP, "").replace(/\*\*/g, "").trim();

// Rule-checking that is never reasoning: dropped anywhere in the thinking.
export function isStrictMeta(sentence) {
  const text = bare(sentence);
  return Boolean(text) && STRICT_META.some((pattern) => pattern.test(text));
}

// Rule-checking, the broad way: dropped at the start of a thinking block.
export function isMetaDeliberation(sentence) {
  const text = bare(sentence);
  if (!text) return false;
  if (isStrictMeta(text)) return true;
  const opening = OPENING_META.exec(text);
  return (opening !== null && opening.index === 0) || OPENING_ANYWHERE.test(text);
}

// Holds text until a sentence or line ends; a very long unterminated sentence
// is judged as it stands rather than held back.
const SENTENCE_END = /[.!?](?=\s|$)|\n/;
const MAX_SENTENCE_HOLD = 600;

export function createMetaThoughtFilter() {
  let opening = true;
  let held = "";
  const judgeOne = (sentence) => {
    if (opening) {
      if (isMetaDeliberation(sentence)) return "";
      // The first real reasoning ends the opening.
      opening = false;
      return sentence.replace(/^\s+/, "");
    }
    if (!isStrictMeta(sentence)) return sentence;
    // A dropped sentence keeps its line break, so the steps around it stay apart.
    return /\n\s*$/.test(sentence) ? "\n" : "";
  };
  const judge = (final) => {
    let out = "";
    for (;;) {
      const end = SENTENCE_END.exec(held);
      if (!end) {
        if (!held || (!final && held.length < MAX_SENTENCE_HOLD)) return out;
        out += judgeOne(held);
        held = "";
        return out;
      }
      const cut = end.index + end[0].length;
      const sentence = held.slice(0, cut);
      held = held.slice(cut);
      const kept = judgeOne(sentence);
      // After a dropped opening sentence, the space before the next one goes too.
      if (opening && !kept) held = held.replace(/^[ \t]+/, "");
      out += kept;
    }
  };
  return {
    push(text) {
      if (typeof text !== "string" || !text) return "";
      held += text;
      return judge(false);
    },
    // End of a block: whatever is still held is judged now.
    flush() { return judge(true); },
    // A new thinking block (the next model call) starts with its own opening.
    reset() { opening = true; held = ""; },
  };
}

// The filter over a whole block: "" when it is all rule-checking.
export function stripMetaThoughts(text) {
  const filter = createMetaThoughtFilter();
  const out = filter.push(String(text ?? "")) + filter.flush();
  return out.trim() ? out : "";
}
