// Replies still being written, wherever the person is in the app: navigation and refresh resilience, not durable generation (an API
// restart ends a running reply; see docs/background-replies.md).
//
// Every reply streams from one run on the server (src/chat/live-replies.js). This store knows which of the person's replies are still
// running and which conversation each belongs to, so the app can show a "reply in progress" indicator that opens that chat, and a chat
// opened (or reloaded) while its reply runs can attach to it instead of looking finished. Attaching follows the existing run only: it
// never sends the message again, so it cannot start a second reply, save a second message or charge twice.

const running = new Map();
const listeners = new Set();
let snapshot = [];

function changed() {
  snapshot = [...running.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  for (const listener of listeners) listener();
}

export function subscribeLiveReplies(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function liveRepliesSnapshot() {
  return snapshot;
}

/** A reply this page started or attached to. "local" marks one whose stream this page is reading right now. */
export function trackLiveReply(replyId, fields = {}) {
  if (!replyId) return;
  const prior = running.get(replyId) ?? { replyId, startedAt: new Date().toISOString(), conversationId: null, label: "Writing a reply", detail: "" };
  running.set(replyId, { ...prior, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) });
  changed();
}

export function untrackLiveReply(replyId) {
  if (running.delete(replyId)) changed();
}

/** The server's list of running replies (GET /api/chat/replies). Replies this page is reading keep their live label; finished ones go. */
export function seedLiveReplies(list) {
  const ids = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry?.replyId) continue;
    ids.add(entry.replyId);
    const prior = running.get(entry.replyId);
    running.set(entry.replyId, {
      label: "Writing a reply",
      detail: "",
      ...prior,
      replyId: entry.replyId,
      conversationId: entry.conversationId ?? prior?.conversationId ?? null,
      startedAt: entry.startedAt ?? prior?.startedAt ?? new Date().toISOString(),
    });
  }
  for (const [id, entry] of running) if (!ids.has(id) && !entry.local) running.delete(id);
  changed();
}

/** The running reply for this conversation, if any. */
export function liveReplyForConversation(conversationId) {
  if (!conversationId) return null;
  return snapshot.find((entry) => entry.conversationId === conversationId) ?? null;
}

/** Which running reply the indicator should offer: one that is not in the chat on screen. */
export function backgroundReply(replies, { page, activeConversationId }) {
  return replies.find((entry) => page !== "chat" || !entry.conversationId || entry.conversationId !== activeConversationId) ?? null;
}

/**
 * Reads a reply's server-sent events. Calls onEvent(event, data, id) for each; returns when the stream ends. A malformed event throws.
 */
export async function readReplyEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (block) => {
    const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
    const encoded = block.match(/^data:\s*(.+)$/m)?.[1];
    if (!event || !encoded) return;
    const id = Number.parseInt(block.match(/^id:\s*(\d+)$/m)?.[1] ?? "", 10);
    let data;
    try { data = JSON.parse(encoded); } catch {
      throw new Error("VibhavGPT returned an unreadable response. Please retry your message.");
    }
    onEvent(event, data, Number.isInteger(id) ? id : null);
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop();
    blocks.forEach(handle);
    if (done) break;
  }
  if (buffer.trim()) handle(buffer);
}

export function resetLiveRepliesForTest() {
  running.clear();
  changed();
}
