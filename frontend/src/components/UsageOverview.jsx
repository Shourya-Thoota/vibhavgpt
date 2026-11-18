import "./usage-overview.css";
import { countText } from "../plan-entitlements.js";

// The Usage screen's three sections, in the order a new person asks: what do I have right now, when do I get more, what happens when it
// runs out. Words and numbers come from usage-overview-view.js; this only lays them out. Nothing here computes an amount.

function Meter({ remaining, limit, label }) {
  const percent = limit > 0 ? Math.round((remaining / limit) * 100) : 0;
  return (
    <div className="uo-meter" role="progressbar" aria-label={`${countText(remaining)} of ${countText(limit)} ${label}`} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={remaining}>
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

function Section({ id, title, children, state, mode }) {
  return (
    <section className="uo-section" aria-labelledby={`uo-${id}-title`} data-uo-section={id} data-uo-state={state} data-credits-mode={mode}>
      <h2 id={`uo-${id}-title`} className="uo-title">{title}</h2>
      {children}
    </section>
  );
}

function Headline({ label, value, note, available }) {
  return (
    <div className="uo-headline">
      <p className="uo-headline__label">{label}</p>
      <p className="uo-headline__value" data-uo-value data-credits-available={available ? "" : undefined}>{value}</p>
      {note && <p className="uo-note">{note}</p>}
    </div>
  );
}

export function ChatAndStudy({ section, legacy }) {
  if (section.kind !== "credits") {
    // Credits are not the active policy: the earlier token screen is shown, under the same heading.
    return <Section id="chat" title={section.title}>{legacy}</Section>;
  }
  return (
    <Section id="chat" title={section.title} state={section.state} mode={section.mode}>
      <Headline label={section.headline.label} value={section.headline.value} note={section.headline.note} available />
      <dl className="uo-rows">
        {section.rows.map((row) => (
          <div key={row.id} className="uo-row" data-uo-row={row.id}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="uo-text">{section.rule}</p>
      <p className="uo-text uo-text--runout" data-uo-runout>{section.runOut}</p>
      <details className="uo-details">
        <summary>View details</summary>
        <dl className="uo-rows">
          {section.details.rows.map((row) => (
            <div key={row.id} className="uo-row"><dt>{row.label}</dt><dd>{row.value}</dd></div>
          ))}
        </dl>
        <div className="uo-meter" role="progressbar" aria-label={`${section.details.meter.label}: ${section.details.meter.percent}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={section.details.meter.percent}>
          <span style={{ width: `${section.details.meter.percent}%` }} />
        </div>
        <p className="uo-caption">{section.details.meter.percent}% of this month's AI credits used</p>
        <h3 className="uo-subtitle">Allocation schedule</h3>
        <ol className="uo-schedule">
          {section.details.schedule.map((week) => (
            <li key={week.id} data-status={week.status}>
              <span>{week.label}</span>
              <span>{week.from}</span>
              <strong>{week.credits}</strong>
              {week.status === "current" && <em>This week</em>}
            </li>
          ))}
        </ol>
        <p className="uo-caption">{section.details.policyNote}</p>
      </details>
    </Section>
  );
}

function AllowanceSection({ id, section, onSeePlans }) {
  if (!section.available) {
    // Unknown is not zero.
    return <Section id={id} title={section.title} state="unavailable"><p className="uo-text" role="status">{section.message}</p></Section>;
  }
  if (!section.included) {
    return (
      <Section id={id} title={section.title} state="not-included">
        <p className="uo-text">{section.message}</p>
        <p className="uo-text uo-text--runout">{section.runOut}</p>
        {onSeePlans && <button type="button" className="btn btn--secondary uo-action" onClick={onSeePlans}>See plans</button>}
      </Section>
    );
  }
  return (
    <Section id={id} title={section.title} state="ok">
      <Headline label={section.headline.label} value={section.headline.value} />
      {section.meter && <Meter {...section.meter} />}
      {section.renews && <p className="uo-text" data-uo-renews>{section.renews}</p>}
      <p className="uo-text uo-text--runout" data-uo-runout>{section.runOut}</p>
    </Section>
  );
}

export const Images = (props) => <AllowanceSection id="images" {...props} />;
export const Documents = (props) => <AllowanceSection id="documents" {...props} />;
