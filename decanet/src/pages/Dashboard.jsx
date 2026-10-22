import { CheckCircle2, Coins, Lock, PlayCircle, RotateCcw, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { api, formatDate } from "../api.js";
import { EventPicker } from "../components/EventPicker.jsx";
import { Modal, Notice, Spinner } from "../components/ui.jsx";
import { Link, navigate } from "../router.jsx";
import { useSession } from "../session.jsx";

function StartModal({ roleplay, event, credits, onClose }) {
  const { refresh } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function start() {
    setBusy(true); setError("");
    try {
      const attempt = await api("/attempts", { method: "POST", body: { roleplayId: roleplay.id } });
      await refresh();
      navigate(`/roleplay/${attempt.id}`);
    } catch (failure) {
      if (failure.code?.startsWith("active-attempt:")) return navigate(`/roleplay/${failure.code.split(":")[1]}`);
      setError(failure.message);
      setBusy(false);
    }
  }
  const outOfCredits = credits < 1;
  return (
    <Modal title={`Start ${event.team ? "Case Study" : "Role-Play"} #${roleplay.number}?`} onClose={onClose}
      actions={outOfCredits
        ? <><button className="btn btn--ghost" onClick={onClose}>Cancel</button><Link to="/credits" className="btn btn--primary">Buy credits</Link></>
        : <><button className="btn btn--ghost" onClick={onClose}>Not yet</button><button className="btn btn--primary" onClick={start} disabled={busy}>{busy ? "Starting…" : "Use 1 credit and start prep"}</button></>}>
      <div className="stack">
        <p><b>{roleplay.instructionalArea}</b> · {roleplay.title}</p>
        {roleplay.completed && <Notice tone="amber">You've already done this one{roleplay.bestScore !== null ? ` (best score ${roleplay.bestScore})` : ""}. You can do it again, but a new role-play is better practice: you won't already know the situation.</Notice>}
        <Notice>
          The clock starts the moment you confirm: <b>{event.prepMinutes} minutes to prep</b>, then <b>up to {event.roleplayMinutes} minutes with the judge</b>. If you leave, you can resume later, but the clock keeps running, so it isn't recommended.
        </Notice>
        <Notice tone="amber">DECANet can't stop you from browsing the internet during prep, but we <b>highly</b> recommend you don't. Keep it real so it counts at competition.</Notice>
        <p className="small muted">You'll need a microphone. This uses 1 of your {credits} credit{credits === 1 ? "" : "s"}.</p>
        {outOfCredits && <Notice tone="red">You're out of credits.</Notice>}
        {error && <p className="error">{error}</p>}
      </div>
    </Modal>
  );
}

function ChangeEventModal({ current, onClose, onSaved }) {
  const [code, setCode] = useState(current);
  const [error, setError] = useState("");
  async function save() {
    try { await api("/account", { method: "PATCH", body: { eventCode: code } }); onSaved(); } catch (failure) { setError(failure.message); }
  }
  return (
    <Modal title="Change your event" onClose={onClose} wide actions={<><button className="btn btn--ghost" onClick={onClose}>Cancel</button><button className="btn btn--primary" disabled={!code || code === current} onClick={save}>Switch to {code}</button></>}>
      <EventPicker value={code} onChange={setCode} />
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

export function Dashboard() {
  const { eventByCode, chapter, refresh } = useSession();
  const [data, setData] = useState(null);
  const [starting, setStarting] = useState(null);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState("");
  const load = () => api("/dashboard").then(setData).catch((failure) => setError(failure.message));
  useEffect(() => { load(); }, []);

  if (error) return <div className="page"><Notice tone="red">{error}</Notice></div>;
  if (!data) return <Spinner />;
  const event = eventByCode(data.eventCode);
  if (!data.eventCode || !event) return <div className="page page--narrow"><div className="card card--pad stack"><h1 className="subtitle">Pick your event to see your role-plays.</h1><Link to="/welcome" className="btn btn--primary">Choose an event</Link></div></div>;
  const done = data.roleplays.filter((roleplay) => roleplay.completed).length;

  return (
    <div className="page">
      {data.active && (
        <div className="banner">
          <div><b>You have a {event.team ? "case study" : "role-play"} in progress.</b> <span style={{ opacity: .85 }}>#{data.active.roleplay.number} {data.active.roleplay.instructionalArea}, {data.active.status === "prep" ? "in prep" : "with the judge"}. The clock is still running.</span></div>
          <Link to={`/roleplay/${data.active.id}`} className="btn btn--sm"><PlayCircle size={16} /> Resume</Link>
        </div>
      )}
      <div className="dash-head">
        <div className="stack stack--sm">
          <span className="eyebrow">{event.cluster} · {event.formatLabel}</span>
          <h1 className="title">{event.name}</h1>
          <div className="row small muted">
            <span>{done} of {data.roleplays.length} completed</span>
            <span>·</span>
            <span>{event.prepMinutes} min prep, {event.roleplayMinutes} min with the judge</span>
            {data.eventLocked
              ? <span className="pill"><Lock size={12} /> Locked by your advisor</span>
              : <button className="btn btn--quiet btn--sm" onClick={() => setChanging(true)}>Change event</button>}
          </div>
        </div>
        <div className="credit-chip"><Coins size={18} color="var(--blue)" /><span><strong>{data.credits}</strong> credit{data.credits === 1 ? "" : "s"}</span><Link to="/credits" className="btn btn--primary btn--sm">Buy</Link></div>
      </div>

      <div className="grid rp-grid">
        {data.roleplays.map((roleplay) => (
          <button key={roleplay.id} type="button" className={`rp-card${roleplay.completed ? " rp-card--done" : ""}`} onClick={() => setStarting(roleplay)}>
            <span className="rp-card__num">{event.team ? "Case Study" : "Role-Play"} {roleplay.number}</span>
            <span className="rp-card__ia">{roleplay.instructionalArea}</span>
            <span className="rp-card__title">{roleplay.title}</span>
            <span className="rp-card__foot">
              {roleplay.completed
                ? <span className="pill pill--green"><CheckCircle2 size={13} /> Done · best {roleplay.bestScore}</span>
                : <span className="pill pill--blue">New</span>}
              {roleplay.completed ? <RotateCcw size={16} color="var(--muted)" /> : <PlayCircle size={18} color="var(--blue)" />}
            </span>
          </button>
        ))}
      </div>

      {!chapter && (
        <div className="card card--pad row row--between" style={{ marginTop: 24 }}>
          <span className="row"><Users size={20} color="var(--blue)" /><span><b>In a DECA chapter?</b> <span className="muted">Join with your advisor's code to get chapter credits.</span></span></span>
          <Link to="/chapter" className="btn btn--ghost btn--sm">Join a chapter</Link>
        </div>
      )}

      <section style={{ marginTop: 36 }}>
        <h2 className="subtitle" style={{ marginBottom: 12 }}>Your history</h2>
        {data.history.length ? (
          <div className="card table-wrap">
            <table className="history">
              <thead><tr><th style={{ paddingTop: 14 }}>Role-play</th><th style={{ paddingTop: 14 }}>Date</th><th style={{ paddingTop: 14 }}>Score</th></tr></thead>
              <tbody>
                {data.history.map((attempt) => (
                  <tr key={attempt.id} className="clickable" onClick={() => navigate(`/roleplay/${attempt.id}`)}>
                    <td><b>{attempt.roleplay?.eventCode} #{attempt.roleplay?.number}</b> <span className="muted">{attempt.roleplay?.instructionalArea}</span></td>
                    <td className="muted">{formatDate(attempt.createdAt)}</td>
                    <td>{attempt.status === "graded" ? <b>{attempt.score}/{attempt.max}</b> : <span className="pill pill--amber">{attempt.status === "grading" ? "Scoring" : "In progress"}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="card empty">No role-plays yet. Pick one above to start.</div>}
      </section>

      {starting && <StartModal roleplay={starting} event={event} credits={data.credits} onClose={() => setStarting(null)} />}
      {changing && <ChangeEventModal current={data.eventCode} onClose={() => setChanging(false)} onSaved={async () => { setChanging(false); await refresh(); load(); }} />}
    </div>
  );
}
