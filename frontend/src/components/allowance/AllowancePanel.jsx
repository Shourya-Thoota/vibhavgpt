import { Info, RotateCw } from "lucide-react";
import { ALLOWANCE_LOAD_STATES, allowanceLoadErrorMessage, allowanceViewModel } from "./allowance-view.js";
import { useAllowanceSummary } from "./useAllowanceSummary.js";
import { AllowanceExhaustedNotice } from "./AllowanceExhaustedNotice.jsx";

/**
 * Signed-in "AI allowance" card for the account usage page.
 * Read-only: loading it never reserves, settles, or sends anything, and it
 * never changes the chat model.
 */
export function AllowancePanel({ userId }) {
  const { status, summary, error, reload } = useAllowanceSummary({ userId, enabled: Boolean(userId) });

  // The server feature gate is off: show nothing rather than an error.
  if (!userId || status === ALLOWANCE_LOAD_STATES.DISABLED || status === ALLOWANCE_LOAD_STATES.IDLE) return null;

  const view = allowanceViewModel(summary);
  const loading = status === ALLOWANCE_LOAD_STATES.LOADING;

  return (
    <section className="allowance-panel" aria-labelledby="allowance-panel-title" aria-busy={loading && !view ? "true" : undefined}>
      <header className="allowance-panel__head">
        <div>
          <span className="usage-hero__eyebrow">{view ? `${view.planLabel} plan` : "Your plan"}</span>
          <h2 id="allowance-panel-title">AI allowance</h2>
        </div>
        {view?.kind === "subscription" && (
          <span className="allowance-panel__status" data-state={view.restriction ?? "available"}>{view.statusText}</span>
        )}
      </header>

      {!view && loading && <p className="allowance-panel__loading" role="status">Loading your AI allowance…</p>}

      {(status === ALLOWANCE_LOAD_STATES.ERROR || status === ALLOWANCE_LOAD_STATES.SESSION_EXPIRED) && (
        <div className="note note--error allowance-panel__error" role="alert">
          <span>{allowanceLoadErrorMessage(status, error)}</span>
          {status === ALLOWANCE_LOAD_STATES.ERROR && (
            <button type="button" className="btn btn--quiet" onClick={reload}><RotateCw size={14} aria-hidden="true" />Try again</button>
          )}
        </div>
      )}

      {view?.kind === "subscription" && (
        <>
          <p className="allowance-panel__headline">{view.headline}</p>
          <div className="allowance-meter" role="img" aria-label={view.meterLabel}>
            <span className="allowance-meter__confirmed" style={{ width: `${view.confirmedShare}%` }} />
            <span className="allowance-meter__pending" style={{ width: `${view.pendingShare}%` }} />
          </div>
          <dl className="allowance-panel__legend">
            <div><dt><span className="allowance-swatch allowance-swatch--confirmed" aria-hidden="true" />Spent</dt><dd>{view.confirmed}</dd></div>
            {view.hasPending && <div><dt><span className="allowance-swatch allowance-swatch--pending" aria-hidden="true" />Pending</dt><dd>{view.pending}</dd></div>}
            <div><dt><span className="allowance-swatch allowance-swatch--remaining" aria-hidden="true" />Remaining</dt><dd>{view.available}</dd></div>
          </dl>
          <p className="allowance-panel__reset">{view.resetLabel}</p>
          {view.pendingNote && <p className="allowance-panel__note">{view.pendingNote}</p>}
          {view.monthlyGrantNote && <p className="allowance-panel__note">{view.monthlyGrantNote}</p>}
          <AllowanceExhaustedNotice view={view} compact />
        </>
      )}

      {view?.kind === "no_allowance" && (
        <>
          <p className="allowance-panel__headline allowance-panel__headline--quiet">{view.headline}</p>
          <p className="allowance-panel__note">Paid plans include a monthly AI allowance for paid models. Included models stay available on every plan.</p>
          {view.freeChoices.length > 0 && (
            <ul className="allowance-panel__free" aria-label="Included models">
              {view.freeChoices.map((choice) => (
                <li key={choice.id} className="allowance-choice" data-available={choice.available ? "true" : "false"}>
                  <div>
                    <strong>{choice.displayName}</strong>
                    <span>{choice.available ? choice.description : choice.unavailableReason}</span>
                  </div>
                  <span className="allowance-choice__status">{choice.available ? "Included" : "Unavailable"}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {view?.previewNote && (
        <p className="allowance-panel__preview"><Info size={14} aria-hidden="true" /><span>{view.previewNote}</span></p>
      )}
    </section>
  );
}

export default AllowancePanel;
