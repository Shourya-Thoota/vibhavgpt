import { useReducer } from "react";
import { Check, ChevronLeft, ChevronRight, RotateCcw, Shuffle } from "lucide-react";
import { deckReducer, deckSummary, initialDeck } from "../study-widgets.js";
import "../study-widgets.css";

// A deck from a ```flashcards block (study-widgets.js). The card is a button:
// a click, Space or Enter flips it; the arrow keys move through the deck.
export default function InteractiveFlashcards({ deck }) {
  const { cards, title } = deck;
  const [state, dispatch] = useReducer(deckReducer, cards.length, initialDeck);
  const total = state.order.length;
  const current = cards[state.order[state.position]];
  const { known, learning } = deckSummary(state);
  const done = state.finished ? total : state.position;

  const onKeyDown = (event) => {
    if (event.key === "ArrowRight") { event.preventDefault(); dispatch({ type: "next" }); }
    if (event.key === "ArrowLeft") { event.preventDefault(); dispatch({ type: "prev" }); }
  };

  return (
    <section className="study-widget flashcards" aria-label={title || "Flashcards"} onKeyDown={onKeyDown}>
      <header className="study-widget__head">
        <span className="study-widget__eyebrow">Flashcards</span>
        {title && <h3 className="study-widget__title">{title}</h3>}
        <div className="study-widget__progress" role="progressbar" aria-label="Progress through the deck" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <span style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
      </header>

      {state.finished ? (
        <div className="study-widget__summary" role="status">
          <p className="study-widget__summary-title">Deck complete</p>
          <p className="study-widget__summary-counts">
            <span data-tone="positive"><Check size={15} strokeWidth={2.4} aria-hidden="true" /> Know it: {known}</span>
            <span data-tone="learning">Still learning: {learning}</span>
          </p>
          <div className="study-widget__actions">
            {learning > 0 && <button type="button" className="btn btn--primary" onClick={() => dispatch({ type: "review" })}>Review {learning} still learning</button>}
            <button type="button" className="btn btn--secondary" onClick={() => dispatch({ type: "restart", count: cards.length })}><RotateCcw size={15} /> Start over</button>
          </div>
        </div>
      ) : (
        <>
          <p className="study-widget__counter" aria-live="polite">Card {state.position + 1} of {total}</p>
          <button
            type="button"
            className="flashcards__card"
            data-flipped={state.flipped || undefined}
            aria-pressed={state.flipped}
            aria-label={state.flipped ? `Answer: ${current.back}. Press to see the question.` : `Question: ${current.front}. Press to see the answer.`}
            onClick={() => dispatch({ type: "flip" })}
          >
            <span className="flashcards__inner">
              <span className="flashcards__face flashcards__face--front" aria-hidden={state.flipped}>
                <span className="flashcards__side">Question</span>
                <span className="flashcards__text">{current.front}</span>
              </span>
              <span className="flashcards__face flashcards__face--back" aria-hidden={!state.flipped}>
                <span className="flashcards__side">Answer</span>
                <span className="flashcards__text">{current.back}</span>
              </span>
            </span>
          </button>
          <div className="flashcards__marks">
            <button type="button" className="flashcards__mark" data-tone="learning" onClick={() => dispatch({ type: "mark", value: "learning" })}>Still learning</button>
            <button type="button" className="flashcards__mark" data-tone="positive" onClick={() => dispatch({ type: "mark", value: "know" })}><Check size={15} strokeWidth={2.4} aria-hidden="true" /> Know it</button>
          </div>
          <div className="study-widget__nav">
            <button type="button" className="study-widget__icon" aria-label="Previous card" disabled={state.position === 0} onClick={() => dispatch({ type: "prev" })}><ChevronLeft size={18} /></button>
            <button type="button" className="btn btn--quiet" onClick={() => dispatch({ type: "flip" })}>Flip</button>
            <button type="button" className="btn btn--quiet" onClick={() => dispatch({ type: "shuffle" })}><Shuffle size={15} /> Shuffle</button>
            <button type="button" className="study-widget__icon" aria-label="Next card" onClick={() => dispatch({ type: "next" })}><ChevronRight size={18} /></button>
          </div>
          {(known > 0 || learning > 0) && <p className="study-widget__tally">Know it: {known} · Still learning: {learning}</p>}
        </>
      )}
    </section>
  );
}
