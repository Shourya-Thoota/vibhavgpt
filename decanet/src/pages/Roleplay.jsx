import { ArrowRight, Hand, Mic, MicOff, PhoneOff, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, formatClock } from "../api.js";
import { Packet } from "../components/Packet.jsx";
import { ResultReport, TranscriptView } from "../components/ResultReport.jsx";
import { Modal, Notice, Spinner } from "../components/ui.jsx";
import { JudgeCall } from "../judge-call.js";
import { Link } from "../router.jsx";
import { useSession } from "../session.jsx";

function useCountdown(seconds, onZero) {
  const deadline = useRef(Date.now() + seconds * 1000);
  const [left, setLeft] = useState(seconds);
  const fired = useRef(false);
  useEffect(() => { deadline.current = Date.now() + seconds * 1000; fired.current = false; setLeft(seconds); }, [seconds]);
  useEffect(() => {
    const timer = setInterval(() => {
      const next = Math.max(0, (deadline.current - Date.now()) / 1000);
      setLeft(next);
      if (next <= 0 && !fired.current) { fired.current = true; onZero?.(); }
    }, 250);
    return () => clearInterval(timer);
  }, [onZero]);
  return left;
}

function useLeaveGuard(active) {
  useEffect(() => {
    if (!active) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);
}

function Clock({ left, warnAt = 60 }) {
  const tone = left <= 30 ? " clock--danger" : left <= warnAt ? " clock--warn" : "";
  return <span className={`clock${tone}`} role="timer" aria-label={`${formatClock(left)} remaining`}>{formatClock(left)}</span>;
}

// ---- Prep -------------------------------------------------------------------

function Prep({ attempt, reload }) {
  const [notes, setNotes] = useState(attempt.notes ?? "");
  const [saved, setSaved] = useState("Saved");
  const [confirming, setConfirming] = useState(false);
  const [moving, setMoving] = useState(false);
  const saveTimer = useRef(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  useLeaveGuard(true);

  const advance = useCallback(async () => {
    setMoving(true);
    clearTimeout(saveTimer.current);
    await api(`/attempts/${attempt.id}/continue`, { method: "POST", body: { notes: notesRef.current } }).catch(() => {});
    reload();
  }, [attempt.id, reload]);
  const left = useCountdown(attempt.prepRemaining, advance);

  function edit(value) {
    setNotes(value);
    setSaved("Saving…");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api(`/attempts/${attempt.id}/notes`, { method: "PUT", body: { notes: value } })
        .then(() => setSaved("Saved"))
        .catch((error) => { if (error.code === "prep-over") reload(); else setSaved("Not saved, retrying…"); });
    }, 700);
  }

  return (
    <div className="workspace">
      <div className="workbar">
        <div className="workbar__title">{attempt.eventCode} {attempt.kind} #{attempt.roleplay.number}<span>Prep · {attempt.roleplay.instructionalArea}</span></div>
        <span className="nav__spacer" />
        <Clock left={left} warnAt={120} />
        <button className="btn btn--primary" onClick={() => setConfirming(true)} disabled={moving}>Continue to {attempt.kind === "Case Study" ? "presentation" : "role-play"} <ArrowRight size={16} /></button>
      </div>
      <div className="split">
        <div className="split__doc"><Packet doc={attempt.document} /></div>
        <div className="split__notes">
          <div className="notes-head"><b>Your notes</b><span className="tiny muted">{saved}</span></div>
          <textarea className="notes-area" value={notes} onChange={(event) => edit(event.target.value)} autoFocus
            placeholder={"Plan your presentation here. Your notes stay on screen during the role-play; the packet doesn't.\n\nTip: jot one idea for each performance indicator, then an opening and a close."} />
          <div className="notes-head tiny muted" style={{ borderTop: "1px solid var(--line)", borderBottom: 0 }}>{notes.trim() ? notes.trim().split(/\s+/).length : 0} words</div>
        </div>
      </div>
      {confirming && (
        <Modal title="Ready to meet the judge?" onClose={() => setConfirming(false)}
          actions={<><button className="btn btn--ghost" onClick={() => setConfirming(false)}>Keep prepping</button><button className="btn btn--primary" onClick={advance} disabled={moving}>I'm ready</button></>}>
          <p>The packet will be put away and only your notes will stay on screen. You still have {formatClock(left)} of prep left, which you'll give up.</p>
        </Modal>
      )}
    </div>
  );
}

// ---- Live role-play -----------------------------------------------------------

function MicCheck({ onReady }) {
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let stream, context, frame;
    navigator.mediaDevices?.getUserMedia({ audio: true }).then((media) => {
      stream = media;
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(media).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const loop = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const value of data) peak = Math.max(peak, Math.abs(value - 128));
        setLevel(Math.min(1, peak / 64));
        frame = requestAnimationFrame(loop);
      };
      loop();
      onReady?.(true);
    }).catch(() => { setError("DECANet can't use your microphone. Allow microphone access in your browser's address bar, then reload."); onReady?.(false); });
    return () => { cancelAnimationFrame(frame); stream?.getTracks().forEach((track) => track.stop()); context?.close(); };
  }, [onReady]);
  if (error) return <Notice tone="red">{error}</Notice>;
  return <div className="stack stack--sm" style={{ alignItems: "center" }}><div className="level"><span style={{ width: `${level * 100}%` }} /></div><span className="tiny muted">Say something to test your mic</span></div>;
}

const PHASE_TEXT = {
  connecting: "Connecting you to the judge…",
  greeting: "The judge is greeting you",
  presenting: "Present your ideas. The judge is listening.",
  q1: "The judge has a question",
  answer1: "Answer the judge's question",
  q2: "The judge has another question",
  answer2: "Answer the judge's question",
  closing: "The judge is wrapping up",
  "closing-done": "Wrapping up…",
  dropped: "The connection dropped",
  done: "Finished",
};

function Live({ attempt, reload }) {
  const { notify } = useSession();
  const [stage, setStage] = useState("ready");
  const [micOk, setMicOk] = useState(null);
  const [call, setCall] = useState(null);
  const [state, setState] = useState({ phase: "connecting", segments: attempt.transcript ?? [] });
  const [remaining, setRemaining] = useState(attempt.roleplayRemaining);
  const [tab, setTab] = useState("notes");
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState("");
  const deadline = useRef(null);
  const flags = useRef({ warned: false, minute: false, questions: false });
  const finishing = useRef(false);
  useLeaveGuard(stage !== "ready");

  const finish = useCallback(async (payload) => {
    if (finishing.current) return;
    finishing.current = true;
    setStage("finishing");
    await api(`/attempts/${attempt.id}/finish`, { method: "POST", body: payload }).catch(() => {});
    reload();
  }, [attempt.id, reload]);

  async function connect(existingSegments) {
    setError("");
    setStage("live");
    const judge = new JudgeCall({
      attemptId: attempt.id,
      transcript: existingSegments ?? attempt.transcript ?? [],
      offsetSeconds: attempt.roleplaySeconds - (deadline.current ? Math.max(0, (deadline.current - Date.now()) / 1000) : attempt.roleplayRemaining),
      onChange: setState,
      onFinished: finish,
    });
    try {
      const answer = await judge.connect();
      deadline.current = Date.now() + answer.roleplayRemaining * 1000;
      setCall(judge);
    } catch (failure) {
      judge.close();
      if (failure.code === "time-up") return finish({ segments: judge.segments, usage: judge.usage });
      setError(failure.name === "NotAllowedError" ? "Microphone access was blocked. Allow it in your browser, then try again." : failure.message ?? "We couldn't connect to the judge.");
      setStage("ready");
    }
  }

  useEffect(() => () => call?.close(), [call]);

  useEffect(() => {
    if (stage !== "live") return undefined;
    const timer = setInterval(() => {
      if (!deadline.current) return;
      const left = Math.max(0, (deadline.current - Date.now()) / 1000);
      setRemaining(left);
      if (left <= attempt.warnAtRemaining && !flags.current.warned) {
        flags.current.warned = true;
        notify(`${Math.round(attempt.warnAtRemaining / 60)} minutes left. Save time for the judge's questions.`);
      }
      if (left <= 60 && !flags.current.minute) { flags.current.minute = true; notify("1 minute left."); }
      if (left <= attempt.questionsAtRemaining && !flags.current.questions && call) { flags.current.questions = true; call.startQuestions("time"); }
      if (left <= 0 && call) call.finish();
    }, 250);
    return () => clearInterval(timer);
  }, [stage, call, attempt, notify]);

  const minutes = Math.round(attempt.roleplaySeconds / 60);
  const resumed = (attempt.transcript ?? []).length > 0 || attempt.roleplayStarted;

  if (stage === "ready") {
    return (
      <div className="page page--narrow">
        <div className="card card--pad stack" style={{ alignItems: "center", textAlign: "center" }}>
          <div className="judge-orb judge-orb--listening" style={{ width: 120, height: 120 }}><Mic size={40} /></div>
          <h1 className="title">{resumed ? "Rejoin your role-play" : "Your judge is ready"}</h1>
          <p className="muted" style={{ maxWidth: 520 }}>
            {resumed
              ? `Your clock kept running while you were away: about ${formatClock(attempt.roleplayRemaining)} is left. The judge will pick up where you left off.`
              : `You'll have up to ${minutes} minutes. The judge will introduce themselves, then it's your turn to present.`}
          </p>
          <MicCheck onReady={setMicOk} />
          <Notice>Present your ideas out loud like you're in the room. Leave about {attempt.kind === "Case Study" ? "5" : "2"} minutes at the end for the judge's questions. Say you're finished, or press <b>I'm finished presenting</b>, when you're done.</Notice>
          {error && <Notice tone="red">{error}</Notice>}
          <button className="btn btn--primary btn--lg" disabled={micOk === false} onClick={() => connect()}>{resumed ? "Rejoin" : "Start role-play"}</button>
        </div>
      </div>
    );
  }

  if (stage === "finishing") return <Spinner label="Sending your role-play to be scored…" />;

  const presenting = state.phase === "presenting" || state.phase === "greeting";
  return (
    <div className="workspace">
      <div className="workbar">
        <div className="workbar__title">{attempt.eventCode} {attempt.kind} #{attempt.roleplay.number}<span>{attempt.roleplay.instructionalArea}</span></div>
        <span className="nav__spacer" />
        <Clock left={remaining} warnAt={attempt.warnAtRemaining} />
        <button className="btn btn--danger" onClick={() => setEnding(true)}><PhoneOff size={16} /> End</button>
      </div>
      <div className="stage">
        <div className="stage__main">
          <div className={`judge-orb${state.judgeSpeaking ? " judge-orb--speaking" : " judge-orb--listening"}`}>
            {state.judgeSpeaking ? <div className="wave">{Array.from({ length: 9 }, (_, index) => <span key={index} style={{ background: "#fff", animationDelay: `${index * 0.1}s` }} />)}</div> : <Mic size={48} />}
          </div>
          <div className="stack stack--sm">
            <h2 className="subtitle">{state.judgeSpeaking ? "The judge is speaking" : PHASE_TEXT[state.phase] ?? ""}</h2>
            <div className="you-meter" style={{ justifyContent: "center" }}><span className={`you-dot${state.userSpeaking ? " you-dot--on" : ""}`} />{state.userSpeaking ? "You're speaking" : "Your mic is on"}</div>
          </div>
          {remaining <= attempt.warnAtRemaining && presenting && (
            <Notice tone="amber">Time is getting short. Wrap up so the judge has time for questions.</Notice>
          )}
          {state.phase === "dropped" ? (
            <button className="btn btn--primary" onClick={() => { call?.close(); connect(state.segments); }}><RefreshCw size={16} /> Reconnect</button>
          ) : (
            <button className="btn btn--ghost btn--lg" disabled={!presenting || !call} onClick={() => call.startQuestions("participant")}><Hand size={18} /> I'm finished presenting</button>
          )}
          {error && <Notice tone="red">{error}</Notice>}
        </div>
        <aside className="stage__side">
          <div className="side-tabs" role="tablist">
            <button role="tab" aria-selected={tab === "notes"} onClick={() => setTab("notes")}>Your notes</button>
            <button role="tab" aria-selected={tab === "captions"} onClick={() => setTab("captions")}>Live captions</button>
          </div>
          {tab === "notes"
            ? <div className="notes-readonly">{attempt.notes?.trim() || <span className="muted">You didn't write any notes.</span>}</div>
            : <div className="captions"><TranscriptView segments={state.segments} /></div>}
        </aside>
      </div>
      {ending && (
        <Modal title="End the role-play now?" onClose={() => setEnding(false)}
          actions={<><button className="btn btn--ghost" onClick={() => setEnding(false)}>Keep going</button><button className="btn btn--primary" onClick={() => { setEnding(false); call ? call.finish() : finish({ segments: state.segments }); }}>End and get my score</button></>}>
          <p>You'll be scored on everything said so far. You can't continue this role-play afterwards.</p>
        </Modal>
      )}
    </div>
  );
}

// ---- Scoring and results ---------------------------------------------------------

function Grading({ attempt, reload }) {
  useEffect(() => {
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
  }, [reload]);
  if (attempt.gradingFailed) {
    return (
      <div className="center">
        <MicOff size={32} color="var(--amber)" />
        <h1 className="subtitle">We couldn't score this role-play yet.</h1>
        <p className="muted">Your role-play is saved. Try scoring it again.</p>
        <button className="btn btn--primary" onClick={() => api(`/attempts/${attempt.id}/retry-grading`, { method: "POST" }).then(reload)}>Try again</button>
      </div>
    );
  }
  return <Spinner label="Your judge is scoring your performance. This usually takes under a minute." />;
}

export function Roleplay({ id }) {
  const { refresh } = useSession();
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => api(`/attempts/${id}`).then(setAttempt).catch((failure) => setError(failure.message)), [id]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { if (attempt?.status === "graded") refresh(); }, [attempt?.status, refresh]);

  if (error) return <div className="page page--narrow"><Notice tone="red">{error}</Notice><p style={{ marginTop: 16 }}><Link to="/dashboard">Back to your role-plays</Link></p></div>;
  if (!attempt) return <Spinner />;
  if (attempt.status === "prep") return <Prep key={attempt.status} attempt={attempt} reload={reload} />;
  if (attempt.status === "roleplay") return <Live key={attempt.status} attempt={attempt} reload={reload} />;
  if (attempt.status === "grading") return <Grading attempt={attempt} reload={reload} />;
  return (
    <div className="page">
      <div className="row row--between" style={{ marginBottom: 20 }}>
        <Link to="/dashboard" className="small">← Back to your role-plays</Link>
      </div>
      <ResultReport attempt={attempt} />
    </div>
  );
}
