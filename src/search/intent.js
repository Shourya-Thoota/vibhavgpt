import { callSearchIntentModel } from "../chat/providers.js";

// This is deliberately broad enough to catch messy current-information
// questions before the old vocabulary matcher has a chance to miss them. It
// is not used for ordinary conversational prompts.
const CURRENT_INTENT_HINT = /\b(?:today|tonight|yesterday|tomorrow|current|latest|recent|right\s+now|live|score|result|winner|won|win|game|match|season|schedule|weather|forecast|price|stock|news|headlines?)\b/i;

export function shouldInterpretSearchIntent(message) {
  const text = String(message ?? "").trim();
  return text.length >= 8 && CURRENT_INTENT_HINT.test(text);
}

function parseJsonObject(value) {
  if (typeof value !== "string") return null;
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? value;
  const candidate = fenced.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function cleanString(value, max = 180) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function validateSearchIntent(value) {
  if (!value || typeof value !== "object") return null;
  const topic = cleanString(value.topic, 120);
  const queryType = cleanString(value.query_type, 60);
  const timeframe = cleanString(value.timeframe, 80);
  const searchQuery = cleanString(value.search_query, 240);
  const entities = Array.isArray(value.entities)
    ? value.entities.filter((item) => typeof item === "string").map((item) => item.trim().slice(0, 80)).filter(Boolean).slice(0, 8)
    : [];
  if (!topic && !searchQuery) return null;
  return {
    needs_search: value.needs_search !== false,
    topic,
    query_type: queryType || "current_fact",
    timeframe,
    entities,
    search_query: searchQuery,
  };
}

function intentPrompt(history, message) {
  const context = history
    .filter((item) => item?.role === "user" || item?.role === "assistant")
    .slice(-6)
    .map((item) => `${item.role}: ${String(item.content ?? "").slice(0, 500)}`)
    .join("\n");
  return [
    {
      role: "system",
      content: [
        "Interpret a user's likely intent for a current-information web search.",
        "Correct obvious spelling errors, including multiple errors in a multi-word entity.",
        "Resolve short follow-ups using the supplied conversation context.",
        "Do not answer the question and do not invent facts.",
        'Return JSON only with exactly these keys: needs_search (boolean), topic (string), query_type (string), timeframe (string), entities (string array), search_query (string).',
        'query_type should be a short label such as match_result, schedule, weather, news, market_price, or current_fact.',
        "search_query should be a concise, correctly spelled query for a search engine, preserving the user's requested timeframe.",
      ].join(" "),
    },
    ...(context ? [{ role: "user", content: `Conversation context:\n${context}` }] : []),
    { role: "user", content: `Current message:\n${message}` },
  ];
}

export async function interpretSearchIntent(message, history = [], { callModel = callSearchIntentModel, signal, requestId } = {}) {
  if (!shouldInterpretSearchIntent(message)) return null;
  try {
    const { data } = await callModel(
      intentPrompt(history, message),
      { maxTokens: 320, signal, requestId },
    );
    const content = data?.choices?.[0]?.message?.content;
    return validateSearchIntent(parseJsonObject(content));
  } catch (error) {
    // An unapproved provider is not a failure: the built-in search rules
    // (the deterministic plan) are used, as they are for any message here.
    if (error?.code !== "route-not-configured") {
      console.warn(JSON.stringify({ event: "search_intent_unavailable", errorType: error?.name ?? "Error", code: error?.code ?? "unknown" }));
    }
    return null;
  }
}
