// Keep visible text on failure, without presenting it as a saved reply.
export function interruptedStreamMessage(text, model) {
  if (!text?.trim()) return null;
  return { role: "assistant", content: text, model, incomplete: true, fresh: false };
}
