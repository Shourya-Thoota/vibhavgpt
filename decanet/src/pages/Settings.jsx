import { useState } from "react";
import { api } from "../api.js";
import { EventPicker } from "../components/EventPicker.jsx";
import { Field, Modal, Notice } from "../components/ui.jsx";
import { VibhavButton } from "../components/VibhavButton.jsx";
import { navigate } from "../router.jsx";
import { useSession } from "../session.jsx";
import { applyTheme, readTheme } from "../theme.js";

export function Settings() {
  const { account, chapter, refresh, notify, eventByCode } = useSession();
  const [name, setName] = useState(account.name);
  const [password, setPassword] = useState({ current: "", password: "" });
  const [theme, setTheme] = useState(readTheme);
  const [pickingEvent, setPickingEvent] = useState(false);
  const [eventCode, setEventCode] = useState(account.eventCode ?? "");
  const [deleting, setDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState("");
  const run = async (work, success) => {
    setError("");
    try { await work(); if (success) notify(success); await refresh(); return true; } catch (failure) { setError(failure.message); return false; }
  };
  const event = eventByCode(account.eventCode);
  const locked = chapter?.lockedEvent;

  return (
    <div className="page page--narrow stack stack--lg">
      <div><span className="eyebrow">Settings</span><h1 className="title">Your account</h1></div>
      {error && <Notice tone="red">{error}</Notice>}

      <section className="card card--pad stack">
        <h2 className="subtitle">Profile</h2>
        <Field label="Name"><input className="input" value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <p className="small muted">Email: {account.email}</p>
        <div className="row">
          <button className="btn btn--primary btn--sm" disabled={name.trim() === account.name} onClick={() => run(() => api("/account", { method: "PATCH", body: { name } }), "Name saved")}>Save name</button>
        </div>
        <hr className="divider" />
        <div className="row row--between">
          <span><b>Account type:</b> {account.role === "advisor" ? "Advisor" : "Participant"}</span>
          <button className="btn btn--ghost btn--sm" disabled={Boolean(chapter)} title={chapter ? "Leave your chapter first" : undefined}
            onClick={() => run(() => api("/account", { method: "PATCH", body: { role: account.role === "advisor" ? "participant" : "advisor" } }), "Account type changed").then((ok) => ok && navigate(account.role === "advisor" ? "/dashboard" : "/chapter"))}>
            Switch to {account.role === "advisor" ? "participant" : "advisor"}
          </button>
        </div>
        {account.role === "participant" && (
          <div className="row row--between">
            <span><b>Event:</b> {event ? `${event.code} · ${event.name}` : "Not chosen"}</span>
            <button className="btn btn--ghost btn--sm" disabled={Boolean(locked)} onClick={() => setPickingEvent(true)}>{locked ? "Locked by advisor" : "Change"}</button>
          </div>
        )}
      </section>

      <section className="card card--pad stack">
        <h2 className="subtitle">Appearance</h2>
        <div className="segmented" role="group" aria-label="Theme">
          {["system", "light", "dark"].map((value) => (
            <button key={value} aria-pressed={theme === value} onClick={() => { applyTheme(value); setTheme(value); }}>{value[0].toUpperCase() + value.slice(1)}</button>
          ))}
        </div>
      </section>

      <section className="card card--pad stack">
        <h2 className="subtitle">VibhavGPT</h2>
        {account.vibhavgpt.connected ? (
          <>
            <Notice tone="green">Connected. You can sign in with VibhavGPT{account.vibhavgpt.tier ? `, and your ${account.vibhavgpt.tier === "pro" ? "Pro" : "Plus"} plan gives you free credits every two months` : ""}.</Notice>
            <button className="btn btn--ghost btn--sm" style={{ alignSelf: "flex-start" }} onClick={() => run(() => api("/auth/vibhavgpt", { method: "DELETE" }), "VibhavGPT disconnected")}>Disconnect</button>
          </>
        ) : (
          <>
            <p className="muted">Connect your VibhavGPT account to sign in with it and, with Plus or Pro, get free DECANet credits.</p>
            <div style={{ maxWidth: 320 }}><VibhavButton label="Connect VibhavGPT" onDone={() => { notify("VibhavGPT connected"); refresh(); }} onError={setError} /></div>
          </>
        )}
      </section>

      <section className="card card--pad stack">
        <h2 className="subtitle">{account.hasPassword ? "Change password" : "Add a password"}</h2>
        {!account.hasPassword && <p className="muted small">You sign in with VibhavGPT. Add a password to also sign in with your email.</p>}
        {account.hasPassword && <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={password.current} onChange={(event) => setPassword({ ...password, current: event.target.value })} /></Field>}
        <Field label="New password" hint="At least 8 characters."><input className="input" type="password" autoComplete="new-password" value={password.password} onChange={(event) => setPassword({ ...password, password: event.target.value })} /></Field>
        <button className="btn btn--primary btn--sm" style={{ alignSelf: "flex-start" }} disabled={password.password.length < 8}
          onClick={() => run(() => api("/account/password", { method: "POST", body: password }), "Password saved").then((ok) => ok && setPassword({ current: "", password: "" }))}>Save password</button>
      </section>

      <section className="card card--pad stack">
        <h2 className="subtitle">Session</h2>
        <div className="row">
          <button className="btn btn--ghost" onClick={async () => { await api("/auth/logout", { method: "POST" }).catch(() => {}); await refresh(); navigate("/"); }}>Sign out</button>
          <button className="btn btn--danger" onClick={() => setDeleting(true)}>Delete account</button>
        </div>
      </section>

      {pickingEvent && (
        <Modal title="Change your event" wide onClose={() => setPickingEvent(false)}
          actions={<><button className="btn btn--ghost" onClick={() => setPickingEvent(false)}>Cancel</button><button className="btn btn--primary" disabled={!eventCode || eventCode === account.eventCode} onClick={() => run(() => api("/account", { method: "PATCH", body: { eventCode } }), "Event changed").then(() => setPickingEvent(false))}>Save</button></>}>
          <EventPicker value={eventCode} onChange={setEventCode} />
        </Modal>
      )}
      {deleting && (
        <Modal title="Delete your DECANet account?" onClose={() => setDeleting(false)}
          actions={<><button className="btn btn--ghost" onClick={() => setDeleting(false)}>Cancel</button><button className="btn btn--danger" disabled={confirmText !== "DELETE"} onClick={() => run(() => api("/account", { method: "DELETE", body: { confirm: "DELETE" } }), "Account deleted").then((ok) => ok && navigate("/"))}>Delete forever</button></>}>
          <div className="stack">
            <p>This permanently deletes your role-plays, scores, notes and any unused credits. It doesn't affect your VibhavGPT account.</p>
            <Field label='Type "DELETE" to confirm'><input className="input" value={confirmText} onChange={(event) => setConfirmText(event.target.value)} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
