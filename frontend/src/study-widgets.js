// Flashcards and quizzes in a reply arrive as fenced blocks the app turns
// into interactive widgets:
//
//   ```flashcards
//   {"title": "Cell biology", "cards": [{"front": "Mitosis", "back": "Cell division into two identical cells"}]}
//   ```
//   ```quiz
//   {"title": "Cell biology", "questions": [{"question": "What does mitosis produce?",
//     "options": ["Two identical cells", "Four gametes"], "answer": 0, "explanation": "Mitosis copies the cell."}]}
//   ```
//
// The model is told this format (src/chat/study.js). This module parses and
// checks a block, and holds the widgets' state machines, so the components
// stay thin and everything here can be tested without a browser.

export const STUDY_BLOCK_LANGUAGES = new Set(["flashcards", "quiz"]);
const MAX_CARDS = 60;
const MAX_QUESTIONS = 40;
const MAX_OPTIONS = 8;
const MAX_TEXT = 600;

const clean = (value) => (typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, MAX_TEXT) : "");

function card(item) {
  if (!item || typeof item !== "object") return null;
  const front = clean(item.front ?? item.term ?? item.question ?? item.q);
  const back = clean(item.back ?? item.definition ?? item.answer ?? item.a);
  return front && back ? { front, back } : null;
}

function question(item) {
  if (!item || typeof item !== "object") return null;
  const prompt = clean(item.question ?? item.prompt ?? item.q);
  const options = (Array.isArray(item.options ?? item.choices) ? (item.options ?? item.choices) : []).map(clean).filter(Boolean).slice(0, MAX_OPTIONS);
  if (!prompt || options.length < 2) return null;
  // The answer may be given as an index or as the option's own text.
  const raw = item.answer ?? item.correct ?? item.correctIndex;
  let answer = Number.isInteger(raw) ? raw : options.findIndex((option) => option.toLowerCase() === clean(raw).toLowerCase());
  if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) return null;
  return { question: prompt, options, answer, explanation: clean(item.explanation ?? item.why) };
}

// A parsed block, or null while it is incomplete (still streaming) or wrong.
export function parseStudyBlock(language, source) {
  const kind = String(language ?? "").toLowerCase();
  if (!STUDY_BLOCK_LANGUAGES.has(kind)) return null;
  let data;
  try {
    data = JSON.parse(String(source ?? "").trim());
  } catch {
    return null;
  }
  const title = clean(data?.title);
  if (kind === "flashcards") {
    const cards = (Array.isArray(data) ? data : data?.cards ?? []).map(card).filter(Boolean).slice(0, MAX_CARDS);
    return cards.length ? { kind, title, cards } : null;
  }
  const questions = (Array.isArray(data) ? data : data?.questions ?? []).map(question).filter(Boolean).slice(0, MAX_QUESTIONS);
  return questions.length ? { kind, title, questions } : null;
}

// --- Flashcards -------------------------------------------------------------

export function initialDeck(count) {
  return { order: Array.from({ length: count }, (_, index) => index), position: 0, flipped: false, marks: {}, finished: false };
}

// `random` is injectable so a shuffle can be tested.
export function deckReducer(state, action) {
  const last = state.order.length - 1;
  switch (action.type) {
    case "flip": return state.finished ? state : { ...state, flipped: !state.flipped };
    case "next": return state.position >= last ? { ...state, finished: true, flipped: false } : { ...state, position: state.position + 1, flipped: false };
    case "prev": return state.finished ? { ...state, finished: false } : { ...state, position: Math.max(0, state.position - 1), flipped: false };
    case "mark": {
      const card = state.order[state.position];
      const marks = { ...state.marks, [card]: action.value };
      return state.position >= last ? { ...state, marks, finished: true, flipped: false } : { ...state, marks, position: state.position + 1, flipped: false };
    }
    case "shuffle": {
      const order = [...state.order];
      const random = action.random ?? Math.random;
      for (let index = order.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [order[index], order[swap]] = [order[swap], order[index]];
      }
      return { ...state, order, position: 0, flipped: false, finished: false };
    }
    // Go through only the cards still being learned, or all of them again.
    case "review": {
      const learning = state.order.filter((card) => state.marks[card] === "learning");
      return learning.length ? { order: learning, position: 0, flipped: false, marks: {}, finished: false } : state;
    }
    case "restart": return initialDeck(action.count ?? state.order.length);
    default: return state;
  }
}

export function deckSummary(state) {
  const values = Object.values(state.marks);
  return { known: values.filter((value) => value === "know").length, learning: values.filter((value) => value === "learning").length };
}

// --- Quiz -------------------------------------------------------------------

export function initialQuiz() {
  return { position: 0, answers: {}, finished: false };
}

export function quizReducer(state, action) {
  switch (action.type) {
    // The first choice for a question is final, so feedback can't be gamed.
    case "choose": return state.answers[state.position] === undefined ? { ...state, answers: { ...state.answers, [state.position]: action.option } } : state;
    case "next": return state.position >= action.count - 1 ? { ...state, finished: true } : { ...state, position: state.position + 1 };
    case "retake": return initialQuiz();
    default: return state;
  }
}

export function quizScore(questions, answers) {
  return questions.reduce((score, item, index) => score + (answers[index] === item.answer ? 1 : 0), 0);
}

// What "Ask VibhavGPT to explain" sends after a wrong answer.
export function explainMessage(item, chosen) {
  return `Can you explain why the correct answer to "${item.question}" is "${item.options[item.answer]}", and why "${item.options[chosen]}" is incorrect?`;
}

export function scoreMessage(score, total) {
  if (total && score === total) return `You got ${score}/${total} correct! 🎉`;
  if (total && score / total >= 0.6) return `You got ${score}/${total} correct. Nice work!`;
  return `You got ${score}/${total} correct. Have another go to lock it in.`;
}
