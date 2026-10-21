import { callImagePromptModel } from "../chat/providers.js";
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

// --- Rewriting the request with a lightweight model -------------------------
//
// In an ongoing conversation, a request like "an image with all the vocab
// Study listed" needs the actual words. A fast model reads the recent turns
// and rewrites the request into one standalone visual prompt. When it is not
// available (its provider not approved, a timeout, an empty answer), the
// handoff above is used instead, so an image is never blocked on it.

export const IMAGE_PROMPT_REWRITER = "You are an image prompt specialist. Given the recent conversation history and the user's latest image request, rewrite the user's request into a detailed, descriptive, standalone visual prompt for an image generator. Extract the exact specific topics, vocabulary words, diagrams, or items discussed in the chat (e.g., specific scientific terms like DNA replication, base pairing, historical facts, or characters) so the image model has full visual context without seeing the chat history. Output ONLY the rewritten image prompt string.";
const MAX_TURNS = 8;
const MAX_REWRITE = 1500;

// Worth a rewrite: there is earlier text in the conversation to draw on.
export function shouldExpandImagePrompt(request, history = []) {
  return Boolean(String(request ?? "").trim()) && history.some((message) => message?.role === "assistant" && typeof message.content === "string" && !IMAGE_REPLY.test(message.content.trim()) && message.content.trim());
}

export function imageRewriteMessages(request, history = []) {
  const turns = history
    .filter((message) => ["user", "assistant"].includes(message?.role) && typeof message.content === "string")
    .filter((message) => !(message.role === "assistant" && IMAGE_REPLY.test(message.content.trim())))
    .slice(-MAX_TURNS)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.role === "assistant" ? shorten(plainContext(message.content), 900) : String(message.content).replace(/\s+/g, " ").trim().slice(0, 300)}`)
    .filter((line) => !/^\w+: $/.test(line));
  return [
    { role: "system", content: IMAGE_PROMPT_REWRITER },
    { role: "user", content: `Recent conversation (oldest first):\n${turns.join("\n")}\n\nLatest image request: ${String(request).trim()}` },
  ];
}

// The model's answer as a prompt: reasoning, wrapping quotes and a "Prompt:"
// label removed, one paragraph, bounded.
export function cleanRewrite(text) {
  const cleaned = stripThoughts(String(text ?? ""))
    .replace(/^\s*(?:rewritten\s+)?(?:image\s+)?prompt\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`“‘]+|["'`”’]+$/g, "")
    .trim();
  return cleaned.length > MAX_REWRITE ? shorten(cleaned, MAX_REWRITE) : cleaned;
}

// { prompt, context, expanded }: the rewritten standalone prompt when the
// model gave one, else the request with the plain handoff context.
export async function expandImagePrompt(request, history = [], { callModel = callImagePromptModel, signal, requestId } = {}) {
  const fallback = { prompt: request, context: imageHandoffContext(request, history), expanded: false };
  if (!shouldExpandImagePrompt(request, history)) return fallback;
  try {
    const { data } = await callModel(imageRewriteMessages(request, history), { signal, requestId });
    const rewritten = cleanRewrite(data?.choices?.[0]?.message?.content);
    return rewritten.length >= 12 ? { prompt: rewritten, context: "", expanded: true } : fallback;
  } catch (error) {
    if (error?.code !== "route-not-configured") {
      console.warn(JSON.stringify({ event: "image_prompt_rewrite_unavailable", errorType: error?.name ?? "Error", code: error?.code ?? "unknown" }));
    }
    return fallback;
  }
}
