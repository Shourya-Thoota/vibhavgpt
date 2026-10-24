// Bylines for replies in a conversation that may have used several models.
// Each saved reply carries the key of the model that wrote it (the server
// stores it with the reply), so its label never follows the model selected
// now. A missing or unknown key, as on replies saved before models were
// recorded, reads as plain "VibhavGPT".

export const NEUTRAL_REPLY_LABEL = "VibhavGPT";
export const IMAGE_REPLY_LABEL = "VibhavGPT Image";

// `models` is the picker's list ({ value, label, full }). Study is left out of
// it on purpose: Study replies read "VibhavGPT", as they always have.
export function createReplyLabels(models) {
  const labels = new Map(models.map((entry) => [entry.value, { full: entry.full, short: entry.label }]));

  const modelLabel = (key) => (key === "image" ? IMAGE_REPLY_LABEL : labels.get(key)?.full ?? NEUTRAL_REPLY_LABEL);

  // Where the thread switched models: index of the turn to mark -> label. A
  // mark goes above the user message that started the first reply on the new
  // model. Only picker models count: image replies and replies with no known
  // model neither mark a switch nor reset the comparison. Nothing is stored;
  // the marks are worked out from the replies' own models each render.
  const modelSwitches = (messages = []) => {
    const marks = new Map();
    let previous = null;
    messages.forEach((message, index) => {
      if (message?.role !== "assistant" || !labels.has(message.model)) return;
      if (previous && previous !== message.model) {
        marks.set(messages[index - 1]?.role === "user" ? index - 1 : index, labels.get(message.model).short);
      }
      previous = message.model;
    });
    return marks;
  };

  return { modelLabel, modelSwitches };
}
