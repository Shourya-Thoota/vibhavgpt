import { PRODUCT_KNOWLEDGE, productKnowledgeFor } from "./product-knowledge.js";
import { useCreditsMode } from "./credits-runtime.js";
import "./legal.css";
import "./public-pages.css";
import { PublicFaq } from "./components/PublicPageDetails.jsx";
import { resetPageScroll } from "./page-scroll.js";
import { useLayoutEffect } from "react";
import { PublicNav } from "./components/PublicNav.jsx";
import SiteFooter from "./components/SiteFooter.jsx";
import { LEGAL_UPDATED } from "./legal-versions.js";
import { SUBPROCESSORS_SECTION } from "./subprocessors.js";

// Voice features were removed in October 2026. Recordings and calls made
// before then were processed by AI inference providers, so the policy keeps
// saying so, in the past tense. This lives only on the policy page (its own
// chunk), not in the app bundle or the assistant's product facts.
const PRIVACY_HISTORY = {
  "AI, hosting, and service providers": "Before voice features were removed in October 2026, voice dictation audio and Live Comet voice calls were also processed by AI inference providers. Transcripts of those calls were saved to your chat history like any other conversation.",
};

const UPDATED = LEGAL_UPDATED;

const DOCUMENTS = {
  terms: {
    title: "Terms of Service",
    lede: "The agreement between you and Pansophy LLC for using VibhavGPT.",
    sections: (creditsMode) => productKnowledgeFor(creditsMode).terms,
  },
  privacy: {
    title: "Privacy Policy",
    lede: "What we collect, why we collect it, who processes it, and the choices you have.",
    // The sub-processor list follows the section on service providers (subprocessors.js: named here only, never to the assistant).
    sections: () => PRODUCT_KNOWLEDGE.privacy.flatMap(([title, body]) => {
      const section = [title, PRIVACY_HISTORY[title] ? `${body} ${PRIVACY_HISTORY[title]}` : body];
      return title === "AI, hosting, and service providers" ? [section, [...SUBPROCESSORS_SECTION]] : [section];
    }),
  },
};

const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function Bar({ onBack, backLabel }) {
  return (
    <header className="legal-bar">
      <a className="brand legal-bar__brand" href="/home" aria-label="VibhavGPT home">
        <img src="/brand/vibhavgpt-icon-64.png" alt="" />
        <span>VibhavGPT</span>
      </a>
      <a className="btn btn--quiet" href="/app" onClick={(event) => { if (onBack) { event.preventDefault(); onBack(); } }}>{backLabel}</a>
    </header>
  );
}

function OtherDocuments({ current }) {
  const links = [
    { page: "guarantee", href: "/guarantee", label: "The VibhavGPT Guarantee" },
    { page: "terms", href: "/terms", label: "Terms of Service" },
    { page: "privacy", href: "/privacy", label: "Privacy Policy" },
  ].filter((link) => link.page !== current);
  return (
    <nav className="legal-related" aria-label="Related documents">
      {links.map((link) => <a key={link.page} href={link.href}>{link.label}</a>)}
      <a href="mailto:support@pansophy.com">support@pansophy.com</a>
    </nav>
  );
}

/* -- The Guarantee --------------------------------------------------------- */

// Four promises, each set as a statement rather than a feature card, under
// one eclipse: the page's single illustration, drawn in CSS.
function Guarantee({ onBack, backLabel }) {
  return (
    <main className="legal guarantee">
      <PublicNav current="guarantee" />
      <article className="guarantee__sheet">
        <header className="page-header guarantee__header">
          <h1 className="page-header__title">The VibhavGPT Guarantee</h1>
          <p className="page-header__lede">Pansophy LLC promises no training on your chats, no data sales, no ads, and control to export or delete your data. These four promises are written into our Terms of Service and bind us.</p>
        </header>

        <ul className="guarantee__promises">
          {PRODUCT_KNOWLEDGE.guarantee.map(([title, body], index) => (
            <li key={title} className="guarantee__promise">
              <span className="guarantee__mark" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h2>{title}</h2>
                <p>{body}</p>
              </div>
            </li>
          ))}
        </ul>

        <section className="guarantee__fine" aria-labelledby="guarantee-fine">
          <h2 id="guarantee-fine">What the Guarantee does not change</h2>
          <p>We still process what you send in order to answer you, keep your account secure, enforce plan limits, and meet legal obligations, exactly as the Privacy Policy describes. Deleted data leaves active systems right away; encrypted recovery backups roll off within 12 months. Payment records stay with the billing provider as the law requires.</p>
          <div className="guarantee__actions">
            <a className="btn btn--primary" href="/app">Open VibhavGPT</a>
            <a className="btn btn--secondary" href="/account-deletion">How account deletion works</a>
          </div>
        </section>

        <PublicFaq path="/guarantee" />
        <p className="legal-updated">Last updated {UPDATED}</p>
        <OtherDocuments current="guarantee" />
      </article>
      <SiteFooter />
    </main>
  );
}

/* -- Terms and Privacy ----------------------------------------------------- */

export default function Legal({ page, onBack, backLabel = "Back to sign in" }) {
  useLayoutEffect(() => { resetPageScroll(); }, [page]);
  const creditsMode = useCreditsMode();
  if (page === "guarantee") return <Guarantee onBack={onBack} backLabel={backLabel} />;
  const doc = DOCUMENTS[page === "terms" ? "terms" : "privacy"];
  const sections = doc.sections(creditsMode);
  return (
    <main className="legal legal-doc">
      <PublicNav current={page} />
      <div className="legal-doc__layout">
        <header className="page-header legal-doc__header">
          <h1 className="page-header__title legal-doc__title">{doc.title}</h1>
          <p className="page-header__lede legal-doc__lede">{doc.lede}</p>
          {page !== "terms" && <p className="legal-updated">VibhavGPT is operated by Pansophy LLC.</p>}
          <p className="legal-updated">Last updated {UPDATED}</p>
          <a className="legal-doc__guarantee" href="/guarantee">
            <span className="legal-doc__guarantee-mark" aria-hidden="true" />
            <span><strong>The short version is the VibhavGPT Guarantee.</strong> We never train on your chats, never sell your data and never show ads. Export or delete everything, any time.</span>
          </a>
        </header>

        <nav className="legal-doc__toc" aria-label="Sections">
          <ol>
            {sections.map(([title]) => <li key={title}><a href={`#${slug(title)}`}>{title}</a></li>)}
          </ol>
        </nav>

        <article className="legal-doc__body">
          {sections.map(([title, body], index) => (
            <section key={title} id={slug(title)}>
              <h2><span className="legal-doc__number">{index + 1}</span>{title}</h2>
              <p>{body}</p>
            </section>
          ))}
          <OtherDocuments current={page} />
        </article>
      </div>
      <SiteFooter />
    </main>
  );
}
