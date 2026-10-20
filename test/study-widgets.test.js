import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  deckReducer, deckSummary, initialDeck, initialQuiz, parseStudyBlock, quizReducer, quizScore, scoreMessage, STUDY_BLOCK_LANGUAGES,
} from "../frontend/src/study-widgets.js";

// Flashcards and quizzes in a reply arrive as ```flashcards and ```quiz JSON
// blocks and render as interactive widgets. The parser and the widgets'
// state machines run here directly; the components are compiled with the
// frontend's own esbuild and rendered with react-dom/server.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const DECK = JSON.stringify({ title: "Cell biology", cards: [
  { front: "Mitosis", back: "Division into two identical cells" },
  { front: "Meiosis", back: "Division into four gametes" },
  { front: "Cytokinesis", back: "The cytoplasm splitting" },
] });
const QUIZ = JSON.stringify({ title: "Cells", questions: [
  { question: "What does mitosis produce?", options: ["Two identical cells", "Four gametes", "One cell"], answer: 0, explanation: "Mitosis copies the cell once." },
  { question: "Which makes gametes?", options: ["Mitosis", "Meiosis"], answer: "Meiosis", explanation: "Meiosis halves the chromosome count." },
] });

test("flashcard and quiz blocks parse into widgets; anything else is left alone", () => {
  assert.deepEqual([...STUDY_BLOCK_LANGUAGES], ["flashcards", "quiz"]);
  const deck = parseStudyBlock("flashcards", DECK);
  assert.equal(deck.kind, "flashcards");
  assert.equal(deck.title, "Cell biology");
  assert.deepEqual(deck.cards[0], { front: "Mitosis", back: "Division into two identical cells" });
  // Common alternative shapes still work: a bare list, term/definition.
  assert.deepEqual(parseStudyBlock("flashcards", '[{"term":"ATP","definition":"Energy currency"}]').cards, [{ front: "ATP", back: "Energy currency" }]);
  const quiz = parseStudyBlock("QUIZ", QUIZ);
  assert.equal(quiz.kind, "quiz");
  assert.equal(quiz.questions[1].answer, 1, "an answer given as the option's text becomes its index");
  assert.equal(parseStudyBlock("javascript", DECK), null);
});

test("an incomplete or malformed block is not a widget yet, so streaming never crashes", () => {
  for (let cut = 0; cut < DECK.length; cut += 7) assert.equal(parseStudyBlock("flashcards", DECK.slice(0, cut)), null, `cut at ${cut}`);
  for (let cut = 0; cut < QUIZ.length; cut += 7) assert.equal(parseStudyBlock("quiz", QUIZ.slice(0, cut)), null, `cut at ${cut}`);
  assert.equal(parseStudyBlock("flashcards", '{"cards": []}'), null);
  assert.equal(parseStudyBlock("flashcards", '{"cards": [{"front": "No back"}]}'), null);
  assert.equal(parseStudyBlock("quiz", '{"questions": [{"question": "One option?", "options": ["Only"], "answer": 0}]}'), null);
  assert.equal(parseStudyBlock("quiz", '{"questions": [{"question": "Bad answer", "options": ["A", "B"], "answer": 5}]}'), null);
  assert.equal(parseStudyBlock("flashcards", "not json"), null);
  // Over-long decks are capped rather than rendered without limit.
  const many = JSON.stringify({ cards: Array.from({ length: 90 }, (_, index) => ({ front: `F${index}`, back: `B${index}` })) });
  assert.equal(parseStudyBlock("flashcards", many).cards.length, 60);
});

test("flashcards flip, move, shuffle, take Know it / Still learning marks and sum them up", () => {
  let state = initialDeck(3);
  state = deckReducer(state, { type: "flip" });
  assert.equal(state.flipped, true);
  state = deckReducer(state, { type: "flip" });
  assert.equal(state.flipped, false, "flips back");
  state = deckReducer(state, { type: "flip" });
  state = deckReducer(state, { type: "next" });
  assert.deepEqual([state.position, state.flipped], [1, false], "a new card starts on its question");
  state = deckReducer(state, { type: "prev" });
  assert.equal(state.position, 0);
  state = deckReducer(state, { type: "prev" });
  assert.equal(state.position, 0, "no card before the first");
  state = deckReducer(state, { type: "mark", value: "know" });
  state = deckReducer(state, { type: "mark", value: "learning" });
  assert.equal(state.position, 2, "marking moves on");
  state = deckReducer(state, { type: "mark", value: "learning" });
  assert.equal(state.finished, true, "the last mark ends the deck");
  assert.deepEqual(deckSummary(state), { known: 1, learning: 2 });
  state = deckReducer(state, { type: "review" });
  assert.deepEqual([state.order, state.finished, deckSummary(state)], [[1, 2], false, { known: 0, learning: 0 }], "review goes through only the cards still being learned");
  state = deckReducer(state, { type: "restart", count: 3 });
  assert.deepEqual(state.order, [0, 1, 2]);
  const shuffled = deckReducer({ ...initialDeck(4), position: 2 }, { type: "shuffle", random: () => 0 });
  assert.deepEqual([shuffled.order, shuffled.position], [[1, 2, 3, 0], 0], "a shuffle reorders and starts again");
  assert.deepEqual([...shuffled.order].sort(), [0, 1, 2, 3], "every card is kept");
});

test("a quiz takes one final answer per question, scores it and can be retaken", () => {
  const questions = parseStudyBlock("quiz", QUIZ).questions;
  let state = initialQuiz();
  state = quizReducer(state, { type: "choose", option: 1 });
  state = quizReducer(state, { type: "choose", option: 0 });
  assert.equal(state.answers[0], 1, "the first choice is final");
  state = quizReducer(state, { type: "next", count: 2 });
  state = quizReducer(state, { type: "choose", option: 1 });
  state = quizReducer(state, { type: "next", count: 2 });
  assert.equal(state.finished, true);
  assert.equal(quizScore(questions, state.answers), 1);
  assert.equal(scoreMessage(1, 2), "You got 1/2 correct. Have another go to lock it in.");
  assert.equal(scoreMessage(4, 5), "You got 4/5 correct. Nice work!");
  assert.equal(scoreMessage(5, 5), "You got 5/5 correct! 🎉");
  assert.deepEqual(quizReducer(state, { type: "retake" }), initialQuiz());
});

// The components, compiled and rendered to HTML.
async function renderWidgets() {
  const require = createRequire(new URL("../frontend/package.json", import.meta.url));
  const esbuild = require("esbuild");
  const result = await esbuild.build({
    stdin: {
      contents: `import { renderToStaticMarkup } from "react-dom/server";
        import InteractiveFlashcards from "./components/InteractiveFlashcards.jsx";
        import InteractiveQuiz from "./components/InteractiveQuiz.jsx";
        export const flashcards = (deck) => renderToStaticMarkup(<InteractiveFlashcards deck={deck} />);
        export const quiz = (quiz) => renderToStaticMarkup(<InteractiveQuiz quiz={quiz} />);`,
      resolveDir: new URL("../frontend/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      loader: "jsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", loader: { ".css": "empty" }, logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  // react-dom's server build uses require(), so the bundle is CommonJS.
  const dir = mkdtempSync(join(tmpdir(), "study-widgets-"));
  try {
    const file = join(dir, "widgets.cjs");
    writeFileSync(file, result.outputFiles[0].text);
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the flashcards and quiz components render their first card and question", async () => {
  const render = await renderWidgets();
  const cards = render.flashcards(parseStudyBlock("flashcards", DECK));
  assert.match(cards, /<section class="study-widget flashcards" aria-label="Cell biology"/);
  assert.match(cards, /Card 1 of 3/);
  assert.match(cards, /role="progressbar"[^>]*aria-valuemax="3"[^>]*aria-valuenow="0"/);
  assert.match(cards, /<button type="button" class="flashcards__card" aria-pressed="false" aria-label="Question: Mitosis\. Press to see the answer\.">/, "the card is a button, so Space and Enter flip it");
  assert.match(cards, /flashcards__face--front" aria-hidden="false">.*Mitosis/);
  assert.match(cards, /flashcards__face--back" aria-hidden="true">.*Division into two identical cells/, "the answer waits on the back");
  for (const label of ["Still learning", "Know it", "Flip", "Shuffle", 'aria-label="Previous card" disabled=""', 'aria-label="Next card"']) assert.ok(cards.includes(label), label);
  const quiz = render.quiz(parseStudyBlock("quiz", QUIZ));
  assert.match(quiz, /Question 1 of 2/);
  assert.match(quiz, /What does mitosis produce\?/);
  assert.equal(quiz.match(/class="quiz__option"/g)?.length, 3);
  assert.doesNotMatch(quiz, /data-result=|quiz__feedback/, "no feedback before an answer");
});

test("replies turn the blocks into widgets, with a placeholder while streaming and plain code if a finished block never parses", () => {
  const app = read("frontend/src/App.jsx");
  assert.match(app, /return STUDY_BLOCK_LANGUAGES\.has\(language\.toLowerCase\(\)\) \? <StudyBlock language=\{language\.toLowerCase\(\)\} text=\{text\} fallback=\{block\} \/> : block;/);
  assert.match(app, /if \(!settled\) return <div className="study-widget study-widget--pending" role="status">/);
  assert.match(app, /return fallback;/);
  assert.match(app, /const settled = !streaming && \(!animate \|\| done\);/);
  assert.match(app, /<AssistantBody text=\{streamText\} animate=\{false\} streaming \/>/, "the live stream is never settled");
  const css = read("frontend/src/study-widgets.css");
  assert.match(css, /var\(--color-positive\)/);
  assert.match(css, /var\(--color-danger\)/);
  assert.match(css, /\.flashcards__card\[data-flipped\] \.flashcards__inner \{ transform: rotateY\(180deg\); \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "theme tokens only, so both skies style it");
});

test("Study and Chat tell the model to write study aids as these blocks", async () => {
  const { STUDY_WIDGET_FORMAT, studyPrompt } = await import("../src/chat/study.js");
  const { buildIdentitySystemPrompt } = await import("../src/chat/prompts.js");
  assert.match(STUDY_WIDGET_FORMAT, /language flashcards containing only JSON: \{"title": "short topic", "cards": \[\{"front": "term or question", "back": "answer or definition"\}\]\}/);
  assert.match(STUDY_WIDGET_FORMAT, /language quiz containing only JSON: \{"title": "short topic", "questions": \[\{"question": "\.\.\.", "options": \[/);
  assert.match(STUDY_WIDGET_FORMAT, /zero-based index/);
  assert.ok(studyPrompt("study").includes(STUDY_WIDGET_FORMAT));
  // Quiz me stays a conversation: its button asks for one question at a time.
  assert.match(studyPrompt("study"), /For Quiz me, ask one question at a time, wait for the learner's response before revealing the answer/);
  for (const tier of ["lumen", "nova", "nebula", "vesper", "study"]) assert.ok(buildIdentitySystemPrompt(tier, { query: "Make me flashcards on cells" }).includes(STUDY_WIDGET_FORMAT), tier);
  assert.doesNotMatch(STUDY_WIDGET_FORMAT, /—|–/);
  // The block's sample shapes are valid input for the parser.
  assert.ok(parseStudyBlock("flashcards", '{"title": "short topic", "cards": [{"front": "term or question", "back": "answer or definition"}]}'));
  assert.ok(parseStudyBlock("quiz", '{"title": "short topic", "questions": [{"question": "...", "options": ["...", "...", "...", "..."], "answer": 0, "explanation": "why the answer is right"}]}'));
});
