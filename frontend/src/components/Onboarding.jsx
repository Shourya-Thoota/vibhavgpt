import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  axisReadout,
  CAPABILITY_FREE_NOTES,
  ONBOARDING_STEPS,
  ONBOARDING_STEP_COUNT,
  PREFERRED_NAME_MAX,
  SKY_OPTIONS,
  defaultOnboarding,
  personalityHeadline,
} from "../onboarding.js";
import "../onboarding.css";

/* -- Slider ---------------------------------------------------------------- */

// A styled native range input: touch, mouse, and keyboard all come for free,
// and `--fill` lets the track paint the accent up to the thumb in one pass
// without a second element tracking the value. Settings reuses it.
export function PersonalitySlider({ axis, value, onChange }) {
  const labelId = `personality-${axis.id}`;
  return (
    <div className="survey-slider">
      <div className="survey-slider__head">
        <span className="survey-slider__name" id={labelId}>{axis.question}</span>
        <span className="survey-slider__read" aria-live="polite">{axisReadout(axis, value)}</span>
      </div>
      <input
        className="survey-slider__input"
        type="range"
        min="0"
        max="100"
        step="1"
        value={value}
        style={{ "--fill": `${value}%` }}
        aria-labelledby={labelId}
        aria-valuetext={`${value}. ${axisReadout(axis, value)}`}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <div className="survey-slider__poles" aria-hidden="true">
        <span>{axis.poles[0]}</span>
        <span>{axis.poles[1]}</span>
      </div>
    </div>
  );
}

/* -- Answers --------------------------------------------------------------- */

/**
 * Answers are words, not boxes. Each sits beside a small orb: an empty ring
 * until chosen, then a lit planet in the accent. Multi-select answers flow
 * like a sentence; single-select answers stack, each with one line saying
 * what it means. The orb's state, the ink weight and aria-checked all carry
 * the selection, so colour never carries it alone.
 */
function Orb() {
  return <span className="survey-orb" aria-hidden="true" />;
}

function WordChoices({ options, isSelected, onToggle, label }) {
  return (
    <div className="survey-words" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="checkbox"
          className="survey-word"
          aria-checked={isSelected(option.value)}
          onClick={() => onToggle(option.value)}
        >
          <Orb />
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ListChoices({ options, value, onSelect, noteFor, label }) {
  return (
    <div className="survey-list" role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const note = noteFor?.(option.value);
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            className="survey-option"
            aria-checked={value === option.value}
            onClick={() => onSelect(option.value)}
          >
            <Orb />
            <span className="survey-option__text">
              <span className="survey-option__label">{option.label}</span>
              {(option.detail || note) && <span className="survey-option__detail">{note ?? option.detail}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* -- Sky and universe ------------------------------------------------------ */

function SkyChoices({ value, onSelect }) {
  return (
    <div className="survey-skies" role="radiogroup" aria-label="Sky">
      {SKY_OPTIONS.map((option) => (
        <button key={option.value} type="button" role="radio" className="survey-sky" data-sky={option.value} aria-checked={value === option.value} onClick={() => onSelect(option.value)}>
          <span className="survey-sky__planet" aria-hidden="true" />
          <span className="survey-sky__label">{option.label}</span>
          <span className="survey-sky__detail">{option.detail}</span>
        </button>
      ))}
    </div>
  );
}

function AccentDots({ options, value, onSelect, label }) {
  return (
    <div className="survey-accents" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          className="survey-accent"
          style={{ "--swatch": `var(--color-accent-${option.accentId})` }}
          aria-checked={value === option.value}
          onClick={() => onSelect(option.value)}
        >
          <span aria-hidden="true" />
          {option.label}
        </button>
      ))}
    </div>
  );
}

// A small, live picture of the workspace in the chosen sky and universe.
// Every colour is the real token (both are already applied to the page as
// you choose), so this is what the app will look like, not a mock-up of it.
function UniversePreview({ option }) {
  return (
    <figure className="survey-preview" aria-label={`Preview: ${option.label}`}>
      <div className="survey-preview__frame" key={option.value}>
        <div className="survey-preview__sky" aria-hidden="true">
          <span className="survey-preview__planet" />
        </div>
        <div className="survey-preview__body" aria-hidden="true">
          <p className="survey-preview__greeting">Ready when you are<span>,</span></p>
          <div className="survey-preview__composer">
            <span>Ask anything</span>
            <span className="survey-preview__send" />
          </div>
          <div className="survey-preview__chips">
            <span data-on>Web</span>
            <span>Study</span>
          </div>
        </div>
      </div>
    </figure>
  );
}

/* -- Flow ------------------------------------------------------------------ */

/**
 * The survey. `initial` seeds a re-run from Settings; `onPreviewTheme` and
 * `onPreviewSky` let the last step apply live, so the final screen is already
 * wearing the answer before Continue is pressed.
 */
export default function Onboarding({ initial, tier = "free", onFinish, onSkip, onPreviewTheme, onPreviewSky }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState(() => ({ ...defaultOnboarding(), ...initial, onboarding_completed: false }));
  const step = ONBOARDING_STEPS[index];
  const columnRef = useRef(null);
  const nameRef = useRef(null);
  // What was in play when the flow opened, so Back out of the last step (or
  // a Skip from it) restores what the user had rather than the live preview.
  const enteredWith = useRef({ theme: answers.theme, sky: answers.sky });

  const setField = useCallback((field, value) => setAnswers((current) => ({ ...current, [field]: value })), []);

  const restorePreview = useCallback(() => {
    onPreviewTheme?.(enteredWith.current.theme);
    onPreviewSky?.(enteredWith.current.sky);
  }, [onPreviewSky, onPreviewTheme]);

  const advance = useCallback(() => {
    if (index + 1 < ONBOARDING_STEP_COUNT) setIndex(index + 1);
    else onFinish({ ...answers, onboarding_completed: true });
  }, [answers, index, onFinish]);

  const back = useCallback(() => {
    if (index === 0) return;
    if (step.kind === "themes") restorePreview();
    setIndex(index - 1);
  }, [index, restorePreview, step.kind]);

  // Enter = Continue, from anywhere on the screen. Ignored while a button has
  // focus so a keyboard user does not both choose an answer and advance.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Enter" || event.defaultPrevented) return;
      if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement) return;
      event.preventDefault();
      advance();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [advance]);

  // Each screen is its own scroll context; a long step (the sliders on a
  // phone) must not open halfway down because the previous one was scrolled.
  useEffect(() => {
    columnRef.current?.scrollTo?.({ top: 0 });
    if (step.kind === "name") requestAnimationFrame(() => nameRef.current?.focus());
  }, [index, step.kind]);

  const continueLabel = step.cta ?? "Continue";
  const progress = Math.round(((index + 1) / ONBOARDING_STEP_COUNT) * 100);
  const summary = useMemo(() => personalityHeadline(answers.personality), [answers.personality]);

  const toggleRole = (value) => setAnswers((current) => ({
    ...current,
    role: current.role.includes(value) ? current.role.filter((item) => item !== value) : [...current.role, value],
  }));

  return (
    <main className="survey" data-step={step.id}>
      <div className="survey__progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
      <div className="survey__stars" aria-hidden="true" />

      <header className="survey__bar">
        <button type="button" className="btn btn--quiet survey__back" onClick={back} hidden={index === 0}>Back</button>
        <span className="survey__count">Step {index + 1} of {ONBOARDING_STEP_COUNT}</span>
        <button type="button" className="btn btn--quiet survey__skip" onClick={() => { restorePreview(); onSkip(); }}>
          Skip
        </button>
      </header>

      <div className="survey__column" ref={columnRef}>
        <div className="survey__screen" key={step.id}>
          {step.kind === "welcome" && (
            <div className="survey__hero">
              <div className="survey__orb"><img src="/planets/earth.webp" alt="" /></div>
              <h1 className="survey__headline survey__headline--hero">{step.headline}</h1>
              <p className="survey__subline">{step.subline}</p>
            </div>
          )}

          {step.kind !== "welcome" && (
            <>
              <h1 className="survey__headline" id={`survey-${step.id}`}>{step.headline}</h1>
              <p className="survey__subline">{step.subline}</p>
            </>
          )}

          {step.kind === "name" && (
            <input
              ref={nameRef}
              className="survey-name"
              aria-labelledby={`survey-${step.id}`}
              value={answers.preferred_name}
              maxLength={PREFERRED_NAME_MAX}
              autoComplete="given-name"
              placeholder="Your name"
              onChange={(event) => setField("preferred_name", event.target.value)}
            />
          )}

          {step.kind === "pills" && step.multi && (
            <WordChoices label={step.headline} options={step.options} isSelected={(value) => answers.role.includes(value)} onToggle={toggleRole} />
          )}

          {step.kind === "pills" && !step.multi && (
            <ListChoices
              label={step.headline}
              options={step.options}
              value={answers[step.field]}
              onSelect={(value) => setField(step.field, value)}
              noteFor={step.field === "primary_capability" && tier === "free" ? (value) => CAPABILITY_FREE_NOTES[value] : undefined}
            />
          )}

          {step.kind === "sliders" && (
            <div className="survey__sliders">
              {step.axes.map((axis) => (
                <PersonalitySlider
                  key={axis.id}
                  axis={axis}
                  value={answers.personality[axis.id]}
                  onChange={(value) => setAnswers((current) => ({
                    ...current,
                    personality: { ...current.personality, [axis.id]: value },
                  }))}
                />
              ))}
              <p className="survey__summary" aria-live="polite">{summary}</p>
            </div>
          )}

          {step.kind === "themes" && (
            <div className="survey__universe">
              <SkyChoices value={answers.sky} onSelect={(value) => { setField("sky", value); onPreviewSky?.(value); }} />
              <AccentDots
                options={step.options}
                value={answers.theme}
                label="Universe"
                onSelect={(value) => { setField("theme", value); onPreviewTheme?.(value); }}
              />
              <UniversePreview option={step.options.find((option) => option.value === answers.theme) ?? step.options[0]} />
            </div>
          )}
        </div>
      </div>

      <footer className="survey__foot">
        <button type="button" className="btn btn--primary btn--lg survey__cta" onClick={advance}>{continueLabel}</button>
      </footer>
    </main>
  );
}
