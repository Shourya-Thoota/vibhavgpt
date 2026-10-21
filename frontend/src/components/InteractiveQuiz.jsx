import { useReducer, useState } from "react";
import { Check, MessageCircleQuestion, RotateCcw, X } from "lucide-react";
import { explainMessage, initialQuiz, quizReducer, quizScore, scoreMessage } from "../study-widgets.js";
import "../study-widgets.css";

// A quiz from a ```quiz block (study-widgets.js), one question at a time.
// The first choice is final: the right answer turns green with a check, a
// wrong choice turns red with a cross, and the explanation appears. After a
// wrong answer, "Ask VibhavGPT to explain" sends a follow-up into the chat
// (`onAsk`); the quiz keeps its place while the reply comes in.
export default function InteractiveQuiz({ quiz, onAsk = null }) {
  const { questions, title } = quiz;
  const [state, dispatch] = useReducer(quizReducer, undefined, initialQuiz);
  const [asked, setAsked] = useState({});
  const total = questions.length;
  const item = questions[state.position];
  const chosen = state.answers[state.position];
  const answered = chosen !== undefined;
  const score = quizScore(questions, state.answers);
  const done = state.finished ? total : state.position + (answered ? 1 : 0);

  return (
    <section className="study-widget-container study-widget interactive-quiz quiz" aria-label={title || "Quiz"}>
      <header className="study-widget__head">
        <span className="study-widget__eyebrow">Quiz</span>
        {title && <h3 className="study-widget__title">{title}</h3>}
        <div className="study-widget__progress" role="progressbar" aria-label="Progress through the quiz" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <span style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
      </header>

      <div className="study-widget__body">
        {state.finished ? (
          <div className="study-widget__summary" role="status">
            <p className="study-widget__summary-title">{scoreMessage(score, total)}</p>
            <ol className="quiz__review">
              {questions.map((question, index) => (
                <li key={index} data-correct={state.answers[index] === question.answer || undefined}>
                  {state.answers[index] === question.answer ? <Check size={14} strokeWidth={2.4} aria-label="Correct" /> : <X size={14} strokeWidth={2.4} aria-label="Incorrect" />}
                  <span>{question.question}</span>
                </li>
              ))}
            </ol>
            <div className="study-widget__actions">
              <button type="button" className="btn btn--primary" onClick={() => { setAsked({}); dispatch({ type: "retake" }); }}><RotateCcw size={15} /> Retake quiz</button>
            </div>
          </div>
        ) : (
          <>
            <p className="study-widget__counter" aria-live="polite">Question {state.position + 1} of {total}</p>
            <p className="quiz__question">{item.question}</p>
            <div className="quiz__options" role="group" aria-label="Answers">
              {item.options.map((option, index) => {
                const result = !answered ? undefined : index === item.answer ? "correct" : index === chosen ? "incorrect" : "other";
                return (
                  <button
                    key={index}
                    type="button"
                    className="quiz__option"
                    data-result={result}
                    aria-pressed={chosen === index}
                    disabled={answered}
                    onClick={() => dispatch({ type: "choose", option: index })}
                  >
                    <span className="quiz__letter" aria-hidden="true">{String.fromCharCode(65 + index)}</span>
                    <span className="quiz__option-text">{option}</span>
                    {result === "correct" && <Check className="quiz__mark" size={17} strokeWidth={2.4} aria-label="Correct answer" />}
                    {result === "incorrect" && <X className="quiz__mark" size={17} strokeWidth={2.4} aria-label="Your answer, incorrect" />}
                  </button>
                );
              })}
            </div>
            {answered && (
              <QuizFeedback
                item={item}
                chosen={chosen}
                last={state.position >= total - 1}
                asked={Boolean(asked[state.position])}
                onAsk={onAsk}
                onAsked={() => setAsked((current) => ({ ...current, [state.position]: true }))}
                onNext={() => dispatch({ type: "next", count: total })}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}

// The panel under an answered question. After a wrong answer, and where the
// reply can be continued (onAsk), it offers "Ask VibhavGPT to explain", which
// sends explainMessage() once.
export function QuizFeedback({ item, chosen, last, asked = false, onAsk = null, onAsked = () => {}, onNext }) {
  const wrong = chosen !== item.answer;
  return (
    <div className="quiz__feedback" role="status" data-correct={!wrong || undefined}>
      <p className="quiz__verdict">{wrong ? `Not quite. The answer is ${String.fromCharCode(65 + item.answer)}.` : "Correct!"}</p>
      {item.explanation && <p className="quiz__explanation">{item.explanation}</p>}
      <div className="quiz__feedback-actions">
        {wrong && onAsk && (
          <button
            type="button"
            className="btn btn--secondary quiz__ask"
            disabled={asked}
            onClick={() => { if (asked) return; onAsked(); onAsk(explainMessage(item, chosen)); }}
          >
            <MessageCircleQuestion size={16} /> {asked ? "Asked VibhavGPT" : "Ask VibhavGPT to explain"}
          </button>
        )}
        <button type="button" className="btn btn--primary" onClick={onNext}>{last ? "See your score" : "Next question"}</button>
      </div>
    </div>
  );
}
