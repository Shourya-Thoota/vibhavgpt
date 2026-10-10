import { PUBLIC_PAGES } from "../public-pages.js";
import "../public-pages.css";

export function PublicFaq({ path }) {
  return <section className="public-faq" aria-labelledby="public-faq-title"><h2 id="public-faq-title">Questions and answers</h2>{PUBLIC_PAGES[path].faq.map(([question, answer]) => <div key={question}><h3>{question}</h3><p>{answer}</p></div>)}<p className="public-operator">VibhavGPT is operated by Pansophy LLC. <a href="mailto:support@pansophy.com">Contact support</a>.</p></section>;
}
