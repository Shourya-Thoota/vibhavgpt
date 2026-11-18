import { siteFooterInner } from "../site-footer.js";
import "../site-footer.css";

// The one footer, on the public site and in the app. The markup is site-footer.js's, so the React pages, the static pages and the
// in-app pages (Settings, Usage) show exactly the same footer. className only places it (site-footer--in-app); it never changes the markup.
export default function SiteFooter({ className = "" }) {
  return <footer className={`site-footer ${className}`.trim()} dangerouslySetInnerHTML={{ __html: siteFooterInner() }} />;
}
