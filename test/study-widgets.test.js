import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  deckReducer, deckSummary, explainMessage, initialDeck, initialQuiz, parseStudyBlock, quizReducer, quizScore, scoreMessage, STUDY_BLOCK_LANGUAGES,
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
        import InteractiveQuiz, { QuizFeedback } from "./components/InteractiveQuiz.jsx";
        export { QuizFeedback };
        export const feedback = (props) => renderToStaticMarkup(<QuizFeedback {...props} />);
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
  assert.match(cards, /<section class="study-widget-container study-widget interactive-flashcards flashcards" aria-label="Cell biology"/);
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


test("a wrong answer offers Ask VibhavGPT to explain, which sends the explanation request once", async () => {
  const render = await renderWidgets();
  const item = parseStudyBlock("quiz", QUIZ).questions[0];
  assert.equal(explainMessage(item, 2), 'Can you explain why the correct answer to "What does mitosis produce?" is "Two identical cells", and why "One cell" is incorrect?');
  const wrong = render.feedback({ item, chosen: 2, last: false, onAsk: () => {}, onNext: () => {} });
  assert.match(wrong, /class="btn btn--secondary quiz__ask"[^>]*>.*Ask VibhavGPT to explain<\/button><button type="button" class="btn btn--primary">Next question<\/button>/, "next to Next question");
  assert.doesNotMatch(render.feedback({ item, chosen: 0, last: false, onAsk: () => {}, onNext: () => {} }), /quiz__ask/, "not after a right answer");
  assert.doesNotMatch(render.feedback({ item, chosen: 2, last: false, onNext: () => {} }), /quiz__ask/, "not where the reply cannot be continued");
  assert.match(render.feedback({ item, chosen: 2, last: true, asked: true, onAsk: () => {}, onNext: () => {} }), /disabled=""[^>]*>.*Asked VibhavGPT<\/button>.*See your score/, "once asked, it says so");

  // The button's own click handler, called directly: it marks the question
  // as asked and sends exactly the explanation request.
  const sent = [];
  let marked = 0;
  const find = (node) => {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
    if (String(node.props?.className ?? "").includes("quiz__ask")) return node;
    return find(node.props?.children);
  };
  const button = find(render.QuizFeedback({ item, chosen: 2, last: false, asked: false, onAsk: (text) => sent.push(text), onAsked: () => { marked += 1; }, onNext: () => {} }));
  assert.ok(button, "the button is in the panel");
  button.props.onClick();
  assert.deepEqual(sent, [explainMessage(item, 2)]);
  assert.equal(marked, 1);
  find(render.QuizFeedback({ item, chosen: 2, last: false, asked: true, onAsk: (text) => sent.push(text), onNext: () => {} })).props.onClick();
  assert.equal(sent.length, 1, "a second click sends nothing");

  // In the app, the quiz in a saved reply sends through the chat's own queue.
  const app = read("frontend/src/App.jsx");
  assert.match(app, /if \(parsed\?\.kind === "quiz"\) return <InteractiveQuiz quiz=\{parsed\} onAsk=\{onAsk\} onResult=\{onResult\} \/>;/);
  assert.match(app, /onAsk=\{askFromWidget\}/);
  assert.match(app, /const askFromWidget = \(content\) => \{[\s\S]*?if \(busyRef\.current \|\| busy\) \{[\s\S]*?setQueue\([\s\S]*?void startTurn\(content, \[\]\);/);
});

test("both widgets, their cards and their end screens are locked to one size, whatever their text", async () => {
  const render = await renderWidgets();
  const cards = render.flashcards(parseStudyBlock("flashcards", DECK));
  const quiz = render.quiz(parseStudyBlock("quiz", QUIZ));
  assert.match(cards, /<section class="study-widget-container study-widget interactive-flashcards flashcards"/);
  assert.match(quiz, /<section class="study-widget-container study-widget interactive-quiz quiz"/);
  assert.match(cards, /<div class="study-widget__body"><p class="study-widget__counter" aria-live="polite">Card 1 of 3<\/p><button type="button" class="flashcards__card"/, "counter, then the card slot");
  assert.match(cards, /<div class="flashcards__controls">.*<p class="study-widget__tally" aria-live="polite"> <\/p><\/div>/, "the controls area keeps a line for the running count");
  assert.match(quiz, /<div class="study-widget__body"><p class="study-widget__counter" aria-live="polite">Question 1 of 2<\/p><div class="quiz__card"><p class="quiz__question">/, "the question, its options and feedback share one card");
  // The end screens take the same slot as the card they replace.
  const flashcardsSource = read("frontend/src/components/InteractiveFlashcards.jsx");
  assert.match(flashcardsSource, /className="study-widget__summary deck-complete flashcards-complete" role="status"/);
  assert.match(flashcardsSource, /\{state\.finished \? "Deck complete" : `Card \$\{state\.position \+ 1\} of \$\{total\}`\}/);
  assert.match(read("frontend/src/components/InteractiveQuiz.jsx"), /className="study-widget__summary quiz-summary" role="status"/);

  const css = read("frontend/src/study-widgets.css");
  const rule = (selectorList) => css.match(new RegExp(`${selectorList.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
  const width = rule(".study-widget-container,\n.interactive-flashcards,\n.interactive-quiz,\n.deck-complete,\n.flashcards-complete,\n.quiz-summary");
  for (const declaration of ["width: 100% !important;", "max-width: 680px !important;", "min-width: 100% !important;", "box-sizing: border-box !important;", "align-self: stretch !important;"]) assert.ok(width.includes(declaration), declaration);
  const height = rule(".flashcards__card,\n.quiz__card,\n.deck-complete,\n.flashcards-complete,\n.quiz-summary");
  for (const declaration of ["height: 320px !important;", "min-height: 320px !important;", "max-height: 320px !important;"]) assert.ok(height.includes(declaration), declaration);
  assert.match(css, /\.bubble:has\(\.study-widget-container, \.diagram-viewer\),\n\.prose:has\(\.study-widget-container, \.diagram-viewer\) \{ width: 100% !important; max-width: 100% !important; \}/, "the reply no longer shrinks to its text");
  assert.match(rule(".deck-complete,\n.flashcards-complete,\n.quiz-summary,\n.quiz__card"), /display: flex; flex-direction: column; justify-content: safe center;[^]*overflow-y: auto;/, "centred, and long text scrolls inside instead of growing the box");
  assert.match(css, /\.flashcards__controls \{[^}]*height: 140px;/, "the controls keep one height");
  assert.match(css, /\.flashcards__face \{[^}]*justify-content: safe center;[^}]*overflow-y: auto;/);
  assert.match(css, /\.study-widget--pending \{[^}]*width: 100%; max-width: 680px; min-height: 120px;/, "the placeholder is as wide as its widget");
});

test("on phones the widgets tighten and stack their actions, keep 44px touch targets, and keep the same 320px card", () => {
  const css = read("frontend/src/study-widgets.css");
  const phone = css.match(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(phone, "a phone layout");
  assert.doesNotMatch(phone, /\.flashcards__card \{ height:/, "the card keeps its locked 320px on phones too");
  assert.match(phone, /\.flashcards__controls \{ height: 156px; \}/, "room for the taller touch targets, still fixed");
  assert.match(phone, /\.flashcards__mark, \.quiz__option \{ min-height: 48px; \}/);
  assert.match(phone, /\.study-widget__icon \{ width: 44px; height: 44px; \}/);
  assert.match(phone, /\.study-widget__nav \.btn, \.study-widget__actions \.btn, \.quiz__feedback-actions \.btn \{ min-height: 44px;/);
  assert.match(phone, /\.study-widget__actions, \.quiz__feedback-actions \{ flex-direction: column; align-items: stretch; width: 100%; \}/);
  assert.match(css, /font-size: clamp\(/, "fluid type");
});
