// Relays the model's thinking state to the client while a reply is prepared.
// The model's own reasoning text is never relayed: only a verified summary
// (reasoning) can be shown, and a bare activity signal records that the model
// thought. Nothing is stored except how long the model thought
// (thoughtSeconds), which is kept with the saved reply.
import { createMetaThoughtFilter } from "./thought-filter.js";

const NAME_REPLACEMENT = "the model";

// Text shown live must never carry a provider name. Names from
// PROVIDER_NAME_TERMS are replaced before any text leaves the server, and the
// last few characters are held back until more arrive, so a name split
// across two chunks is still caught.
export function createReasoningForwarder(emit, { pattern = null, maxTermLength = 0 } = {}) {
  const global = pattern ? new RegExp(pattern.source, "gi") : null;
  const holdBack = global ? Math.max(maxTermLength, NAME_REPLACEMENT.length) + 1 : 0;
  let raw = "";
  let sent = 0;
  const send = (final) => {
    const safe = global ? raw.replace(global, NAME_REPLACEMENT) : raw;
    const end = final ? safe.length : Math.max(sent, safe.length - holdBack);
    if (end > sent) {
      emit(safe.slice(sent, end));
      sent = end;
    }
  };
  return {
    push(text) {
      if (typeof text !== "string" || !text) return;
      raw += text;
      send(false);
    },
    flush() { send(true); },
    reset() { raw = ""; sent = 0; },
  };
}

// Relays one reply's thinking and retries to the client. A reply may take
// several model calls (tool steps); thoughtSeconds is measured on the call
// that answers: from its start to its first visible text, and only when the
// model streamed thinking on that call.
export function createThinkingRelay({ onDelta, onStatus, pattern = null, maxTermLength = 0, privateText = [], now = Date.now }) {
  const forwarder = createReasoningForwarder((text) => onDelta({ reasoning: text }), { pattern, maxTermLength });
  // Thinking that deliberates about instructions or persona at the start of
  // a block, or quotes the instructions or saved facts (privateText), is not
  // shown (see createMetaThoughtFilter).
  const meta = createMetaThoughtFilter({ privateText });
  let shown = false;
  let separate = false;
  let callStartedAt = null;
  let thoughtThisCall = false;
  let firstVisibleAt = null;
  let thoughtSeconds = null;
  // A call that follows a tool result is the model talking itself through the
  // tool's outcome (what it picked, why it failed). That is not shown; the
  // client shows activity labels grounded in the executed step instead.
  let hidden = false;
  const show = (text) => {
    if (!text || hidden) return;
    // Only thinking that is shown counts: a block that was all rule-checking
    // gets no "Thought for X s" (thoughtSeconds stays null).
    if (firstVisibleAt === null) thoughtThisCall = true;
    // Thinking from an earlier tool step stays on screen; a blank line keeps
    // the next call's thinking apart from it, once that call shows any.
    if (separate) forwarder.push("\n\n");
    separate = false;
    shown = true;
    forwarder.push(text);
  };
  const reset = () => {
    forwarder.reset();
    meta.reset();
    if (shown) onDelta({ reasoningReset: true });
    shown = false;
    separate = false;
  };
  return {
    // afterTool: this call follows an executed tool step; its thinking is not shown.
    startCall({ afterTool = false } = {}) {
      show(meta.flush());
      forwarder.flush();
      meta.reset();
      hidden = afterTool;
      separate = shown;
      callStartedAt = now();
      thoughtThisCall = false;
      firstVisibleAt = null;
    },
    // Verified summary text only (see reasoningDisplay in providers.js). Raw
    // reasoning never reaches this method.
    reasoning(text) {
      if (typeof text !== "string" || !text) return;
      show(meta.push(text));
    },
    // The model is thinking and none of it is shown. No text is involved: this
    // only lets the answering call report how long it thought.
    activity() {
      if (firstVisibleAt === null) thoughtThisCall = true;
    },
    visible() {
      if (firstVisibleAt !== null) return;
      // Held thinking is judged before the answer starts, so it still counts.
      show(meta.flush());
      firstVisibleAt = now();
      forwarder.flush();
    },
    retry({ attempt, maxAttempts, rateLimited = false }) {
      // The next try starts over, so its thinking replaces this try's.
      reset();
      callStartedAt = now();
      thoughtThisCall = false;
      firstVisibleAt = null;
      // A host that refused for load is named as high demand, not as a slow reply.
      onStatus(rateLimited ? "busy" : "retrying", { attempt, maxAttempts });
    },
    // `answered` is true when the call returned the reply's text rather than
    // a tool request.
    endCall({ answered }) {
      show(meta.flush());
      forwarder.flush();
      if (answered && thoughtThisCall && callStartedAt !== null) {
        const elapsed = Math.max(0, Math.round(((firstVisibleAt ?? now()) - callStartedAt) / 1000));
        thoughtSeconds = elapsed >= 1 ? elapsed : null;
      }
    },
    get thoughtSeconds() { return thoughtSeconds; },
  };
}
