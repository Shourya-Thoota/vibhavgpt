// Replies that keep running when the page that asked for them goes away: navigation and refresh resilience, NOT durable generation.
// A reply survives the person leaving, opening another chat or reloading; it does not survive the API process restarting. What a restart
// does to a running reply, its partial text and its credit hold, and the plan for restart-safe recovery: docs/background-replies.md.
//
// A streaming reply is one run on this server. Its events (status, deltas, the saved conversation, complete or error) are numbered and kept
// here while it runs and for a short while after, so the person who asked for it can attach again (after a reload, or from another chat)
// and see the same reply continue. Attaching only replays and follows the run that already exists: it never starts inference, saves a
// message or charges anything. Only the person who started a reply can see, attach to or stop it; anyone else is told it does not exist.
//
// A run lives in this process's memory. The API runs as one replica; a deploy or restart ends a run exactly as it did before this existed
// (the saved message stays, ready to retry), and attaching then finds nothing, so the page reloads the conversation instead.
import { randomUUID } from "node:crypto";

const replies = new Map();
// How long a finished reply stays attachable, so a page that reloads just as it finishes still gets the end of it.
const KEEP_AFTER_DONE_MS = 60_000;
// A reply's events are capped; past the cap a late attach cannot replay it and reloads the saved conversation instead.
const MAX_EVENTS = 20_000;
const MAX_BYTES = 4 * 1024 * 1024;

/** Starts tracking a reply. abort() stops its inference (the same signal a disconnect used to send). */
export function startLiveReply({ userId, conversationId = null, mode = "chat", abort }) {
  const entry = {
    id: randomUUID(),
    userId,
    conversationId,
    mode: mode === "study" ? "study" : mode === "build" ? "build" : "chat",
    startedAt: new Date().toISOString(),
    phase: "preparing",
    events: [],
    bytes: 0,
    overflow: false,
    seq: 0,
    done: false,
    stopped: false,
    listeners: new Set(),
    abort,
  };
  replies.set(entry.id, entry);
  return entry;
}

/** Records one event and hands it to everyone attached. Returns its sequence number. */
export function recordLiveEvent(entry, event, data) {
  const seq = ++entry.seq;
  if (event === "status" && typeof data?.phase === "string") entry.phase = data.phase;
  if (event === "conversation" && typeof data?.conversationId === "string") entry.conversationId = data.conversationId;
  if (event === "complete" && typeof data?.conversationId === "string") entry.conversationId = data.conversationId;
  const item = { seq, event, data };
  if (!entry.overflow) {
    const size = JSON.stringify(data ?? null).length;
    if (entry.events.length >= MAX_EVENTS || entry.bytes + size > MAX_BYTES) {
      entry.overflow = true;
      entry.events = [];
    } else {
      entry.events.push(item);
      entry.bytes += size;
    }
  }
  for (const listener of entry.listeners) listener.onEvent(item);
  return seq;
}

export function finishLiveReply(entry) {
  if (entry.done) return;
  entry.done = true;
  for (const listener of entry.listeners) listener.onEnd();
  entry.listeners.clear();
  const timer = setTimeout(() => { if (replies.get(entry.id) === entry) replies.delete(entry.id); }, KEEP_AFTER_DONE_MS);
  timer.unref?.();
}

/** This person's reply, or null for a reply that does not exist, has expired, or is someone else's (never told apart). */
export function liveReplyFor(userId, replyId) {
  const entry = typeof replyId === "string" ? replies.get(replyId) : null;
  return entry && userId && entry.userId === userId ? entry : null;
}

/** This person's replies that are still running, newest first. */
export function runningRepliesFor(userId) {
  return [...replies.values()]
    .filter((entry) => entry.userId === userId && !entry.done)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .map((entry) => ({ replyId: entry.id, conversationId: entry.conversationId, mode: entry.mode, startedAt: entry.startedAt, phase: entry.phase }));
}

/** Explicit stop: ends the inference. Returns false if there is nothing of theirs to stop. */
export function stopLiveReply(userId, replyId) {
  const entry = liveReplyFor(userId, replyId);
  if (!entry || entry.done) return false;
  entry.stopped = true;
  entry.abort?.();
  return true;
}

/**
 * Attaches a listener: the events after "after" are replayed, then new ones follow until the reply ends. Returns a detach function, or null
 * when the events after "after" are no longer kept (the caller then reloads the saved conversation).
 */
export function attachLiveReply(entry, after, { onEvent, onEnd }) {
  const from = Number.isInteger(after) && after >= 0 ? after : 0;
  if (entry.overflow && from < entry.seq) return null;
  for (const item of entry.events) if (item.seq > from) onEvent(item);
  if (entry.done) { onEnd(); return () => {}; }
  const listener = { onEvent, onEnd };
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

export function resetLiveRepliesForTest() {
  replies.clear();
}
