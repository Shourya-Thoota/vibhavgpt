import { CheckCircle2, MessageSquareQuote, Mic, TrendingUp } from "lucide-react";
import { formatClock } from "../api.js";
import { Packet } from "./Packet.jsx";
import { Bar, ratingTone } from "./ui.jsx";

function ScoreRing({ total, max }) {
  const radius = 64, circumference = 2 * Math.PI * radius, share = total / Math.max(max, 1);
  return (
    <div className="ring" role="img" aria-label={`${total} out of ${max}`}>
      <svg width="150" height="150" viewBox="0 0 150 150">
        <circle cx="75" cy="75" r={radius} fill="none" stroke="var(--surface-2)" strokeWidth="12" />
        <circle cx="75" cy="75" r={radius} fill="none" stroke="var(--blue)" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${circumference * share} ${circumference}`} />
      </svg>
      <div className="ring__label"><div><strong>{total}</strong><span className="muted small">out of {max}</span></div></div>
    </div>
  );
}

export function verdict(total, max) {
  const share = total / Math.max(max, 1);
  if (share >= 0.85) return "Excellent. That's a medal-level performance.";
  if (share >= 0.7) return "Strong. You met the judge's expectations.";
  if (share >= 0.5) return "Solid start. A few areas are holding your score back.";
  return "Keep practicing. Focus on addressing every indicator.";
}

export function TranscriptView({ segments }) {
  if (!segments?.length) return <p className="muted">No conversation was captured.</p>;
  return (
    <div className="transcript">
      {segments.map((segment, index) => (
        <div key={index} className={`caption${segment.speaker === "judge" ? " caption--judge" : ""}`}>
          <b>{segment.speaker === "judge" ? "Judge" : "You"} · {formatClock(segment.t ?? 0)}</b>{segment.text}
        </div>
      ))}
    </div>
  );
}

export function ResultReport({ attempt, ownerLabel = "you" }) {
  const result = attempt.result;
  if (!result) return null;
  const delivery = result.delivery ?? {};
  const fillerEntries = Object.entries(delivery.fillers ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="stack stack--lg">
      <section className="card card--pad">
        <div className="score-hero">
          <ScoreRing total={result.total} max={result.max} />
          <div className="stack stack--sm">
            <span className="eyebrow">{attempt.eventCode} {attempt.kind} #{attempt.roleplay.number} · {attempt.roleplay.instructionalArea}</span>
            <h1 className="title">{verdict(result.total, result.max)}</h1>
            {result.summary && <p className="muted">{result.summary}</p>}
            <div className="row small muted">
              <span>Performance indicators <b style={{ color: "var(--ink)" }}>{result.performanceIndicatorTotal}</b></span>
              <span>21st Century Skills <b style={{ color: "var(--ink)" }}>{result.skillTotal}</b></span>
              {attempt.durationSeconds > 0 && <span>Length <b style={{ color: "var(--ink)" }}>{formatClock(attempt.durationSeconds)}</b></span>}
              {attempt.judge && <span>Judge <b style={{ color: "var(--ink)" }}>{attempt.judge.name}</b></span>}
            </div>
          </div>
        </div>
      </section>

      <div className="grid two-col">
        <section className="card card--pad stack">
          <h2 className="subtitle row"><CheckCircle2 size={20} color="var(--green)" /> What went well</h2>
          <ul className="list-check">{result.strengths.map((item) => <li key={item}><CheckCircle2 size={16} color="var(--green)" />{item}</li>)}</ul>
          {!result.strengths.length && <p className="muted">Nothing stood out yet. That's what practice is for.</p>}
        </section>
        <section className="card card--pad stack">
          <h2 className="subtitle row"><TrendingUp size={20} color="var(--blue)" /> How to improve</h2>
          <ul className="list-check">{result.improvements.map((item) => <li key={item}><TrendingUp size={16} color="var(--blue)" />{item}</li>)}</ul>
        </section>
      </div>

      <section className="card card--pad">
        <h2 className="subtitle">Performance indicators</h2>
        <p className="muted small" style={{ marginBottom: 6 }}>Each is scored 0 to {result.performanceIndicators[0]?.max} on DECA's four rating bands.</p>
        {result.performanceIndicators.map((entry) => (
          <div className="criterion" key={entry.index}>
            <div className="criterion__head">
              <strong>{entry.index + 1}. {entry.text}</strong>
              <span className="criterion__score">{entry.score}/{entry.max}</span>
            </div>
            <Bar value={entry.score} max={entry.max} />
            <span className={`pill pill--${ratingTone(entry.rating)}`} style={{ justifySelf: "start" }}>{entry.rating}</span>
            {entry.evidence && <p className="evidence">"{entry.evidence}"</p>}
            {entry.feedback && <p>{entry.feedback}</p>}
            {entry.improvement && <p className="small"><b>Next time:</b> {entry.improvement}</p>}
          </div>
        ))}
      </section>

      <section className="card card--pad">
        <h2 className="subtitle">21st Century Skills</h2>
        {result.skills.map((skill) => (
          <div className="criterion" key={skill.key}>
            <div className="criterion__head">
              <span><strong>{skill.label}</strong> <span className="muted small">{skill.detail}</span></span>
              <span className="criterion__score">{skill.score}/{skill.max}</span>
            </div>
            <Bar value={skill.score} max={skill.max} />
            {skill.feedback && <p>{skill.feedback}</p>}
          </div>
        ))}
      </section>

      <div className="grid two-col">
        <section className="card card--pad stack">
          <h2 className="subtitle row"><Mic size={20} color="var(--blue)" /> Delivery</h2>
          <div className="row">
            <div className="stat"><strong>{delivery.fillerTotal ?? 0}</strong><span className="muted small">filler words</span></div>
            <div className="stat" style={{ marginLeft: 20 }}><strong>{delivery.fillersPerMinute ?? 0}</strong><span className="muted small">per minute</span></div>
            <div className="stat" style={{ marginLeft: 20 }}><strong>{delivery.wordsPerMinute ?? 0}</strong><span className="muted small">words per minute</span></div>
          </div>
          {fillerEntries.length > 0 && <div className="filler-chips">{fillerEntries.map(([word, count]) => <span className="pill" key={word}>"{word}" × {count}</span>)}</div>}
          {delivery.fillerFeedback && <p>{delivery.fillerFeedback}</p>}
          {delivery.pacingFeedback && <p>{delivery.pacingFeedback}</p>}
          {delivery.professionalismFeedback && <p>{delivery.professionalismFeedback}</p>}
        </section>
        <section className="card card--pad stack">
          <h2 className="subtitle row"><MessageSquareQuote size={20} color="var(--blue)" /> The judge's questions</h2>
          {result.judgeQuestions.length ? result.judgeQuestions.map((entry) => (
            <div key={entry.question} className="stack stack--sm">
              <strong>"{entry.question}"</strong>
              <span className={`pill pill--${entry.answered ? "green" : "amber"}`} style={{ alignSelf: "flex-start" }}>{entry.answered ? "Answered" : "Not fully answered"}</span>
              <p className="small">{entry.feedback}</p>
            </div>
          )) : <p className="muted">The judge didn't get to ask questions. Save about two minutes at the end for them.</p>}
        </section>
      </div>

      <details className="panel">
        <summary>Full transcript <span className="muted small">{ownerLabel === "you" ? "Everything you and the judge said" : "Everything said in the role-play"}</span></summary>
        <div><TranscriptView segments={attempt.transcript} /></div>
      </details>
      {attempt.document && (
        <details className="panel">
          <summary>The role-play packet <span className="muted small">Situation and performance indicators</span></summary>
          <div style={{ background: "var(--surface-2)" }}><Packet doc={attempt.document} /></div>
        </details>
      )}
      {attempt.judge && (
        <details className="panel">
          <summary>Judge's instructions <span className="muted small">What {attempt.judge.name} was told</span></summary>
          <div className="stack">
            <p>{attempt.judge.characterization}</p>
            <ol style={{ margin: 0, paddingLeft: 20 }}>{attempt.judge.questions.map((question) => <li key={question}>{question}</li>)}</ol>
          </div>
        </details>
      )}
    </div>
  );
}
