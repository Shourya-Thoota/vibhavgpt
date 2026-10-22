import { useEffect, useRef, useState } from "react";
import { api, VIBHAVGPT_URL } from "../api.js";

function VibhavMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="#5fd0e1" />
      <path d="M7 7l5 11 5-11" fill="none" stroke="#04101f" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Signs in (or connects) with the visitor's VibhavGPT account. If they aren't
// signed in to VibhavGPT yet, VibhavGPT opens in a new window; once they sign
// in there, this finishes on its own.
export function VibhavButton({ label = "Continue with VibhavGPT", role, onDone, onError, className = "btn btn--vibhav btn--block" }) {
  const [waiting, setWaiting] = useState(false);
  const poll = useRef(null);
  useEffect(() => () => clearInterval(poll.current), []);

  async function complete() {
    clearInterval(poll.current);
    setWaiting(false);
    try {
      onDone?.(await api("/auth/vibhavgpt", { method: "POST", body: { role } }));
    } catch (error) {
      onError?.(error.message);
    }
  }

  async function start() {
    onError?.("");
    const status = await api("/auth/vibhavgpt").catch(() => ({ signedIn: false }));
    if (status.signedIn) return complete();
    const popup = window.open(`${VIBHAVGPT_URL}/app`, "vibhavgpt-signin", "width=480,height=720");
    if (!popup) return onError?.(`Allow pop-ups, or sign in at ${VIBHAVGPT_URL.replace(/^https?:\/\//, "")} in another tab and try again.`);
    setWaiting(true);
    const started = Date.now();
    poll.current = setInterval(async () => {
      if (Date.now() - started > 5 * 60 * 1000) { clearInterval(poll.current); setWaiting(false); return; }
      const next = await api("/auth/vibhavgpt").catch(() => ({ signedIn: false }));
      if (next.signedIn) {
        try { popup.close(); } catch {}
        complete();
      }
    }, 2000);
  }

  return (
    <button type="button" className={className} onClick={start} disabled={waiting}>
      <VibhavMark /> {waiting ? "Waiting for VibhavGPT sign-in…" : label}
    </button>
  );
}
