import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// The Vibhav theme defines every token; it loads first so each stylesheet
// after it, including the legacy aliases, resolves against it.
import "./theme/vibhav.css";
import "./styles.css";
import "./planetary.css";
import App from "./App.jsx";
// Last, so the phone layout overrides every other sheet at its width.
import "./mobile.css";
// Public legal pages must also be styled before their lazy JS chunk loads,
// including the prerendered version viewed without JavaScript.
import "./legal.css";
// The Windows desktop app's title bar strip; inert in a browser.
import "./desktop.css";
import { markDesktopApp } from "./desktop-app.js";
import Sentry from "./sentry.js";
import ErrorFallback from "./components/ErrorFallback.jsx";
import { PUBLIC_PAGES, publicPagePath } from "./public-pages.js";
// Direct .html and trailing-slash visits must render the same public view.
// The bare root retains its billing/auth callback handling.
const publicPath = publicPagePath(window.location.pathname);
if (window.location.pathname !== "/" && PUBLIC_PAGES[publicPath] && window.location.pathname !== publicPath) {
  window.history.replaceState(window.history.state, "", `${publicPath}${window.location.search}${window.location.hash}`);
}
// The Windows app's own look (desktop.css): <body> gets .is-desktop-app.
markDesktopApp();
createRoot(document.getElementById("root")).render(<StrictMode><Sentry.ErrorBoundary fallback={<ErrorFallback />}><App /></Sentry.ErrorBoundary></StrictMode>);
