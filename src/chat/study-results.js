// What the learner did with a reply's flashcards or quiz, kept with that
// reply so every later turn, on any model, knows how it went. The app sends
// plain numbers and the quiz's own text (frontend/src/study-widgets.js); the
// note is built here, short and bounded, never taken as written.

const MAX_NOTES_PER_REPLY = 5;
const MAX_MISSED = 10;
const clip = (value, limit) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
const count = (value, max = 500) => (Number.isInteger(value) && value >= 0 && value <= max ? value : null);

// The note for one result, or null when the result is not well formed.
export function studyResultNote(result) {
  const title = clip(result?.title, 80);
  const named = title ? ` "${title}"` : "";
  if (result?.kind === "flashcards") {
    const total = count(result.total);
    const known = count(result.known);
    const learning = count(result.learning);
    if (!total || known === null || learning === null || known + learning > total) return null;
    return `Flashcard review of${named || " the deck"}: ${known} know it, ${learning} still learning, of ${total} cards.`;
  }
  if (result?.kind === "quiz") {
    const total = count(result.total, 100);
    const score = count(result.score, 100);
    if (!total || score === null || score > total) return null;
    const missed = (Array.isArray(result.missed) ? result.missed : []).slice(0, MAX_MISSED)
      .map((item) => {
        const question = clip(item?.question, 160);
        const chosen = clip(item?.chosen, 80);
        const correct = clip(item?.correct, 80);
        return question && chosen && correct ? `"${question}" (chose "${chosen}"; correct: "${correct}")` : null;
      })
      .filter(Boolean);
    return `Quiz${named}: ${score}/${total} correct.${missed.length ? ` Missed: ${missed.join("; ")}.` : ""}`;
  }
  return null;
}

// A reply's notes, newest last, kept to a few.
export function appendStudyNote(metadata, note) {
  const previous = Array.isArray(metadata?.studyResults) ? metadata.studyResults.filter((item) => typeof item === "string") : [];
  return { ...(metadata ?? {}), studyResults: [...previous, note].slice(-MAX_NOTES_PER_REPLY) };
}

// The history each model sees: a reply carries what the learner did with it.
export function withStudyResults(history = []) {
  return history.map((message) => (message?.role === "assistant" && Array.isArray(message.studyResults) && message.studyResults.length
    ? { ...message, content: `${message.content}\n\n${message.studyResults.map((note) => `[Study result: ${note}]`).join("\n")}` }
    : message));
}
