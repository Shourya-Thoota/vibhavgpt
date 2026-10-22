import { Check, Clock, FileText, Mic, Users } from "lucide-react";
import { formatMoney } from "../api.js";
import { Link } from "../router.jsx";
import { useSession } from "../session.jsx";

export function Landing() {
  const { catalog } = useSession();
  const tiers = catalog?.pricing.chapterTiers ?? [];
  const tierRows = [...tiers].reverse().map((tier, index, list) => {
    const next = list[index + 1];
    return { range: next ? `${tier.min}–${next.min - 1}` : `${tier.min}+`, cents: tier.centsPerCredit };
  });
  return (
    <div className="page">
      <section className="hero">
        <div>
          <span className="eyebrow">DECA role-play practice · by VibhavGPT</span>
          <h1>Walk into states <em>already</em> knowing the room.</h1>
          <p className="lead">Prep with an official-style packet, present to a live AI judge who talks back and asks the hard questions, then get scored on the real rubric with feedback on every performance indicator.</p>
          <div className="hero__actions">
            <Link to="/signup" className="btn btn--primary btn--lg">Start practicing</Link>
            <a href="#pricing" className="btn btn--ghost btn--lg">See pricing</a>
          </div>
          <p className="small muted" style={{ marginTop: 14 }}>All {catalog?.events.length ?? 28} DECA role-play and case study events · 5 role-plays each</p>
        </div>
        <div className="hero__visual" aria-hidden="true">
          <div className="hero__card--back" />
          <div className="card hero__card stack">
            <div className="row row--between"><span className="pill pill--blue">Role-Play #2 · Selling</span><span className="clock">7:42</span></div>
            <div className="row"><div className="judge-orb judge-orb--speaking" style={{ width: 64, height: 64 }}><Mic size={24} /></div>
              <div><b>Your judge</b><div className="muted small">Store owner · speaking</div></div></div>
            <div className="wave">{Array.from({ length: 22 }, (_, index) => <span key={index} style={{ animationDelay: `${(index % 7) * 0.12}s` }} />)}</div>
            <p className="small" style={{ fontStyle: "italic" }}>"And how would you follow up after the sale?"</p>
            <hr className="divider" />
            <div className="row row--between small"><span className="muted">Performance indicators</span><b>64 / 70</b></div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <span className="eyebrow">How it works</span>
          <h2>As close to the real thing as practice gets.</h2>
        </div>
        <div className="grid steps">
          {[
            [FileText, "Prep with the packet", "Read the situation, performance indicators and 21st Century Skills, and take notes, on the clock. 10 minutes, like competition."],
            [Mic, "Present to the judge", "Talk to a live judge with a name, a voice and a personality. They listen, react and answer your questions."],
            [Clock, "Field the questions", "Save time at the end: the judge asks two questions, just like at a real conference."],
            [Check, "Get your score", "A full rubric breakdown, filler words counted, and specific ways to raise every indicator."],
          ].map(([Icon, title, text], index) => (
            <div className="card card--pad" key={title}>
              <div className="step__num">{index + 1}</div>
              <h3 style={{ fontSize: 18, marginBottom: 6 }} className="row"><Icon size={18} color="var(--blue)" /> {title}</h3>
              <p className="muted small">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section" id="pricing">
        <div className="section__head">
          <span className="eyebrow">Pricing</span>
          <h2>Pay per role-play. No subscription.</h2>
          <p className="muted" style={{ marginTop: 8 }}>One credit is one role-play, scored and saved. VibhavGPT Plus members get 1 free credit every two months, and Pro members get 2.</p>
        </div>
        <div className="grid prices">
          <div className="card card--pad price">
            <span className="label">Single</span>
            <div className="price__amount">$2.50</div>
            <p className="muted small">One role-play, any event.</p>
            <Link to="/signup" className="btn btn--ghost" style={{ marginTop: "auto" }}>Get started</Link>
          </div>
          <div className="card card--pad price price--featured">
            <span className="row"><span className="label">Five-pack</span><span className="pill pill--blue">Save 20%</span></span>
            <div className="price__amount">$10</div>
            <p className="muted small">Five role-plays: one for every instructional area in your event.</p>
            <Link to="/signup" className="btn btn--primary" style={{ marginTop: "auto" }}>Get the five-pack</Link>
          </div>
          <div className="card card--pad price">
            <span className="row"><span className="label">Chapters</span><Users size={16} color="var(--blue)" /></span>
            <table className="tier-table"><tbody>
              {tierRows.map((row) => <tr key={row.range}><td>{row.range} credits</td><td>{formatMoney(row.cents)} each</td></tr>)}
            </tbody></table>
            <p className="muted small">Advisors buy in bulk, hand out credits and see every member's scores.</p>
            <Link to="/signup?role=advisor" className="btn btn--ghost" style={{ marginTop: "auto" }}>Start a chapter</Link>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <span className="eyebrow">Every event</span>
          <h2>Principles, Series, PFL and Team Decision Making.</h2>
        </div>
        <div className="event-cloud">
          {(catalog?.events ?? []).map((event) => <span className="pill" key={event.code} title={event.name}>{event.code}</span>)}
        </div>
      </section>
    </div>
  );
}
