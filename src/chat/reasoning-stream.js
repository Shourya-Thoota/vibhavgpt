// Streams the model's thinking to the client while a reply is prepared.
// Thinking text is shown live and never stored; only how long the model
// thought (thoughtSeconds) is kept with the saved reply.

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
export function createThinkingRelay({ onDelta, onStatus, pattern = null, maxTermLength = 0, now = Date.now }) {
  const forwarder = createReasoningForwarder((text) => onDelta({ reasoning: text }), { pattern, maxTermLength });
  let shown = false;
  let separate = false;
  let callStartedAt = null;
  let thoughtThisCall = false;
  let firstVisibleAt = null;
  let thoughtSeconds = null;
  const reset = () => {
    forwarder.reset();
    if (shown) onDelta({ reasoningReset: true });
    shown = false;
    separate = false;
  };
  return {
    startCall() {
      forwarder.flush();
      // Thinking from an earlier tool step stays on screen; a blank line
      // keeps the next call's thinking apart from it.
      separate = shown;
      callStartedAt = now();
      thoughtThisCall = false;
      firstVisibleAt = null;
    },
    reasoning(text) {
      if (typeof text !== "string" || !text) return;
      if (firstVisibleAt === null) thoughtThisCall = true;
      if (separate) forwarder.push("\n\n");
      separate = false;
      shown = true;
      forwarder.push(text);
    },
    visible() {
      if (firstVisibleAt !== null) return;
      firstVisibleAt = now();
      forwarder.flush();
    },
    retry({ attempt, maxAttempts }) {
      // The next try starts over, so its thinking replaces this try's.
      reset();
      callStartedAt = now();
      thoughtThisCall = false;
      firstVisibleAt = null;
      onStatus("retrying", { attempt, maxAttempts });
    },
    // `answered` is true when the call returned the reply's text rather than
    // a tool request.
    endCall({ answered }) {
      forwarder.flush();
      if (answered && thoughtThisCall && callStartedAt !== null) {
        thoughtSeconds = Math.max(0, Math.round(((firstVisibleAt ?? now()) - callStartedAt) / 1000));
      }
    },
    get thoughtSeconds() { return thoughtSeconds; },
  };
}
