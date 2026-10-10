import { useEffect, useRef, useState } from "react";

const REDUCED_MOTION = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * A slice of markdown taken mid-word leaves emphasis and code markers open, so
 * the reader briefly sees raw `**` and backticks. Dropping a half-typed marker
 * and closing the ones already open keeps every frame valid markdown.
 */
function balanceMarkdown(partial) {
  let text = partial.replace(/(\*{1,2}|_{1,2}|`{1,3}|~{2})$/, "");
  if ((text.match(/^```/gm) ?? []).length % 2) text += "\n```";
  if ((text.match(/(?<!`)`(?!`)/g) ?? []).length % 2) text += "`";
  if ((text.match(/\*\*/g) ?? []).length % 2) text += "**";
  if ((text.replace(/\*\*/g, "").match(/\*/g) ?? []).length % 2) text += "*";
  return text;
}

/**
 * Reveals an already-received reply a few characters at a time so a finished
 * answer lands the way a person types rather than appearing all at once.
 *
 * The API returns the whole reply in one `complete` event, so this is a
 * presentation effect over text we already hold — never a stand-in for text
 * that has not arrived. `onTick` lets the caller keep the view scrolled.
 */
export function useTypewriter(text, { enabled = true, onTick } = {}) {
  const [count, setCount] = useState(() => (enabled ? 0 : text.length));
  const frameRef = useRef(0);
  const tickRef = useRef(onTick);
  tickRef.current = onTick;

  useEffect(() => {
    if (!enabled || REDUCED_MOTION()) {
      setCount(text.length);
      return undefined;
    }
    // Driven by elapsed time, not by frames: re-rendering the markdown on every
    // step is expensive, and a frame-counted reveal would crawl whenever those
    // renders drop the frame rate. A long answer still finishes inside the cap.
    const duration = Math.min(2600, Math.max(600, text.length * 5));
    const start = performance.now();
    setCount(0);
    const step = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      setCount(Math.ceil(progress * text.length));
      tickRef.current?.();
      if (progress < 1) frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameRef.current);
  }, [text, enabled]);

  const done = count >= text.length;
  return { shown: done ? text : balanceMarkdown(text.slice(0, count)), done };
}

/** The three-dot "still writing" indicator shown while a reply is in flight. */
export function TypingDots({ label }) {
  return (
    <span className="typing-dots" role="status" aria-live="polite">
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      {label && <em>{label}</em>}
    </span>
  );
}

/** Cycles a word in place — used for the "Thinking / Reading / Writing" line. */
export function CyclingWord({ words, interval = 2200 }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (words.length < 2 || REDUCED_MOTION()) return undefined;
    const timer = setInterval(() => setIndex((current) => (current + 1) % words.length), interval);
    return () => clearInterval(timer);
  }, [words, interval]);
  return (
    <span className="cycling-word" key={words[index]}>
      {words[index]}
    </span>
  );
}

/**
 * Types a line out character by character behind a blinking caret.
 *
 * Distinct from RevealWords, which fades whole words in place: this one has a
 * visible cursor and a measurable speed, so it reads as composition rather
 * than as an entrance. Reserved for a single hero line per view — more than
 * one on screen competes for the eye and stops feeling deliberate.
 *
 * The full string is always in the accessible name, so assistive tech reads
 * the finished sentence rather than announcing each partial frame.
 */
export function Typewriter({ text, as: Tag = "span", speed = 42, startDelay = 250, className = "", onDone }) {
  const [count, setCount] = useState(() => (REDUCED_MOTION() ? text.length : 0));
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (REDUCED_MOTION()) {
      setCount(text.length);
      doneRef.current?.();
      return undefined;
    }
    setCount(0);
    let frame = 0;
    let start = 0;
    // Time-based like useTypewriter, so a slow frame skips ahead instead of
    // stretching the line out.
    const step = (now) => {
      if (!start) start = now;
      const elapsed = now - start - startDelay;
      const next = elapsed <= 0 ? 0 : Math.min(text.length, Math.floor(elapsed / speed));
      setCount(next);
      if (next < text.length) frame = requestAnimationFrame(step);
      else doneRef.current?.();
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text, speed, startDelay]);

  const done = count >= text.length;
  return (
    <Tag className={`typewriter ${className}`.trim()} aria-label={text} data-done={done || undefined}>
      <span aria-hidden="true">{text.slice(0, count)}</span>
    </Tag>
  );
}

/** Reveals a heading one word at a time on mount. */
export function RevealWords({ text, as: Tag = "span", delay = 0, className = "" }) {
  const words = text.split(" ");
  return (
    <Tag className={`reveal-words ${className}`.trim()} aria-label={text}>
      {words.map((word, index) => (
        <span
          key={`${word}-${index}`}
          aria-hidden="true"
          style={{ animationDelay: `${delay + index * 55}ms` }}
        >
          {word}
          {index < words.length - 1 ? " " : ""}
        </span>
      ))}
    </Tag>
  );
}
