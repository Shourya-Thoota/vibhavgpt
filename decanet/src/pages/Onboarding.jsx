import { useState } from "react";
import { api } from "../api.js";
import { EventPicker } from "../components/EventPicker.jsx";
import { Field, Notice } from "../components/ui.jsx";
import { navigate } from "../router.jsx";
import { useSession } from "../session.jsx";

export function pendingInvite() {
  try { return sessionStorage.getItem("decanet-invite"); } catch { return null; }
}

export function Onboarding() {
  const { account, refresh } = useSession();
  const [eventCode, setEventCode] = useState(account?.eventCode ?? "");
  const [mode, setMode] = useState("create");
  const [chapter, setChapter] = useState({ name: "", school: "", requireApproval: true, code: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function finishParticipant() {
    setBusy(true); setError("");
    try {
      await api("/account", { method: "PATCH", body: { eventCode, onboarded: true } });
      await refresh();
      const invite = pendingInvite();
      navigate(invite ? `/join/${invite}` : "/dashboard", { replace: true });
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }

  async function finishAdvisor(event) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      if (mode === "create") await api("/chapter", { method: "POST", body: chapter });
      else await api("/chapter/join", { method: "POST", body: { code: chapter.code } });
      await api("/account", { method: "PATCH", body: { onboarded: true } });
      await refresh();
      navigate("/chapter", { replace: true });
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }

  if (account.role === "advisor") {
    return (
      <div className="page page--narrow">
        <form className="card card--pad stack" onSubmit={finishAdvisor}>
          <span className="eyebrow">Welcome, {account.name.split(" ")[0]}</span>
          <h1 className="title">Set up your chapter</h1>
          <div className="segmented" role="group" aria-label="Chapter setup">
            <button type="button" aria-pressed={mode === "create"} onClick={() => setMode("create")}>Start a new chapter</button>
            <button type="button" aria-pressed={mode === "join"} onClick={() => setMode("join")}>Join as a co-advisor</button>
          </div>
          {mode === "create" ? (
            <>
              <Field label="Chapter name"><input className="input" required placeholder="Lincoln High DECA" value={chapter.name} onChange={(event) => setChapter({ ...chapter, name: event.target.value })} /></Field>
              <Field label="School (optional)"><input className="input" value={chapter.school} onChange={(event) => setChapter({ ...chapter, school: event.target.value })} /></Field>
              <label className="check"><input type="checkbox" checked={chapter.requireApproval} onChange={(event) => setChapter({ ...chapter, requireApproval: event.target.checked })} />
                <span>Approve join requests before members get in. Recommended, so only your students can join.</span></label>
            </>
          ) : (
            <Field label="Advisor code" hint="8 characters. An existing advisor finds it on their chapter page."><input className="input input--code" maxLength={8} required value={chapter.code} onChange={(event) => setChapter({ ...chapter, code: event.target.value })} /></Field>
          )}
          {error && <p className="error">{error}</p>}
          <div className="row row--between">
            <button type="button" className="btn btn--quiet" onClick={async () => { await api("/account", { method: "PATCH", body: { onboarded: true } }); await refresh(); navigate("/chapter"); }}>Skip for now</button>
            <button className="btn btn--primary" disabled={busy}>{mode === "create" ? "Create chapter" : "Request to join"}</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="stack" style={{ maxWidth: 920, margin: "0 auto" }}>
        <span className="eyebrow">Welcome, {account.name.split(" ")[0]}</span>
        <h1 className="title">Which event are you competing in?</h1>
        <p className="muted">You'll see the five role-plays for your event. You can change it anytime in Settings, unless your advisor locks it.</p>
        <EventPicker value={eventCode} onChange={setEventCode} />
        {error && <Notice tone="red">{error}</Notice>}
        <div className="row" style={{ position: "sticky", bottom: 16, justifyContent: "flex-end" }}>
          <button className="btn btn--primary btn--lg" disabled={!eventCode || busy} onClick={finishParticipant}>{eventCode ? `Continue with ${eventCode}` : "Choose an event"}</button>
        </div>
      </div>
    </div>
  );
}
