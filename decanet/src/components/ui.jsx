import { useEffect } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

export function Modal({ title, children, onClose, actions, wide = false }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={wide ? { maxWidth: 760 } : undefined}>
        <h2 className="subtitle" style={{ marginBottom: 14 }}>{title}</h2>
        {children}
        {actions && <div className="modal__actions">{actions}</div>}
      </div>
    </div>
  );
}

const ICONS = { info: Info, amber: AlertTriangle, red: XCircle, green: CheckCircle2 };
export function Notice({ tone = "info", children }) {
  const Icon = ICONS[tone];
  return <div className={`notice${tone === "info" ? "" : ` notice--${tone}`}`}><Icon size={18} /><div>{children}</div></div>;
}

export function Spinner({ label }) {
  return <div className="center"><div className="spinner" />{label && <p className="muted">{label}</p>}</div>;
}

export function Field({ label, children, hint }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="tiny muted">{hint}</span>}
    </label>
  );
}

export function Bar({ value, max }) {
  return <div className="bar" aria-hidden="true"><span style={{ width: `${Math.round((value / Math.max(max, 1)) * 100)}%` }} /></div>;
}

export function ratingTone(rating) {
  return { "Exceeds Expectations": "green", "Meets Expectations": "blue", "Below Expectations": "amber", "Little/No Value": "red" }[rating] ?? "blue";
}
