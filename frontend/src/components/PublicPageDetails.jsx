import { PUBLIC_PAGES, pricingFaqFor } from "../public-pages.js";
import { useCreditsMode } from "../credits-runtime.js";
import "../public-pages.css";

export function PublicFaq({ path }) {
  // The pricing answers follow the credits wording the server is enforcing (see credits-runtime.js).
  const creditsMode = useCreditsMode();
  const faq = path === "/pricing" ? pricingFaqFor(creditsMode) : PUBLIC_PAGES[path].faq;
  return <section className="public-faq" aria-labelledby="public-faq-title"><h2 id="public-faq-title">Questions and answers</h2>{faq.map(([question, answer]) => <div key={question}><h3>{question}</h3><p>{answer}</p></div>)}<p className="public-operator">VibhavGPT is operated by Pansophy LLC. <a href="mailto:support@pansophy.com">Contact support</a>.</p></section>;
}
