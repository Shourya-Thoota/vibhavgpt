import { stripThoughts } from "./thought-filter.js";

// Keep visible text on failure, without presenting it as a saved reply.
// The text goes through the same filter as a live reply first: a stream that stops in the middle of the model's reasoning must not leave
// that reasoning in the conversation. Reasoning that is only started (an opening tag never closed) is dropped, whatever comes before it
// is kept, and if nothing but reasoning was received, nothing is saved.
export function interruptedStreamMessage(text, model, { stopped = false } = {}) {
  const visible = stripThoughts(text);
  if (!visible.trim()) return null;
  // stopped: the person pressed Stop (the server confirmed it); otherwise the reply broke off.
  return { role: "assistant", content: visible, model, incomplete: true, fresh: false, ...(stopped ? { stopped: true } : {}) };
}
