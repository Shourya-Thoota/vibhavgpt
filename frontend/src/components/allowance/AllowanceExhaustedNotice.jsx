import { CircleAlert, CircleSlash, Clock } from "lucide-react";
import { allowanceViewModel } from "./allowance-view.js";

/**
 * Reusable notice for when paid allowance cannot fund paid models.
 *
 * Shows the reason, reset timing, and the server-approved free choices. A
 * free choice is only ever taken through an explicit click on its button, and
 * only when the parent passes onChooseFreeModel; the notice never switches
 * models or sends messages by itself. Without a handler, choices render as a
 * read-only list.
 */
export function AllowanceExhaustedNotice({ summary, view: providedView = null, onChooseFreeModel = null, compact = false, children = null }) {
  const view = providedView ?? allowanceViewModel(summary);
  if (!view || view.kind !== "subscription" || !view.restriction) return null;

  const available = view.freeChoices.filter((choice) => choice.available);
  const unavailable = view.freeChoices.filter((choice) => !choice.available);
  const titleId = "allowance-exhausted-title";

  return (
    <section className={`allowance-exhausted${compact ? " allowance-exhausted--compact" : ""}`} aria-labelledby={titleId} data-reason={view.restriction}>
      <div className="allowance-exhausted__head">
        <CircleAlert size={18} aria-hidden="true" />
        <h3 id={titleId}>{view.restrictionTitle}</h3>
      </div>
      <p>{view.restrictionBody}</p>
      <p className="allowance-exhausted__reset">
        <Clock size={14} aria-hidden="true" />
        <span>{view.resetDate ? <>Your allowance resets on <strong>{view.resetDate}</strong>.</> : "Your allowance resets at the start of your next monthly period."}</span>
      </p>

      {available.length > 0 ? (
        <div className="allowance-exhausted__choices">
          <h4>Included models you can still use</h4>
          <ul>
            {available.map((choice) => (
              <li key={choice.id} className="allowance-choice" data-available="true">
                <div>
                  <strong>{choice.displayName}</strong>
                  {choice.description && <span>{choice.description}</span>}
                </div>
                {onChooseFreeModel ? (
                  <button type="button" className="btn btn--secondary allowance-choice__use" onClick={() => onChooseFreeModel(choice)}>
                    Use {choice.displayName}
                  </button>
                ) : (
                  <span className="allowance-choice__status">Included</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="allowance-exhausted__none" role="status">
          <CircleSlash size={14} aria-hidden="true" />
          <span>No included models are available right now. {view.resetDate ? `Your allowance resets on ${view.resetDate}.` : "Your allowance resets at the start of your next monthly period."}</span>
        </p>
      )}

      {children}
      {unavailable.length > 0 && (
        <ul className="allowance-exhausted__unavailable" aria-label="Included models that are unavailable">
          {unavailable.map((choice) => (
            <li key={choice.id} className="allowance-choice" data-available="false">
              <div>
                <strong>{choice.displayName}</strong>
                <span>{choice.unavailableReason ?? "This model is temporarily unavailable."}</span>
              </div>
              <span className="allowance-choice__status">Unavailable</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default AllowanceExhaustedNotice;
