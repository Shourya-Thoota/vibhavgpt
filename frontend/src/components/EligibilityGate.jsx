// The eligibility screen (legal audit, 2026-11-16; the server enforces it in src/account/agreements.js). Every account answers a neutral
// age question (month and year of birth) and accepts the current Terms of Service and Privacy Policy once, before using VibhavGPT,
// whichever way it signed up. Under 16 the account is blocked; it can still sign out or ask for deletion. If the check itself can't be
// loaded, the workspace is shown: the server still refuses work until the record exists, so nothing is let through by a failed fetch.
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { MINIMUM_AGE } from "../legal-versions.js";
import "../eligibility.css";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default function EligibilityGate({ onLegal, onSignOut, children }) {
  const [status, setStatus] = useState(null);
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [accept, setAccept] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api("/api/me/agreements", { cache: "no-store" })
      .then(({ agreements }) => { if (!cancelled) setStatus(agreements ?? null); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, []);

  async function submit(event) {
    event.preventDefault();
    setError("");
    if (!status?.ageChecked && (!month || !year)) { setError("Choose the month and year you were born."); return; }
    if (!accept) { setError("Accept the Terms of Service and Privacy Policy to continue."); return; }
    setSaving(true);
    try {
      const { agreements } = await api("/api/me/agreements", { method: "POST", body: JSON.stringify({ birthMonth: Number(month), birthYear: Number(year), acceptTerms: true }) });
      setStatus(agreements);
    } catch (err) {
      if (err?.code === "age_blocked") setStatus((current) => ({ ...(current ?? {}), blocked: true, required: false }));
      else setError(err?.message || "That couldn't be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (status?.blocked) {
    return (
      <main className="eligibility" aria-labelledby="eligibility-title">
        <section className="eligibility__card">
          <h1 id="eligibility-title">VibhavGPT is for people {MINIMUM_AGE} and older</h1>
          <p>Based on the date of birth you gave, you can&apos;t use VibhavGPT. We keep only the result of this check, not your date of birth.</p>
          <p>You can sign out, or ask us to delete this account and everything in it.</p>
          <div className="eligibility__actions">
            <button type="button" className="btn btn--secondary" onClick={() => void onSignOut?.()}>Sign out</button>
            <a className="btn btn--ghost" href="/account-deletion">Delete this account</a>
          </div>
        </section>
      </main>
    );
  }

  if (!status?.required) return children;

  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 110 }, (_, i) => thisYear - i);
  return (
    <>
      {children}
      <div className="eligibility eligibility--over" role="dialog" aria-modal="true" aria-labelledby="eligibility-title">
        <form className="eligibility__card" onSubmit={submit} noValidate>
          <h1 id="eligibility-title">Before you continue</h1>
          {!status.ageChecked && (
            <fieldset className="eligibility__birth">
              <legend>When were you born?</legend>
              <p className="eligibility__hint">We use this once to check you&apos;re old enough, and keep only the result.</p>
              <div className="eligibility__row">
                <label>
                  <span>Month</span>
                  <select value={month} onChange={(event) => setMonth(event.target.value)} required>
                    <option value="">Month</option>
                    {MONTHS.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
                  </select>
                </label>
                <label>
                  <span>Year</span>
                  <select value={year} onChange={(event) => setYear(event.target.value)} required>
                    <option value="">Year</option>
                    {years.map((y) => <option key={y} value={y}>{y}</option>)}
                  </select>
                </label>
              </div>
            </fieldset>
          )}
          <label className="checkbox eligibility__accept">
            <input type="checkbox" checked={accept} onChange={(event) => setAccept(event.target.checked)} />
            <span>
              I agree to the{" "}
              <a href="/terms" onClick={(event) => { if (onLegal) { event.preventDefault(); onLegal("terms"); } }}>Terms of Service</a> and{" "}
              <a href="/privacy" onClick={(event) => { if (onLegal) { event.preventDefault(); onLegal("privacy"); } }}>Privacy Policy</a>.
            </span>
          </label>
          {error && <p className="note note--error" role="alert">{error}</p>}
          <div className="eligibility__actions">
            <button type="submit" className="btn btn--primary" disabled={saving}>{saving ? "Saving…" : "Continue"}</button>
            <button type="button" className="btn btn--ghost" onClick={() => void onSignOut?.()}>Sign out</button>
          </div>
        </form>
      </div>
    </>
  );
}
