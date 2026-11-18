// Keep the provider prompt conservative across model switches. This is an
// estimate, not a tokenizer: UTF-8 bytes / 3 intentionally errs high for
// ordinary English while remaining much safer than raw character counts for
// non-Latin text. Image payloads are counted as vision tokens, not base64.
export const CHAT_INPUT_TOKEN_BUDGET = 24_000;
export const VISION_IMAGE_TOKEN_ESTIMATE = 4_096;
const MAX_REFERENCE_TOKENS = 8_000;
const MAX_HISTORY_TOKENS = 7_000;
const MAX_HISTORY_SUMMARY_TOKENS = 1_200;

function textTokenEstimate(value) {
  return Math.ceil(Buffer.byteLength(String(value ?? ""), "utf8") / 3);
}

// The input tokens of a whole request (messages and tool definitions) as the
// provider receives it: its JSON text, with each image counted as a fixed
// vision estimate instead of its base64.
export function requestTokenEstimate(messages, tools) {
  const text = JSON.stringify({ messages, tools }, (key, value) => key === "image_url" ? { url: "[image]" } : value);
  const images = (messages ?? []).flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((part) => part.type === "image_url").length;
  return textTokenEstimate(text) + images * VISION_IMAGE_TOKEN_ESTIMATE;
}

// The output tokens of a finished reply: its text and any tool calls.
export function replyTokenEstimate(message) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls.map((call) => call?.function ?? {}) : [];
  return textTokenEstimate(message?.content ?? "") + (calls.length ? textTokenEstimate(JSON.stringify(calls)) : 0);
}

function contentTokenEstimate(content) {
  if (typeof content === "string") return textTokenEstimate(content);
  if (!Array.isArray(content)) return textTokenEstimate(JSON.stringify(content ?? ""));
  return content.reduce((sum, part) => {
    if (part?.type === "image_url" || part?.type === "image") return sum + VISION_IMAGE_TOKEN_ESTIMATE;
    if (typeof part?.text === "string") return sum + textTokenEstimate(part.text);
    return sum + textTokenEstimate(JSON.stringify(part ?? ""));
  }, 0);
}

export function estimateChatMessageTokens(message) {
  return 8 + contentTokenEstimate(message?.content);
}

export function estimateChatPromptTokens(messages = []) {
  return messages.reduce((sum, message) => sum + estimateChatMessageTokens(message), 0);
}

function normalizeHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter((message) => ["user", "assistant"].includes(message?.role))
    .filter((message) => typeof message.content === "string" && message.content.trim())
    // Conversation persistence stores visible turns only. Drop any accidental
    // tool-call fields so a stale/malformed row cannot create an orphan tool
    // result or leak raw tool syntax back into a later provider request.
    .map(({ id, role, content }) => ({ ...(id ? { id } : {}), role, content: content.trim() }));
}

function groupExchanges(history) {
  const groups = [];
  for (const message of history) {
    if (message.role === "user" || !groups.length) groups.push([]);
    groups.at(-1).push(message);
  }
  return groups;
}

function truncateText(value, maxTokens) {
  const text = String(value ?? "");
  const maxChars = Math.max(0, Math.floor(maxTokens * 3));
  if (text.length <= maxChars) return { text, truncated: false };
  if (maxChars < 80) return { text: "[Earlier context omitted to fit the model context window.]", truncated: true };
  const marker = "\n[… context omitted to fit the model context window …]\n";
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(available * 0.72);
  const tailLength = available - headLength;
  return {
    text: `${text.slice(0, headLength)}${marker}${tailLength ? text.slice(-tailLength) : ""}`,
    truncated: true,
  };
}

// What a person said that later turns must keep honouring: corrections, preferences, standing instructions and facts about themselves.
export const KEY_FACT_PATTERN = /\b(correction|actually|instead|anymore|i prefer|prefer|always|never|don't|do not|please (?:always|never)|remember|from now on|make sure|my (?:name|favou?rite|[a-z]+) (?:is|are)|i (?:am|live|work|use|need))\b/i;
export const SUMMARY_VERSION = "extract-v2";
const KEY_LINE_CHARS = 320;
const RECENT_LINE_CHARS = 240;

function clipLine(text, max) {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

// The abridged part of a long conversation. Built from the saved messages on every request (nothing is cached), so an edit or a deletion
// shows up at once. User lines that carry corrections, preferences or standing instructions are kept first, newest first, from anywhere in
// the abridged part; then the most recent abridged exchanges fill what is left. Lines are whole (never cut in the middle), in their original
// order, and earlier assistant replies are labelled as possibly outdated so they are never read as the person's own statements.
function historySummary(groups, maxTokens) {
  const omitted = groups.flat().map((message, index) => ({ ...message, index }));
  if (!omitted.length || maxTokens < 120) return null;
  const header = `Earlier conversation context (an abridged extract of ${omitted.length} earlier messages, oldest first; later messages and corrections take precedence over anything here):`;
  let budget = maxTokens - textTokenEstimate(header) - 16;
  const chosen = new Map();
  const take = (message, line) => {
    if (chosen.has(message.index)) return true;
    const cost = textTokenEstimate(line) + 2;
    if (cost > budget) return false;
    budget -= cost;
    chosen.set(message.index, { message, line });
    return true;
  };
  const keyFacts = omitted.filter((m) => m.role === "user" && KEY_FACT_PATTERN.test(m.content));
  const keyBudgetFloor = Math.floor(budget * 0.4);
  for (const message of [...keyFacts].reverse()) {
    if (budget <= keyBudgetFloor && chosen.size) break;
    take(message, `User: ${clipLine(message.content, KEY_LINE_CHARS)}`);
  }
  for (const message of [...omitted].reverse()) {
    const label = message.role === "user" ? "User" : "VibhavGPT (earlier reply; may be outdated)";
    if (!take(message, `${label}: ${clipLine(message.content, RECENT_LINE_CHARS)}`)) break;
  }
  // A very small budget where no whole line fits: keep the newest abridged message, shortened to what fits.
  if (!chosen.size) {
    const message = omitted.at(-1);
    const label = message.role === "user" ? "User" : "VibhavGPT (earlier reply; may be outdated)";
    const room = Math.floor((budget - 4) * 3) - label.length - 8;
    if (room >= 40) take(message, `${label}: ${clipLine(message.content, room)}`);
  }
  if (!chosen.size) return null;
  const lines = [...chosen.values()].sort((a, b) => a.message.index - b.message.index).map((entry) => entry.line);
  return {
    message: { role: "user", content: `${header}\n${lines.join("\n")}` },
    provenance: {
      version: SUMMARY_VERSION,
      omittedMessageIds: omitted.map((m) => m.id).filter(Boolean),
      includedMessageIds: [...chosen.values()].sort((a, b) => a.message.index - b.message.index).map((entry) => entry.message.id).filter(Boolean),
    },
  };
}

function fitReferences(references, maxTokens) {
  const kept = [];
  let usedTokens = 0;
  let truncated = false;
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    const remainingTokens = maxTokens - usedTokens;
    if (remainingTokens < 40) {
      truncated = true;
      break;
    }
    const candidate = { role: "user", content: String(reference?.content ?? "") };
    const tokens = estimateChatMessageTokens(candidate);
    const remainingReferences = references.length - index;
    const fairShare = Math.max(40, Math.floor(remainingTokens / remainingReferences));
    const allowance = Math.min(remainingTokens, Math.max(fairShare, Math.min(tokens, 1_600)));
    if (tokens <= allowance) {
      kept.push(candidate);
      usedTokens += tokens;
      continue;
    }
    const clipped = truncateText(candidate.content, Math.max(0, allowance - 8));
    if (clipped.text) {
      kept.push({ role: "user", content: clipped.text });
      usedTokens += estimateChatMessageTokens(kept.at(-1));
    }
    truncated = true;
  }
  if (kept.length < references.length) truncated = true;
  return { kept, usedTokens, truncated };
}

/**
 * Fit stable instructions, references, prior visible turns, and the current
 * user turn into a conservative shared context window. Recent whole exchanges
 * win; older turns become a bounded extractive summary. Tool messages are not
 * accepted as persisted history.
 */
export function fitConversationContext({
  systemMessages = [],
  history = [],
  earlierHistory = [],
  referenceMessages = [],
  currentMessage,
  maxInputTokens = CHAT_INPUT_TOKEN_BUDGET,
} = {}) {
  const systems = systemMessages.filter((message) => message?.role === "system" && typeof message.content === "string");
  const current = currentMessage && ["user", "assistant"].includes(currentMessage.role)
    ? { role: currentMessage.role, content: currentMessage.content }
    : { role: "user", content: "" };
  const normalizedHistory = normalizeHistory(history);
  const groups = groupExchanges(normalizedHistory);
  // Messages older than the loaded window that state a correction, preference or instruction: they can only ever appear in the extract.
  const earlierGroups = normalizeHistory(earlierHistory).map((message) => [message]);
  const base = [...systems, current];
  const baseTokens = estimateChatPromptTokens(base);
  if (baseTokens > maxInputTokens) {
    return { ok: false, reason: "current-turn-too-large", estimatedTokens: baseTokens, maxInputTokens };
  }

  const remaining = maxInputTokens - baseTokens;
  const hasHistory = groups.length > 0 || earlierGroups.length > 0;
  const summaryReserve = hasHistory ? Math.min(MAX_HISTORY_SUMMARY_TOKENS, Math.floor(remaining * 0.12)) : 0;
  const historyReserve = hasHistory ? Math.min(MAX_HISTORY_TOKENS, Math.floor(remaining * 0.38)) : 0;
  const referenceBudget = Math.min(MAX_REFERENCE_TOKENS, Math.max(0, remaining - historyReserve - summaryReserve));
  const references = fitReferences(referenceMessages, referenceBudget);
  let historyBudget = Math.min(MAX_HISTORY_TOKENS, Math.max(0, remaining - references.usedTokens));
  const availableForRecent = Math.max(0, historyBudget - summaryReserve);

  const recentGroups = [];
  let recentTokens = 0;
  let firstKept = groups.length;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    const groupTokens = estimateChatPromptTokens(group);
    if (recentTokens + groupTokens <= availableForRecent) {
      recentGroups.unshift(group);
      recentTokens += groupTokens;
      firstKept = index;
      continue;
    }
    // Keep a clipped most-recent exchange instead of discarding it wholesale.
    if (!recentGroups.length && availableForRecent > 100) {
      const clippedGroup = [];
      let groupBudget = availableForRecent;
      for (const message of group) {
        if (groupBudget < 40) break;
        const clipped = truncateText(message.content, groupBudget - 8);
        const normalized = { role: message.role, content: clipped.text };
        const cost = estimateChatMessageTokens(normalized);
        clippedGroup.push(normalized);
        groupBudget -= cost;
      }
      if (clippedGroup.length) {
        recentGroups.unshift(clippedGroup);
        recentTokens = estimateChatPromptTokens(clippedGroup);
        firstKept = index;
      }
    }
    break;
  }

  const omittedGroups = [...earlierGroups, ...groups.slice(0, firstKept)];
  let compacted = historySummary(omittedGroups, Math.min(summaryReserve, Math.max(0, historyBudget - recentTokens)));
  let summary = compacted?.message ?? null;
  let messages = [...systems, ...(summary ? [summary] : []), ...recentGroups.flat(), ...references.kept, current];
  let estimatedTokens = estimateChatPromptTokens(messages);

  // Estimation and per-message overhead can differ slightly after clipping.
  // If necessary, sacrifice the oldest retained context, never the current
  // turn or stable system rules.
  while (estimatedTokens > maxInputTokens && recentGroups.length) {
    recentGroups.shift();
    const priorGroups = omittedGroups.concat(recentGroups.length ? [] : groups.slice(firstKept));
    compacted = historySummary(priorGroups, Math.min(MAX_HISTORY_SUMMARY_TOKENS, Math.max(0, maxInputTokens - baseTokens - references.usedTokens - 150)));
    summary = compacted?.message ?? null;
    messages = [...systems, ...(summary ? [summary] : []), ...recentGroups.flat(), ...references.kept, current];
    estimatedTokens = estimateChatPromptTokens(messages);
  }

  return {
    ok: estimatedTokens <= maxInputTokens,
    messages,
    estimatedTokens,
    maxInputTokens,
    historyMessages: normalizedHistory.length,
    keptHistoryMessages: recentGroups.flat().length,
    historySummarized: Boolean(summary),
    // Which saved messages were abridged and which made it into the extract: ids only, never text.
    summaryProvenance: compacted?.provenance ?? null,
    referencesTruncated: references.truncated,
  };
}
