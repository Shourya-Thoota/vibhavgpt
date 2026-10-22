import { Check, Copy, Lock, Minus, Plus, RefreshCw, Users, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, chapterUnitCents, formatDate, formatMoney } from "../api.js";
import { ResultReport } from "../components/ResultReport.jsx";
import { Field, Modal, Notice, Spinner } from "../components/ui.jsx";
import { Link, navigate } from "../router.jsx";
import { useSession } from "../session.jsx";
import { useCheckoutReturn } from "./Credits.jsx";

function CopyBox({ label, value, display }) {
  const { notify } = useSession();
  return (
    <div className="stack stack--sm">
      <span className="label">{label}</span>
      <div className="code-box">
        <code style={display ? { fontSize: 14, letterSpacing: 0, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : undefined}>{display ?? value}</code>
        <button className="icon-btn" aria-label={`Copy ${label}`} onClick={() => navigator.clipboard.writeText(value).then(() => notify("Copied"))}><Copy size={16} /></button>
      </div>
    </div>
  );
}

// ---- Participants -------------------------------------------------------------

export function JoinForm({ token, preview, onJoined }) {
  const [code, setCode] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const result = token
        ? await api(`/chapter/invite/${token}/join`, { method: "POST", body: { consent } })
        : await api("/chapter/join", { method: "POST", body: { code, consent } });
      onJoined?.(result);
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  return (
    <form className="stack" onSubmit={submit}>
      {!token && <Field label="Chapter code" hint="6 characters, from your advisor."><input className="input input--code" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value)} /></Field>}
      <label className="check">
        <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} required />
        <span>I agree to share my DECANet role-play results with {preview?.name ?? "this chapter"}'s advisors, including scores, feedback, transcripts and notes. Advisors can also assign my event.</span>
      </label>
      {error && <p className="error">{error}</p>}
      <button className="btn btn--primary" disabled={busy || !consent}>{busy ? "Joining…" : preview?.requireApproval === false ? "Join chapter" : "Request to join"}</button>
    </form>
  );
}

function ParticipantChapter() {
  const { chapter, refresh, notify, eventByCode } = useSession();
  async function leave() {
    if (!confirm("Leave this chapter? Your advisors will no longer see new results.")) return;
    await api("/chapter/leave", { method: "POST" }).catch((error) => notify(error.message));
    refresh();
  }
  if (!chapter) {
    return (
      <div className="page page--narrow">
        <div className="card card--pad stack">
          <span className="eyebrow">Chapters</span>
          <h1 className="title">Join your DECA chapter</h1>
          <p className="muted">Your advisor can give you credits, assign your event and follow your progress. You can also use DECANet on your own without a chapter.</p>
          <JoinForm onJoined={(result) => { notify(result.status === "active" ? `You joined ${result.chapterName}!` : `Request sent to ${result.chapterName}.`); refresh(); }} />
        </div>
      </div>
    );
  }
  const locked = chapter.lockedEvent ? eventByCode(chapter.lockedEvent) : null;
  return (
    <div className="page page--narrow">
      <div className="card card--pad stack">
        <span className="eyebrow">Your chapter</span>
        <h1 className="title">{chapter.name}</h1>
        {chapter.school && <p className="muted">{chapter.school}</p>}
        {chapter.status === "pending"
          ? <Notice tone="amber">Your request to join is waiting for an advisor to approve it.</Notice>
          : <Notice tone="green">You're a member. Your advisors can see your role-play scores and feedback.</Notice>}
        {locked && <Notice><Lock size={14} style={{ verticalAlign: -2 }} /> Your advisor locked your event to <b>{locked.name}</b>.</Notice>}
        <div className="row">
          <Link to="/dashboard" className="btn btn--primary">Go to my role-plays</Link>
          <button className="btn btn--ghost" onClick={leave}>{chapter.status === "pending" ? "Cancel request" : "Leave chapter"}</button>
        </div>
      </div>
    </div>
  );
}

// ---- Advisors -----------------------------------------------------------------

function BuyChapterCredits({ tiers }) {
  const [quantity, setQuantity] = useState(50);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const unit = chapterUnitCents(quantity, tiers);
  async function buy() {
    setBusy(true); setError("");
    try { location.href = (await api("/checkout", { method: "POST", body: { kind: "chapter", quantity } })).url; } catch (failure) { setError(failure.message); setBusy(false); }
  }
  return (
    <div className="stack">
      <Field label="Credits to buy"><input className="input" type="number" min={1} max={5000} value={quantity} onChange={(event) => setQuantity(Math.max(1, Math.min(5000, Number(event.target.value) || 1)))} /></Field>
      <div className="row row--between small"><span className="muted">{formatMoney(unit)} per credit</span><b style={{ fontSize: 18 }}>{formatMoney(unit * quantity)}</b></div>
      <div className="row" style={{ gap: 6 }}>{[25, 50, 100, 250].map((value) => <button key={value} className="btn btn--ghost btn--sm" onClick={() => setQuantity(value)}>{value}</button>)}</div>
      {error && <p className="error">{error}</p>}
      <button className="btn btn--primary" onClick={buy} disabled={busy}>{busy ? "Opening checkout…" : `Buy ${quantity} credits`}</button>
      <p className="tiny muted">1–49: $2.00 · 50–99: $1.80 · 100–249: $1.75 · 250+: $1.50 each</p>
    </div>
  );
}

function MemberDrawer({ memberId, onClose }) {
  const [data, setData] = useState(null);
  const [detail, setDetail] = useState(null);
  useEffect(() => { api(`/chapter/members/${memberId}/attempts`).then(setData).catch(() => setData({ attempts: [], member: {} })); }, [memberId]);
  if (detail) {
    return (
      <Modal title={`${detail.memberName}'s role-play`} onClose={() => setDetail(null)} wide actions={<button className="btn btn--ghost" onClick={() => setDetail(null)}>Back</button>}>
        <ResultReport attempt={detail} ownerLabel="member" />
        {detail.notes?.trim() && <details className="panel" style={{ marginTop: 16 }}><summary>Their prep notes</summary><div style={{ whiteSpace: "pre-wrap" }}>{detail.notes}</div></details>}
      </Modal>
    );
  }
  return (
    <Modal title={data?.member?.name ?? "Member"} onClose={onClose} wide actions={<button className="btn btn--ghost" onClick={onClose}>Close</button>}>
      {!data ? <div className="spinner" /> : data.attempts.length ? (
        <table className="history"><tbody>
          {data.attempts.map((attempt) => (
            <tr key={attempt.id} className={attempt.status === "graded" ? "clickable" : ""} onClick={() => attempt.status === "graded" && api(`/chapter/attempts/${attempt.id}`).then(setDetail)}>
              <td><b>{attempt.roleplay?.eventCode} #{attempt.roleplay?.number}</b> <span className="muted">{attempt.roleplay?.instructionalArea}</span></td>
              <td className="muted small">{formatDate(attempt.createdAt)}</td>
              <td>{attempt.status === "graded" ? <b>{attempt.score}/{attempt.max}</b> : <span className="pill pill--amber">In progress</span>}</td>
            </tr>
          ))}
        </tbody></table>
      ) : <p className="muted">No role-plays since joining the chapter.</p>}
    </Modal>
  );
}

function AdvisorChapter() {
  const { chapter, refresh, notify, catalog } = useSession();
  const [form, setForm] = useState({ name: "", school: "", requireApproval: true, code: "" });
  const [perMember, setPerMember] = useState(1);
  const [viewing, setViewing] = useState(null);
  const [error, setError] = useState("");
  useCheckoutReturn();
  const act = async (work, success) => {
    setError("");
    try { await work(); if (success) notify(success); await refresh(); } catch (failure) { setError(failure.message); notify(failure.message); }
  };

  if (!chapter) {
    return (
      <div className="page page--narrow">
        <div className="card card--pad stack">
          <span className="eyebrow">Advisor</span>
          <h1 className="title">Start your chapter</h1>
          <Field label="Chapter name"><input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Lincoln High DECA" /></Field>
          <Field label="School (optional)"><input className="input" value={form.school} onChange={(event) => setForm({ ...form, school: event.target.value })} /></Field>
          <label className="check"><input type="checkbox" checked={form.requireApproval} onChange={(event) => setForm({ ...form, requireApproval: event.target.checked })} /><span>Approve join requests</span></label>
          <button className="btn btn--primary" disabled={!form.name.trim()} onClick={() => act(() => api("/chapter", { method: "POST", body: form }), "Chapter created")}>Create chapter</button>
          <hr className="divider" />
          <Field label="Or join an existing chapter as a co-advisor" hint="Enter its 8-character advisor code."><input className="input input--code" maxLength={8} value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} /></Field>
          <button className="btn btn--ghost" disabled={form.code.length !== 8} onClick={() => act(() => api("/chapter/join", { method: "POST", body: { code: form.code } }), "Request sent")}>Request to join</button>
          {error && <p className="error">{error}</p>}
        </div>
      </div>
    );
  }
  if (chapter.status === "pending") {
    return <div className="page page--narrow"><div className="card card--pad stack"><h1 className="title">{chapter.name}</h1><Notice tone="amber">Waiting for an advisor of this chapter to approve you.</Notice><button className="btn btn--ghost" onClick={() => act(() => api("/chapter/leave", { method: "POST" }))}>Cancel request</button></div></div>;
  }

  const participants = chapter.members.filter((member) => member.role === "participant");
  const pending = chapter.members.filter((member) => member.status === "pending");
  const active = participants.filter((member) => member.status === "active");
  const inviteUrl = `${location.origin}/join/${chapter.inviteToken}`;
  return (
    <div className="page stack stack--lg">
      <div className="dash-head" style={{ marginBottom: 0 }}>
        <div className="stack stack--sm">
          <span className="eyebrow">Advisor · {chapter.school || "Your chapter"}</span>
          <h1 className="title">{chapter.name}</h1>
          <div className="row small muted"><span><Users size={14} style={{ verticalAlign: -2 }} /> {active.length} participant{active.length === 1 ? "" : "s"}</span><span>·</span><span>{chapter.members.filter((member) => member.role === "advisor" && member.status === "active").length} advisor(s)</span></div>
        </div>
        <div className="row">
          <div className="stat card card--pad" style={{ padding: "12px 18px" }}><strong style={{ color: "var(--blue)" }}>{chapter.credits}</strong><span className="muted small">credits in the pool</span></div>
        </div>
      </div>
      {error && <Notice tone="red">{error}</Notice>}

      {pending.length > 0 && (
        <section className="card card--pad stack">
          <h2 className="subtitle">Join requests</h2>
          {pending.map((member) => (
            <div className="row row--between" key={member.id}>
              <span><b>{member.name}</b> <span className="muted small">{member.email} · {member.role}</span></span>
              <span className="row">
                <button className="btn btn--primary btn--sm" onClick={() => act(() => api(`/chapter/members/${member.id}/approve`, { method: "POST" }), `${member.name} approved`)}><Check size={14} /> Approve</button>
                <button className="btn btn--ghost btn--sm" onClick={() => act(() => api(`/chapter/members/${member.id}`, { method: "DELETE" }), "Request declined")}><X size={14} /> Decline</button>
              </span>
            </div>
          ))}
        </section>
      )}

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <section className="card card--pad stack">
          <h2 className="subtitle">Invite members</h2>
          <CopyBox label="Invite link" value={inviteUrl} display={inviteUrl.replace(/^https?:\/\//, "")} />
          <CopyBox label="Participant code" value={chapter.joinCode} />
          <CopyBox label="Co-advisor code" value={chapter.advisorCode} />
          <label className="check"><input type="checkbox" checked={chapter.requireApproval} onChange={(event) => act(() => api("/chapter", { method: "PATCH", body: { requireApproval: event.target.checked } }))} /><span>Require approval to join</span></label>
          <button className="btn btn--quiet btn--sm" style={{ alignSelf: "flex-start" }} onClick={() => confirm("Make new codes and a new link? The old ones stop working.") && act(() => api("/chapter/rotate-codes", { method: "POST" }), "New codes created")}><RefreshCw size={14} /> Reset codes and link</button>
        </section>
        <section className="card card--pad stack">
          <h2 className="subtitle">Buy credits for the chapter</h2>
          <BuyChapterCredits tiers={catalog?.pricing.chapterTiers ?? [{ min: 1, centsPerCredit: 200 }]} />
        </section>
        <section className="card card--pad stack">
          <h2 className="subtitle">Hand out credits</h2>
          <p className="muted small">Give every active participant the same number from the pool, or adjust one person in the table below.</p>
          <Field label="Credits per participant"><input className="input" type="number" min={1} max={100} value={perMember} onChange={(event) => setPerMember(Math.max(1, Number(event.target.value) || 1))} /></Field>
          <p className="small muted">Uses {perMember * active.length} of {chapter.credits} credits.</p>
          <button className="btn btn--primary" disabled={!active.length || perMember * active.length > chapter.credits} onClick={() => act(() => api("/chapter/credits/distribute", { method: "POST", body: { perMember } }), "Credits distributed")}>Give {perMember} to everyone</button>
        </section>
      </div>

      <section>
        <h2 className="subtitle" style={{ marginBottom: 12 }}>Members</h2>
        <div className="card table-wrap">
          <table className="members">
            <thead><tr><th style={{ paddingTop: 14 }}>Name</th><th style={{ paddingTop: 14 }}>Event</th><th style={{ paddingTop: 14 }}>Credits</th><th style={{ paddingTop: 14 }}>Done</th><th style={{ paddingTop: 14 }}>Avg score</th><th style={{ paddingTop: 14 }}>Last active</th><th /></tr></thead>
            <tbody>
              {chapter.members.filter((member) => member.status === "active").map((member) => (
                <tr key={member.id}>
                  <td><b>{member.name}</b>{member.self && <span className="muted"> (you)</span>}<div className="tiny muted">{member.role === "advisor" ? "Advisor" : member.email}</div></td>
                  <td>{member.role === "participant" ? (
                    <select className="select" style={{ minWidth: 150, padding: "6px 8px" }} value={member.lockedEvent ?? ""} onChange={(event) => act(() => api(`/chapter/members/${member.id}`, { method: "PATCH", body: { lockedEvent: event.target.value || null } }), event.target.value ? `Locked to ${event.target.value}` : "Event unlocked")}>
                      <option value="">{member.eventCode ? `${member.eventCode} (their choice)` : "Not chosen"}</option>
                      {(catalog?.events ?? []).map((event) => <option key={event.code} value={event.code}>🔒 {event.code}</option>)}
                    </select>
                  ) : "-"}</td>
                  <td>{member.role === "participant" ? (
                    <span className="stepper">
                      <button aria-label="Take back a credit" disabled={member.credits < 1} onClick={() => act(() => api(`/chapter/members/${member.id}/credits`, { method: "POST", body: { delta: -1 } }))}><Minus size={14} /></button>
                      <b style={{ minWidth: 22, textAlign: "center" }}>{member.credits}</b>
                      <button aria-label="Give a credit" disabled={chapter.credits < 1} onClick={() => act(() => api(`/chapter/members/${member.id}/credits`, { method: "POST", body: { delta: 1 } }))}><Plus size={14} /></button>
                    </span>
                  ) : "-"}</td>
                  <td>{member.role === "participant" ? member.completed : "-"}</td>
                  <td>{member.average ?? "-"}</td>
                  <td className="muted small">{member.lastActivity ? formatDate(member.lastActivity) : "-"}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {member.role === "participant" && <button className="btn btn--ghost btn--sm" onClick={() => setViewing(member.id)}>Results</button>}
                    {!member.self && <button className="btn btn--quiet btn--sm" onClick={() => confirm(`Remove ${member.name} from the chapter?`) && act(() => api(`/chapter/members/${member.id}`, { method: "DELETE" }), "Removed")}>Remove</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!participants.length && <div className="empty">No participants yet. Share your invite link or participant code.</div>}
        </div>
      </section>

      <div className="row">
        <button className="btn btn--quiet btn--sm" onClick={() => confirm("Leave this chapter?") && act(() => api("/chapter/leave", { method: "POST" }), "You left the chapter")}>Leave chapter</button>
        <button className="btn btn--quiet btn--sm" style={{ color: "var(--red)" }} onClick={() => confirm("Delete this chapter for everyone? Members keep their own credits.") && act(() => api("/chapter", { method: "DELETE" }), "Chapter deleted")}>Delete chapter</button>
      </div>
      {viewing && <MemberDrawer memberId={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

export function Chapter() {
  const { account } = useSession();
  return account.role === "advisor" ? <AdvisorChapter /> : <ParticipantChapter />;
}

// /join/:token — the invite link.
export function Invite({ token }) {
  const { account, loading, refresh, notify } = useSession();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    try { sessionStorage.setItem("decanet-invite", token); } catch {}
    api(`/chapter/invite/${token}`).then(setPreview).catch((failure) => setError(failure.message));
  }, [token]);
  if (error) return <div className="page page--narrow"><Notice tone="red">{error}</Notice></div>;
  if (!preview || loading) return <Spinner />;
  const finished = (result) => {
    try { sessionStorage.removeItem("decanet-invite"); } catch {}
    notify(result.status === "active" ? `Welcome to ${result.chapterName}!` : `Request sent to ${result.chapterName}.`);
    refresh().then(() => navigate(account?.onboarded ? "/chapter" : "/welcome"));
  };
  return (
    <div className="page page--auth" style={{ maxWidth: 520 }}>
      <div className="card card--pad stack">
        <span className="eyebrow">Chapter invite</span>
        <h1 className="title">Join {preview.name}</h1>
        {preview.school && <p className="muted">{preview.school}</p>}
        {!account ? (
          <>
            <p className="muted">Create a free DECANet account or sign in to join this chapter.</p>
            <Link to={`/signup?next=/join/${token}`} className="btn btn--primary">Create an account</Link>
            <Link to={`/login?next=/join/${token}`} className="btn btn--ghost">I have an account</Link>
          </>
        ) : account.role === "advisor" ? (
          <Notice tone="amber">This invite is for participants. Co-advisors join with the chapter's advisor code on the chapter page.</Notice>
        ) : (
          <JoinForm token={token} preview={preview} onJoined={finished} />
        )}
      </div>
    </div>
  );
}
