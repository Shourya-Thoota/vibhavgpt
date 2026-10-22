import { useState } from "react";
import { ArrowLeft, Check, Copy, ScanSearch, Sparkles, Wand2 } from "lucide-react";
import { Segmented } from "./ui.jsx";
import { copyText } from "../clipboard.js";
import "../writing-tools.css";

// VibhavGPT Writing Tools in Study mode: an AI Detector and a Humanizer.
// Native components only; both tools talk to /api/study.
export const MIN_WORDS = 30;
export const MAX_WORDS = 3000;
const countWords = (text) => (text.match(/\S+/g) ?? []).length;

function Counter({ text }) {
  const words = countWords(text);
  const tone = words > MAX_WORDS ? " writing-tools__count--over" : words && words < MIN_WORDS ? " writing-tools__count--under" : "";
  return (
    <span className={`writing-tools__count${tone}`} aria-live="polite">
      {words.toLocaleString()} {words === 1 ? "word" : "words"} · {text.length.toLocaleString()} characters
    </span>
  );
}

const ready = (text) => { const words = countWords(text); return words >= MIN_WORDS && words <= MAX_WORDS; };

function ScoreDial({ humanScore }) {
  const radius = 52, circumference = 2 * Math.PI * radius;
  const verdict = humanScore >= 70 ? "Likely Human" : humanScore >= 40 ? "Mixed signals" : "Likely AI";
  return (
    <div className="writing-tools__dial" role="img" aria-label={`${humanScore}% ${verdict}`}>
      <svg viewBox="0 0 128 128" width="128" height="128" aria-hidden="true">
        <circle cx="64" cy="64" r={radius} className="writing-tools__dial-track" />
        <circle cx="64" cy="64" r={radius} className="writing-tools__dial-value" strokeDasharray={`${(humanScore / 100) * circumference} ${circumference}`} />
      </svg>
      <div className="writing-tools__dial-label"><strong>{humanScore}%</strong><span>{verdict}</span></div>
    </div>
  );
}

function Detector({ api, text, setText, onHumanize }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function scan() {
    setBusy(true); setError("");
    try { setResult(await api("/api/study/detect", { method: "POST", body: JSON.stringify({ text }) })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const flagged = result?.sentences.filter((sentence) => sentence.aiProbability >= 0.6).length ?? 0;
  return (
    <div className="writing-tools__panel">
      <label className="writing-tools__label" htmlFor="writing-detector-input">Text to scan</label>
      <textarea id="writing-detector-input" className="textarea writing-tools__input" value={text} onChange={(event) => { setText(event.target.value); setResult(null); }}
        placeholder={`Paste at least ${MIN_WORDS} words of writing to check how human it reads.`} />
      <div className="writing-tools__bar">
        <Counter text={text} />
        <button type="button" className="btn btn--primary" disabled={!ready(text) || busy} onClick={scan} aria-busy={busy}>
          <ScanSearch size={16} />{busy ? "Scanning…" : "Scan Text"}
        </button>
      </div>
      {error && <p className="banner banner--error" role="alert">{error}</p>}
      {result && (
        <section className="writing-tools__result" aria-label="Scan result">
          <div className="writing-tools__summary">
            <ScoreDial humanScore={result.humanScore} />
            <div className="writing-tools__meter">
              <div className="writing-tools__meter-row"><span>Human</span><strong>{result.humanScore}%</strong></div>
              <div className="writing-tools__track"><span className="writing-tools__fill" style={{ width: `${result.humanScore}%` }} /></div>
              <div className="writing-tools__meter-row writing-tools__meter-row--ai"><span>AI</span><strong>{result.aiScore}%</strong></div>
              <p className="writing-tools__note">{flagged ? `${flagged} of ${result.sentences.length} sentences have a high AI cadence.` : "No sentences stand out as machine-like."} This is an estimate from writing patterns, not proof of who wrote it.</p>
              <button type="button" className="btn btn--secondary" onClick={() => onHumanize(text)}><Wand2 size={16} />Send to Humanizer</button>
            </div>
          </div>
          <h3 className="writing-tools__heading">Sentence breakdown</h3>
          <p className="writing-tools__sentences">
            {result.sentences.map((sentence, index) => (
              <span key={index} className={`writing-tools__sentence${sentence.aiProbability >= 0.6 ? " writing-tools__sentence--flagged" : ""}`}
                title={`${Math.round(sentence.aiProbability * 100)}% AI · ${sentence.reason}`}>{sentence.text} </span>
            ))}
          </p>
          {flagged > 0 && (
            <ul className="writing-tools__reasons">
              {result.sentences.filter((sentence) => sentence.aiProbability >= 0.6).slice(0, 6).map((sentence, index) => (
                <li key={index}><strong>{Math.round(sentence.aiProbability * 100)}%</strong> {sentence.reason}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function Humanizer({ api, text, setText, onScan }) {
  const [tone, setTone] = useState("natural");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  async function humanize() {
    setBusy(true); setError(""); setCopied(false);
    try { setOutput((await api("/api/study/humanize", { method: "POST", body: JSON.stringify({ text, tone }) })).text); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function copy() {
    await copyText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }
  return (
    <div className="writing-tools__panel">
      <div className="writing-tools__bar">
        <span className="writing-tools__label">Tone</span>
        <Segmented label="Tone" size="sm" value={tone} onChange={setTone} options={[{ value: "natural", label: "Natural" }, { value: "academic", label: "Academic" }]} />
      </div>
      <div className="writing-tools__dual">
        <div className="writing-tools__side">
          <label className="writing-tools__label" htmlFor="writing-humanizer-input">Your text</label>
          <textarea id="writing-humanizer-input" className="textarea writing-tools__input" value={text} onChange={(event) => setText(event.target.value)}
            placeholder="Paste writing that sounds stiff or robotic. Facts, names and numbers stay exactly as they are." />
          <Counter text={text} />
        </div>
        <div className="writing-tools__side">
          <span className="writing-tools__label">Rewritten</span>
          <div className={`writing-tools__output${output ? "" : " writing-tools__output--empty"}`} aria-live="polite">
            {busy ? <span className="writing-tools__pending">Rewriting…</span> : output || "Your rewritten text will appear here."}
          </div>
          {output && !busy && <Counter text={output} />}
        </div>
      </div>
      <div className="writing-tools__bar">
        <span className="writing-tools__note">Review the result before you use it, and follow your school's rules on writing help.</span>
        <button type="button" className="btn btn--primary" disabled={!ready(text) || busy} onClick={humanize} aria-busy={busy}>
          <Sparkles size={16} />{busy ? "Humanizing…" : "Humanize"}
        </button>
      </div>
      {error && <p className="banner banner--error" role="alert">{error}</p>}
      {output && !busy && (
        <div className="writing-tools__actions">
          <button type="button" className="btn btn--secondary" onClick={copy}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "Copied" : "Copy"}</button>
          <button type="button" className="btn btn--secondary" onClick={() => onScan(output)}><ScanSearch size={16} />Scan in Detector</button>
        </div>
      )}
    </div>
  );
}

export default function StudyWritingTools({ api, onBack }) {
  const [tab, setTab] = useState("detector");
  const [detectorText, setDetectorText] = useState("");
  const [humanizerText, setHumanizerText] = useState("");
  return (
    <section className="writing-tools" aria-label="VibhavGPT Writing Tools">
      <header className="writing-tools__header">
        {onBack && <button type="button" className="btn btn--quiet writing-tools__back" onClick={onBack}><ArrowLeft size={15} />Back to study chat</button>}
        <p className="writing-tools__eyebrow">VibhavGPT Writing Tools</p>
        <h2 className="writing-tools__title">{tab === "detector" ? "VibhavGPT AI Detector" : "VibhavGPT Humanizer"}</h2>
        <Segmented label="Writing tool" value={tab} onChange={setTab} options={[
          { value: "detector", label: "AI Detector", icon: <ScanSearch size={15} /> },
          { value: "humanizer", label: "AI Humanizer", icon: <Wand2 size={15} /> },
        ]} />
      </header>
      {tab === "detector"
        ? <Detector api={api} text={detectorText} setText={setDetectorText} onHumanize={(text) => { setHumanizerText(text); setTab("humanizer"); }} />
        : <Humanizer api={api} text={humanizerText} setText={setHumanizerText} onScan={(text) => { setDetectorText(text); setTab("detector"); }} />}
    </section>
  );
}
