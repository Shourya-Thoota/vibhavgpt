import { creditsView } from "../credits-view.js";
import "./credits-panel.css";

// The signed-in AI credits display. It shows only what the server reported for
// the account, worded by the shared credits view; it computes nothing itself.
export function CreditsPanel({ credits }) {
  const view = creditsView(credits);
  if (!view) return null;
  const exhausted = view.state !== "ok";
  return (
    <section className="credits-panel" aria-labelledby="credits-panel-title" data-credits-state={view.state} data-credits-mode={view.carryMode} data-credits-policy={view.policyVersion}>
      <header className="credits-panel__head">
        <h2 id="credits-panel-title" className="credits-panel__title">{view.title}</h2>
        <p className="credits-panel__timing" data-credits-timing>{view.timing.text}</p>
      </header>

      <div className={`credits-panel__headline${exhausted ? " is-exhausted" : ""}`}>
        <p className="credits-panel__label">{view.headline.label}</p>
        <p className="credits-panel__value" data-credits-available>{view.headline.value}</p>
        {view.headline.note && <p className="credits-panel__note">{view.headline.note}</p>}
      </div>

      <dl className="credits-panel__rows">
        {view.rows.map((row) => (
          <div key={row.id} className="credits-panel__row" data-credits-row={row.id}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>

      <div className="credits-panel__meter" role="progressbar" aria-label={`${view.meter.label}: ${view.meter.percent}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.meter.percent}>
        <span style={{ width: `${view.meter.percent}%` }} />
      </div>
      <p className="credits-panel__meter-caption">{view.meter.percent}% of this month's AI credits used</p>

      <details className="credits-panel__schedule">
        <summary>Allocation schedule</summary>
        <ol>
          {view.schedule.map((week) => (
            <li key={week.id} data-status={week.status}>
              <span>{week.label}</span>
              <span>{week.from}</span>
              <strong>{week.credits}</strong>
              {week.status === "current" && <em>This week</em>}
            </li>
          ))}
        </ol>
      </details>

      <p className="credits-panel__policy">{view.policyNote}{view.timing.note ? ` ${view.timing.note}` : ""}</p>
    </section>
  );
}
