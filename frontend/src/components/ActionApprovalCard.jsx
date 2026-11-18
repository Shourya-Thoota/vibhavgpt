import { useEffect, useState } from "react";
import { Check, X, Lock, AlertCircle } from "lucide-react";
import { api } from "../api.js";
import { failureText, failureTitle, operationKind, serviceName, unknownOutcomeText } from "./action-failure-copy.js";
import { FOUND_LABEL, NOT_FOUND_LABEL, NOT_UPLOADED_CONFIRM, UNKNOWN_TITLE, canReconcile, settledText, unknownBody } from "./upload-recovery-copy.js";

function providerFileLink(result) {
  const raw = result?.webViewLink || result?.url || result?.documentUrl;
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && (url.hostname === "drive.google.com" || url.hostname === "docs.google.com")) return url.href;
  } catch { /* ignore untrusted links */ }
  return null;
}

function providerResultText(result) {
  const link = providerFileLink(result);
  const id = result?.id || result?.documentId;
  if (link && id) return `Created ${id}. ${link}`;
  if (link) return link;
  if (id) return `Created ${id}.`;
  return result?.summary || "External mutation completed successfully.";
}

export function ActionApprovalCard({ pendingAction, onResolved }) {
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState(pendingAction);
  const [error, setError] = useState("");
  const [confirmingNotUploaded, setConfirmingNotUploaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!pendingAction?.id) return undefined;
    api(`/api/connectors/actions/${pendingAction.id}`)
      .then((res) => { if (!cancelled && res?.action) setAction(res.action); })
      .catch(() => { /* keep the snapshot already rendered */ });
    return () => { cancelled = true; };
  }, [pendingAction?.id]);

  if (!action) return null;
  const status = action.status || "pending";

  const applyServerAction = (next) => {
    if (!next) return;
    setAction(next);
    if (next.status === "completed" || next.status === "discarded" || next.status === "failed" || next.status === "uncertain" || next.status === "expired") {
      onResolved?.(next);
    }
  };

  const handleApprove = async () => {
    if (loading || status !== "pending") return;
    try {
      setLoading(true);
      setError("");
      const res = await api(`/api/connectors/actions/${action.id}/approve`, { method: "POST" });
      applyServerAction(res.action);
    } catch (err) {
      if (err.action) applyServerAction(err.action);
      else setError(err.message || "Failed to approve action.");
    } finally {
      setLoading(false);
    }
  };

  const handleDiscard = async () => {
    if (loading || status !== "pending") return;
    try {
      setLoading(true);
      setError("");
      const res = await api(`/api/connectors/actions/${action.id}/discard`, { method: "POST" });
      applyServerAction(res.action || { ...action, status: "discarded" });
    } catch (err) {
      if (err.action) applyServerAction(err.action);
      else setError(err.message || "Failed to discard action.");
    } finally {
      setLoading(false);
    }
  };

  const handleReconcile = async (outcome) => {
    if (loading || !canReconcile(action)) return;
    try {
      setLoading(true);
      setError("");
      const res = await api(`/api/connectors/actions/${action.id}/reconcile`, { method: "POST", body: JSON.stringify({ outcome }) });
      setConfirmingNotUploaded(false);
      applyServerAction(res.action);
    } catch (err) {
      setError(err.message || "Couldn't record that. Nothing was changed.");
    } finally {
      setLoading(false);
    }
  };

  const settled = settledText(action);
  if (status === "completed" && settled) {
    return (
      <div className="action-approval-card action-approval-card--approved" role="status">
        <div className="action-approval-card__status-row">
          <Check size={16} className="action-approval-card__icon--success" />
          <strong>{settled.title}</strong>
        </div>
        <p className="action-approval-card__result-text">{settled.body}</p>
      </div>
    );
  }

  if (status === "completed" && (operationKind(action) === "email_send" || operationKind(action) === "email_draft")) {
    const sent = operationKind(action) === "email_send";
    return (
      <div className="action-approval-card action-approval-card--approved" role="status">
        <div className="action-approval-card__status-row">
          <Check size={16} className="action-approval-card__icon--success" />
          <strong>{sent ? "Email sent" : "Draft saved"}</strong>
        </div>
        <p className="action-approval-card__result-text">
          {sent ? `Gmail confirmed the message to ${action.payload?.to || "the recipient"}.` : `Saved in your Gmail drafts for ${action.payload?.to || "the recipient"}. It was not sent.`}
          {action.deduped || action.result?.deduped ? " This exact email was already handled a moment ago, so it was not done again." : ""}
        </p>
      </div>
    );
  }

  if (status === "completed") {
    return (
      <div className="action-approval-card action-approval-card--approved" role="status">
        <div className="action-approval-card__status-row">
          <Check size={16} className="action-approval-card__icon--success" />
          <strong>Action Approved and Executed</strong>
        </div>
        <p className="action-approval-card__result-text">
          {providerResultText(action.result)}
          {providerFileLink(action.result) && (
            <>
              {" "}
              <a className="link" href={providerFileLink(action.result)} target="_blank" rel="noopener noreferrer">Open in Google Drive</a>
            </>
          )}
        </p>
      </div>
    );
  }

  if (status === "discarded") {
    return (
      <div className="action-approval-card action-approval-card--discarded" role="status">
        <div className="action-approval-card__status-row">
          <X size={16} className="action-approval-card__icon--declined" />
          <span>Action discarded. No external changes were made.</span>
        </div>
      </div>
    );
  }

  if (status === "failed" && settled) {
    return (
      <div className="action-approval-card action-approval-card--failed" role="status">
        <div className="action-approval-card__status-row">
          <AlertCircle size={16} />
          <strong>{settled.title}</strong>
        </div>
        <p className="action-approval-card__result-text">{settled.body}</p>
      </div>
    );
  }

  if (status === "failed" || status === "expired") {
    return (
      <div className="action-approval-card action-approval-card--failed" role="alert">
        <div className="action-approval-card__status-row">
          <AlertCircle size={16} />
          <strong>{failureTitle(action)}</strong>
        </div>
        <p className="action-approval-card__result-text">{failureText(action)}</p>
      </div>
    );
  }

  if (status === "uncertain") {
    const recoverable = canReconcile(action);
    const unknown = unknownBody(action);
    return (
      <div className="action-approval-card action-approval-card--uncertain" role="alert">
        <div className="action-approval-card__status-row">
          <AlertCircle size={16} />
          <strong>{recoverable ? UNKNOWN_TITLE : unknownOutcomeText(action).title}</strong>
        </div>
        {recoverable ? (
          <>
            <p className="action-approval-card__result-text">{unknown.summary}</p>
            <p className="action-approval-card__result-text"><strong>{unknown.warning}</strong></p>
            <ol className="action-approval-card__steps">
              {unknown.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
            {error && (
              <div className="action-approval-card__error" role="alert">
                <AlertCircle size={14} />
                <span>{error}</span>
              </div>
            )}
            {confirmingNotUploaded ? (
              <div className="action-approval-card__confirm" role="group" aria-label={NOT_UPLOADED_CONFIRM.title}>
                <p className="action-approval-card__result-text"><strong>{NOT_UPLOADED_CONFIRM.title}</strong> {NOT_UPLOADED_CONFIRM.body}</p>
                <div className="action-approval-card__actions">
                  <button type="button" className="btn btn--primary btn--sm" disabled={loading} onClick={() => handleReconcile("not_uploaded")}>{NOT_UPLOADED_CONFIRM.confirm}</button>
                  <button type="button" className="btn btn--quiet btn--sm" disabled={loading} onClick={() => setConfirmingNotUploaded(false)}>{NOT_UPLOADED_CONFIRM.cancel}</button>
                </div>
              </div>
            ) : (
              <div className="action-approval-card__actions">
                <button type="button" className="btn btn--primary btn--sm" disabled={loading} onClick={() => handleReconcile("uploaded")}>{FOUND_LABEL}</button>
                <button type="button" className="btn btn--quiet btn--sm" disabled={loading} onClick={() => setConfirmingNotUploaded(true)}>{NOT_FOUND_LABEL}</button>
              </div>
            )}
          </>
        ) : (
          <p className="action-approval-card__result-text">
            {unknownOutcomeText(action).body}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="action-approval-card" role="alertdialog" aria-labelledby={`action-title-${action.id}`}>
      <div className="action-approval-card__header">
        <div className="action-approval-card__badge">
          <Lock size={13} strokeWidth={2.2} />
          <span>Human Approval Required</span>
        </div>
        <span className="action-approval-card__tool-tag">{serviceName(action.toolName)}</span>
      </div>

      <h4 id={`action-title-${action.id}`} className="action-approval-card__title">
        {action.actionDescription}
      </h4>

      {action.payload && (
        <div className="action-approval-card__payload-box">
          {action.toolName === "google_drive_upload_file" ? (
            <dl className="action-approval-card__drive">
              <div><dt>File</dt><dd>{action.payload.fileName}</dd></div>
              <div><dt>Folder</dt><dd>{action.payload.folderName || "My Drive"}</dd></div>
              <div><dt>Content</dt><dd>{String(action.payload.content || "").slice(0, 500)}</dd></div>
            </dl>
          ) : operationKind(action) === "email_send" || operationKind(action) === "email_draft" ? (
            <dl className="action-approval-card__drive">
              <div><dt>From</dt><dd>{action.payload.senderLabel || "Your connected Gmail account"}</dd></div>
              <div><dt>To</dt><dd>{action.payload.to}</dd></div>
              <div><dt>Subject</dt><dd>{action.payload.subject}</dd></div>
              <div><dt>Message</dt><dd style={{ whiteSpace: "pre-wrap" }}>{action.payload.body}</dd></div>
            </dl>
          ) : (
            <pre className="action-approval-card__code">
              {JSON.stringify(action.payload, null, 2)}
            </pre>
          )}
        </div>
      )}

      {status === "in_progress" || loading ? (
        <p className="action-approval-card__result-text" role="status">Executing the approved upload…</p>
      ) : null}

      {error && (
        <div className="action-approval-card__error" role="alert">
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
      )}

      {status === "pending" && (
        <div className="action-approval-card__actions">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={loading}
            onClick={handleApprove}
          >
            <Check size={14} />
            <span>{operationKind(action) === "email_send" ? "Approve & Send" : operationKind(action) === "email_draft" ? "Approve & Save Draft" : "Approve & Execute"}</span>
          </button>
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            disabled={loading}
            onClick={handleDiscard}
          >
            <X size={14} />
            <span>Discard</span>
          </button>
        </div>
      )}
    </div>
  );
}

export default ActionApprovalCard;
