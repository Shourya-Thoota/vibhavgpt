import { stripThoughts } from "../chat/thought-filter.js";

// An image asked for in a chat or Study conversation often points back at
// what the assistant just wrote: "make an image of that analogy", "draw the
// flashcards", "illustrate the character you described". The image model
// sees only its prompt, so such a request is sent with the assistant's most
// recent reply, cleaned to plain prose and kept short. A request that stands
// on its own ("a red fox in fresh snow") is sent as it is.

const MAX_CONTEXT_CHARS = 1200;
// Saved for a reply that was itself an image; nothing to hand on from it.
const IMAGE_REPLY = /^I created this image for you\.?$/i;

const POINTER = "(?:that|this|these|those|it|them)";
const ARTIFACT = "(?:cards?|flashcards?|analog(?:y|ies)|diagrams?|descriptions?|characters?|scenes?|story|stories|explanations?|summary|summaries|examples?|concepts?|steps|plan|poem|outline|notes|definitions?|metaphors?|ideas?|answer|list|setting|creature|design)";
const REFERS_BACK = [
  /\b(?:above|previous|earlier|the same)\b/i,
  /\byou(?:'ve|\s+have)?\s+(?:just\s+)?(?:said|described|wrote|written|explained|made|listed|suggested|mentioned|gave|created|came\s+up\s+with)\b/i,
  new RegExp(String.raw`\b(?:based\s+on|from|of|for|showing|illustrating|about|depicting|visuali[sz]ing)\s+${POINTER}\b`, "i"),
  new RegExp(String.raw`\b(?:draw|illustrate|visuali[sz]e|depict|sketch|paint|render|picture)\s+${POINTER}\b`, "i"),
  // "the flashcards", "that solar kitchen analogy": up to three words between.
  new RegExp(String.raw`\b(?:the|your|these|those|each|every|that|this)\s+(?:[\w'-]+\s+){0,3}${ARTIFACT}\b`, "i"),
];

export function refersToConversation(request) {
  const text = String(request ?? "");
  return REFERS_BACK.some((pattern) => pattern.test(text));
}

// Markdown, code and links read as clutter (or as text to paint) to an image
// model; what is left is the reply's plain meaning.
export function plainContext(markdown) {
  return stripThoughts(String(markdown ?? ""))
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "; ")
    // A table: its divider row goes, and each row reads as its cells.
    .replace(/^\s*\|?\s*:?-{3,}[\s|:-]*$/gm, "")
    .replace(/^\s*\|(.*)\|\s*$/gm, (_row, cells) => `; ${cells.split("|").map((cell) => cell.trim()).filter(Boolean).join(", ")}`)
    .replace(/(\*\*|__|\*|_|`)/g, "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/(?:^|\s);\s*/g, (match, offset) => (offset === 0 ? "" : "; "))
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s;,]+|[\s;,]+$/g, "");
}

function shorten(text, limit = MAX_CONTEXT_CHARS) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const sentence = cut.lastIndexOf(". ");
  return (sentence > limit * 0.6 ? cut.slice(0, sentence + 1) : cut.slice(0, cut.lastIndexOf(" "))).trim();
}

// The context to send with an image request, or "" when it needs none.
export function imageHandoffContext(request, history = []) {
  if (!refersToConversation(request)) return "";
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== "assistant" || typeof message.content !== "string") continue;
    if (IMAGE_REPLY.test(message.content.trim())) continue;
    const context = shorten(plainContext(message.content));
    if (context) return context;
  }
  return "";
}
