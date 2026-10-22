import { GraduationCap, Presentation } from "lucide-react";
import { useState } from "react";
import { api } from "../api.js";
import { Brand } from "../components/Layout.jsx";
import { Field } from "../components/ui.jsx";
import { VibhavButton } from "../components/VibhavButton.jsx";
import { Link, navigate, useLocation } from "../router.jsx";
import { useSession } from "../session.jsx";

function afterSignIn(account, next) {
  if (next && next.startsWith("/") && !next.startsWith("//")) return navigate(next, { replace: true });
  if (!account.onboarded) return navigate("/welcome", { replace: true });
  navigate(account.role === "advisor" ? "/chapter" : "/dashboard", { replace: true });
}

function Divider() {
  return <div className="row" style={{ gap: 10 }}><hr className="divider" style={{ flex: 1 }} /><span className="tiny muted">or</span><hr className="divider" style={{ flex: 1 }} /></div>;
}

export function Login() {
  const { refresh } = useSession();
  const { query } = useLocation();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const next = query.get("next");
  async function done() {
    const me = await refresh();
    afterSignIn(me.account, next);
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError("");
    try { await api("/auth/login", { method: "POST", body: form }); await done(); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  return (
    <div className="page page--auth">
      <div className="card card--pad stack">
        <div className="stack stack--sm" style={{ alignItems: "center", textAlign: "center" }}>
          <Brand />
          <h1 className="subtitle" style={{ marginTop: 8 }}>Welcome back</h1>
        </div>
        <VibhavButton onDone={done} onError={setError} />
        <Divider />
        <form className="stack" onSubmit={submit}>
          <Field label="Email"><input className="input" type="email" autoComplete="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
          <Field label="Password"><input className="input" type="password" autoComplete="current-password" required value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
          {error && <p className="error">{error}</p>}
          <button className="btn btn--primary btn--block" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>
        <div className="row row--between small">
          <Link to="/reset">Forgot password?</Link>
          <span className="muted">New here? <Link to={`/signup${next ? `?next=${encodeURIComponent(next)}` : ""}`}>Create an account</Link></span>
        </div>
      </div>
    </div>
  );
}

export function Signup() {
  const { refresh } = useSession();
  const { query } = useLocation();
  const [role, setRole] = useState(query.get("role") === "advisor" ? "advisor" : "participant");
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const next = query.get("next");
  async function done() {
    const me = await refresh();
    afterSignIn(me.account, next);
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError("");
    try { await api("/auth/signup", { method: "POST", body: { ...form, role } }); await done(); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  return (
    <div className="page page--auth" style={{ maxWidth: 480 }}>
      <div className="card card--pad stack">
        <div className="stack stack--sm" style={{ alignItems: "center", textAlign: "center" }}>
          <Brand />
          <h1 className="subtitle" style={{ marginTop: 8 }}>Create your DECANet account</h1>
        </div>
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {[["participant", GraduationCap, "Participant", "I compete and practice role-plays."], ["advisor", Presentation, "Advisor", "I run a chapter and manage members."]].map(([value, Icon, title, text]) => (
            <button type="button" key={value} className="event-option" aria-pressed={role === value} onClick={() => setRole(value)} style={{ flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
              <Icon size={20} color="var(--blue)" /><b>{title}</b><span className="tiny muted">{text}</span>
            </button>
          ))}
        </div>
        <VibhavButton label="Sign up with VibhavGPT" role={role} onDone={done} onError={setError} />
        <Divider />
        <form className="stack" onSubmit={submit}>
          <Field label="Your name"><input className="input" autoComplete="name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
          <Field label="Email"><input className="input" type="email" autoComplete="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
          <Field label="Password" hint="At least 8 characters."><input className="input" type="password" autoComplete="new-password" minLength={8} required value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
          {error && <p className="error">{error}</p>}
          <button className="btn btn--primary btn--block" disabled={busy}>{busy ? "Creating account…" : `Create ${role} account`}</button>
        </form>
        <p className="tiny muted" style={{ textAlign: "center" }}>
          By continuing you agree to the <a href="https://vibhavgpt.com/terms">Terms</a> and <a href="https://vibhavgpt.com/privacy">Privacy Policy</a>. Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}

export function ResetPassword() {
  const { refresh } = useSession();
  const [step, setStep] = useState("email");
  const [form, setForm] = useState({ email: "", code: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      if (step === "email") {
        await api("/auth/password/forgot", { method: "POST", body: { email: form.email } });
        setStep("code");
      } else {
        await api("/auth/password/reset", { method: "POST", body: form });
        const me = await refresh();
        afterSignIn(me.account);
      }
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  return (
    <div className="page page--auth">
      <form className="card card--pad stack" onSubmit={submit}>
        <h1 className="subtitle">Reset your password</h1>
        {step === "email" ? (
          <>
            <p className="muted small">We'll email you a 6-digit code. Accounts created with VibhavGPT sign in with VibhavGPT instead.</p>
            <Field label="Email"><input className="input" type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
          </>
        ) : (
          <>
            <p className="muted small">If {form.email} has a DECANet password, a code is on its way.</p>
            <Field label="6-digit code"><input className="input input--code" inputMode="numeric" maxLength={6} required value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value.replace(/\D/g, "") })} /></Field>
            <Field label="New password" hint="At least 8 characters."><input className="input" type="password" minLength={8} required autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <button className="btn btn--primary btn--block" disabled={busy}>{step === "email" ? "Send code" : "Set new password"}</button>
        <Link to="/login" className="small">Back to sign in</Link>
      </form>
    </div>
  );
}
