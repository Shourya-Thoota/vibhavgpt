import { Children, isValidElement, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import {
  ArrowUp, BarChart3, Brain, Check, ChevronRight, Copy, CreditCard, Eye, EyeOff, FileText, Fingerprint,
  Image as ImageIcon, LogOut, Mail, Menu as MenuIcon, Mic,
  Moon, Paperclip, Plus, RotateCw, Settings as SettingsIcon,
  Download, Lock, MessageSquareText, Palette, ShieldCheck, SlidersHorizontal, Sparkles, SquarePen, Sun, Trash2, UserRound, X,
} from "lucide-react";
import SecurityPanel from "./components/SecurityPanel.jsx";
import ImageWorkspace from "./components/ImageWorkspace.jsx";
import { imageJobs } from "./image-jobs.js";
import Sidebar from "./components/Sidebar.jsx";
import { useDrawerSwipe } from "./components/useDrawerSwipe.js";
import "./study.css";
import "./auth.css";
import "./composer.css";
import "./cosmos.css";
import "./settings.css";
import "./pricing.css";
import { productModeFromPath, productPath, STUDY_TAGLINES, STUDY_STARTERS } from "./product-modes.js";
import { passkeysSupported, signInWithPasskey as runPasskeySignIn } from "./passkey-auth.js";
import { BottomSheet, ChoiceCards, dismissTopOverlay, Field, IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, Modal, NARROW_QUERY, Segmented, Select, SettingsSelect, useMediaQuery } from "./components/ui.jsx";
import { RevealWords, TypingDots, useTypewriter } from "./components/Typing.jsx";
import { copyText } from "./clipboard.js";
import { joinDictation, useDictation } from "./dictation.js";
import { protectPlainDollarSigns, normalizeTexDelimiters } from "./markdown.js";
import { emailOtpVerificationRequest } from "./auth-code-endpoint.js";
import { api, apiRequest, responseError } from "./api.js";
import { accessStatus } from "./access-status.js";
import { PrivateFileLink, PrivateImage, ResourceLink, saveFile } from "./components/PrivateMedia.jsx";
import { ThinkingTool } from "./components/ui/thinking-tool.jsx";
import { LiveStatusLabel, ReasoningTrace } from "./components/ui/reasoning-trace.jsx";
import { SourcesDisclosure } from "./components/ui/sources-disclosure.jsx";
import { elapsedSeconds } from "./live-status.js";
import { applyPageMetadata } from "./seo.js";
import { DELETION_PLAN_NOTICE } from "./public-pages.js";
import { PublicFaq } from "./components/PublicPageDetails.jsx";
import { resetPageScroll } from "./page-scroll.js";
import { SETTINGS_SECTIONS, settingsPath, settingsRoute } from "./settings-routes.js";
import { updateStatusLabel, updateStore } from "./desktop-updates.js";
import { PRODUCT_KNOWLEDGE } from "./product-knowledge.js";
import { usagePercentage, combinedTokenUsage } from "./usage-percentage.js";
import { interruptedStreamMessage } from "./stream-recovery.js";
import { CODING_NUDGE_COPY, shouldSuggestNebula } from "./coding-nudge.js";
import Onboarding, { PersonalitySlider } from "./components/Onboarding.jsx";
import {
  accentForTheme, CAPABILITY_OPTIONS, landingModeFor, mergeInstructions, personalityHeadline,
  defaultOnboarding, EXPERTISE_OPTIONS, PERSONALITY_AXES, readOnboarding, responseStyleForPersonality, ROLE_OPTIONS, stripManagedInstructions,
  THEME_OPTIONS, UNIT_OPTIONS, writeOnboarding,
} from "./onboarding.js";
import { checkDirectAndroidUpdate } from "./direct-distribution.js";
import { NAMELESS_GREETING, workspaceNames } from "./display-names.js";
import { COMPARISON_GROUPS, monthlyEquivalent, yearlySaving } from "./plan-comparison.js";
import { SOURCE_REPO_URL } from "./source-repo.js";
import Sentry from "./sentry.js";

// Terms and Privacy load on demand, in their own chunk, so the app bundle
// carries only what the app itself shows.
const Legal = lazy(() => import("./Legal.jsx"));

const BRAND_ICON = "/brand/vibhavgpt-icon-64.png";
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;

function capacitorReturnPath(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "vibhavgpt:" || url.hostname !== "account") return null;
    const query = new URLSearchParams();
    if (url.searchParams.get("upgraded") === "true") query.set("upgraded", "true");
    const credits = url.searchParams.get("credits");
    if (["success", "cancelled"].includes(credits)) query.set("credits", credits);
    return `/account${query.size ? `?${query}` : ""}`;
  } catch {
    return null;
  }
}

// Google sign-in in the native app runs in the system browser (see
// src/auth/native-oauth.js). The verifier stays here and redeems the one-time
// code the browser hands back, so an intercepted return link is useless.
const NATIVE_OAUTH_VERIFIER_KEY = "vibhavgpt-native-oauth-verifier";

const base64Url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function startNativeGoogleSignIn() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const verifierHash = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  // localStorage rather than memory: Android may kill the backgrounded app
  // while the browser is open, and the return link then cold-starts it.
  localStorage.setItem(NATIVE_OAUTH_VERIFIER_KEY, verifier);
  const { url } = await api("/api/native-auth/google/start", { method: "POST", body: JSON.stringify({ verifierHash }) });
  try {
    await Browser.open({ url });
  } catch {
    // App builds from before the Browser plugin: a plain navigation still
    // leaves the WebView for any host the app does not serve itself.
    window.location.assign(url);
  }
}

async function finishNativeGoogleSignIn(returnUrl) {
  void Browser.close().catch(() => null);
  let verifier = null;
  try {
    verifier = localStorage.getItem(NATIVE_OAUTH_VERIFIER_KEY);
    localStorage.removeItem(NATIVE_OAUTH_VERIFIER_KEY);
  } catch {
    // Storage unavailable: fall through to the error below.
  }
  const code = returnUrl.searchParams.get("code");
  const failure = returnUrl.searchParams.get("error");
  if (failure || !code || !verifier) {
    window.location.assign(`/app?error=${encodeURIComponent(failure || "expired")}`);
    return;
  }
  try {
    const { params } = await api("/api/native-auth/exchange", { method: "POST", body: JSON.stringify({ code, verifier }) });
    const query = new URLSearchParams(params ?? {});
    window.location.assign(`/app${query.size ? `?${query}` : ""}`);
  } catch {
    window.location.assign("/app?error=expired");
  }
}

function useCapacitorReturnLinks() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined;
    let listener;
    let disposed = false;
    const handleUrl = ({ url }) => {
      let parsed = null;
      try { parsed = new URL(url); } catch { /* not a return link */ }
      if (parsed?.protocol === "vibhavgpt:" && parsed.hostname === "account" && parsed.pathname === "/auth") {
        void finishNativeGoogleSignIn(parsed);
        return;
      }
      const path = capacitorReturnPath(url);
      if (path) window.location.assign(path);
    };
    const register = async () => {
      listener = await CapacitorApp.addListener("appUrlOpen", handleUrl);
      const launch = await CapacitorApp.getLaunchUrl();
      if (!disposed && launch?.url) handleUrl(launch);
      if (disposed) await listener.remove();
    };
    void register().catch(() => null);
    return () => {
      disposed = true;
      void listener?.remove();
    };
  }, []);
}
function legalPageFromPath(pathname) {
  if (pathname === "/terms" || pathname === "/terms-of-service") return "terms";
  if (pathname === "/privacy" || pathname === "/privacy-policy") return "privacy";
  if (pathname === "/guarantee") return "guarantee";
  return null;
}

function LegalLink({ page, onOpen, children }) {
  const href = page === "terms" ? "/terms" : page === "guarantee" ? "/guarantee" : "/privacy";
  return (
    <a
      className="link"
      href={href}
      onClick={(event) => {
        event.preventDefault();
        onOpen(page);
      }}
    >
      {children}
    </a>
  );
}

/* -- Theme and accent ----------------------------------------------------- */

// The universes the reader can pick. Their colours are tokens, not values
// here: each id names a per-sky palette in theme/vibhav.css
// (--color-accent-<id>), and data-accent on <html> chooses which one becomes
// --color-accent. Changing sky retints the accent with no code at all.
const ACCENTS = [
  { id: "cerulean", label: "Orbit cyan" },
  { id: "nebula", label: "Nebula violet" },
  { id: "pine", label: "Pine" },
  { id: "ember", label: "Mars copper" },
  { id: "amber", label: "Amber" },
];

const THEMES = [
  { id: "system", label: "Match system", description: "Follow your device between Daybreak and Deep Space." },
  { id: "light", label: "Daybreak", description: "Cool paper grounds and dark ink, like a planet seen at altitude." },
  { id: "dark", label: "Deep Space", description: "Deep navy grounds and light ink, the night side." },
];

const prefersLight = () => window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;

// Deep Space is the default sky. Older builds saved "system" for every reader
// who never opened the setting, so "system" counts only once the reader has
// picked a sky themselves (vibhavgpt-theme-chosen). Mirrors
// theme/appearance-boot.js.
function resolveSavedTheme() {
  try {
    const saved = localStorage.getItem("vibhavgpt-theme");
    if (saved === "light" || saved === "dark") return saved;
    if (saved === "system" && localStorage.getItem("vibhavgpt-theme-chosen") === "1") return "system";
  } catch {
    // Storage blocked: fall through to the default sky.
  }
  return "dark";
}

// Appearance lives above sign-in so the login screen honours it too. Theme and
// accent are independent: theme picks the sky, accent picks the light running
// through it, and the accent's value depends on which sky resolved.
function useAppearance() {
  const [accentId, setAccentId] = useState(() => localStorage.getItem("vibhavgpt-accent") || "cerulean");
  const [themeId, setSavedThemeId] = useState(resolveSavedTheme);
  // Every sky the reader picks (Settings, the account menu, onboarding) goes
  // through here, so a later "Match system" is known to be deliberate.
  const setThemeId = useCallback((value) => {
    try { localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch { /* storage blocked */ }
    setSavedThemeId(value);
  }, []);
  const [systemTheme, setSystemTheme] = useState(() => (prefersLight() ? "light" : "dark"));

  // Tracked unconditionally rather than only while themeId === "system", so
  // switching back to "system" is already correct instead of stale.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (event) => setSystemTheme(event.matches ? "light" : "dark");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const resolved = themeId === "system" ? systemTheme : themeId;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
    localStorage.setItem("vibhavgpt-theme", themeId);
  }, [resolved, themeId]);

  // The boot script in each HTML entry already set data-accent before first
  // paint; this keeps it in step with the picker from then on.
  useEffect(() => {
    const accent = ACCENTS.find((option) => option.id === accentId) ?? ACCENTS[0];
    document.documentElement.setAttribute("data-accent", accent.id);
    localStorage.setItem("vibhavgpt-accent", accent.id);
  }, [accentId]);

  return { accentId, setAccentId, themeId, setThemeId, resolved };
}

/* -- Turnstile ------------------------------------------------------------ */

let turnstileLoader;

function reportTurnstileDiagnostic(phase, details = {}) {
  try {
    Sentry.captureMessage(`bot-check-client:${phase}`, {
      level: "info",
      tags: { feature: "bot-check", phase },
      extra: {
        online: typeof navigator === "undefined" ? null : navigator.onLine,
        visibility: typeof document === "undefined" ? null : document.visibilityState,
        hasSiteKey: Boolean(TURNSTILE_SITE_KEY),
        ...details,
      },
    });
  } catch {
    // Diagnostics must never affect authentication or widget rendering.
  }
}

function loadTurnstile() {
  if (typeof window !== "undefined" && window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileLoader) return turnstileLoader;
  turnstileLoader = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (error) {
        turnstileLoader = null;
        reject(error);
      } else if (window.turnstile) {
        resolve(window.turnstile);
      } else {
        turnstileLoader = null;
        reject(new Error("Turnstile loaded without its client API."));
      }
    };
    const timeout = window.setTimeout(() => {
      reportTurnstileDiagnostic("script-load-timeout");
      finish(new Error("Turnstile did not load in time."));
    }, 12_000);
    const existingScript = Boolean(document.querySelector("script[data-vibhavgpt-turnstile]"));
    const script = document.querySelector("script[data-vibhavgpt-turnstile]") ?? document.createElement("script");
    reportTurnstileDiagnostic("script-load-start", { existingScript });
    if (!script.src) {
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.dataset.vibhavgptTurnstile = "true";
      document.head.appendChild(script);
    }
    script.addEventListener("load", () => {
      reportTurnstileDiagnostic("script-load-success", { apiReady: Boolean(window.turnstile) });
      finish();
    }, { once: true });
    script.addEventListener("error", () => {
      reportTurnstileDiagnostic("script-load-error");
      finish(new Error("Turnstile script failed to load."));
    }, { once: true });
    if (window.turnstile) finish();
  });
  return turnstileLoader;
}

function TurnstileWidget({ onToken, onError, onReady, resetKey, theme }) {
  const containerRef = useRef(null);
  const widgetIdRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    let failed = false;
    const clearWidget = () => {
      if (widgetIdRef.current !== null && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // Turnstile may already have removed a failed iframe itself.
        }
      }
      widgetIdRef.current = null;
      containerRef.current?.replaceChildren();
    };
    const fail = (message, phase = "widget-error") => {
      if (cancelled || failed) return;
      failed = true;
      reportTurnstileDiagnostic(phase);
      // Turnstile renders its own failure panel inside the iframe. Remove it
      // before showing our single app-level error so users never see two
      // competing bot-check failures at once.
      clearWidget();
      onError(message);
    };
    if (!TURNSTILE_SITE_KEY) {
      fail("Bot protection is not configured. Please try again later.");
      return undefined;
    }
    loadTurnstile().then((turnstile) => {
      if (cancelled || !containerRef.current) return;
      try {
        widgetIdRef.current = turnstile.render(containerRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          theme,
          size: "flexible",
          retry: "never",
          "refresh-expired": "auto",
          "refresh-timeout": "auto",
          callback: onToken,
          "expired-callback": () => fail("The bot check expired. Please complete it again.", "challenge-expired"),
          "timeout-callback": () => fail("The bot check timed out. Please try again.", "challenge-timeout"),
          "unsupported-callback": () => fail("This browser cannot complete the bot check. Try another browser or use email-code sign-in.", "challenge-unsupported"),
          "execution-failed-callback": () => fail("The bot check could not finish. Check your connection or disable content blockers, then try again.", "challenge-execution-failed"),
          "error-callback": () => fail("The bot check could not load. Check your connection or disable content blockers, then try again.", "challenge-error"),
        });
        reportTurnstileDiagnostic("widget-render-success");
        onReady?.();
      } catch (error) {
        reportTurnstileDiagnostic("widget-render-error", {
          errorName: error?.name || "unknown",
          errorMessage: typeof error?.message === "string" ? error.message.slice(0, 160) : "unknown",
        });
        fail("The bot check could not load. Check your connection or disable content blockers, then try again.", "widget-render-error");
      }
    }).catch((error) => {
      fail("The bot check could not load. Check your connection or disable content blockers, then try again.", error?.message === "Turnstile did not load in time." ? "script-load-timeout" : "script-load-error");
    });
    return () => {
      cancelled = true;
      clearWidget();
    };
  }, [onError, onReady, onToken, resetKey, theme]);
  return <div className="turnstile" data-configured={TURNSTILE_SITE_KEY ? "true" : undefined} ref={containerRef} aria-label="Bot check" />;
}

// Native clients load this route in a WebView because Turnstile has no native
// SDK. The page lives on vibhavgpt.com, the hostname verified by the API, and
// sends only the short-lived Turnstile token back to the app.
function MobileTurnstileBridge({ theme }) {
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);
  const [cycle, setCycle] = useState(0);
  const postBridgeStatus = useCallback((type, extra = {}) => {
    if (typeof window.ReactNativeWebView?.postMessage !== "function") return false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type, ...extra }));
    return true;
  }, []);

  useEffect(() => {
    postBridgeStatus("bridge-ready");
  }, [postBridgeStatus]);

  const sendToken = useCallback((token) => {
    if (!postBridgeStatus("turnstile-token", { token })) {
      setError("This security check must be opened from the VibhavGPT app.");
      return;
    }
    setComplete(true);
  }, [postBridgeStatus]);

  const reportError = useCallback((message) => {
    postBridgeStatus("turnstile-error", { message });
    setError(message);
  }, [postBridgeStatus]);

  return (
    <div className="auth auth--bridge">
      <main className="auth__main" aria-live="polite">
        <header className="auth__top"><Brand size="brand--lg" /></header>
        <div className="auth__center">
          <section className="auth__card" aria-labelledby="bridge-title">
            <div className="auth__step">
              <div className="auth__head">
                <h1 className="auth__title" id="bridge-title">Quick security check.</h1>
                <p className="auth__subtitle">Complete this check to continue securely in VibhavGPT.</p>
              </div>
              {complete ? <p className="note note--good">Verification complete. Passing it to the app…</p> : <TurnstileWidget onToken={sendToken} onError={reportError} onReady={() => postBridgeStatus("turnstile-widget-ready")} resetKey={cycle} theme={theme} />}
              {error && <><p className="note note--error" role="alert">{error}</p><button className="btn btn--secondary btn--block" type="button" onClick={() => { setError(""); setCycle((value) => value + 1); }}>Try again</button></>}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

/* -- Transport ------------------------------------------------------------ */


async function streamChat(payload, onStatus, { signal, onDelta, onConversation } = {}) {
  let response;
  try {
    response = await apiRequest("/api/chat/stream", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    if (Number.isInteger(error?.status)) {
      if (error.status === 401) throw new Error("Your session has expired. Sign in again, then retry your message.");
      if (error.access) throw error;
      throw new Error(error.message || "VibhavGPT couldn't accept this request. Please retry your message.");
    }
    throw new Error("Couldn't connect to VibhavGPT. Check your connection and try sending again.");
  }
  if (!response.ok || !response.body) {
    if (response.status === 401) throw new Error("Your session has expired. Sign in again, then retry your message.");
    if (response.status === 429) throw new Error("You've reached a usage limit or need more credits for this request. Check your plan and try again.");
    if (response.status >= 500 || !response.ok) throw new Error("VibhavGPT is temporarily unavailable. Please retry your message shortly.");
    throw new Error("VibhavGPT opened a response stream that could not be read. Please retry your message.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let complete;
  function handleEvent(block) {
    const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
    const encoded = block.match(/^data:\s*(.+)$/m)?.[1];
    if (!event || !encoded) return;
    let data;
    try { data = JSON.parse(encoded); } catch {
      throw new Error("VibhavGPT returned an unreadable response. Please retry your message.");
    }
    if (event === "status") onStatus(data.phase, data);
    if (event === "delta") onDelta?.(data);
    // The message was saved before any reply: the conversation it is in.
    if (event === "conversation") onConversation?.(data);
    if (event === "error") throw responseError(data, data.status);
    if (event === "complete") complete = data;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const events = buffer.split("\n\n");
      buffer = events.pop();
      events.forEach(handleEvent);
      if (done) break;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof Error && !(error instanceof TypeError)) throw error;
    throw new Error("The connection ended before VibhavGPT finished replying. Your message is still available to retry.");
  }
  if (buffer.trim()) handleEvent(buffer);
  if (!complete) throw new Error("The response ended before VibhavGPT could reply.");
  return complete;
}

function authErrorMessage(error, isSignUp) {
  switch (error.code) {
    case "TWO_FACTOR_SETUP_INVALID":
      return "Your authenticator setup needs to be renewed. Use an email code or backup code to finish signing in.";
    case "INVALID_CODE":
      return "That verification code is invalid or expired. Try a new code.";
    case "SESSION_EXPIRED":
      return "Your sign-in session expired. Please sign in again.";
    case "USER_NOT_FOUND":
      return "No account was found with that email. Create an account first.";
    case "INVALID_EMAIL_OR_PASSWORD":
    case "INVALID_PASSWORD":
      return "Incorrect email or password.";
    case "USER_ALREADY_EXISTS":
      return "An account already exists with that email. Try signing in instead.";
    case "INVALID_EMAIL":
      return "Enter a valid email address.";
    case "PASSWORD_TOO_SHORT":
      return "Your password needs to be at least 8 characters.";
    default:
      return (
        error.message ||
        (isSignUp ? "We couldn't create your account. Please try again." : "We couldn't sign you in. Please try again.")
      );
  }
}

const Brand = ({ size = "" }) => (
  <a className={`brand ${size}`.trim()} href="/home" aria-label="VibhavGPT home">
    <img src={BRAND_ICON} alt="" />
    <span>VibhavGPT</span>
  </a>
);

/* -- Root ----------------------------------------------------------------- */

export default function App() {
  useCapacitorReturnLinks();
  const appearance = useAppearance();
  const isMobileTurnstileBridge = window.location.pathname === "/mobile-auth/turnstile";
  const [user, setUser] = useState(null);
  const [mode, setMode] = useState(() => window.location.pathname === "/signup" ? "signup" : "signin");
  const [loading, setLoading] = useState(true);
  const [legal, setLegal] = useState(() => legalPageFromPath(window.location.pathname));

  useEffect(() => {
    applyPageMetadata(window.location.pathname);
    resetPageScroll();
  }, [legal]);

  const openLegal = useCallback((page) => {
    const path = page === "terms" ? "/terms" : page === "guarantee" ? "/guarantee" : "/privacy";
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
    setLegal(page);
  }, []);

  const closeLegal = useCallback(() => {
    window.history.pushState({}, "", "/app");
    setLegal(null);
  }, []);

  useEffect(() => {
    const onPopState = () => setLegal(legalPageFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (isMobileTurnstileBridge) {
      setLoading(false);
      return undefined;
    }
    api("/api/me")
      .then(({ user: session }) => setUser(session))
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [isMobileTurnstileBridge]);


  // Preserve query/hash based sign-in callbacks and old billing deep links.
  // On the web a plain root visit always opens the public landing page, even
  // when signed in. The native app skips the landing page for a signed-in
  // user: its hamburger is the marketing nav, not the workspace sidebar.
  const isPlainRoot = window.location.pathname === "/" && !window.location.search && !window.location.hash;
  let showLanding = isPlainRoot || ["/home", "/home/"].includes(window.location.pathname);
  if (showLanding && Capacitor.isNativePlatform()) {
    if (loading) {
      return (
        <main className="boot">
          <img src={BRAND_ICON} alt="" />
          <TypingDots label="Opening your workspace" />
        </main>
      );
    }
    if (user) {
      window.history.replaceState(null, "", "/app");
      showLanding = false;
    }
  }
  if (showLanding && isPlainRoot) {
    window.location.replace("/home");
    return null;
  }
  if (showLanding) {
    return <iframe className="home-frame" title="VibhavGPT home" src="/home/index.html" />;
  }
  if (window.location.pathname === "/pricing") {
    return <PublicPricing signedIn={Boolean(user)} />;
  }
  if (isMobileTurnstileBridge) return <MobileTurnstileBridge theme={appearance.resolved} />;
  if (loading) {
    return (
      <main className="boot">
        <img src={BRAND_ICON} alt="" />
        <TypingDots label="Opening your workspace" />
      </main>
    );
  }
  if (legal) return <Suspense fallback={null}><Legal page={legal} onBack={closeLegal} backLabel={user ? "Back to VibhavGPT" : "Back to sign in"} /></Suspense>;
  // The guarded /onboarding route: a deep link to a survey this account has
  // already finished is not a second survey, it is the workspace. Re-running it
  // deliberately goes through Settings, which opens the view directly.
  if (user && window.location.pathname === "/onboarding" && readOnboarding(user.id).onboarding_completed) {
    window.history.replaceState(null, "", "/app");
  }
  return user ? (
    <Workspace
      user={user}
      appearance={appearance}
      onSignOut={async () => {
        await api("/api/auth/sign-out", { method: "POST" });
        window.history.replaceState(null, "", "/app");
        setUser(null);
      }}
      onDeleted={() => {
        // The account is gone on the server; nothing of it should stay on
        // this device either. Appearance choices are not account data.
        clearAccountLocalData(user?.id);
        // On the web, the deletion page confirms it in words; the app shell
        // has no such page, so it returns to sign-in.
        if (!Capacitor.isNativePlatform()) { window.location.replace("/account-deletion?deleted=1"); return; }
        window.history.replaceState(null, "", "/app");
        setUser(null);
      }}
      onLegal={openLegal}
    />
  ) : (
    <Auth mode={mode} setMode={setMode} onUser={(session) => { window.history.replaceState({}, "", settingsRoute(window.location.pathname, window.location.search)?.redirect ?? (settingsRoute(window.location.pathname) ? `${window.location.pathname}${window.location.search}` : `${productPath(productModeFromPath(window.location.pathname))}${window.location.search}`)); setUser(session); }} onLegal={openLegal} theme={appearance.resolved} />
  );
}

function clearAccountLocalData(userId) {
  try {
    for (const key of Object.keys(localStorage)) {
      if ((userId && key.endsWith(`:${userId}`)) || key.startsWith("vibhavgpt-groups-open:")) localStorage.removeItem(key);
    }
  } catch {
    // Storage blocked: there is nothing stored to clear.
  }
}

/* -- Auth ----------------------------------------------------------------- */

// What an account here does and doesn't do, in the words the policy uses.
// Shown beside the form on wide screens and under it on phones.
const ACCOUNT_FACTS = [
  "No ads.",
  "We don't sell your data.",
  "We don't train AI models on your chats.",
  "Export your data or delete your account from Settings.",
];

function AccountFacts({ className = "" }) {
  return (
    <section className={`auth__facts ${className}`.trim()} aria-label="How we treat your account">
      <p className="auth__facts-title">How we treat your account</p>
      <ul>
        {ACCOUNT_FACTS.map((fact) => <li key={fact}>{fact}</li>)}
      </ul>
    </section>
  );
}

// A light that follows a fine pointer across one surface, written as
// --spot-x/--spot-y on that element (one write per frame). Never on touch
// and never under reduced motion; the surface reads the same without it.
function usePointerSpotlight(ref) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const finePointer = window.matchMedia?.("(pointer: fine)");
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!finePointer?.matches || reducedMotion?.matches) return undefined;
    let frame = 0;
    let last = null;
    const paint = () => {
      frame = 0;
      if (!last) return;
      const box = element.getBoundingClientRect();
      element.style.setProperty("--spot-x", `${Math.round(last.clientX - box.left)}px`);
      element.style.setProperty("--spot-y", `${Math.round(last.clientY - box.top)}px`);
      element.dataset.spot = "";
    };
    const move = (event) => {
      last = event;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const leave = () => {
      last = null;
      delete element.dataset.spot;
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", leave);
    };
  }, [ref]);
}

function AuthSky({ skyRef }) {
  return (
    <aside className="auth__sky" ref={skyRef}>
      <span className="auth__stars" aria-hidden="true" />
      <span className="auth__stars-lit" aria-hidden="true" />
      <span className="auth__atmosphere" aria-hidden="true" />
      <div className="auth__planet" aria-hidden="true">
        <img src="/planets/earth.webp" alt="" width="800" height="800" decoding="async" />
      </div>
      <div className="auth__sky-copy">
        <p className="auth__quote">A quiet place to think out loud.</p>
        <AccountFacts />
      </div>
    </aside>
  );
}

function Auth({ mode, setMode, onUser, onLegal, theme }) {
  const signUp = mode === "signup";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileError, setTurnstileError] = useState("");
  const [turnstileCycle, setTurnstileCycle] = useState(0);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [otp, setOtp] = useState("");
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [step, setStep] = useState("password");
  const [factorMethod, setFactorMethod] = useState("otp");
  const [factorMethods, setFactorMethods] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [resendUntil, setResendUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [emailCodeDialogOpen, setEmailCodeDialogOpen] = useState(false);
  const [emailCodeAddress, setEmailCodeAddress] = useState("");
  const [passwordResetDialogOpen, setPasswordResetDialogOpen] = useState(false);
  const [passwordResetStep, setPasswordResetStep] = useState("request");
  const [passwordResetEmail, setPasswordResetEmail] = useState("");
  const [passwordResetCode, setPasswordResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [passwordResetNotice, setPasswordResetNotice] = useState("");
  const cardRef = useRef(null);
  const skyRef = useRef(null);
  usePointerSpotlight(cardRef);
  usePointerSpotlight(skyRef);

  const resetPasswordResetFlow = () => {
    setPasswordResetStep("request");
    setPasswordResetCode("");
    setNewPassword("");
    setConfirmNewPassword("");
    setPasswordResetNotice("");
  };

  const handleTurnstileToken = useCallback((token) => {
    setTurnstileToken(token);
    setTurnstileError("");
  }, []);
  const handleTurnstileError = useCallback((message) => {
    setTurnstileToken("");
    setTurnstileError(message);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("reset-password") === "true") {
      resetPasswordResetFlow();
      setPasswordResetDialogOpen(true);
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
    // Set by a failed Google sign-in (Better Auth's errorURL, or the native
    // app's return link).
    if (params.has("error")) {
      setError(params.get("error") === "access_denied"
        ? "Google sign-in was cancelled."
        : "Google sign-in didn't finish. Please try again.");
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
    if (params.get("twoFactor") !== "required" && params.get("twoFactorRequired") !== "true") return;
    const methods = (params.get("twoFactorMethods") || "").split(",").filter(Boolean);
    setFactorMethods(methods);
    setFactorMethod(methods.includes("totp") ? "totp" : methods.includes("otp") ? "otp" : "backup");
    setStep("two-factor");
    setNotice("Enter your second verification code to finish signing in.");
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const resetMessage = () => {
    setError("");
    setNotice("");
  };

  useEffect(() => {
    if (!resendUntil || resendUntil <= Date.now()) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [resendUntil]);

  const secondsUntilResend = Math.max(0, Math.ceil((resendUntil - now) / 1000));
  const beginCooldown = () => {
    setCodeSent(true);
    setResendUntil(Date.now() + 60_000);
    setNow(Date.now());
  };

  async function submit(event) {
    event.preventDefault();
    if (signUp && !ageConfirmed) {
      setError("Please confirm that you are at least 16 years old.");
      return;
    }
    if (!turnstileToken) {
      if (!turnstileError) setError("Please complete the bot check before continuing.");
      return;
    }
    setBusy(true);
    resetMessage();
    try {
      const result = await api(signUp ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email", {
        method: "POST",
        headers: { "x-captcha-response": turnstileToken },
        body: JSON.stringify(signUp ? { name, email, password, turnstileToken } : { email, password, turnstileToken }),
      });
      if (signUp) {
        setStep("verify-email");
        beginCooldown();
        setNotice("We sent a six-digit verification code to your email.");
      } else if (result.twoFactorRedirect) {
        const methods = result.twoFactorMethods ?? [];
        setFactorMethods(methods);
        setFactorMethod(methods.includes("totp") ? "totp" : "otp");
        setCodeSent(false);
        setResendUntil(0);
        setStep("two-factor");
        setNotice("Enter your second verification code to finish signing in.");
      } else {
        const session = await api("/api/me");
        onUser(session.user);
      }
    } catch (err) {
      setError(authErrorMessage(err, signUp));
    } finally {
      setBusy(false);
      setTurnstileToken("");
      setTurnstileCycle((cycle) => cycle + 1);
    }
  }

  async function sendSignInCode() {
    const requestedEmail = emailCodeAddress.trim().toLowerCase();
    if (!requestedEmail) return;
    setBusy(true);
    resetMessage();
    try {
      await api("/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        body: JSON.stringify({ email: requestedEmail, type: "sign-in" }),
      });
      setEmail(requestedEmail);
      setEmailCodeDialogOpen(false);
      setStep("sign-in-otp");
      beginCooldown();
      setNotice("If an account exists for this email, a six-digit code is on its way.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function requestPasswordReset() {
    const requestedEmail = passwordResetEmail.trim().toLowerCase();
    if (!requestedEmail) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/email-otp/request-password-reset", {
        method: "POST",
        body: JSON.stringify({ email: requestedEmail }),
      });
      setPasswordResetEmail(requestedEmail);
      setPasswordResetStep("code");
      setPasswordResetNotice("If an account exists for this email, a six-digit reset code is on its way.");
      beginCooldown();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function completePasswordReset() {
    if (newPassword !== confirmNewPassword) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/email-otp/reset-password", {
        method: "POST",
        body: JSON.stringify({ email: passwordResetEmail, otp: passwordResetCode, password: newPassword }),
      });
      setPasswordResetDialogOpen(false);
      resetPasswordResetFlow();
      setPassword(passwordResetEmail ? "" : password);
      setEmail(passwordResetEmail);
      setNotice("Your password was updated. Sign in with your new password.");
    } catch (err) {
      setError(authErrorMessage(err, false));
    } finally {
      setBusy(false);
    }
  }

  async function sendTwoFactorCode() {
    setBusy(true);
    resetMessage();
    try {
      await api("/api/auth/two-factor/send-otp", { method: "POST", body: JSON.stringify({}) });
      beginCooldown();
      setNotice("We sent a six-digit security code to your email.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    if (secondsUntilResend > 0 || busy) return;
    if (step === "two-factor") {
      await sendTwoFactorCode();
      return;
    }
    setBusy(true);
    resetMessage();
    try {
      const type = step === "verify-email" ? "email-verification" : "sign-in";
      await api("/api/auth/email-otp/send-verification-otp", { method: "POST", body: JSON.stringify({ email, type }) });
      beginCooldown();
      setNotice("We sent a new six-digit code to your email.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event) {
    event.preventDefault();
    setBusy(true);
    resetMessage();
    try {
      let recovery = null;
      if (step === "two-factor") {
        const path =
          factorMethod === "totp"
            ? "/api/auth/two-factor/verify-totp"
            : factorMethod === "backup"
              ? "/api/auth/two-factor/verify-backup-code"
              : "/api/auth/two-factor/verify-otp";
        const body = factorMethod === "backup" ? { code: otp } : { code: otp, trustDevice: false };
        await api(path, { method: "POST", body: JSON.stringify(body) });
      } else {
        const request = emailOtpVerificationRequest(step, { email, otp });
        await api(request.path, {
          method: "POST",
          body: JSON.stringify(request.body),
        });
      }
      // A successful email-code sign-in is the recovery authority for an
      // enrollment that the current auth secret can no longer decrypt. The
      // server only removes a record when it belongs to this session's user
      // and is actually unusable; healthy enrollments are left untouched.
      const usedEmailRecovery = step === "sign-in-otp" || (step === "two-factor" && factorMethod === "otp");
      if (usedEmailRecovery) {
        recovery = await api("/api/security/two-factor/recover", { method: "POST" }).catch(() => null);
      }
      const session = await api("/api/me");
      if (recovery?.recovered) {
        session.user = {
          ...session.user,
          twoFactorEnabled: false,
          twoFactorRecoveryRequired: true,
        };
      }
      onUser(session.user);
    } catch (err) {
      setError(step === "two-factor" ? authErrorMessage(err, false) : err.message);
    } finally {
      setBusy(false);
    }
  }

  async function signInWithGoogle() {
    setGoogleBusy(true);
    resetMessage();
    try {
      if (Capacitor.isNativePlatform()) {
        await startNativeGoogleSignIn();
        return;
      }
      const result = await api("/api/auth/sign-in/social", {
        method: "POST",
        // Land in the workspace after sign-in, not on the public homepage that
        // now owns a bare /. A brand-new account opens onboarding from there.
        body: JSON.stringify({ provider: "google", callbackURL: `${window.location.origin}/app`, errorCallbackURL: `${window.location.origin}/app` }),
      });
      if (result?.url) window.location.assign(result.url);
      else setError("Google sign-in could not be started. Please try again.");
    } catch (err) {
      setError(err.message);
    } finally {
      setGoogleBusy(false);
    }
  }

  async function signInWithPasskey() {
    if (!passkeysSupported()) {
      setError("Passkeys are not supported in this browser.");
      return;
    }
    setBusy(true);
    resetMessage();
    try {
      // Errors arrive already worded for people (see passkey-auth.js).
      const result = await runPasskeySignIn();
      if (result?.twoFactorRedirect) {
        const methods = result.twoFactorMethods ?? [];
        setFactorMethods(methods);
        setFactorMethod(methods.includes("totp") ? "totp" : methods.includes("otp") ? "otp" : "backup");
        setCodeSent(false);
        setResendUntil(0);
        setStep("two-factor");
        setNotice("Enter your second verification code to finish signing in.");
        return;
      }
      const session = await api("/api/me");
      onUser(session.user);
    } catch (err) {
      setError(err?.name === "PasskeyError" ? err.message : "Passkey sign-in didn't work. Try again, or sign in another way.");
    } finally {
      setBusy(false);
    }
  }

  const codeStep = step === "verify-email" || step === "sign-in-otp" || step === "two-factor";
  const factorOptions = [
    factorMethods.includes("totp") && { value: "totp", label: "Authenticator app", description: "The rotating code on your phone." },
    factorMethods.includes("otp") && { value: "otp", label: "Email code", description: "Sent to your inbox." },
    { value: "backup", label: "Backup code", description: "One of the codes you saved." },
  ].filter(Boolean);

  const switchMode = (next) => {
    if (next === mode) return;
    setMode(next);
    setStep("password");
    setCodeSent(false);
    setResendUntil(0);
    resetMessage();
  };
  const backupCode = step === "two-factor" && factorMethod === "backup";

  return (
    <div className="auth">
      <AuthSky skyRef={skyRef} />
      <main className="auth__main">
        <header className="auth__top"><Brand size="brand--lg" /></header>
        <div className="auth__center">
          <section className="auth__card" ref={cardRef} aria-labelledby="auth-title">
            {!codeStep && (
              <Segmented
                className="auth__switch"
                label="Sign in or create an account"
                value={signUp ? "signup" : "signin"}
                onChange={switchMode}
                options={[
                  { value: "signin", label: "Sign in" },
                  { value: "signup", label: "Create account" },
                ]}
              />
            )}
            <div className="auth__step" key={codeStep ? step : mode}>
              {codeStep ? (
                <>
                  <div className="auth__head">
                    <h1 className="auth__title" id="auth-title">
                      {step === "verify-email" ? "Check your inbox." : step === "two-factor" ? "One more step." : "Your code is on the way."}
                    </h1>
                    <p className="auth__subtitle">
                      {step === "two-factor"
                        ? "Confirm it's you with your authenticator, an email code, or a backup code."
                        : `Enter the six-digit code we sent to ${email}.`}
                    </p>
                  </div>
                  <form className="auth__form" onSubmit={verifyCode}>
                    {step === "two-factor" && factorOptions.length > 1 && (
                      <Field label="How would you like to verify?">
                        <Select value={factorMethod} onChange={setFactorMethod} options={factorOptions} label="Verification method" />
                      </Field>
                    )}
                    <Field label={backupCode ? "Backup code" : "Verification code"}>
                      <input
                        className={`input ${backupCode ? "" : "input--code"}`}
                        required
                        autoFocus
                        inputMode={factorMethod === "backup" ? "text" : "numeric"}
                        autoComplete="one-time-code"
                        maxLength={backupCode ? 11 : 6}
                        value={otp}
                        onChange={(event) => setOtp(event.target.value)}
                        placeholder={backupCode ? "XXXXX-XXXXX" : "000000"}
                      />
                    </Field>
                    {(step !== "two-factor" || factorMethod === "otp") && (
                      <button
                        className="btn btn--quiet auth__resend"
                        type="button"
                        disabled={busy || secondsUntilResend > 0}
                        onClick={codeSent ? resendCode : sendTwoFactorCode}
                      >
                        {codeSent && secondsUntilResend > 0 ? `Resend in ${secondsUntilResend}s` : codeSent ? "Resend code" : "Send email code"}
                      </button>
                    )}
                    {notice && <p className="note note--good">{notice}</p>}
                    {error && <p className="note note--error" role="alert">{error}</p>}
                    <button className="btn btn--primary btn--lg btn--block" disabled={busy || !otp}>
                      {busy ? "Verifying…" : "Verify and continue"}
                    </button>
                  </form>
                  <button
                    className="btn btn--ghost auth__back"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setStep("password");
                      setOtp("");
                      setCodeSent(false);
                      setResendUntil(0);
                      resetMessage();
                    }}
                  >
                    Use a different method
                  </button>
                </>
              ) : (
                <>
                  <div className="auth__head">
                    <h1 className="auth__title" id="auth-title">{signUp ? "Create your account." : "Welcome back."}</h1>
                    <p className="auth__subtitle">
                      {signUp
                        ? "One account for chat, study and image creation."
                        : "Your chats, memory and files are where you left them."}
                    </p>
                  </div>
                  <form className="auth__form" onSubmit={submit}>
                    {signUp && (
                      <Field label="Name">
                        <input className="input" required value={name} autoComplete="name" onChange={(event) => setName(event.target.value)} placeholder="Your name" />
                      </Field>
                    )}
                    <Field label="Email">
                      <input
                        className="input"
                        required
                        type="email"
                        value={email}
                        autoComplete={signUp ? "email" : "username webauthn"}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="you@example.com"
                      />
                    </Field>
                    <Field label="Password" htmlFor="auth-password">
                      <span className="input-affix">
                        <input
                          id="auth-password"
                          className="input"
                          required
                          minLength="8"
                          type={passwordVisible ? "text" : "password"}
                          value={password}
                          autoComplete={signUp ? "new-password" : "current-password webauthn"}
                          onChange={(event) => setPassword(event.target.value)}
                          placeholder="At least 8 characters"
                        />
                        <button
                          type="button"
                          className="input-affix__button"
                          onClick={() => setPasswordVisible((visible) => !visible)}
                          aria-label={passwordVisible ? "Hide password" : "Show password"}
                        >
                          {passwordVisible ? <EyeOff size={17} /> : <Eye size={17} />}
                        </button>
                      </span>
                    </Field>
                    {!signUp && (
                      <button
                        className="btn btn--quiet auth__forgot"
                        type="button"
                        disabled={busy || googleBusy}
                        onClick={() => {
                          setPasswordResetEmail(email);
                          resetPasswordResetFlow();
                          setPasswordResetDialogOpen(true);
                          setError("");
                        }}
                      >
                        Forgot password?
                      </button>
                    )}
                    {signUp && (
                      <>
                        <label className="checkbox">
                          <input type="checkbox" required checked={ageConfirmed} onChange={(event) => setAgeConfirmed(event.target.checked)} />
                          I confirm I am at least 16 years old.
                        </label>
                        <p className="auth__consent">
                          By creating an account you agree to our{" "}
                          <LegalLink page="terms" onOpen={onLegal}>Terms of Service</LegalLink> and{" "}
                          <LegalLink page="privacy" onOpen={onLegal}>Privacy Policy</LegalLink>.
                        </p>
                      </>
                    )}
                    <TurnstileWidget
                      key={`${signUp}-${turnstileCycle}`}
                      resetKey={turnstileCycle}
                      theme={theme}
                      onToken={handleTurnstileToken}
                      onError={handleTurnstileError}
                    />
                    {turnstileError && (
                      <div className="auth__captcha-error" role="alert">
                        <p className="note note--error">{turnstileError}</p>
                        <button
                          className="btn btn--quiet"
                          type="button"
                          onClick={() => {
                            setTurnstileError("");
                            setTurnstileToken("");
                            setTurnstileCycle((cycle) => cycle + 1);
                          }}
                        >
                          Try the bot check again
                        </button>
                      </div>
                    )}
                    {notice && <p className="note note--good">{notice}</p>}
                    {error && <p className="note note--error" role="alert">{error}</p>}
                    <button className="btn btn--primary btn--lg btn--block" disabled={busy || googleBusy}>
                      {busy ? "One moment…" : signUp ? "Create account" : "Sign in"}
                    </button>
                  </form>
                  {!signUp && (
                    <div className="auth__alt">
                      <button className="btn btn--quiet" type="button" disabled={busy || googleBusy} onClick={() => {
                        setEmailCodeAddress(email);
                        setEmailCodeDialogOpen(true);
                        resetMessage();
                      }}>
                        <Mail size={15} /> Email me a code
                      </button>
                      <button className="btn btn--quiet" type="button" disabled={busy || googleBusy} onClick={signInWithPasskey}>
                        <Fingerprint size={15} /> Use a passkey
                      </button>
                    </div>
                  )}
                  <div className="auth__divider">or</div>
                  <button className="btn btn--secondary btn--lg btn--block" type="button" disabled={busy || googleBusy} onClick={signInWithGoogle}>
                    <GoogleMark />
                    {googleBusy ? "Connecting…" : "Continue with Google"}
                  </button>
                </>
              )}
            </div>
          </section>
          <AccountFacts className="auth__facts--main" />
        </div>
        <p className="auth__legal">
          <LegalLink page="terms" onOpen={onLegal}>Terms</LegalLink>
          <LegalLink page="privacy" onOpen={onLegal}>Privacy</LegalLink>
        </p>
      </main>

      <Modal
        open={emailCodeDialogOpen}
        onClose={() => { setEmailCodeDialogOpen(false); resetMessage(); }}
        eyebrow="Passwordless sign-in"
        title="Get a sign-in code"
        description="Enter the email address for your VibhavGPT account and we'll send a six-digit code."
        onSubmit={(event) => { event.preventDefault(); sendSignInCode(); }}
      >
        <Field label="Email address">
          <input
            className="input"
            autoFocus
            required
            type="email"
            value={emailCodeAddress}
            onChange={(event) => setEmailCodeAddress(event.target.value)}
            placeholder="you@example.com"
          />
        </Field>
        {error && <p className="note note--error" role="alert">{error}</p>}
        <div className="ui-modal__actions">
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => { setEmailCodeDialogOpen(false); resetMessage(); }}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={busy || !emailCodeAddress.trim()}>
            {busy ? "Sending…" : "Email me a code"}
          </button>
        </div>
      </Modal>

      <Modal
        open={passwordResetDialogOpen}
        onClose={() => { setPasswordResetDialogOpen(false); resetPasswordResetFlow(); setError(""); }}
        eyebrow="Password reset"
        title={passwordResetStep === "request" ? "Reset your password" : passwordResetStep === "code" ? "Enter your reset code" : "Choose a new password"}
        description={
          passwordResetStep === "request"
            ? "Enter your account email and we'll send a six-digit reset code."
            : passwordResetStep === "code"
              ? `Enter the six-digit code sent to ${passwordResetEmail}.`
              : "Choose a new password for your account."
        }
        onSubmit={(event) => {
          event.preventDefault();
          if (passwordResetStep === "request") requestPasswordReset();
          else if (passwordResetStep === "code") {
            if (passwordResetCode.length !== 6) setError("Enter the six-digit reset code.");
            else { setError(""); setPasswordResetStep("password"); }
          } else completePasswordReset();
        }}
      >
        {passwordResetStep === "request" ? (
          <Field label="Email address">
            <input
              className="input"
              autoFocus
              required
              type="email"
              value={passwordResetEmail}
              onChange={(event) => setPasswordResetEmail(event.target.value)}
              placeholder="you@example.com"
            />
          </Field>
        ) : passwordResetStep === "code" ? (
          <Field label="Reset code">
            <input
              className="input input--code"
              autoFocus
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength="6"
              value={passwordResetCode}
              onChange={(event) => setPasswordResetCode(event.target.value.replace(/\D/g, ""))}
              placeholder="000000"
            />
          </Field>
        ) : (
          <>
            <Field label="New password">
              <input
                className="input"
                autoFocus
                required
                minLength="8"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="At least 8 characters"
              />
            </Field>
            <Field label="Confirm new password">
              <input
                className="input"
                required
                minLength="8"
                type="password"
                autoComplete="new-password"
                value={confirmNewPassword}
                onChange={(event) => setConfirmNewPassword(event.target.value)}
                placeholder="Repeat your new password"
              />
            </Field>
          </>
        )}
        {passwordResetNotice && <p className="note note--good">{passwordResetNotice}</p>}
        {error && <p className="note note--error" role="alert">{error}</p>}
        <div className="ui-modal__actions">
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => { setPasswordResetDialogOpen(false); resetPasswordResetFlow(); setError(""); }}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={
              busy ||
              !passwordResetEmail.trim() ||
              (passwordResetStep === "code" && passwordResetCode.length !== 6) ||
              (passwordResetStep === "password" && (!newPassword || !confirmNewPassword))
            }
          >
            {busy ? "One moment…" : passwordResetStep === "request" ? "Email reset code" : passwordResetStep === "code" ? "Continue" : "Update password"}
          </button>
        </div>
      </Modal>
    </div>
  );
}

const GoogleMark = () => (
  <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.2-.4-4.7H24v8.9h11.8a10 10 0 0 1-4.4 6.6v5.5h7.1c4.2-3.8 6.6-9.5 6.6-16.3z" />
    <path fill="#34A853" d="M24 46c6 0 11-2 14.5-5.2l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7A22 22 0 0 0 24 46z" />
    <path fill="#FBBC05" d="M11.8 28.4a13 13 0 0 1 0-8.4v-5.7H4.5a22 22 0 0 0 0 19.8l7.3-5.7z" />
    <path fill="#EA4335" d="M24 9.9c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 3.4 30 1.5 24 1.5A22 22 0 0 0 4.5 14.3l7.3 5.7c1.7-5.2 6.5-9 12.2-9z" />
  </svg>
);

/* -- Workspace ------------------------------------------------------------ */

const MODELS = [
  { value: "lumen", label: "Lumen", full: "VibhavGPT Lumen", description: "Fastest. Good for everyday questions.", badges: [{ label: "Entry", tone: "entry" }] },
  { value: "nova", label: "Nova", full: "VibhavGPT Nova", description: "Balanced speed and depth. Reads images.", badges: [{ label: "Balanced", tone: "balanced" }, { label: "Vision" }] },
  { value: "nebula", label: "Nebula", full: "VibhavGPT Nebula", description: "Strong reasoning for demanding, high-complexity work. Reads images.", badges: [{ label: "Premium", tone: "premium" }, { label: "Vision" }] },
  { value: "vesper", label: "Vesper", full: "VibhavGPT Vesper", description: "Flagship. Highest reasoning capacity for the most difficult problems. Reads images.", badges: [{ label: "Top Tier", tone: "top-tier" }, { label: "Vision" }] },
];
const VISION_MODELS = ["nova", "nebula", "vesper"];
const STUDY_MODEL = "study";

// The four models are one ladder, Lumen to Vesper, so the picker draws each as
// an orb whose size is its rung: the comparison reads before the words do.
const MODEL_RANK = Object.fromEntries(MODELS.map((entry, index) => [entry.value, index + 1]));
const READS_IMAGES = / Reads images\.$/;

function ModelOrb({ model, size = "md" }) {
  return <span className="model-orb" data-size={size} style={{ "--rank": MODEL_RANK[model] ?? 1 }} aria-hidden="true"><span /></span>;
}

// One row of the model picker, shared by the desktop dropdown and the phone
// sheet so both describe a model the same way.
function ModelRow({ entry, allowed, selected }) {
  const vision = VISION_MODELS.includes(entry.value);
  const tier = entry.badges.find((badge) => badge.tone)?.label;
  return (
    <span className="model-row" data-locked={!allowed || undefined}>
      <ModelOrb model={entry.value} />
      <span className="model-row__text">
        <span className="model-row__head">
          <span className="model-row__name">{entry.label}</span>
          {tier && <span className="model-row__tier">{tier.charAt(0) + tier.slice(1).toLowerCase()}</span>}
        </span>
        <span className="model-row__desc">{allowed ? entry.description.replace(READS_IMAGES, "") : "Available with Plus or Pro."}</span>
      </span>
      <span className="model-row__meta">
        {vision && <span className="model-row__vision" title="Reads images"><Eye size={14} strokeWidth={1.9} aria-hidden="true" /><span className="sr-only">Reads images</span></span>}
        {!allowed && <span className="model-row__lock"><Lock size={12} strokeWidth={2.2} aria-hidden="true" />Plus</span>}
        {selected && <Check className="model-row__check" size={16} strokeWidth={2.6} aria-hidden="true" />}
      </span>
    </span>
  );
}
const THINKING_MODELS = ["nova", "nebula", "vesper"];
const THINKING_OPTIONS = [
  { value: "normal", label: "Normal", description: "Balanced reasoning for most questions." },
  { value: "low", label: "Low", description: "Think less for a faster response." },
  { value: "high", label: "High", description: "More deliberate reasoning." },
  { value: "xhigh", label: "Extra High", description: "Deep reasoning; uses more output tokens." },
  { value: "max", label: "Maximum", description: "Maximum reasoning; uses more output tokens." },
];

const GREETINGS = ["Good to see you", "Where should we start", "What's on your mind", "The floor is yours", "Ready when you are"];

const RESPONSE_MODES = [
  { value: "concise", label: "Concise", icon: <Sparkles size={19} strokeWidth={1.9} /> },
  { value: "detailed", label: "Detailed", icon: <FileText size={19} strokeWidth={1.9} /> },
  { value: "friendly", label: "Learning", icon: <Brain size={19} strokeWidth={1.9} /> },
];

const PRODUCT_TABS = [
  { value: "chat", label: "Chat" },
  { value: "image", label: "Image" },
  { value: "study", label: "Study" },
];

const TIER_LABEL = { free: "Free", plus: "Plus", pro: "Pro" };

function modelAllowedForTier(model, tier, creditBalance = 0) {
  if (!MODELS.some((entry) => entry.value === model)) return false;
  return tier !== "free" || model === "lumen" || model === "nova";
}

function preferredModelForProfile(preferences, tier, creditBalance = 0) {
  const currentKey = (key) => key === "spark" ? "lumen" : key === "ultra" ? "nebula" : key;
  const candidates = [currentKey(preferences?.preferredModel), currentKey(preferences?.lastUsedModel), "lumen"];
  return candidates.find((model) => modelAllowedForTier(model, tier, creditBalance)) ?? "lumen";
}

function relativeConversationTime(value) {
  const when = new Date(value).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - when) / 1000));
  if (!Number.isFinite(when)) return "Recently";
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}

const MOBILE_PAGE_TITLES = { memory: "Memory", billing: "Plan", usage: "Usage & limits", settings: "Settings" };

const ONBOARDING_PATH = "/onboarding";

// The survey needs no new endpoints: the personality axes become personal
// instructions plus a response style (both already reach the system prompt via
// buildPreferenceSystemPrompt), and the capability answer becomes the stored
// product mode. The existing instructions are read first so a user's own text
// in Settings survives — mergeInstructions only rewrites its own block.
async function persistOnboardingProfile(record) {
  const current = await api("/api/profile/preferences", { cache: "no-store" }).catch(() => null);
  await api("/api/profile/preferences", {
    method: "PATCH",
    body: JSON.stringify({
      responseStyle: responseStyleForPersonality(record.personality),
      customInstructions: mergeInstructions(current?.customInstructions ?? "", record),
    }),
  });
  await api("/api/profile/product-mode", {
    method: "PATCH",
    body: JSON.stringify({ productMode: landingModeFor(record) }),
  });
}

function Workspace({ user, appearance, onSignOut, onDeleted, onLegal }) {
  const [productMode, setProductMode] = useState(() => productModeFromPath(window.location.pathname));
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState("");
  const modeHydrated = useRef(false);
  const modeSessions = useRef({});
  const [page, setPage] = useState(() => {
    const route = settingsRoute(window.location.pathname, window.location.search);
    if (route) return route.page;
    const query = new URLSearchParams(window.location.search);
    if (query.has("credits")) return "usage";
    if (query.has("billing") || query.has("upgraded")) return "billing";
    // /app?delete-account, from the account-deletion page: straight to the
    // confirmation in Settings (after sign-in, which keeps the query).
    if (query.has("delete-account")) return "settings";
    return "chat";
  });
  const [settingsSection, setSettingsSection] = useState(() => settingsRoute(window.location.pathname, window.location.search)?.section ?? "account");
  useEffect(() => {
    const route = settingsRoute(window.location.pathname, window.location.search);
    if (route?.redirect) window.history.replaceState(null, "", route.redirect);
  }, []);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("vibhavgpt-sidebar-collapsed") === "true");
  const [tier, setTier] = useState(null);
  const [chatKey, setChatKey] = useState(0);
  const [lastSelectedModel, setLastSelectedModel] = useState(null);
  const [profileModelReady, setProfileModelReady] = useState(false);
  const [creditBalance, setCreditBalance] = useState(0);
  const [accessNotice, setAccessNotice] = useState(null);
  const usageRequest = useRef(0);
  const [activeConversationId, setActiveConversationId] = useState(() => new URLSearchParams(window.location.search).get("conversation"));
  const [historyRevision, setHistoryRevision] = useState(0);
  // A new chat started from a project or folder's menu. Its first reply files
  // the saved conversation there (saveSession), and until then the request
  // carries the group so a project's instructions apply from the first turn.
  const [pendingGroup, setPendingGroup] = useState(null);
  const pendingGroupRef = useRef(null);
  pendingGroupRef.current = pendingGroup;
  const narrow = useMediaQuery(NARROW_QUERY);
  const workspaceRef = useRef(null);
  const [backgroundTask, setBackgroundTask] = useState(null);
  // An image being made (or finished) while another tab is open.
  const { job: imageJob } = useSyncExternalStore(imageJobs.subscribe, imageJobs.get);
  // Signing out ends this workspace; its image job must not carry over.
  useEffect(() => () => imageJobs.clear(), []);
  const [upgradeConfirmation, setUpgradeConfirmation] = useState(() => new URLSearchParams(window.location.search).get("upgraded") === "true" ? "confirming" : null);
  const [directUpdate, setDirectUpdate] = useState(null);
  // The survey runs in front of the workspace rather than above sign-in, so it
  // can read the account's tier (for the honest credit-cost hints), write the
  // landing tab straight into productMode, and reuse the live appearance.
  const [onboarding, setOnboarding] = useState(() => readOnboarding(user.id));
  const [surveyOpen, setSurveyOpen] = useState(() => !readOnboarding(user.id).onboarding_completed);
  const [surveyToast, setSurveyToast] = useState("");
  const [memoryToast, setMemoryToast] = useState(null);
  const [pendingRecap, setPendingRecap] = useState(null);
  const currentWorkspace = useRef({ productMode, activeConversationId, chatKey });
  currentWorkspace.current = { productMode, activeConversationId, chatKey };

  useDrawerSwipe({ enabled: narrow, open: sidebarOpen, setOpen: setSidebarOpen, rootRef: workspaceRef });

  useEffect(() => {
    let cancelled = false;
    void checkDirectAndroidUpdate().then((release) => {
      if (!cancelled && release) setDirectUpdate(release);
    });
    return () => { cancelled = true; };
  }, []);

  // Android's hardware/gesture Back closes the topmost pop-up (model sheet,
  // menu, dialog), then the phone drawer, before it leaves the page.
  // Registering any listener replaces Capacitor's default handling, so the
  // default (step back through history, else exit) is reproduced here.
  const sidebarOpenRef = useRef(sidebarOpen);
  sidebarOpenRef.current = sidebarOpen;
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined;
    const listener = CapacitorApp.addListener("backButton", ({ canGoBack }) => {
      if (dismissTopOverlay()) return;
      if (sidebarOpenRef.current) setSidebarOpen(false);
      else if (canGoBack) window.history.back();
      else void CapacitorApp.exitApp();
    });
    return () => { void listener.then((handle) => handle.remove()); };
  }, []);

  // The rail is a desktop affordance; the mobile drawer always shows labels.
  const rail = collapsed && !narrow;

  useEffect(() => {
    localStorage.setItem("vibhavgpt-sidebar-collapsed", String(collapsed));
  }, [collapsed]);

  const refreshUsageAccess = useCallback(() => {
    const requestId = ++usageRequest.current;
    return api("/api/usage")
    .then((usage) => {
      if (requestId !== usageRequest.current) return null;
      setTier(usage.tier === "paid" ? "pro" : ["plus", "pro"].includes(usage.tier) ? usage.tier : "free");
      setCreditBalance(usage.creditBalance ?? 0);
      return usage;
    })
    // A failed read is not evidence that a paid user became Free.
    .catch(() => null);
  }, []);

  useEffect(() => {
    const changed = (event) => {
      if (event.detail?.userId && event.detail.userId !== user?.id) return;
      setAccessNotice(null);
      void refreshUsageAccess();
    };
    const access = (event) => setAccessNotice(event.detail);
    window.addEventListener("vibhavgpt:subscription-changed", changed);
    window.addEventListener("vibhavgpt:access-status", access);
    return () => {
      window.removeEventListener("vibhavgpt:subscription-changed", changed);
      window.removeEventListener("vibhavgpt:access-status", access);
    };
  }, [user?.id, refreshUsageAccess]);

  useEffect(() => {
    if (upgradeConfirmation !== "confirming") void refreshUsageAccess();
  }, [refreshUsageAccess, upgradeConfirmation]);

  useEffect(() => {
    if (upgradeConfirmation !== "confirming") return undefined;
    let cancelled = false;
    let timer;
    let attempts = 0;
    const confirmUpgrade = async () => {
      const usage = await refreshUsageAccess();
      if (cancelled) return;
      if (usage && usage.tier !== "free") {
        setUpgradeConfirmation("confirmed");
        const query = new URLSearchParams(window.location.search);
        query.delete("upgraded");
        window.history.replaceState(null, "", `${window.location.pathname}${query.size ? `?${query}` : ""}`);
        return;
      }
      attempts += 1;
      if (attempts >= 10) {
        setUpgradeConfirmation("delayed");
        return;
      }
      timer = setTimeout(confirmUpgrade, 2000);
    };
    void confirmUpgrade();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [refreshUsageAccess, upgradeConfirmation]);

  // Hydrate the model before mounting Chat. Chat's local initial state is
  // Lumen, so mounting it first creates a visible (and occasionally sticky)
  // Lumen fallback while the account preference request is still in flight.
  // The server preference is authoritative for a fresh workspace; an
  // explicit fixed default wins over last-used inside preferredModelForProfile.
  useEffect(() => {
    if (!tier) return undefined;
    let cancelled = false;
    setProfileModelReady(false);
    api("/api/profile/preferences", { cache: "no-store" })
      .then((preferences) => {
        if (!cancelled) {
          setLastSelectedModel(preferredModelForProfile(preferences, tier, creditBalance));
          if (!modeHydrated.current) {
            const explicit = Boolean(settingsRoute(window.location.pathname, window.location.search)) || window.location.pathname.startsWith("/app/study") || window.location.pathname.startsWith("/app/image") || new URLSearchParams(window.location.search).has("conversation");
            const restored = explicit ? productModeFromPath(window.location.pathname) : ["study", "image"].includes(preferences.productMode) ? preferences.productMode : "chat";
            setProductMode(restored);
            // Not while the survey owns the URL: its own answer decides the
            // landing tab, and it rewrites the path on the way out.
            if (!explicit && !window.location.search && window.location.pathname !== ONBOARDING_PATH) {
              window.history.replaceState(null, "", productPath(restored));
            }
            modeHydrated.current = true;
          }
        }
      })
      .catch(() => {
        if (!cancelled) setLastSelectedModel("lumen");
      })
      .finally(() => {
        if (!cancelled) setProfileModelReady(true);
      });
    return () => { cancelled = true; };
  }, [tier, creditBalance]);

  const names = workspaceNames(user, onboarding);
  const { displayName } = names;
  const firstName = names.greetingName;
  const initials = displayName.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  const tierKey = tier ?? "free";

  const go = (next, section = "account") => {
    const path = next === "settings" ? settingsPath(section) : next === "usage" ? "/app/usage" : next === "chat" ? productPath(productMode, activeConversationId) : `/app/${next}`;
    const workspacePath = /^\/app(?:\/(?:chat|study|image))?\/?$/.test(window.location.pathname);
    if ((next !== "chat" || !workspacePath) && window.location.pathname + window.location.search !== path) window.history.pushState(null, "", path);
    if (next === "settings") setSettingsSection(section);
    setPage(next);
    setSidebarOpen(false);
  };
  // "Memory updated" opens a fresh Chat (whatever mode is on screen) that asks
  // what was learned. A one-off navigation: the sticky default mode is kept.
  const openMemoryRecap = (facts) => {
    setMemoryToast(null);
    modeSessions.current.chat = null;
    setProductMode("chat");
    setActiveConversationId(null);
    window.history.pushState(null, "", productPath("chat"));
    setPendingRecap({ text: "What did you learn about me from the memories I just added?", memoryRecap: facts.map((fact) => fact.id) });
    setChatKey((key) => key + 1);
    go("chat");
  };

  const newChat = () => {
    setPendingGroup(null);
    setActiveConversationId(null);
    modeSessions.current[productMode] = null;
    window.history.pushState(null, "", productPath(productMode));
    setChatKey((key) => key + 1);
    go("chat");
  };
  // `mode` defaults to whatever's already active, which is right for every
  // same-mode history click (Chat opening a chat, Study opening a study
  // session). Image's sidebar passes "chat" explicitly: ImageWorkspace has no
  // per-conversation thread view, so reopening one of its past sessions means
  // switching into Chat to view that actual conversation, not staying on the
  // image page. This is a one-off navigation, not a change to the user's
  // sticky default mode, so it updates state directly rather than going
  // through switchMode's /api/profile/product-mode write.
  const newChatInGroup = (group) => {
    newChat();
    setPendingGroup(group);
  };
  // "New Chat" in the Windows desktop app's tray menu (desktop/preload.js).
  const newChatRef = useRef(newChat);
  newChatRef.current = newChat;
  useEffect(() => {
    const onDesktopNewChat = () => newChatRef.current();
    window.addEventListener("desktop:new-chat", onDesktopNewChat);
    return () => window.removeEventListener("desktop:new-chat", onDesktopNewChat);
  }, []);
  const openConversation = (conversationId, mode = productMode) => {
    setPendingGroup(null);
    setActiveConversationId(conversationId);
    modeSessions.current[mode] = conversationId;
    if (mode !== productMode) setProductMode(mode);
    window.history.pushState(null, "", productPath(mode, conversationId));
    setChatKey((key) => key + 1);
    go("chat");
  };

  useEffect(() => {
    const restoreRoute = () => {
      if (window.location.pathname === ONBOARDING_PATH) { setSurveyOpen(true); return; }
      setSurveyOpen(false);
      const route = settingsRoute(window.location.pathname, window.location.search);
      if (route) {
        if (route.redirect) window.history.replaceState(null, "", route.redirect);
        setPage(route.page);
        if (route.page === "chat") {
          setProductMode("chat");
          setActiveConversationId(new URLSearchParams(window.location.search).get("conversation"));
          setChatKey((key) => key + 1);
        }
        if (route.section) setSettingsSection(route.section);
        setSidebarOpen(false);
        return;
      }
      setProductMode(productModeFromPath(window.location.pathname));
      setActiveConversationId(new URLSearchParams(window.location.search).get("conversation"));
      setChatKey((key) => key + 1); setPage("chat"); setSidebarOpen(false);
    };
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, []);

  /* -- Onboarding survey -------------------------------------------------- */

  // The URL follows the survey rather than the other way round, so a reload or
  // a hardware Back press while it is open behaves like any other route.
  useEffect(() => {
    if (surveyOpen && window.location.pathname !== ONBOARDING_PATH) {
      window.history.replaceState(null, "", ONBOARDING_PATH);
    }
  }, [surveyOpen]);

  useEffect(() => {
    if (!surveyToast) return undefined;
    const timer = setTimeout(() => setSurveyToast(""), 6000);
    return () => clearTimeout(timer);
  }, [surveyToast]);

  // Leaving the survey always lands on the answered tab. modeHydrated is set so
  // the profile-preferences effect does not overwrite that with the stored
  // product mode a moment later.
  const leaveSurvey = useCallback((record) => {
    const saved = writeOnboarding(user.id, record);
    setOnboarding(saved);
    setSurveyOpen(false);
    const mode = landingModeFor(saved);
    modeHydrated.current = true;
    setProductMode(mode);
    setPage("chat");
    window.history.replaceState(null, "", productPath(mode));
    return saved;
  }, [user.id]);

  const finishSurvey = useCallback((record) => {
    const saved = leaveSurvey({ ...record, onboarding_completed: true });
    appearance.setAccentId(accentForTheme(saved.theme));
    // The sky question was answered on the last screen, so it is a choice.
    appearance.setThemeId(saved.sky);
    setSurveyToast(`Set up. ${personalityHeadline(saved.personality)}`);
    // Best-effort: the answers are already applied locally, so a failed write
    // must not block the user out of the workspace they just set up. A
    // refused "Call me" name is dropped and the reason shown.
    void persistOnboardingProfile(saved).catch((error) => {
      if (error?.code !== "name-not-allowed") return;
      setOnboarding(writeOnboarding(user.id, { ...saved, preferred_name: "" }));
      setSurveyToast(error.message);
    });
  }, [appearance, leaveSurvey, user.id]);

  // Skipping records that the survey has been seen, so it does not reappear on
  // the next load, but writes nothing to the account: a skip is not an answer.
  const skipSurvey = useCallback(() => {
    leaveSurvey({ ...onboarding, onboarding_completed: true });
  }, [leaveSurvey, onboarding]);

  const rerunSurvey = useCallback(() => {
    window.history.pushState(null, "", ONBOARDING_PATH);
    setSurveyOpen(true);
    setSidebarOpen(false);
  }, []);

  // Tweaking the sliders in Settings takes the same path as finishing the
  // survey, minus the navigation: one mapping, one place it can drift.
  const saveOnboarding = useCallback(async (record) => {
    const saved = writeOnboarding(user.id, record);
    setOnboarding(saved);
    appearance.setAccentId(accentForTheme(saved.theme));
    try {
      await persistOnboardingProfile(saved);
    } catch (error) {
      if (error?.code === "name-not-allowed") setOnboarding(writeOnboarding(user.id, { ...saved, preferred_name: "" }));
      throw error;
    }
  }, [appearance, user.id]);

  async function switchMode(next) {
    if (modeSaving) return;
    setModeSaving(true); setModeError("");
    try {
      await api("/api/profile/product-mode", { method: "PATCH", body: JSON.stringify({ productMode: next }) });
      if (next === productMode) { go("chat"); return; }
      modeSessions.current[productMode] = activeConversationId;
      const id = modeSessions.current[next] ?? null;
      setProductMode(next); setActiveConversationId(id); setChatKey((key) => key + 1);
      window.history.pushState(null, "", productPath(next, id)); go("chat");
    } catch (err) { setModeError(err.message); }
    finally { setModeSaving(false); }
  }
  // Persistent top tabs for the three workspaces (was a dropdown in the
  // drawer head). Tapping the current tab returns to its conversation.
  const activeTab = PRODUCT_TABS.findIndex((tab) => tab.value === productMode);
  const modeTabs = (
    <div className="mode-tabs" role="tablist" aria-label="Workspace" style={{ "--tab-count": PRODUCT_TABS.length, "--tab-index": Math.max(0, activeTab) }}>
      {PRODUCT_TABS.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          className="mode-tabs__tab"
          aria-selected={productMode === tab.value && page === "chat"}
          disabled={modeSaving || !profileModelReady}
          onClick={() => void switchMode(tab.value)}
        >
          {tab.label}
          {tab.value === "image" && imageJob && !(productMode === "image" && page === "chat") && (
            <>
              <span className="mode-tabs__dot" data-state={imageJob.status} aria-hidden="true" />
              <span className="sr-only">{imageJob.status === "generating" ? " (generating)" : imageJob.status === "done" ? " (image ready)" : " (image failed)"}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
  const saveSession = (id, completedInBackground = false) => {
    const group = pendingGroupRef.current;
    if (group && id) {
      setPendingGroup(null);
      api(`/api/chat/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ groupId: group.id }) })
        .then(() => setHistoryRevision((value) => value + 1))
        .catch(() => setModeError(`This chat was saved, but it couldn't be added to ${group.name}. Use Move to… in the sidebar.`));
    }
    setHistoryRevision((value) => value + 1);
    if (!completedInBackground || modeSessions.current[productMode] === activeConversationId) modeSessions.current[productMode] = id;
    // A completed request belongs to its originating workspace, not whichever
    // mode the user navigated to while it was running.
    if (currentWorkspace.current.productMode !== productMode || currentWorkspace.current.chatKey !== chatKey || !/^\/app(?:\/(?:chat|study|image))?\/?$/.test(window.location.pathname)) return;
    setActiveConversationId(id);
    window.history.replaceState(null, "", productPath(productMode, id));
    if (completedInBackground && page === "chat") setChatKey((key) => key + 1);
  };
  // Phone header title off the chat screen, where the workspace tabs sit.
  const mobileTitle = MOBILE_PAGE_TITLES[page] ?? "Settings";

  // Each screen change slides in on phones: sub-pages arrive from the right,
  // returning to the conversation arrives from the left. The direction is
  // decided when the screen key changes and remembered for re-renders.
  const screenKey = page === "chat" ? `chat:${productMode}:${chatKey}` : page;
  useEffect(() => { if (page !== "chat") resetPageScroll(); }, [page, settingsSection]);
  const screenDepth = page === "chat" ? 0 : 1;
  const lastScreen = useRef({ key: screenKey, depth: screenDepth, direction: "none" });
  if (lastScreen.current.key !== screenKey) {
    const direction = screenDepth < lastScreen.current.depth ? "back" : "forward";
    lastScreen.current = { key: screenKey, depth: screenDepth, direction };
  }

  // Full-bleed and ahead of the workspace shell: one idea per screen means no
  // sidebar, tabs, or composer competing with the question.
  if (surveyOpen) {
    return (
      <Onboarding
        // The sky starts as whatever the reader sees now, so a re-run from
        // Settings never flips Daybreak back to night by default.
        initial={{ ...onboarding, sky: appearance.resolved, preferred_name: names.surveyName }}
        tier={tierKey}
        onFinish={finishSurvey}
        onSkip={skipSurvey}
        onPreviewTheme={(theme) => appearance.setAccentId(accentForTheme(theme))}
        onPreviewSky={(sky) => document.documentElement.setAttribute("data-theme", sky)}
      />
    );
  }

  const renderChat = (studyProps = {}) => <Chat key={chatKey} userName={firstName} tier={tier} creditBalance={creditBalance} initialConversationId={activeConversationId} initialModel={lastSelectedModel} onModelChange={setLastSelectedModel} onUsageChanged={refreshUsageAccess} onOpenSettings={() => go("settings")} onConversationSaved={saveSession} onBackgroundTask={setBackgroundTask} autoPrompt={pendingRecap} onAutoPromptSent={() => setPendingRecap(null)} group={pendingGroup} {...studyProps} />;

  return (
    <div className="workspace" ref={workspaceRef} data-collapsed={rail} data-page={page}>
      <Sidebar
        variant={productMode}
        api={api}
        user={user}
        appearance={appearance}
        rail={rail}
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        setCollapsed={setCollapsed}
        // The wordmark goes home: a bare / is the public homepage.
        brand={<a className="brand sidebar__brand" href="/" aria-label="VibhavGPT home"><img src={BRAND_ICON} alt="" /><span>VibhavGPT</span></a>}
        tierKey={tier === null ? "checking" : tierKey}
        tierLabel={tier === null ? "Checking" : TIER_LABEL[tierKey]}
        page={page}
        go={go}
        newChat={newChat}
        newChatInGroup={newChatInGroup}
        openConversation={openConversation}
        onOpenImageSession={(id) => openConversation(id, "chat")}
        activeConversationId={activeConversationId}
        historyRevision={historyRevision}
        onSignOut={onSignOut}
      />

      {/* Always mounted so it can fade out as well as in, and so a swipe can
          drive its opacity while the drawer follows the finger. */}
      <button
        className="scrim-mobile"
        type="button"
        data-open={sidebarOpen || undefined}
        tabIndex={sidebarOpen ? 0 : -1}
        aria-hidden={!sidebarOpen}
        onClick={() => setSidebarOpen(false)}
        aria-label="Close navigation"
      />

      <div className="workspace__main" data-product-mode={page === "chat" ? productMode : undefined}>
        <AccessNotice access={accessNotice} onAction={(action) => {
            if (action === "plans" || action === "restore") go("billing");
            else if (action === "credits" || action === "usage") go("usage");
            else if (action === "storage") go("chat");
            else if (action === "support") window.location.assign("mailto:support@pansophy.com");
            else setAccessNotice(null);
          }} onDismiss={() => setAccessNotice(null)} />
        {page === "chat" && <div className="mode-tabs-bar">{modeTabs}</div>}
        {modeError && <p className="banner banner--error" role="alert">{modeError}</p>}
        {upgradeConfirmation === "confirming" && <p className="banner" role="status">Confirming your plan…</p>}
        {upgradeConfirmation === "confirmed" && <p className="banner" role="status">Your new plan is ready to use.</p>}
        {upgradeConfirmation === "delayed" && <p className="banner banner--error" role="status">Your payment is still being confirmed. Refresh this page in a minute. If your plan has not changed, email support@pansophy.com.</p>}
        {directUpdate && (
          <div className="banner direct-update" role="status">
            <span><strong>VibhavGPT {directUpdate.versionName} is available.</strong>{directUpdate.releaseNotes ? ` ${directUpdate.releaseNotes}` : ""}</span>
            <a className="btn btn--secondary" href={directUpdate.downloadPage || "/android"} target="_blank" rel="noreferrer">View update</a>
            <button className="btn btn--quiet" type="button" aria-label="Dismiss update notice" onClick={() => setDirectUpdate(null)}>Dismiss</button>
          </div>
        )}
        <DesktopUpdateBanner />
        {backgroundTask && page !== "chat" && (
          <div className="background-task" role="status">
            <strong>{backgroundTask.label}</strong>
            <span>{backgroundTask.detail}</span>
          </div>
        )}
        <header className="topbar-mobile">
          <IconButton label="Open navigation" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}><MenuIcon size={21} strokeWidth={1.9} /></IconButton>
          {page === "chat" ? modeTabs : <h1 className="topbar-mobile__title">{mobileTitle}</h1>}
          <IconButton label={productMode === "study" ? "New study session" : "New chat"} onClick={newChat}><SquarePen size={20} strokeWidth={1.9} /></IconButton>
        </header>

        <div className="screen" key={screenKey} data-direction={lastScreen.current.direction}>
        {page === "chat" && !profileModelReady ? (
          <main className="page page--centered"><TypingDots label="Opening your workspace" /></main>
        ) : page === "chat" ? (
          productMode === "image" ? <ImageWorkspace api={api} />
          : renderChat({ mode: productMode })
        ) : page === "memory" ? (
          <Memory onMemoriesAdded={(added) => setMemoryToast(added)} />
        ) : page === "billing" ? (
          <Billing tier={tier} userId={user.id} onEntitlementChanged={refreshUsageAccess} />
        ) : page === "usage" ? (
          <UsageDashboard onOpenSettings={() => go("settings")} onLegal={onLegal} />
        ) : (
          <Settings
            section={settingsSection}
            onSectionChange={(section) => go("settings", section)}
            user={user}
            appearance={appearance}
            tier={tierKey}
            creditBalance={creditBalance}
            onDeleted={onDeleted}
            onLegal={onLegal}
            onOpenUsage={() => go("usage")}
            onOpenBilling={() => go("billing")}
            onboarding={onboarding}
            onSaveOnboarding={saveOnboarding}
            onRerunOnboarding={rerunSurvey}
          />
        )}
        </div>
      </div>

      {memoryToast?.length > 0 && (
        <MemoryUpdatedToast facts={memoryToast} onOpen={() => openMemoryRecap(memoryToast)} onDismiss={() => setMemoryToast(null)} />
      )}
      {surveyToast && (
        <output className="survey-toast">
          <Check size={15} strokeWidth={2.4} aria-hidden="true" />
          <span>{surveyToast}</span>
        </output>
      )}
    </div>
  );
}

function CodeBlock({ inline, className, children, ...props }) {
  const [copied, setCopied] = useState(false);

  if (inline) {
    return <code className={className} {...props}>{children}</code>;
  }

  const code = isValidElement(children) ? children : Children.toArray(children)[0];
  if (!isValidElement(code)) {
    return <code className={className} {...props}>{children}</code>;
  }

  const language = code.props.className?.match(/language-([\w-]+)/)?.[1] ?? "text";
  const text = String(code.props.children ?? "").replace(/\n$/, "");

  return (
    <div className="code-block">
      <div className="code-block__header">
        <span className="code-block__language">{language}</span>
        <button
          type="button"
          className="code-block__copy"
          onClick={async () => {
            if (await copyText(text)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }
          }}
        >
          {copied ? <Check size={14} strokeWidth={2.3} /> : <Copy size={14} strokeWidth={1.9} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre><code className={code.props.className}>{code.props.children}</code></pre>
    </div>
  );
}

function AssistantBody({ text, animate, onTick }) {
  const { shown, done } = useTypewriter(text, { enabled: animate, onTick });
  // Models sometimes use HTML line-break tags. Convert only that harmless
  // formatting shorthand to Markdown before rendering; do not enable raw HTML
  // from model output in the DOM.
  const rendered = protectPlainDollarSigns(normalizeTexDelimiters(shown).replace(/<br\s*\/?\s*>/gi, "  \n"));
  return (
    <div className="prose" data-typing={animate && !done ? "true" : undefined}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }] ]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a: ({ href, children }) => <ResourceLink href={href}>{children}</ResourceLink>,
          code: CodeBlock,
          img: ({ src, alt }) => <PrivateImage src={src} alt={alt} />,
          pre: CodeBlock,
          // Wide tables scroll inside the column instead of widening the page.
          table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
        }}
      >
        {rendered}
      </ReactMarkdown>
    </div>
  );
}

function CopyButton({ text }) {
  // A clipboard write can be refused, so the button reports what actually
  // happened instead of always claiming success.
  const [state, setState] = useState("idle");
  useEffect(() => {
    if (state === "idle") return undefined;
    const timer = setTimeout(() => setState("idle"), 1800);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <IconButton
      label={state === "done" ? "Copied" : state === "failed" ? "Couldn't copy. Select the text instead." : "Copy reply"}
      tone={state === "failed" ? "danger" : "default"}
      onClick={async () => setState((await copyText(text)) ? "done" : "failed")}
    >
      {state === "done" ? (
        <Check size={15} strokeWidth={2.4} />
      ) : state === "failed" ? (
        <X size={15} strokeWidth={2.4} />
      ) : (
        <Copy size={15} strokeWidth={1.9} />
      )}
    </IconButton>
  );
}

function Chat({ userName, tier = "free", creditBalance = 0, initialConversationId = null, initialModel = null, onModelChange, onUsageChanged, onOpenSettings, onConversationSaved, onBackgroundTask, mode = "chat", autoPrompt = null, onAutoPromptSent, group = null }) {
  const [model, setModel] = useState(initialModel || "lumen");
  const studyMode = mode === "study";
  const sentModel = studyMode ? STUDY_MODEL : model;
  const [messages, setMessages] = useState([]);
  const [conversationId, setConversationId] = useState(initialConversationId);
  // Shown in the header once a saved conversation loads; a new chat's first
  // reply does not return its title, so it keeps the generic label.
  const [loadingConversation, setLoadingConversation] = useState(Boolean(initialConversationId));
  const [draft, setDraft] = useState("");
  // Counts sends; the composer's data-send-pulse flips with it so its pop
  // (desktop.css, Windows app only) restarts on every send.
  const [sendPulse, setSendPulse] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const activeRequestRef = useRef(null);
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [uploadLimits, setUploadLimits] = useState(null);
  const [activity, setActivity] = useState("");
  // The reply as it streams in, shown until the saved reply replaces it.
  const [streamText, setStreamText] = useState("");
  const [livePhase, setLivePhase] = useState({ phase: "thinking", startedAt: 0 });
  // The model's thinking for the reply in progress: shown live, never saved.
  const [liveReasoning, setLiveReasoning] = useState("");
  const [liveThought, setLiveThought] = useState(null);
  const [liveSources, setLiveSources] = useState([]);
  const narrow = useMediaQuery(NARROW_QUERY);
  // Phone composer sheets: "add" is the "+" sheet; "model" and "effort" are
  // opened from it. Only one is open at a time.
  const [sheet, setSheet] = useState(null);
  const closeSheet = useCallback(() => setSheet(null), []);
  const [scrolled, setScrolled] = useState(false);
  const [failed, setFailed] = useState(null);
  const [codingNudge, setCodingNudge] = useState(false);
  // Messages sent while a reply is still coming in. They wait here, visible in
  // the thread, and go out one at a time, in order, once the reply is done.
  const [queue, setQueue] = useState([]);
  const queueId = useRef(0);
  const [greeting] = useState(() => {
    const choices = mode === "study" ? STUDY_TAGLINES : GREETINGS;
    return choices[Math.floor(Math.random() * choices.length)];
  });

  const scrollRef = useRef(null);
  const endRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const mountedRef = useRef(true);
  // Text already in the field when dictation started; what's heard is
  // appended to it, so speaking never erases what was typed.
  const dictationBaseRef = useRef("");
  const dictation = useDictation({
    onTranscript: (spoken) => setDraft(joinDictation(dictationBaseRef.current, spoken)),
    onError: (message) => setError(message),
  });
  const [quickPreferences, setQuickPreferences] = useState({ responseStyle: "balanced", customInstructions: "", thinkingEffort: "normal" });
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  // Keep the server's explicit preferred default separate from the transient
  // last-used model. A model-picker change must not silently erase a fixed
  // default selected in Settings.
  const preferredModelRef = useRef(undefined);

  const modelInfo = MODELS.find((entry) => entry.value === model) ?? MODELS[0];
  const modelOptions = MODELS.map((entry) => {
    const allowed = modelAllowedForTier(entry.value, tier, creditBalance);
    return {
      ...entry,
      icon: <Sparkles size={14} strokeWidth={1.9} />,
      disabled: !allowed,
      description: allowed ? entry.description : "Available with Plus or Pro.",
      badges: allowed ? entry.badges : [...entry.badges, { label: "Plus", tone: "premium" }],
    };
  });
  const initialThread = useRef(initialConversationId);

  useEffect(() => {
    let cancelled = false;
    if (!initialThread.current) {
      setLoadingConversation(false);
      return undefined;
    }
    setLoadingConversation(true);
    api(`/api/chat/conversations/${initialThread.current}`)
      .then((result) => {
        if (cancelled) return;
        setConversationId(result.conversation.id);
        const restoredModel = result.conversation.model === "spark" ? "lumen" : result.conversation.model;
        const conversationModel = modelAllowedForTier(restoredModel, tier, creditBalance) ? restoredModel : "lumen";
        setModel(conversationModel);
        onModelChange?.(conversationModel);
        setMessages((result.history ?? []).map((message) => ({
          role: message.role,
          content: message.content,
          attachment: message.attachment ?? null,
          sources: message.sources ?? [],
          activitySummary: message.activitySummary ?? [],
          thoughtSeconds: message.thoughtSeconds ?? null,
          createdAt: message.createdAt,
          fresh: false,
        })));
      })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoadingConversation(false); });
    return () => { cancelled = true; };
  }, [onModelChange]);
  const stickToBottom = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    // Only follow the reveal while the reader is already at the end.
    if (node.scrollHeight - node.scrollTop - node.clientHeight < 220) {
      node.scrollTop = node.scrollHeight;
    }
  }, []);
  useEffect(() => { if (streamText) stickToBottom(); }, [streamText, stickToBottom]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, busy]);

  useEffect(() => {
    api("/api/uploads/limits").then(setUploadLimits).catch(() => null);
  }, []);

  // The same material strip serves ordinary chats and legacy Study sessions.
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    api(`/api/chat/conversations/${conversationId}/materials`).then((result) => {
      if (!cancelled) setMaterials(result.materials ?? []);
    }).catch((error) => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, [conversationId, messages.length]);

  // These are the same account-wide preferences shown in Settings. Keeping the
  // current custom instructions in the PATCH prevents a quick style change from
  // accidentally clearing them. Workspace owns the initial model hydration;
  // Chat intentionally never sets it from this second preference read.
  useEffect(() => {
    let cancelled = false;
    api("/api/profile/preferences", { cache: "no-store" })
      .then((preferences) => {
        if (cancelled) return;
        setQuickPreferences({
          responseStyle: preferences.responseStyle ?? "balanced",
          customInstructions: preferences.customInstructions ?? "",
          thinkingEffort: preferences.thinkingEffort ?? "normal",
        });
        preferredModelRef.current = preferences.preferredModel ?? null;
        setPreferencesLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setPreferencesLoaded(true);
      });
    return () => { cancelled = true; };
  }, [initialConversationId, initialModel, tier, creditBalance]);

  // Grow the composer with its content instead of scrolling a one-line box.
  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [draft]);

  const attachmentLabel = uploadLimits
    ? `${TIER_LABEL[uploadLimits.tier] ?? "Free"}: up to ${Math.round(uploadLimits.fileBytes / 1024 / 1024)} MB per file`
    : "Attach files";
  const hasImages = attachments.some((attachment) => attachment.file.type.startsWith("image/"));
  const visionModelRequired = !studyMode && hasImages && !VISION_MODELS.includes(model);

  function addAttachmentFiles(files) {
    const chosen = Array.from(files ?? []).map((file) => ({
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    }));
    if (!chosen.length) return;
    const next = [...attachments, ...chosen];
    if (next.length > 3) {
      setError("You can attach up to 3 files to one message.");
      return;
    }
    if (uploadLimits) {
      const total = next.reduce((sum, attachment) => sum + attachment.file.size, 0);
      if (next.some((attachment) => attachment.file.size > (attachment.file.type.startsWith("image/") ? uploadLimits.imageBytes : uploadLimits.fileBytes))) {
        setError("One or more files exceed your plan's per-file limit.");
        return;
      }
      if (total > uploadLimits.messageBytes) {
        setError(`Attachments for one message are limited to ${Math.round(uploadLimits.messageBytes / 1024 / 1024)} MB on your plan.`);
        return;
      }
    }
    setError("");
    setAttachments(next);
  }

  function chooseAttachments(event) {
    addAttachmentFiles(event.target.files);
    event.target.value = "";
  }

  function handlePaste(event) {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    addAttachmentFiles(files);
  }

  function removeAttachment(index) {
    setAttachments((files) =>
      files.filter((attachment, fileIndex) => {
        if (fileIndex === index) URL.revokeObjectURL(attachment.previewUrl);
        return fileIndex !== index;
      }),
    );
  }

  async function changeModel(nextModel) {
    if (modelSaving || busyRef.current || nextModel === model) return;
    if (!modelAllowedForTier(nextModel, tier, creditBalance)) {
      const access = accessStatus({ reason: "plan", feature: MODELS.find((entry) => entry.value === nextModel)?.label ?? "This model" });
      setError(access.message);
      window.dispatchEvent(new CustomEvent("vibhavgpt:access-status", { detail: access }));
      return;
    }
    const previousModel = model;
    setModelSaving(true);
    setModel(nextModel);
    onModelChange?.(nextModel);
    setError("");
    // Use the same full preference upsert as Settings. Preserve an explicit
    // fixed default; when Settings is in Last-used mode, preferredModel is
    // null and the remembered model is what the next session restores.
    const payload = { ...quickPreferences, lastUsedModel: nextModel };
    if (preferredModelRef.current !== undefined) payload.preferredModel = preferredModelRef.current;
    let conversationSaved = false;
    try {
      if (conversationId) {
        await api(`/api/chat/conversations/${conversationId}`, {
          method: "PATCH",
          body: JSON.stringify({ model: nextModel }),
        });
        conversationSaved = true;
      }
      await api("/api/profile/preferences", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    } catch (preferenceError) {
      if (!conversationSaved) {
        setModel(previousModel);
        onModelChange?.(previousModel);
        setError(preferenceError.message || "We couldn't remember that model.");
      } else {
        setError(`This conversation is using ${MODELS.find((entry) => entry.value === nextModel)?.label ?? "the selected model"}. We couldn't update your default model, but the conversation is saved.`);
      }
    } finally {
      setModelSaving(false);
    }
  }

  async function changeResponseStyle(responseStyle) {
    if (mode === "study") return;
    if (!preferencesLoaded) return;
    const previous = quickPreferences;
    const next = { ...previous, responseStyle };
    setQuickPreferences(next);
    setError("");
    try {
      const saved = await api("/api/profile/preferences", {
        method: "PATCH",
        body: JSON.stringify(next),
      });
      setQuickPreferences({
        responseStyle: saved.responseStyle ?? responseStyle,
        customInstructions: saved.customInstructions ?? previous.customInstructions,
        thinkingEffort: saved.thinkingEffort ?? previous.thinkingEffort,
      });
    } catch (preferenceError) {
      setQuickPreferences(previous);
      setError(preferenceError.message || "We couldn't update your response mode.");
    }
  }

  function applyStarter(text) {
    setDraft(text);
    requestAnimationFrame(() => {
      const node = inputRef.current;
      node?.focus();
      node?.setSelectionRange(text.length, text.length);
    });
  }

  // Delivery is separate from send so a failed attempt can be replayed without
  // appending the user's message to the thread a second time.
  async function deliver(content, selectedAttachments) {
    if (busyRef.current) return;
    setCodingNudge(mode === "chat" && shouldSuggestNebula(content, sentModel, selectedAttachments.length));
    busyRef.current = true;
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setBusy(true);
    setError("");
    setLiveSources([]);
    setActivity(selectedAttachments.length ? "Thinking" : "Thinking");
    onBackgroundTask?.({ label: "Thinking", detail: selectedAttachments.length ? "Reading your files and preparing a reply." : "Preparing a reply in the background." });
    let uploaded = [];
    let visibleStream = "";
    let previousStream = "";
    let currentPhase = selectedAttachments.length ? "attachments" : "thinking";
    let thinkingStartedAt = Date.now();
    let reasoningSoFar = "";
    setLivePhase({ phase: currentPhase, startedAt: thinkingStartedAt });
    setLiveReasoning("");
    setLiveThought(null);
    try {
      if (selectedAttachments.length) {
        const formData = new FormData();
        selectedAttachments.forEach((attachment) => formData.append("files", attachment.file));
        const result = await api("/api/uploads", { method: "POST", body: formData, signal: controller.signal });
        uploaded = result.attachments;
      }
      // The server searches the web on its own when a question needs it and
      // reports "searching" as it does (see the status handler below).
      setActivity("Thinking");
      setStreamText("");
      currentPhase = "thinking";
      thinkingStartedAt = Date.now();
      setLivePhase({ phase: currentPhase, startedAt: thinkingStartedAt });
      let streamedAny = false;
      const reply = await streamChat(
        {
          message: content,
          model: sentModel,
          conversationId,
          mode,
          ...(group && !conversationId ? { groupId: group.id } : {}),
          ...(recapRef.current ? { memoryRecap: recapRef.current } : {}),
          attachmentIds: uploaded.map((file) => file.id),
          // Send the currently selected mode with this turn as well as saving
          // it in Settings. This avoids a PATCH/send race when someone changes
          // the mode and immediately sends their next message.
          responseStyle: mode === "study" ? "friendly" : quickPreferences.responseStyle,
          thinkingEffort: quickPreferences.thinkingEffort,
        },
        (phase, details) => {
          if (mountedRef.current && details?.sources) setLiveSources(details.sources);
          const next = phase === "searching" ? "Searching the web" : phase === "calculating" ? "Calculating" : phase === "writing" ? "Writing" : "Thinking";
          if (mountedRef.current) setActivity(next);
          if (phase !== currentPhase) {
            currentPhase = phase;
            if (phase === "thinking") thinkingStartedAt = Date.now();
          }
          if (mountedRef.current) setLivePhase({ phase, attempt: details?.attempt, maxAttempts: details?.maxAttempts, startedAt: thinkingStartedAt });
          onBackgroundTask?.({ label: next === "Writing" ? "Writing your document" : next, detail: phase === "searching" ? "Checking web sources for up-to-date information." : phase === "calculating" ? "Running the calculation in an isolated sandbox." : phase === "writing" ? "Writing your document. Longer documents take up to a minute." : "Preparing a reply in the background." });
        },
        {
          signal: controller.signal,
          // A first message's conversation exists before the reply does, so
          // a failed reply's Retry (and the next message) continue it
          // instead of starting another.
          onConversation: (saved) => {
            if (!saved?.conversationId || saved.conversationId === conversationId) return;
            setConversationId(saved.conversationId);
            onConversationSaved?.(saved.conversationId, !mountedRef.current);
          },
          onDelta: (delta) => {
            if (!mountedRef.current) return;
            if (typeof delta.reasoning === "string") {
              reasoningSoFar += delta.reasoning;
              setLiveReasoning(reasoningSoFar);
              if (currentPhase !== "thinking") {
                currentPhase = "thinking";
                thinkingStartedAt = Date.now();
                setLivePhase({ phase: currentPhase, startedAt: thinkingStartedAt });
              }
              return;
            }
            if (delta.reasoningReset) { reasoningSoFar = ""; setLiveReasoning(""); return; }
            // A withdrawn stream was the model's reasoning: keep no copy of it,
            // so a failed reply can never show it as a partial answer.
            if (delta.reset) { previousStream = delta.withdraw ? "" : (visibleStream || previousStream); visibleStream = ""; setStreamText(""); return; }
            if (typeof delta.text !== "string") return;
            if (!streamedAny && reasoningSoFar) setLiveThought(elapsedSeconds(thinkingStartedAt));
            streamedAny = true;
            visibleStream += delta.text;
            setStreamText((current) => current + delta.text);
          },
        },
      );
      if (mountedRef.current) setActivity("Almost done");
      onBackgroundTask?.({ label: "Almost done", detail: "Saving the completed response to this conversation." });
      await new Promise((resolve) => setTimeout(resolve, 240));
      setConversationId(reply.conversationId);
      onConversationSaved?.(reply.conversationId, !mountedRef.current);
      if (mountedRef.current) setMessages((current) => [
        ...current,
        // A reply already read as it streamed isn't typed out a second time.
        { role: "assistant", content: reply.reply, sources: reply.sources ?? [], activitySummary: reply.activitySummary ?? [], attachment: reply.attachment ?? null, model: reply.model ?? modelInfo.full, fresh: !streamedAny,
          // No shown thinking (empty, or all rule-checking that was scrubbed):
          // no "Thought for X s" pill or drawer for this reply.
          reasoning: reasoningSoFar.trim() ? reasoningSoFar : undefined, thoughtSeconds: reasoningSoFar.trim() ? (reply.thoughtSeconds ?? null) : null },
      ]);
      if (mountedRef.current) { setStreamText(""); setLiveReasoning(""); setLiveThought(null); }
      selectedAttachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
      if (mountedRef.current) setFailed(null);
    } catch (err) {
      if (mountedRef.current) {
        const partial = interruptedStreamMessage(visibleStream || previousStream, modelInfo.full);
        if (partial) setMessages((current) => [...current, partial]);
        setError(err.access?.reason === "quota" ? "" : err.message);
      }
      // Keep the attempt so the banner can offer a retry; without this the
      // message is stranded in the thread with no reply and no way back.
      if (mountedRef.current) setFailed({ content, attachments: selectedAttachments });
      await Promise.all(uploaded.map((file) => api(`/api/uploads/${file.id}`, { method: "DELETE" }).catch(() => null)));
    } finally {
      busyRef.current = false;
      if (activeRequestRef.current === controller) activeRequestRef.current = null;
      // Refresh after both a successful reservation and an automatic refund so
      // Free users' paid-model availability always reflects the real balance.
      void onUsageChanged?.();
      if (mountedRef.current) {
        setBusy(false);
        setActivity("");
        setStreamText("");
        setLiveReasoning("");
        setLiveThought(null);
      }
      onBackgroundTask?.(null);
    }
  }

  // Opened from "Memory updated": send the question once, with the ids of the
  // facts just imported so the reply can say what was learned from them.
  const recapRef = useRef(null);
  const autoPromptSent = useRef(false);
  useEffect(() => {
    if (!autoPrompt || autoPromptSent.current) return;
    autoPromptSent.current = true;
    recapRef.current = autoPrompt.memoryRecap ?? null;
    setMessages((current) => [...current, { role: "user", content: autoPrompt.text }]);
    void deliver(autoPrompt.text, []).finally(() => { recapRef.current = null; });
    onAutoPromptSent?.();
  // Runs once per opened recap; deliver reads current state through refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPrompt]);

  async function send(event) {
    event.preventDefault();
    const content = draft.trim();
    if (!content && attachments.length === 0) {
      inputRef.current?.focus();
      return;
    }
    if (visionModelRequired) {
      setError("Choose a model that supports images to ask about an image.");
      return;
    }
    const selectedAttachments = attachments;
    if (dictation.listening) dictation.stop();
    setSendPulse((count) => count + 1);
    setDraft("");
    setAttachments([]);
    // A reply is still coming in: queue this one instead. The stream is left
    // alone; the queue only moves once the current reply has finished.
    if (busyRef.current || busy) {
      queueId.current += 1;
      setQueue((current) => [...current, { id: queueId.current, content, attachments: selectedAttachments }]);
      requestAnimationFrame(() => stickToBottom());
      return;
    }
    await startTurn(content, selectedAttachments);
  }

  function startTurn(content, selectedAttachments) {
    setFailed(null);
    setMessages((current) => [
      ...current,
      {
        role: "user",
        content: content || "Attached file(s)",
        attachments: selectedAttachments.map((attachment) => ({
          name: attachment.file.name,
          image: attachment.file.type.startsWith("image/"),
        })),
      },
    ]);
    return deliver(content, selectedAttachments);
  }

  function removeQueued(id) {
    setQueue((current) => {
      const removed = current.find((item) => item.id === id);
      removed?.attachments.forEach((attachment) => attachment.previewUrl && URL.revokeObjectURL(attachment.previewUrl));
      return current.filter((item) => item.id !== id);
    });
  }

  // When a reply finishes, the next queued message goes out. A failed reply
  // pauses the queue until it's retried or dismissed, so nothing jumps ahead
  // of a message that didn't get an answer.
  useEffect(() => {
    if (busy || busyRef.current || failed || !queue.length) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void startTurn(next.content, next.attachments);
  // startTurn reads current state; the queue moves only on these changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queue, failed]);

  async function changeThinkingEffort(thinkingEffort) {
    if (!preferencesLoaded) return;
    const previous = quickPreferences;
    const next = { ...previous, thinkingEffort };
    setQuickPreferences(next);
    setError("");
    try {
      const saved = await api("/api/profile/preferences", {
        method: "PATCH",
        body: JSON.stringify(next),
      });
      setQuickPreferences({
        responseStyle: saved.responseStyle ?? previous.responseStyle,
        customInstructions: saved.customInstructions ?? previous.customInstructions,
        thinkingEffort: saved.thinkingEffort ?? thinkingEffort,
      });
    } catch (preferenceError) {
      setQuickPreferences(previous);
      setError(preferenceError.message || "We couldn't update your thinking effort.");
    }
  }

  const empty = !loadingConversation && messages.length === 0;
  const effortApplies = tier !== "free" && THINKING_MODELS.includes(sentModel);

  // Composer parts, shared by the desktop bar and the phone pill so the two
  // layouts cannot drift apart in behaviour, only in arrangement.
  const composerInput = (
    <textarea
      ref={inputRef}
      className="composer__input"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onPaste={handlePaste}
      onKeyDown={(event) => {
        // Enter sends; Shift+Enter keeps the native newline.
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void send({ preventDefault() {} });
        }
      }}
      placeholder={narrow ? "Ask anything" : studyMode ? "Message VibhavGPT…" : `Message ${modelInfo.full}…`}
      aria-label={narrow ? (studyMode ? "Message VibhavGPT" : `Message ${modelInfo.full}`) : undefined}
      rows="1"
    />
  );
  const attachmentTray = attachments.length > 0 && (
    <div className="tray" aria-label="Files attached to your next message">
      {attachments.map((attachment, index) => (
        <span className="tray__item" key={`${attachment.file.name}-${attachment.file.lastModified}`}>
          {attachment.previewUrl ? (
            <img src={attachment.previewUrl} alt="" />
          ) : (
            <FileText size={13} />
          )}
          {attachment.file.name}
          <button type="button" onClick={() => removeAttachment(index)} aria-label={`Remove ${attachment.file.name}`}>
            <X size={12} strokeWidth={2.4} />
          </button>
        </span>
      ))}
      {uploadLimits && <small>{attachmentLabel}</small>}
    </div>
  );
  const addMenu = (
    <Menu
      label="Add to message"
      placement="top"
      className="composer__add"
      trigger={({ ref, open, toggle }) => (
        <button
          ref={ref}
          type="button"
          className="composer__add-trigger"
          aria-label="Add to message"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
        >
          <Plus size={19} strokeWidth={2} />
        </button>
      )}
    >
      <MenuLabel>Add to message</MenuLabel>
      <MenuItem icon={<ImageIcon size={16} />} description="Images from your device" onSelect={() => imageInputRef.current?.click()}>Photos</MenuItem>
      <MenuItem icon={<FileText size={16} />} description="PDF, Word, text, CSV or JSON" onSelect={() => fileInputRef.current?.click()}>Files</MenuItem>
      {mode !== "study" && <>
      <MenuSeparator />
      <MenuLabel>Response mode</MenuLabel>
      <MenuItem icon={<Sparkles size={16} />} description="Short, direct answers" selected={quickPreferences.responseStyle === "concise"} onSelect={() => changeResponseStyle("concise")} disabled={busy || !preferencesLoaded}>Concise</MenuItem>
      <MenuItem icon={<FileText size={16} />} description="Thorough context and examples" selected={quickPreferences.responseStyle === "detailed"} onSelect={() => changeResponseStyle("detailed")} disabled={busy || !preferencesLoaded}>Detailed</MenuItem>
      <MenuItem icon={<Brain size={16} />} description="Step by step, beginner-friendly" selected={quickPreferences.responseStyle === "friendly"} onSelect={() => changeResponseStyle("friendly")} disabled={busy || !preferencesLoaded}>Learning</MenuItem>
      <MenuItem icon={<SettingsIcon size={16} />} description="Your own instructions in Settings" trailing={<ChevronRight className="ui-menu__chevron" size={15} aria-hidden="true" />} onSelect={onOpenSettings}>Custom</MenuItem>
      </>}
    </Menu>
  );
  const addSheetButton = (
    <button
      type="button"
      className="composer__add-trigger"
      aria-label="Add to message"
      aria-haspopup="dialog"
      aria-expanded={sheet === "add"}
      onClick={() => setSheet("add")}
    >
      <Plus size={19} strokeWidth={2} />
    </button>
  );
  const imageInput = (
    <input
      ref={imageInputRef}
      type="file"
      style={{ display: "none" }}
      multiple
      accept=".jpg,.jpeg,.png,.gif,.webp,image/jpeg,image/png,image/gif,image/webp"
      onChange={chooseAttachments}
    />
  );
  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      style={{ display: "none" }}
      multiple
      accept=".pdf,.docx,.txt,.md,.csv,.json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/csv,application/json"
      onChange={chooseAttachments}
    />
  );
  const fileInputs = <>{imageInput}{fileInput}</>;
  const micButton = dictation.supported && (
    <button
      type="button"
      className="composer__mic"
      aria-label={dictation.listening ? "Stop dictation" : "Dictate a message"}
      title={dictation.listening ? "Stop dictation" : "Dictate a message"}
      aria-pressed={dictation.listening}
      onClick={() => {
        if (dictation.listening) {
          dictation.stop();
          inputRef.current?.focus();
          return;
        }
        setError("");
        dictationBaseRef.current = draft;
        dictation.start();
      }}
    >
      <Mic size={18} strokeWidth={2} />
    </button>
  );
  const sendButton = (
    <button className="composer__send" aria-label={busy ? "Add to queue" : "Send message"} title={busy ? "Add to queue" : "Send message"} disabled={!draft.trim() && !attachments.length}>
      <ArrowUp size={18} strokeWidth={2.4} />
    </button>
  );

  return (
    <section className="chat" data-scrolled={scrolled}>
      <div
        className="chat__scroll"
        data-empty={empty || undefined}
        ref={scrollRef}
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 6)}
      >
        {loadingConversation ? (
          <div className="chat__loading"><TypingDots label="Loading conversation" /></div>
        ) : empty ? (
          <div className="opening">
            <div className="opening__planet" aria-hidden="true"><img src={mode === "study" ? "/planets/mars.webp" : "/planets/earth.webp"} alt="" /></div>
            <h1 className="opening__title">
              <RevealWords text={mode !== "study" && !userName ? NAMELESS_GREETING : greeting} />
              {mode !== "study" && userName ? <em>, {userName}</em> : null}
            </h1>
            {mode === "study" && <div className="study-starters" aria-label="Study suggestions">
              {STUDY_STARTERS.map((label) => <button type="button" className="btn btn--secondary" key={label} onClick={() => { setDraft(label); inputRef.current?.focus(); }}>{label}</button>)}
            </div>}
          </div>
        ) : (
          <div className="chat__thread">
            {messages.map((message, index) =>
              message.role === "user" ? (
                <article className="turn turn--user" key={index}>
                  <div className="bubble bubble--user">{message.content}</div>
                  {message.attachments?.length > 0 && (
                    <ul className="attached">
                      {message.attachments.map((attachment) => (
                        <li key={attachment.name}>
                          {attachment.image ? <ImageIcon size={13} /> : <FileText size={13} />} {attachment.name}
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              ) : (
                <article className="turn" key={index}>
                  <div className="turn__byline">
                    <span className="turn__mark"><img src={BRAND_ICON} alt="" /></span>
                    {studyMode ? "VibhavGPT" : message.model ?? modelInfo.full}
                  </div>
                  <div className="bubble bubble--assistant bubble--wide">
                    <ReasoningTrace text={message.reasoning ?? ""} seconds={message.thoughtSeconds ?? null} />
                    <AssistantBody
                      text={message.content}
                      animate={Boolean(message.fresh) && index === messages.length - 1}
                      onTick={stickToBottom}
                    />
                    {message.incomplete && <p className="response-interrupted" role="status">Response interrupted. This partial answer is not saved; retry for a complete response.</p>}
                    <SourcesDisclosure sources={message.sources ?? []} steps={message.activitySummary ?? []} />
                    {message.attachment && (
                      <PrivateFileLink className="generated-attachment" href={message.attachment.downloadUrl} name={message.attachment.name}>
                        {message.attachment.kind === "generated-image" ? <PrivateImage src={message.attachment.previewUrl ?? message.attachment.downloadUrl} alt={message.attachment.name} /> : <FileText size={22} />}
                        <span><strong>{message.attachment.name}</strong><small>Download file</small></span>
                      </PrivateFileLink>
                    )}
                  </div>
                  <div className="turn__tools">
                    <CopyButton text={message.content} />
                  </div>
                </article>
              ),
            )}
            {busy && (
              <article className="turn">
                <div className="turn__byline">
                  <span className="turn__mark"><img src={BRAND_ICON} alt="" /></span>
                  {studyMode ? "VibhavGPT" : modelInfo.full}
                </div>
                <div className={`bubble bubble--assistant${streamText ? " bubble--wide" : ""}`}>
                  {liveReasoning && streamText && <ReasoningTrace text={liveReasoning} seconds={liveThought} />}
                  {streamText
                    ? <AssistantBody text={streamText} animate={false} />
                    : <ThinkingTool state="thinking" label={<LiveStatusLabel {...livePhase} />} sources={liveSources} />}
                  {liveReasoning && !streamText && <ReasoningTrace text={liveReasoning} live />}
                </div>
              </article>
            )}
            {queue.length > 0 && (
              <ol className="chat-queue" aria-label="Queued messages">
                {queue.map((item, position) => (
                  <li className="chat-queue__item" key={item.id}>
                    <div className="chat-queue__bubble">
                      <span className="chat-queue__label">{position === 0 ? (failed ? "Paused" : "Sends next") : `Queued, ${position + 1} of ${queue.length}`}</span>
                      <p>{item.content || "Attached file(s)"}</p>
                      {item.attachments.length > 0 && (
                        <ul className="attached">
                          {item.attachments.map((attachment) => (
                            <li key={`${attachment.file.name}-${attachment.file.lastModified}`}>
                              {attachment.file.type.startsWith("image/") ? <ImageIcon size={13} /> : <FileText size={13} />} {attachment.file.name}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <IconButton className="chat-queue__remove" label={`Remove queued message: ${(item.content || "attached files").slice(0, 60)}`} onClick={() => removeQueued(item.id)}>
                      <X size={15} strokeWidth={2.2} />
                    </IconButton>
                  </li>
                ))}
                {failed && <li className="chat-queue__note">Queued messages wait until the last one is retried or dismissed.</li>}
              </ol>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div className="composer-wrap">
        {mode === "chat" && codingNudge && sentModel !== "nebula" && sentModel !== "ultra" && (
          <div className="coding-nudge" role="status">
            <ModelOrb model="nebula" size="sm" />
            <span className="coding-nudge__copy">{CODING_NUDGE_COPY}</span>
            <button type="button" className="btn btn--primary coding-nudge__switch" disabled={busy || modelSaving} onClick={() => changeModel("nebula")}>Switch to Nebula</button>
            <IconButton className="coding-nudge__dismiss" label="Dismiss model suggestion" onClick={() => setCodingNudge(false)}><X size={14} /></IconButton>
          </div>
        )}
        {materials.length > 0 && <div className="chat-materials" aria-label="Conversation materials">
          {materials.map((file) => <PrivateFileLink key={file.id} href={file.downloadUrl} name={file.name} className="btn btn--quiet"><FileText size={14} />{file.name}</PrivateFileLink>)}
        </div>}
        {error && (
          <div className="banner banner--error" role="alert">
            <span>{error}</span>
            <div className="banner__actions">
              <button type="button" className="btn btn--ghost" onClick={() => { setError(""); setFailed(null); }}>Dismiss</button>
              {failed && (
                <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => deliver(failed.content, failed.attachments)}>
                  <RotateCw size={14} strokeWidth={2} /> Retry
                </button>
              )}
            </div>
          </div>
        )}
        {visionModelRequired && (
          <div className="banner" role="status">
            <span>Choose a model that supports images.</span>
            <div className="banner__actions">
              <button type="button" className="btn btn--primary" onClick={() => changeModel("nova")}>Switch to Nova</button>
            </div>
          </div>
        )}

        {narrow ? (
          <>
            <form className="composer" data-layout="pill" data-send-pulse={sendPulse ? (sendPulse % 2 ? "odd" : "even") : undefined} onSubmit={send}>
              {attachmentTray}
              <div className="composer__row">
                {addSheetButton}
                {composerInput}
                {micButton}
                {sendButton}
              </div>
              {fileInputs}
            </form>
          </>
        ) : (
          <form className="composer" data-send-pulse={sendPulse ? (sendPulse % 2 ? "odd" : "even") : undefined} onSubmit={send}>
            {composerInput}
            {attachmentTray}
            <div className="composer__bar">
              <div className="composer__left">
                {addMenu}
                {imageInput}
              </div>
              {fileInput}
              <div className="composer__right">
                {effortApplies && (
                  <Select
                    size="sm"
                    className="composer__effort"
                    label="Thinking effort for your next response"
                    value={quickPreferences.thinkingEffort}
                    onChange={changeThinkingEffort}
                    disabled={busy || !preferencesLoaded}
                    placement="top"
                    options={THINKING_OPTIONS}
                  />
                )}
                {!studyMode && <Select
                  size="sm"
                  className="composer__model"
                  listClassName="model-list"
                  label="Model for your next message"
                  value={model}
                  onChange={changeModel}
                  onDisabledChange={(option) => void changeModel(option.value)}
                  disabled={busy || modelSaving}
                  placement="top"
                  align="end"
                  options={modelOptions}
                  renderValue={(option) => <><ModelOrb model={option.value} size="sm" /><span>{option.label}</span></>}
                  renderOption={(option, { selected }) => <ModelRow entry={option} allowed={!option.disabled} selected={selected} />}
                />}
                {micButton}
                {sendButton}
              </div>
            </div>
          </form>
        )}
      </div>
      <BottomSheet open={narrow && sheet === "add"} onClose={closeSheet} title="Add to message">
        <div className="add-sheet">
          <div className="add-sheet__tiles">
            <button type="button" className="add-sheet__tile" onClick={() => { closeSheet(); imageInputRef.current?.click(); }}>
              <ImageIcon size={22} strokeWidth={1.8} />
              <span>Photos</span>
            </button>
            <button type="button" className="add-sheet__tile" onClick={() => { closeSheet(); fileInputRef.current?.click(); }}>
              <FileText size={22} strokeWidth={1.8} />
              <span>Files</span>
            </button>
          </div>
          {mode !== "study" && <><div className="add-sheet__list">
            <button type="button" className="add-sheet__row" disabled={busy} onClick={() => setSheet("model")}>
              <Sparkles size={19} strokeWidth={1.9} />
              <span className="add-sheet__copy">Model<small>{modelInfo.label}</small></span>
              <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
            </button>
            {effortApplies && (
              <button type="button" className="add-sheet__row" disabled={busy || !preferencesLoaded} onClick={() => setSheet("effort")}>
                <Brain size={19} strokeWidth={1.9} />
                <span className="add-sheet__copy">Thinking effort<small>{THINKING_OPTIONS.find((option) => option.value === quickPreferences.thinkingEffort)?.label}</small></span>
                <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
          <p className="add-sheet__label">Response mode</p>
          <div className="add-sheet__list" role="radiogroup" aria-label="Response mode">
            {RESPONSE_MODES.map((mode) => (
              <button key={mode.value} type="button" role="radio" aria-checked={quickPreferences.responseStyle === mode.value} className="add-sheet__row" disabled={busy || !preferencesLoaded} onClick={() => void changeResponseStyle(mode.value)}>
                {mode.icon}
                <span className="add-sheet__copy">{mode.label}</span>
                {quickPreferences.responseStyle === mode.value && <Check size={18} strokeWidth={2.6} aria-hidden="true" />}
              </button>
            ))}
            <button type="button" className="add-sheet__row" onClick={() => { closeSheet(); onOpenSettings(); }}>
              <SettingsIcon size={19} strokeWidth={1.9} />
              <span className="add-sheet__copy">Custom</span>
              <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
          </>}
        </div>
      </BottomSheet>
      <BottomSheet open={narrow && sheet === "model"} onClose={closeSheet} title="Choose a model">
        <div className="model-sheet" role="radiogroup" aria-label="Model">
          {MODELS.map((entry) => {
            const allowed = modelAllowedForTier(entry.value, tier, creditBalance);
            const selected = entry.value === model;
            return (
              <button
                key={entry.value}
                type="button"
                role="radio"
                aria-checked={selected}
                className="model-sheet__option"
                aria-disabled={!allowed || busy || modelSaving || undefined}
                onClick={() => { if (busy || modelSaving) return; void changeModel(entry.value); closeSheet(); }}
              >
                <ModelRow entry={entry} allowed={allowed} selected={selected} />
              </button>
            );
          })}
        </div>
      </BottomSheet>
      <BottomSheet open={narrow && sheet === "effort"} onClose={closeSheet} title="Thinking effort">
        <div className="model-sheet" role="radiogroup" aria-label="Thinking effort for your next response">
          {THINKING_OPTIONS.map((option) => {
            const selected = quickPreferences.thinkingEffort === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                className="model-sheet__option"
                disabled={busy || !preferencesLoaded}
                onClick={() => { void changeThinkingEffort(option.value); closeSheet(); }}
              >
                <span className="model-sheet__icon" aria-hidden="true"><Brain size={16} strokeWidth={1.9} /></span>
                <span className="model-sheet__copy">
                  <span className="model-sheet__name">{option.label}</span>
                  <small>{option.description}</small>
                </span>
                {selected && <Check className="model-sheet__check" size={18} strokeWidth={2.6} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </BottomSheet>
    </section>
  );
}

/* -- Memory --------------------------------------------------------------- */

// Deletes every saved memory after an explicit confirmation.
function ClearMemoryDialog({ open, count, onClose, onCleared }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function clear() {
    setBusy(true);
    setError("");
    try {
      await api("/api/memory", { method: "DELETE" });
      onCleared?.();
    } catch (err) {
      setError(err.message || "Memory couldn't be cleared. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={() => !busy && onClose()} eyebrow="Memory" title="Clear all memory?" description={`This permanently deletes ${count === 1 ? "the 1 saved memory" : count ? `all ${count} saved memories` : "every saved memory"}. Your chats are not affected.`}>
      {error && <p className="note note--error" role="alert">{error}</p>}
      <div className="ui-modal__actions">
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={onClose}>Keep my memory</button>
        <button type="button" className="btn btn--danger" disabled={busy} onClick={clear}>{busy ? "Clearing…" : "Clear all memory"}</button>
      </div>
    </Modal>
  );
}

// Settings: whether VibhavGPT uses and saves memory at all, and clear-all.
function MemorySettingsCard() {
  const [state, setState] = useState({ loading: true, enabled: true, count: 0 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [clearOpen, setClearOpen] = useState(false);
  const load = useCallback(async () => {
    try {
      const result = await api("/api/memory");
      setState({ loading: false, enabled: result.enabled !== false, count: result.facts?.length ?? 0 });
    } catch {
      setState((current) => ({ ...current, loading: false }));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function toggle(value) {
    const enabled = value === "on";
    if (enabled === state.enabled) return;
    setSaving(true);
    setError("");
    const previous = state.enabled;
    setState((current) => ({ ...current, enabled }));
    try {
      await api("/api/memory/settings", { method: "PUT", body: JSON.stringify({ enabled }) });
    } catch (err) {
      setState((current) => ({ ...current, enabled: previous }));
      setError(err.message || "That setting couldn't be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }
  const countLabel = state.loading ? "Checking saved memory…" : state.count === 0 ? "No saved memories" : `${state.count} saved ${state.count === 1 ? "memory" : "memories"}`;
  return (
    <div className="settings-stack">
      <SettingsGroup title="How memory works" description="When memory is on, VibhavGPT remembers lasting details you share and uses them in later chats. When it's off, nothing is saved or used, and your saved memories stay until you clear them.">
        <SettingsRow label="Remember details" description="Use and save lasting details from your chats.">
          <Segmented
            label="Memory"
            value={state.enabled ? "on" : "off"}
            onChange={(value) => void toggle(value)}
            options={[{ value: "on", label: "On" }, { value: "off", label: "Off" }]}
          />
        </SettingsRow>
        <SettingsRow label="Saved memories" description={countLabel}>
          <button type="button" className="btn btn--danger" disabled={state.loading || saving || state.count === 0} onClick={() => setClearOpen(true)}>
            <Trash2 size={15} /> Clear all memory
          </button>
        </SettingsRow>
      </SettingsGroup>
      {error && <p className="note note--error" role="alert">{error}</p>}
      <ClearMemoryDialog open={clearOpen} count={state.count} onClose={() => setClearOpen(false)} onCleared={() => { setClearOpen(false); void load(); }} />
    </div>
  );
}

function importSummary(result) {
  const added = result.imported?.length ?? 0;
  const parts = [`Added ${added} ${added === 1 ? "memory" : "memories"}`];
  if (result.duplicates) parts.push(`${result.duplicates} already saved`);
  if (result.unsupported) parts.push(`${result.unsupported} couldn't be saved as memory`);
  return `${parts.join(" · ")}.`;
}

// "User prefers short answers." -> "Prefers short answers."
const factForDisplay = (content) => {
  const text = String(content ?? "").replace(/^User(?:'s)?\s+/i, (match) => (/'s/i.test(match) ? "Your " : ""));
  return text.charAt(0).toUpperCase() + text.slice(1);
};

function MemoryUpdatedToast({ facts, onOpen, onDismiss }) {
  const shown = facts.slice(0, 3);
  const more = facts.length - shown.length;
  return (
    <div className="memory-toast" role="status" aria-live="polite">
      <button type="button" className="memory-toast__body" onClick={onOpen}>
        <span className="memory-toast__head"><Brain size={16} strokeWidth={2} aria-hidden="true" /> Memory updated</span>
        <ul className="memory-toast__facts">
          {shown.map((fact) => <li key={fact.id}>{factForDisplay(fact.content)}</li>)}
          {more > 0 && <li className="memory-toast__more">and {more} more</li>}
        </ul>
        <span className="memory-toast__cta">See what VibhavGPT learned <ChevronRight size={15} strokeWidth={2.2} aria-hidden="true" /></span>
      </button>
      <IconButton className="memory-toast__close" label="Dismiss" onClick={onDismiss}><X size={16} strokeWidth={2} /></IconButton>
    </div>
  );
}

const EXPORT_PROMPT = `Please export what you know about me as a structured memory summary for another assistant. Only include information I explicitly shared, never guesses. Organize it under these headings: Preferences, Profile, Academics, Interests, Recent Work, and Tools. For a recurring named project or topic, use its own heading (for example, "## VibhavGPT"). Use one bullet per durable fact and include a rough date or timeframe when known. Do not include private secrets, passwords, or information about you/your system.`;

const MEMORY_GROUPS = [
  { id: "preferences", section: "You", title: "Preferences", summary: "How you want VibhavGPT to respond." },
  { id: "profile", section: "You", title: "Profile", summary: "Personal context picked up from your chats." },
  { id: "academics", section: "Topics", title: "Academics", summary: "Study goals, classes, and learning context." },
  { id: "interests", section: "Topics", title: "Interests", summary: "Interests that help make conversations more relevant." },
  { id: "recent_work", section: "Topics", title: "Recent work", summary: "Work, career, and ongoing professional context." },
  { id: "tools", section: "Topics", title: "Tools", summary: "Tools and workflows you use regularly." },
];

function memoryText(content) {
  return String(content ?? "")
    .replace(/^user(?:'s)?\s+(?:preferences|profile|identity|career|projects?|imported context)\s*:\s*/i, "")
    .replace(/^user\s+/i, "")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function memoryDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "Updated recently";
  return `Updated ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date)}`;
}

function groupMemoryFacts(facts) {
  const grouped = new Map(MEMORY_GROUPS.map((group) => [group.id, { ...group, facts: [] }]));
  const areas = new Map();
  for (const fact of facts) {
    if (fact.category === "area" && fact.area) {
      const key = fact.area.trim();
      const group = areas.get(key) ?? { id: `area:${key}`, section: "Areas", title: key, summary: "A dedicated thread of context from your conversations.", facts: [] };
      group.facts.push(fact);
      areas.set(key, group);
    } else {
      (grouped.get(fact.category) ?? grouped.get("profile")).facts.push(fact);
    }
  }
  // One isolated project fact is more useful under Recent work than as a noisy
  // one-card Area. A named Area appears only after related context accumulates.
  for (const area of areas.values()) {
    if (area.facts.length < 2) grouped.get("recent_work").facts.push(...area.facts);
  }
  const sections = ["You", "Topics", "Areas"].map((section) => ({ section, groups: [] }));
  for (const group of grouped.values()) {
    if (group.facts.length) sections.find((item) => item.section === group.section).groups.push(group);
  }
  for (const area of areas.values()) {
    if (area.facts.length >= 2) sections.find((item) => item.section === "Areas").groups.push(area);
  }
  return sections.filter((section) => section.groups.length);
}

function Memory({ onMemoriesAdded }) {
  const [facts, setFacts] = useState([]);
  const [memoryEnabled, setMemoryEnabled] = useState(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [view, setView] = useState("memory");
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState("");
  const [previewFacts, setPreviewFacts] = useState([]);
  const [previewSource, setPreviewSource] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [confirmingImport, setConfirmingImport] = useState(false);
  const [copied, setCopied] = useState("idle");
  const groups = useMemo(() => groupMemoryFacts(facts), [facts]);

  useEffect(() => {
    if (copied === "idle") return undefined;
    const timer = setTimeout(() => setCopied("idle"), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  const load = useCallback(async () => {
    try {
      const result = await api("/api/memory");
      setMemoryEnabled(result.enabled !== false);
      setFacts(result.facts);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save(id) {
    try {
      const result = await api(`/api/memory/${id}`, { method: "PATCH", body: JSON.stringify({ content: text }) });
      setFacts((current) => current.map((fact) => (fact.id === id ? result.fact : fact)));
      setEditing();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(id) {
    try {
      await api(`/api/memory/${id}`, { method: "DELETE" });
      setFacts((current) => current.filter((fact) => fact.id !== id));
    } catch (err) {
      setError(err.message);
    }
  }

  async function importMemory() {
    if (!importText.trim()) return;
    setImporting(true);
    setError("");
    setImportResult("");
    try {
      const result = await api("/api/memory/import", { method: "POST", body: JSON.stringify({ text: importText }) });
      await load();
      setImportResult(importSummary(result));
      if (result.imported.length) { setImportText(""); onMemoriesAdded?.(result.imported); }
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  }

  async function previewMemoryFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPreviewing(true);
    setError("");
    setImportResult("");
    try {
      const body = new FormData();
      body.append("file", file);
      const result = await api("/api/memory/import/preview", { method: "POST", body });
      setPreviewSource(result.sourceName || file.name);
      setPreviewFacts(result.facts || []);
    } catch (err) {
      setError(err.message);
      setPreviewFacts([]);
      setPreviewSource("");
    } finally {
      setPreviewing(false);
    }
  }

  async function confirmMemoryFileImport() {
    const facts = previewFacts.filter((fact) => fact.content.trim());
    if (!facts.length) return;
    setConfirmingImport(true);
    setError("");
    try {
      const result = await api("/api/memory/import/confirm", { method: "POST", body: JSON.stringify({ facts }) });
      await load();
      setImportResult(importSummary(result));
      if (result.imported.length) onMemoriesAdded?.(result.imported);
      setPreviewFacts([]);
      setPreviewSource("");
    } catch (err) {
      setError(err.message);
    } finally {
      setConfirmingImport(false);
    }
  }

  return (
    <main className="page">
      <header className="page__header">
        <p className="ui-eyebrow">Memory</p>
        <h1 className="page__title"><RevealWords text="What VibhavGPT keeps about you" /></h1>
        <p className="page__lede">
          Facts are saved only when they'd help a future conversation. Edit or remove any of them, any time.
        </p>
      </header>

      <Segmented
        label="Memory view"
        value={view}
        onChange={setView}
        options={[
          { value: "memory", label: "Saved memory" },
          { value: "import", label: "Import" },
        ]}
      />

      {error && <p className="note note--error" role="alert">{error}</p>}
      {memoryEnabled === false && (
        <p className="note note--info">Memory is off. VibhavGPT isn't using or saving memories in your chats. Turn it back on in Settings.</p>
      )}
      {view === "memory" && facts.length > 0 && (
        <div className="memory-clear">
          <button type="button" className="btn btn--quiet" onClick={() => setClearOpen(true)}>
            <Trash2 size={15} /> Clear all memory
          </button>
        </div>
      )}
      <ClearMemoryDialog open={clearOpen} count={facts.length} onClose={() => setClearOpen(false)} onCleared={() => { setClearOpen(false); void load(); }} />

      <div style={{ marginTop: 24 }}>
        {view === "import" ? (
          <>
            <article className="card">
              <h2>Bring your context with you</h2>
              <p>Ask another assistant to export a summary, then paste it here. Imports only add: nothing you already have is touched.</p>
              <div className="card__body">
                <Field label="Copy this prompt">
                  <textarea className="prompt-field" readOnly value={EXPORT_PROMPT} onFocus={(event) => event.target.select()} />
                </Field>
                <div>
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={async () => setCopied((await copyText(EXPORT_PROMPT)) ? "done" : "failed")}
                  >
                    {copied === "done" ? (
                      <><Check size={15} strokeWidth={2.4} /> Copied</>
                    ) : copied === "failed" ? (
                      <><X size={15} strokeWidth={2.4} /> Select it instead</>
                    ) : (
                      <><Copy size={15} /> Copy prompt</>
                    )}
                  </button>
                </div>
              </div>
            </article>
            <article className="card">
              <h2>Import a Markdown or PDF file</h2>
              <p>Upload a short export instead of pasting it. We use the same PDF text extraction pipeline as document Q&amp;A, then show the facts for your review before saving anything.</p>
              <div className="card__body">
                <label className="file-picker">
                  <FileText size={17} />
                  <span>{previewing ? "Reading file…" : "Choose .md or .pdf"}</span>
                  <input type="file" accept=".md,.pdf,text/markdown,application/pdf" onChange={previewMemoryFile} disabled={previewing || confirmingImport} />
                </label>
                <p className="muted">Up to 5 MB. Nothing is saved until you confirm the reviewed facts.</p>
              </div>
            </article>
            {previewFacts.length > 0 && (
              <article className="card memory-import-review">
                <header className="card__header">
                  <div><h2>Review extracted facts</h2><p>{previewSource} · edit or remove anything before importing.</p></div>
                  <span className="badge">{previewFacts.length} found</span>
                </header>
                <div className="card__body">
                  {previewFacts.map((fact, index) => (
                    <div className="memory-import-review__row" key={`${fact.content}-${index}`}>
                      <textarea className="textarea" value={fact.content} onChange={(event) => setPreviewFacts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, content: event.target.value } : item))} />
                      <Select
                        label="Category"
                        value={fact.category}
                        onChange={(value) => setPreviewFacts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, category: value, area: value === "area" ? item.area : null } : item))}
                        options={[
                          { value: "preferences", label: "Preferences" }, { value: "profile", label: "Profile" },
                          { value: "academics", label: "Academics" }, { value: "interests", label: "Interests" },
                          { value: "recent_work", label: "Recent work" }, { value: "tools", label: "Tools" }, { value: "area", label: "Area" },
                        ]}
                      />
                      <button type="button" className="btn btn--quiet" onClick={() => setPreviewFacts((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={15} /> Remove</button>
                    </div>
                  ))}
                  <div className="button-row">
                    <button type="button" className="btn btn--primary" disabled={confirmingImport || !previewFacts.some((fact) => fact.content.trim())} onClick={confirmMemoryFileImport}>{confirmingImport ? "Adding…" : "Add reviewed facts to memory"}</button>
                    <button type="button" className="btn btn--quiet" disabled={confirmingImport} onClick={() => { setPreviewFacts([]); setPreviewSource(""); }}>Discard</button>
                  </div>
                </div>
              </article>
            )}
            <article className="card">
              <h2>Paste the exported summary</h2>
              <p>Use Preferences, Profile, Academics, Interests, Recent Work, or Tools. Give a recurring project its own heading. Duplicates and unsupported lines are skipped.</p>
              <div className="card__body">
                <textarea
                  className="textarea"
                  style={{ minHeight: 200 }}
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                  placeholder={"## Profile\n- I live in…\n\n## Preferences\n- I prefer concise answers…\n\n## VibhavGPT\n- I am rebuilding the memory page…"}
                />
                <div>
                  <button type="button" className="btn btn--primary" disabled={importing || !importText.trim()} onClick={importMemory}>
                    {importing ? "Importing…" : "Add to memory"}
                  </button>
                </div>
                {importResult && <p className="note note--good">{importResult}</p>}
              </div>
            </article>
          </>
        ) : loading ? (
          <TypingDots label="Loading memory" />
        ) : facts.length === 0 ? (
          <div className="empty-state">
            <strong>Nothing saved yet</strong>
            <p>Share a lasting preference or detail in chat and it will show up here.</p>
          </div>
        ) : (
          <div className="memory-sections">
            {groups.map((section) => (
              <section className="memory-section" key={section.section} aria-labelledby={`memory-${section.section.toLowerCase()}`}>
                <p className="memory-section__label" id={`memory-${section.section.toLowerCase()}`}>{section.section}</p>
                <div className="memory-groups">
                  {section.groups.map((group) => {
                    const updatedAt = group.facts.reduce((latest, fact) => {
                      const value = new Date(fact.updatedAt ?? fact.createdAt ?? 0).getTime();
                      return value > latest ? value : latest;
                    }, 0);
                    return (
                      <article className="memory-group" key={group.id}>
                        <header className="memory-group__head">
                          <div>
                            <h2>{group.title}</h2>
                            <p>{group.summary}</p>
                          </div>
                          <time dateTime={updatedAt ? new Date(updatedAt).toISOString() : undefined}>{memoryDate(updatedAt)}</time>
                        </header>
                        <div className="memory-group__facts">
                          {group.facts.map((fact) => (
                            <article className="memory-fact" key={fact.id}>
                              {editing === fact.id ? (
                                <>
                                  <textarea className="textarea" style={{ minHeight: 80 }} value={text} onChange={(event) => setText(event.target.value)} />
                                  <div className="fact__actions">
                                    <button className="btn btn--primary" style={{ minHeight: 34 }} onClick={() => save(fact.id)}>Save</button>
                                    <button className="btn btn--quiet" onClick={() => setEditing()}>Cancel</button>
                                  </div>
                                </>
                              ) : (
                                <>
                                  <p>{memoryText(fact.content)}</p>
                                  <div className="fact__actions">
                                    <button className="btn btn--quiet" onClick={() => { setEditing(fact.id); setText(fact.content); }}>Edit</button>
                                    <button className="btn btn--quiet" style={{ color: "var(--danger)" }} onClick={() => remove(fact.id)}>Delete</button>
                                  </div>
                                </>
                              )}
                            </article>
                          ))}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

/* -- Settings ------------------------------------------------------------- */

const RESPONSE_STYLES = [
  { value: "concise", label: "Concise", description: "Short, direct answers." },
  { value: "balanced", label: "Balanced", description: "Clear detail for most tasks." },
  { value: "detailed", label: "Detailed", description: "Thorough context and examples." },
  { value: "friendly", label: "Friendly", description: "Warm and beginner-friendly." },
];

function Settings({
  section = "account", onSectionChange, user, appearance, tier = "free", creditBalance = 0, onDeleted, onLegal, onOpenUsage, onOpenBilling = () => {},
  onboarding = defaultOnboarding(), onSaveOnboarding = async () => {}, onRerunOnboarding = () => {},
}) {
  const { accentId, setAccentId, themeId, setThemeId, resolved } = appearance;
  const names = workspaceNames(user, onboarding);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(() => new URLSearchParams(window.location.search).has("delete-account"));
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The delete dialog keeps its own error, so a refusal shows once, inside
  // the dialog, and never as a banner on the page behind it.
  const [deleteError, setDeleteError] = useState("");
  // "active-subscription" when deletion was refused because a plan is active.
  const [deleteErrorCode, setDeleteErrorCode] = useState("");
  const [responseStyle, setResponseStyle] = useState("balanced");
  const [customInstructions, setCustomInstructions] = useState("");
  const [preferencesBusy, setPreferencesBusy] = useState(false);
  const [preferencesSaved, setPreferencesSaved] = useState(false);
  const [preferredModel, setPreferredModel] = useState("");
  const [thinkingEffort, setThinkingEffort] = useState("normal");
  const [personality, setPersonality] = useState(() => ({ ...onboarding.personality }));
  const [personalityBusy, setPersonalityBusy] = useState(false);
  const [personalitySaved, setPersonalitySaved] = useState(false);
  const [personalityError, setPersonalityError] = useState("");

  useEffect(() => {
    api("/api/profile/preferences", { cache: "no-store" })
      .then((preferences) => {
        setResponseStyle(preferences.responseStyle ?? "balanced");
        // The personality block is managed by the survey and shown as sliders
        // below, so the editable field holds only what the user typed here.
        setCustomInstructions(stripManagedInstructions(preferences.customInstructions ?? ""));
        setPreferredModel(preferences.preferredModel ?? "");
        setThinkingEffort(preferences.thinkingEffort ?? "normal");
      })
      .catch(() => null);
  }, []);

  async function savePreferences() {
    setPreferencesBusy(true);
    setPreferencesSaved(false);
    setError("");
    try {
      const saved = await api("/api/profile/preferences", {
        method: "PATCH",
        body: JSON.stringify({
          responseStyle,
          // Re-attach the survey's managed block: the textarea above only ever
          // holds the user's own text.
          customInstructions: mergeInstructions(customInstructions, { ...onboarding, personality }),
          preferredModel: preferredModel || null,
          thinkingEffort,
        }),
      });
      setResponseStyle(saved.responseStyle);
      setCustomInstructions(stripManagedInstructions(saved.customInstructions));
      setPreferredModel(saved.preferredModel ?? "");
      setThinkingEffort(saved.thinkingEffort ?? "normal");
      setPreferencesSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setPreferencesBusy(false);
    }
  }

  async function exportData() {
    setExporting(true);
    setError("");
    try {
      const data = await api("/api/account/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      await saveFile(blob, "vibhavgpt-account-data.json");
      setExported(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  // Arriving from the account-deletion page opens the confirmation once;
  // the query is dropped so a reload does not open it again.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (!query.has("delete-account")) return;
    query.delete("delete-account");
    window.history.replaceState(null, "", `${window.location.pathname}${query.size ? `?${query}` : ""}`);
    resetPageScroll();
  }, []);

  function openDeleteDialog() {
    setConfirm("");
    setError("");
    setDeleteError("");
    setDeleteErrorCode("");
    setDeleteOpen(true);
  }

  function closeDeleteDialog() {
    setDeleteOpen(false);
    setError("");
    setDeleteError("");
    setDeleteErrorCode("");
  }

  async function deleteAccount() {
    if (confirm !== "DELETE") return;
    setBusy(true);
    setDeleteError("");
    setDeleteErrorCode("");
    try {
      await api("/api/account", { method: "DELETE" });
      onDeleted();
    } catch (err) {
      setDeleteError(err.message);
      setDeleteErrorCode(err.code ?? "");
      setBusy(false);
    }
  }

  const meta = SETTINGS_META[section] ?? SETTINGS_META.account;

  return (
    <main className="page settings">
      <div className="settings__layout">
        {/* Every section sits in one dock across the top: three clusters of
            icon tiles. Each tile opens that section's own page. */}
        <header className="settings__top">
          <h1 className="settings__title">Settings</h1>
          <SettingsIndex current={section} onChange={onSectionChange} />
        </header>

        <div className="settings__sections">
          <div className="settings__content" id={`settings-${section === "your-data" ? "data" : section === "delete-account" ? "delete" : section}`}>
            <SettingsSectionHeader icon={meta.icon} title={meta.title} tone={meta.tone}>
              {section === "personality" ? `${personalityHeadline(personality)} These are the answers from your setup. Change any of them here, or run the whole thing again.` : meta.description}
            </SettingsSectionHeader>

            {error && <p className="note note--error" role="alert">{error}</p>}

            {section === "account" && (
              <div className="settings-stack">
                <SettingsGroup title="Profile">
                  <SettingsRow label="Name"><span className="settings-value">{names.settingsName}</span></SettingsRow>
                  <SettingsRow label="Email"><span className="settings-value">{user.email}</span></SettingsRow>
                </SettingsGroup>
                <SettingsGroup title="Plan usage">
                  <SettingsRow label="Usage and limits" description="See how much of your plan's allowance you have used this period.">
                    <a href="/app/usage" className="btn btn--secondary" onClick={(event) => {
                      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                      event.preventDefault(); onOpenUsage();
                    }}>
                      <BarChart3 size={16} /> View usage & limits
                    </a>
                  </SettingsRow>
                </SettingsGroup>
                <DesktopUpdateSettings />
              </div>
            )}

            {section === "appearance" && (
              <div className="settings-stack">
                <SettingsGroup title="Theme" description="Both choices apply instantly and are remembered on this device.">
                  <SettingsRow stacked>
                    <div className="theme-picker" role="radiogroup" aria-label="Theme">
                      {THEMES.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          role="radio"
                          className="theme-option"
                          // "system" has no fixed look, so it previews whichever sky
                          // is currently resolved rather than a third invented one.
                          data-preview={option.id === "system" ? resolved : option.id}
                          aria-checked={themeId === option.id}
                          onClick={() => setThemeId(option.id)}
                        >
                          <span className="theme-option__art" aria-hidden="true">
                            <span className="theme-option__planet" />
                          </span>
                          <span className="theme-option__copy">
                            <strong>{option.label}</strong>
                            <small>{option.description}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  </SettingsRow>
                </SettingsGroup>
                <SettingsGroup title="Accent" description="The light that runs through the app.">
                  <SettingsRow stacked>
                    <div className="swatches" role="group" aria-label="Accent colour">
                      {ACCENTS.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className="swatch"
                          // Reads the universe's token for the active sky, so the
                          // swatch shows the value the reader will actually get.
                          style={{ "--swatch": `var(--color-accent-${option.id})` }}
                          aria-pressed={accentId === option.id}
                          onClick={() => setAccentId(option.id)}
                        >
                          <span aria-hidden="true" />
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </SettingsRow>
                </SettingsGroup>
              </div>
            )}

            {section === "replies" && (
              <div className="settings-stack">
                <SettingsGroup title="Response style">
                  <SettingsRow stacked>
                    <ChoiceCards label="Response style" value={responseStyle} onChange={setResponseStyle} options={RESPONSE_STYLES} />
                  </SettingsRow>
                </SettingsGroup>
                <SettingsGroup title="Personal instructions" description="Anything VibhavGPT should always keep in mind when it answers you.">
                  <SettingsRow stacked>
                    <Field label="Personal instructions" hint={`${customInstructions.length}/4000`} className="settings-field--bare">
                      <textarea
                        className="textarea"
                        maxLength={4000}
                        value={customInstructions}
                        onChange={(event) => setCustomInstructions(event.target.value)}
                        placeholder="For example: use metric units, and show your reasoning briefly."
                      />
                    </Field>
                  </SettingsRow>
                </SettingsGroup>
                <SettingsGroup
                  title="Defaults for new chats"
                  footer={<>
                    <span className="settings-saved" role="status">{preferencesSaved && <><Check size={15} strokeWidth={2.4} aria-hidden="true" />Saved</>}</span>
                    <button className="btn btn--primary" disabled={preferencesBusy} onClick={savePreferences}>
                      {preferencesBusy ? "Saving…" : "Save preferences"}
                    </button>
                  </>}
                >
                  <SettingsRow label="Preferred default model" description="Use your last-used model, or choose a fixed starting model for new chats." htmlFor="preferred-default-model">
                    <SettingsSelect
                      id="preferred-default-model"
                      label="Preferred default model"
                      value={preferredModel}
                      onChange={setPreferredModel}
                      placeholder="Last-used model"
                      align="end"
                      options={[
                        { value: "", label: "Last-used model", description: "Restore the model you used most recently." },
                        ...MODELS.map((model) => ({
                          ...model,
                          disabled: !modelAllowedForTier(model.value, tier, creditBalance),
                        })),
                      ]}
                      // The same rows as the composer's model picker, so a model
                      // looks the same wherever it is chosen.
                      listClassName="model-list"
                      renderValue={(option) => (option.value ? <><ModelOrb model={option.value} size="sm" /><span>{option.label}</span></> : <span>{option.label}</span>)}
                      renderOption={(option, { selected }) => (option.value
                        ? <ModelRow entry={option} allowed={!option.disabled} selected={selected} />
                        : <span className="model-row">
                            <span className="model-orb" aria-hidden="true"><span className="model-orb__last" /></span>
                            <span className="model-row__text">
                              <span className="model-row__head"><span className="model-row__name">{option.label}</span></span>
                              <span className="model-row__desc">{option.description}</span>
                            </span>
                            <span className="model-row__meta">{selected && <Check className="model-row__check" size={16} strokeWidth={2.6} aria-hidden="true" />}</span>
                          </span>)}
                    />
                  </SettingsRow>
                  {tier !== "free" && (
                    <SettingsRow label="Default thinking effort" description="You can override this beside the model picker for any response.">
                      <SettingsSelect
                        label="Default thinking effort"
                        value={thinkingEffort}
                        onChange={setThinkingEffort}
                        align="end"
                        options={THINKING_OPTIONS}
                      />
                    </SettingsRow>
                  )}
                </SettingsGroup>
              </div>
            )}

            {section === "personality" && (
              <div className="settings-stack">
                <SettingsGroup
                  title="How VibhavGPT talks to you"
                  footer={<>
                    <span className="settings-saved" role="status">
                      {personalitySaved && <><Check size={15} strokeWidth={2.4} aria-hidden="true" />Saved</>}
                      {personalityError && <span className="settings-saved__error">{personalityError}</span>}
                    </span>
                    <button
                      className="btn btn--primary"
                      disabled={personalityBusy}
                      onClick={async () => {
                        setPersonalityBusy(true);
                        setPersonalitySaved(false);
                        setPersonalityError("");
                        try {
                          await onSaveOnboarding({ ...onboarding, personality });
                          // The length slider also moves the account's response style,
                          // so the Replies section has to reflect the new value.
                          setResponseStyle(responseStyleForPersonality(personality));
                          setPersonalitySaved(true);
                        } catch (err) {
                          setPersonalityError(err.message);
                        } finally {
                          setPersonalityBusy(false);
                        }
                      }}
                    >
                      {personalityBusy ? "Saving…" : "Save personality"}
                    </button>
                  </>}
                >
                  <SettingsRow stacked>
                    <div className="survey__sliders settings-sliders">
                      {PERSONALITY_AXES.map((axis) => (
                        <PersonalitySlider
                          key={axis.id}
                          axis={axis}
                          value={personality[axis.id]}
                          onChange={(value) => {
                            setPersonality((current) => ({ ...current, [axis.id]: value }));
                            setPersonalitySaved(false);
                          }}
                        />
                      ))}
                    </div>
                  </SettingsRow>
                </SettingsGroup>
                <SettingsGroup title="Your setup answers" description="From the questions you answered when you joined.">
                  <SettingsRow label="Using it for">
                    <span className="settings-value">{onboarding.role.length
                      ? ROLE_OPTIONS.filter((option) => onboarding.role.includes(option.value)).map((option) => option.label).join(", ")
                      : "Not answered"}</span>
                  </SettingsRow>
                  <SettingsRow label="Opens on"><span className="settings-value">{CAPABILITY_OPTIONS.find((option) => option.value === onboarding.primary_capability)?.label ?? "Chat"}</span></SettingsRow>
                  <SettingsRow label="Call me"><span className="settings-value">{names.settingsCallMe}</span></SettingsRow>
                  <SettingsRow label="Background"><span className="settings-value">{(EXPERTISE_OPTIONS.find((option) => option.value === onboarding.expertise) ?? EXPERTISE_OPTIONS[1]).label}</span></SettingsRow>
                  <SettingsRow label="Units"><span className="settings-value">{(UNIT_OPTIONS.find((option) => option.value === onboarding.units) ?? UNIT_OPTIONS[0]).label}</span></SettingsRow>
                  <SettingsRow label="Universe"><span className="settings-value">{(THEME_OPTIONS.find((option) => option.value === onboarding.theme) ?? THEME_OPTIONS[0]).label}</span></SettingsRow>
                  <SettingsRow label="Answer them again" description="Walk through the setup questions from the start.">
                    <button className="btn btn--secondary" onClick={onRerunOnboarding}>
                      <RotateCw size={15} /> Run setup again
                    </button>
                  </SettingsRow>
                </SettingsGroup>
              </div>
            )}

            {section === "memory" && <MemorySettingsCard />}

            {section === "security" && <SecurityPanel user={user} />}

            {section === "your-data" && (
              <div className="settings-stack">
                <SettingsGroup title="Export">
                  <SettingsRow label="Download your data" description={exported ? "Your export has been downloaded." : "A copy of your account, conversations, memory, usage, and subscription records."}>
                    <button className="btn btn--secondary" disabled={exporting} onClick={exportData}>
                      <Download size={15} /> {exporting ? "Preparing export…" : "Export my data"}
                    </button>
                  </SettingsRow>
                </SettingsGroup>
              </div>
            )}

            {section === "delete-account" && (
              <div className="settings-stack">
                <SettingsGroup tone="danger" title="Delete your account">
                  <SettingsRow
                    label="Permanently delete"
                    description={<>Permanently delete your VibhavGPT account and active account data. Restricted recovery backups expire within 12 months; billing providers may retain transaction records. <a href="https://vibhavgpt.com/account-deletion" target="_blank" rel="noreferrer">Learn about account deletion</a></>}
                  >
                    <button className="btn btn--danger" onClick={openDeleteDialog}>
                      <Trash2 size={15} /> Delete account
                    </button>
                  </SettingsRow>
                </SettingsGroup>
                {/* The dialog repeats this notice, so it is not shown twice at once. */}
                {!deleteOpen && <p className="settings-notice">{DELETION_PLAN_NOTICE}</p>}
              </div>
            )}
          </div>
          <SettingsFooter onLegal={onLegal} />
        </div>
      </div>

      <Modal
        open={deleteOpen}
        onClose={closeDeleteDialog}
        eyebrow="Permanent"
        title="Delete your account?"
        description={`Your conversations, memory, uploads, image library, and account-linked records will be removed from active VibhavGPT systems. Recovery backups expire within 12 months, and billing providers may retain transaction records. ${DELETION_PLAN_NOTICE} Type DELETE to confirm.`}
      >
        <Field label="Confirmation">
          <input className="input" autoFocus value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder="DELETE" />
        </Field>
        {deleteError && (
          <p className="note note--error" role="alert">
            {deleteError}
            {deleteErrorCode === "active-subscription" && (
              <>
                {" "}
                <a href="/app/billing" onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault(); closeDeleteDialog(); onOpenBilling();
                }}>Plan and billing</a>
              </>
            )}
          </p>
        )}
        <div className="ui-modal__actions">
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={closeDeleteDialog}>Keep my account</button>
          <button type="button" className="btn btn--danger" disabled={confirm !== "DELETE" || busy} onClick={deleteAccount}>
            {busy ? "Deleting…" : "Delete permanently"}
          </button>
        </div>
      </Modal>
    </main>
  );
}

/* -- Settings building blocks ---------------------------------------------- */

// Every section is described here once: where it sits in the navigation,
// its icon, and the heading and line of help at the top of its page. The
// routes themselves live in settings-routes.js.
const SETTINGS_META = {
  account: { group: "You", icon: UserRound, title: "Account", description: "Your profile and how much of your plan you have used." },
  personality: { group: "You", icon: SlidersHorizontal, title: "Personality", description: "" },
  appearance: { group: "Experience", icon: Palette, title: "Appearance", description: "Pick the sky, then the light that runs through it." },
  replies: { group: "Experience", icon: MessageSquareText, title: "Replies", description: "How replies are written. This shapes every conversation until you change it." },
  memory: { group: "Experience", icon: Brain, title: "Memory", description: "What VibhavGPT remembers between chats." },
  security: { group: "Privacy and security", icon: ShieldCheck, title: "Security", description: "Passkeys and two-step verification for signing in." },
  "your-data": { group: "Privacy and security", icon: Download, title: "Your data", description: "Take a copy of everything in your account." },
  "delete-account": { group: "Privacy and security", icon: Trash2, title: "Delete account", description: "Permanently remove your account and everything in it.", tone: "danger" },
};
const SETTINGS_GROUPS = ["You", "Experience", "Privacy and security"];

function SettingsSectionHeader({ icon: Icon, title, tone, children }) {
  return (
    <header className="settings-section__head" data-tone={tone}>
      <span className="settings-section__icon" aria-hidden="true"><Icon size={18} strokeWidth={1.9} /></span>
      <div>
        <h2>{title}</h2>
        {children && <p>{children}</p>}
      </div>
    </header>
  );
}

// A titled panel of rows. The title and help sit above the panel; a footer
// holds the action that saves what the panel contains.
function SettingsGroup({ title, description, tone, footer, children }) {
  return (
    <section className="settings-group" data-tone={tone}>
      {(title || description) && (
        <header className="settings-group__head">
          {title && <h3>{title}</h3>}
          {description && <p>{description}</p>}
        </header>
      )}
      <div className="settings-group__panel">
        {children}
        {footer && <div className="settings-group__footer">{footer}</div>}
      </div>
    </section>
  );
}

// One setting: its name and a line of help on the left, the control on the
// right. Wide controls (pickers, sliders, text) take the row's full width.
function SettingsRow({ label, description, htmlFor, stacked = false, children }) {
  const Label = htmlFor ? "label" : "span";
  return (
    <div className="settings-row" data-stacked={stacked || undefined}>
      {(label || description) && (
        <div className="settings-row__text">
          {label && <Label className="settings-row__label" {...(htmlFor ? { htmlFor } : {})}>{label}</Label>}
          {description && <span className="settings-row__description">{description}</span>}
        </div>
      )}
      <div className="settings-row__control">{children}</div>
    </div>
  );
}

function useDesktopUpdates() {
  const store = updateStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { store, state };
}

// The Windows desktop app's version and updates (desktop-updates.js). Not
// shown on the web, where window.desktopAPI does not exist.
function DesktopUpdateSettings() {
  const { store, state } = useDesktopUpdates();
  if (!store.available) return null;
  const busy = state.status === "checking" || state.status === "available" || state.status === "downloading";
  const label = updateStatusLabel(state);
  return (
    <SettingsGroup title="Desktop app">
      <SettingsRow label={state.appVersion ? `Version ${state.appVersion}` : "Version"} description="Updates download in the background and install the next time VibhavGPT restarts.">
        {state.status === "downloaded"
          ? <button type="button" className="btn btn--primary" onClick={store.install}>Install & Restart</button>
          : <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void store.check()}><RotateCw size={16} /> Check for updates</button>}
      </SettingsRow>
      {label && <p className="settings-update-status" role="status" aria-live="polite" data-status={state.status}>{label}</p>}
    </SettingsGroup>
  );
}

// Shown over the workspace once an update has downloaded, until dismissed.
function DesktopUpdateBanner() {
  const { store, state } = useDesktopUpdates();
  const [dismissed, setDismissed] = useState(null);
  if (!store.available || state.status !== "downloaded" || dismissed === (state.version ?? "")) return null;
  return (
    <div className="banner direct-update" role="status">
      <span><strong>{state.version ? `VibhavGPT ${state.version} is ready.` : "An update is ready."}</strong> Restart to install it, or it installs the next time you quit.</span>
      <button className="btn btn--secondary" type="button" onClick={store.install}>Install & Restart</button>
      <button className="btn btn--quiet" type="button" aria-label="Dismiss update notice" onClick={() => setDismissed(state.version ?? "")}>Later</button>
    </div>
  );
}

function SettingsFooter({ onLegal }) {
  return <footer className="settings__footer">
    <p className="settings__legal">
      <LegalLink page="terms" onOpen={onLegal}>Terms of Service</LegalLink>
      <LegalLink page="privacy" onOpen={onLegal}>Privacy Policy</LegalLink>
      <LegalLink page="guarantee" onOpen={onLegal}>The VibhavGPT Guarantee</LegalLink>
      <a className="link" href={SOURCE_REPO_URL} target="_blank" rel="noopener noreferrer">Source code</a>
    </p>
    <p className="settings__attribution">Made by Vibhav Thoota</p>
  </footer>;
}

// URL-backed navigation keeps every section available as its own page: a
// dock of icon tiles in three clusters. Where it scrolls sideways (phones),
// the current tile is kept in view.
function SettingsIndex({ current, onChange }) {
  const navigationRef = useRef(null);
  useEffect(() => {
    const navigation = navigationRef.current;
    const link = navigation?.querySelector('[aria-current="page"]');
    if (!link || navigation.scrollWidth <= navigation.clientWidth) return;
    const bounds = navigation.getBoundingClientRect();
    const selected = link.getBoundingClientRect();
    const delta = selected.left < bounds.left ? selected.left - bounds.left
      : selected.right > bounds.right ? selected.right - bounds.right : 0;
    if (delta) navigation.scrollBy({ left: delta, behavior: "auto" });
  }, [current]);
  return (
    <nav ref={navigationRef} className="settings-dock" aria-label="Settings sections">
      {SETTINGS_GROUPS.map((group) => (
        <div className="settings-dock__group" key={group} role="group" aria-label={group}>
          <span className="settings-dock__label" aria-hidden="true">{group}</span>
          <div className="settings-dock__items">
            {SETTINGS_SECTIONS.filter((section) => (SETTINGS_META[section.slug]?.group ?? "You") === group).map((section) => {
              const Icon = SETTINGS_META[section.slug]?.icon ?? SettingsIcon;
              return (
                <a key={section.slug} href={settingsPath(section.slug)}
                  className="settings-dock__item"
                  aria-current={current === section.slug ? "page" : undefined}
                  data-tone={section.slug === "delete-account" ? "danger" : undefined}
                  onClick={(event) => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    onChange(section.slug);
                  }}>
                  <span className="settings-dock__icon" aria-hidden="true"><Icon size={19} strokeWidth={1.8} /></span>
                  <span className="settings-dock__name">{section.label}</span>
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

/* -- Usage ---------------------------------------------------------------- */

const CREDIT_PRESETS = [5, 10, 20, 50];

function formatUsageDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function formatUsageCountdown(value) {
  if (!value) return null;
  const diff = new Date(value).getTime() - Date.now();
  if (diff <= 0) return "now";
  const hours = Math.ceil(diff / (60 * 60 * 1000));
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.ceil(hours / 24)} days`;
}

function formatUsageNumber(value) {
  const number = Number(value ?? 0);
  return number.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function UsageProgress({ used, limit, label, percentageOnly = false }) {
  const capped = Number.isFinite(limit);
  const percentage = usagePercentage(used, limit);
  return (
    <div className="usage-progress">
      <div className="usage-progress__copy">
        <strong>{percentageOnly ? `${percentage}%` : capped ? `${formatUsageNumber(used)} of ${formatUsageNumber(limit)}` : used.toLocaleString()}</strong>
        <span>{label}</span>
      </div>
      {capped && <div className="usage-progress__track" aria-label={percentageOnly ? `${percentage}% ${label}` : `${used} of ${limit} ${label}`} role="progressbar" aria-valuemin={0} aria-valuemax={percentageOnly ? 100 : limit} aria-valuenow={percentageOnly ? percentage : used}>
        <span style={{ width: `${percentage}%` }} />
      </div>}
    </div>
  );
}

function UsageDashboard({ onOpenSettings, onLegal }) {
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState("");
  const [creditAmount, setCreditAmount] = useState("5");
  const [creditBusy, setCreditBusy] = useState(false);
  const [creditPurchases, setCreditPurchases] = useState([]);
  const [creditPurchasesLoading, setCreditPurchasesLoading] = useState(true);
  const creditResult = new URLSearchParams(window.location.search).get("credits");
  const isNativeApp = Capacitor.isNativePlatform();

  const loadUsage = useCallback(() => api("/api/usage"), []);

  useEffect(() => {
    let mounted = true;
    loadUsage()
      .then((data) => { if (mounted) setUsage(data); })
      .catch((err) => { if (mounted) setError(err.message || "Could not load usage."); });
    const refreshTimers = creditResult === "success"
      ? [1500, 3500, 7000].map((delay) => setTimeout(() => {
        if (mounted) loadUsage().then((data) => { if (mounted) setUsage(data); }).catch(() => null);
      }, delay))
      : [];
    const changed = () => loadUsage().then((data) => { if (mounted) setUsage(data); }).catch(() => {});
    const usageRefresh = setInterval(changed, 30_000);
    window.addEventListener("focus", changed);
    window.addEventListener("vibhavgpt:subscription-changed", changed);
    return () => { mounted = false; clearInterval(usageRefresh); refreshTimers.forEach(clearTimeout); window.removeEventListener("focus", changed); window.removeEventListener("vibhavgpt:subscription-changed", changed); };
  }, [creditResult, loadUsage]);

  useEffect(() => {
    let mounted = true;
    api("/api/billing/credit-purchases")
      .then(({ purchases }) => { if (mounted) setCreditPurchases(purchases ?? []); })
      .catch(() => { if (mounted) setCreditPurchases([]); })
      .finally(() => { if (mounted) setCreditPurchasesLoading(false); });
    return () => { mounted = false; };
  }, []);

  async function buyCredits(amount) {
    if (isNativeApp) {
      setError("Flex Credit purchases are currently available on VibhavGPT web only.");
      return;
    }
    setCreditBusy(true);
    setError("");
    try {
      const result = await api("/api/billing/credits/checkout", {
        method: "POST",
        body: JSON.stringify({ amount }),
      });
      if (!result.url) throw new Error("Credit checkout did not return a payment page.");
      window.location.assign(result.url);
    } catch (err) {
      setError(err.message || "Credit checkout could not be started.");
      setCreditBusy(false);
    }
  }

  const tier = usage?.tier === "paid" ? "pro" : usage?.tier;
  const combined = combinedTokenUsage(usage);
  const resetAt = usage?.periodEndsAt;
  const resetDate = formatUsageDate(resetAt);
  const resetCountdown = formatUsageCountdown(resetAt);

  return (
    <main className="page usage-page">
      <header className="page__header">
        <p className="ui-eyebrow">Usage & limits</p>
        <h1 className="page__title"><RevealWords text="A clear view of your usage" /></h1>
        <p className="page__lede">Your counters come directly from the same usage window that controls your plan access.</p>
      </header>

      {error && <p className="note note--error" role="alert">{error}</p>}
      {creditResult === "success" && <p className="note note--good">Thanks for your purchase. Your credits will show in your balance once the payment is confirmed.</p>}
      {creditResult === "cancelled" && <p className="note">Purchase canceled. You were not charged.</p>}
      {!usage && !error ? <TypingDots label="Loading usage" /> : usage && (
        <>
          <article className="usage-hero">
            <div>
              <span className="usage-hero__eyebrow">{TIER_LABEL[tier] ?? "Free"} plan</span>
              <p className="usage-hero__summary">Token usage</p>
              <div className="card__body">
                <UsageProgress used={combined.monthly.used} limit={combined.monthly.limit} label="of monthly token allowances used" percentageOnly />
                <UsageProgress used={combined.rolling.used} limit={combined.rolling.limit} label="of 5-hour token allowances used" percentageOnly />
              </div>
              <p className="usage-cap__reset">Input and output tokens both count. Monthly caps reset on the first day at 00:00 UTC. The 5-hour window rolls continuously. Model limits apply separately.</p>
            </div>
            {resetDate && <p className="usage-hero__reset">Monthly token allowances reset<strong>{resetDate}{resetCountdown ? ` (${resetCountdown})` : ""}</strong></p>}
          </article>

          {tier === "plus" && (
            <section className="usage-caps" aria-label="Plus plan limits">
              <article className="usage-cap">
                <span>Image generation</span>
                <UsageProgress used={usage.imageGenerationsThisPeriod ?? 0} limit={usage.imageLimit ?? 25} label="image generations this billing month" />
                <p className="usage-cap__reset">Resets<strong>{formatUsageDate(usage.imagePeriodEndsAt ?? usage.periodEndsAt) ?? "next billing cycle"}</strong></p>
              </article>
              <article className="usage-cap">
                <span>Document generation</span>
                <UsageProgress used={usage.documentGenerationsThisPeriod ?? 0} limit={usage.documentLimit ?? 20} label="document generations this billing month" />
                <p className="usage-cap__reset">Resets<strong>{formatUsageDate(usage.imagePeriodEndsAt) ?? "next billing cycle"}</strong></p>
              </article>
            </section>
          )}

          {tier === "pro" && (
            <section className="usage-caps" aria-label="Pro image generation usage">
              <article className="usage-cap">
                <span>Image generation</span>
                <UsageProgress used={usage.imageGenerationsThisPeriod ?? 0} limit={usage.imageLimit ?? 60} label="image generations this UTC calendar month" />
              </article>
              <article className="usage-cap">
                <span>Document generation</span>
                <UsageProgress used={usage.documentGenerationsThisPeriod ?? 0} limit={Infinity} label="document generations this calendar month, unlimited" />
              </article>
            </section>
          )}

          <section className="credit-purchase" aria-labelledby="credit-purchase-title">
            <div className="credit-purchase__intro">
              <p className="ui-eyebrow">Flex Credits</p>
              <h2 id="credit-purchase-title">Keep going without changing plans</h2>
              <p>Credits do not expire. Token caps apply to chat and Study even when you have Flex Credits. On Plus or Pro, image generations beyond the plan allowance cost 3 credits and documents cost 1 credit. Free cannot use credits to unlock image or document generation.</p>
            </div>
            <div className="credit-balance" aria-label={`${usage.creditBalance ?? 0} Flex Credits available`}>
              <strong>{(usage.creditBalance ?? 0).toLocaleString()}</strong>
              <span>available credits</span>
            </div>
            {isNativeApp ? (
              <p className="note">Flex Credit purchases are currently available on VibhavGPT web only.</p>
            ) : <div className="credit-purchase__controls">
              <div className="credit-presets" aria-label="Preset credit purchase amounts">
                {CREDIT_PRESETS.map((amount) => (
                  <button key={amount} type="button" className="btn btn--secondary" disabled={creditBusy} onClick={() => buyCredits(amount)}>
                    ${amount} <small>{amount * 10}</small>
                  </button>
                ))}
              </div>
              <form className="credit-custom" onSubmit={(event) => { event.preventDefault(); buyCredits(creditAmount); }}>
                <label htmlFor="credit-amount">Custom amount</label>
                <div className="credit-custom__input"><span aria-hidden="true">$</span><input id="credit-amount" type="number" min="1" max="500" step="0.10" inputMode="decimal" value={creditAmount} onChange={(event) => setCreditAmount(event.target.value)} /></div>
                <button className="btn btn--primary" disabled={creditBusy}>{creditBusy ? "Opening…" : "Buy credits"}</button>
              </form>
              <small>Custom purchases can be $1 to $500 in $0.10 increments.</small>
            </div>}
          </section>

          <section className="credit-purchase-history" aria-labelledby="credit-purchase-history-title">
            <div>
              <p className="ui-eyebrow">Purchase history</p>
              <h2 id="credit-purchase-history-title">Flex Credit purchases</h2>
            </div>
            {creditPurchasesLoading ? <p className="credit-purchase-history__empty">Loading purchases…</p> : creditPurchases.length === 0 ? (
              <p className="credit-purchase-history__empty">No Flex Credit purchases yet.</p>
            ) : (
              <ul className="credit-purchase-history__list">
                {creditPurchases.map((purchase) => {
                  const date = purchase.purchasedAt ? new Date(purchase.purchasedAt) : null;
                  const amount = Number.isFinite(purchase.amountCents) ? `$${(purchase.amountCents / 100).toFixed(2)}` : "Amount unavailable";
                  return (
                    <li key={purchase.id}>
                      <div>
                        <strong>{amount}</strong>
                        <span>{date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "Purchase date unavailable"}</span>
                      </div>
                      <div className="credit-purchase-history__credits">
                        <span>{purchase.creditsGranted.toLocaleString()} credits</span>
                        {purchase.receiptUrl && <a href={purchase.receiptUrl} target="_blank" rel="noreferrer">View receipt</a>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

        </>
      )}

      <button type="button" className="btn btn--ghost usage-page__back" onClick={onOpenSettings}>Back to settings</button>
      <SettingsFooter onLegal={onLegal} />
    </main>
  );
}

/* -- Billing -------------------------------------------------------------- */

const PLANS = PRODUCT_KNOWLEDGE.plans.map((plan) => ({ ...plan, featured: plan.id === "plus" }));

function AccessNotice({ access, onAction, onDismiss }) {
  if (!access) return null;
  if (access.reason === "quota") return <section className="usage-notice" role="status" aria-label={`${access.feature} usage limit`}>
    <div className="usage-notice__copy">
      <span className="usage-notice__eyebrow">Usage allowance</span>
      <h2>{access.feature} {access.window === "rolling" ? "5-hour" : access.window === "monthly" ? "monthly" : "usage"} limit</h2>
      {access.percentage !== null && access.percentage !== undefined && <p className="usage-notice__percentage">You've used {access.percentage}% of your {access.feature} {access.window === "rolling" ? "5-hour" : "monthly"} limit.</p>}
      <p>{access.message}</p>
      <p className="usage-notice__timing">{access.resetAt ? `Tokens start freeing up ${new Date(access.resetAt).toLocaleString()}.` : access.window === "rolling" ? "Tokens free up as earlier usage leaves the 5-hour window." : "Check usage for your allowance reset."}{access.pending > 0 ? " Pending usage is included in your allowance." : ""}</p>
    </div>
    <div className="usage-notice__actions">
      <button type="button" className="btn btn--primary usage-notice__usage" onClick={() => onAction("usage")}><BarChart3 size={16} aria-hidden="true" />View usage<ChevronRight size={14} aria-hidden="true" /></button>
      <button type="button" className="btn btn--quiet usage-notice__dismiss" onClick={onDismiss}>Dismiss</button>
    </div>
  </section>;
  return <div className="banner" role="status">
    <span>{access.message}{access.requiredPlan ? ` Available with ${access.requiredPlan}.` : ""}
      {access.resetAt ? ` Resets ${new Date(access.resetAt).toLocaleString()}.` : ""}</span>{" "}
    {!["retry", "permission"].includes(access.action) && <button className="btn btn--secondary" onClick={() => onAction(access.action)}>{access.cta}</button>}
    <button className="btn btn--quiet" aria-label="Dismiss notice" onClick={onDismiss}>Dismiss</button>
  </div>;
}

export function PublicPricing({ signedIn = false }) {
  return <><nav className="public-nav"><Brand /><a className="btn btn--primary" href={signedIn ? "/app" : "/signup"}>{signedIn ? "Open workspace" : "Get started"}</a></nav><Billing tier="visitor" publicPreview /></>;
}

function Billing({ tier, userId, onEntitlementChanged, publicPreview = false }) {
  const [period, setPeriod] = useState("monthly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [subscription, setSubscription] = useState(null);
  const [subscriptionLoaded, setSubscriptionLoaded] = useState(publicPreview);
  const [subscriptionLoadError, setSubscriptionLoadError] = useState(false);
  const [manageBusy, setManageBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  useEffect(() => {
    if (publicPreview) return;
    let mounted = true;
    let version = 0;
    const refresh = () => {
      const requestId = ++version;
      setSubscriptionLoaded(false);
      setSubscriptionLoadError(false);
      return api("/api/billing/subscription")
      .then(({ subscription: value }) => {
        if (mounted && requestId === version) { setSubscription(value); setSubscriptionLoaded(true); }
      })
      .catch(() => { if (mounted && requestId === version) setSubscriptionLoadError(true); });
    };
    void refresh();
    window.addEventListener("vibhavgpt:subscription-changed", refresh);
    window.addEventListener("focus", refresh);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { mounted = false; window.removeEventListener("vibhavgpt:subscription-changed", refresh); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [publicPreview, userId]);

  const annual = period === "yearly";
  const checkingPlan = tier === null || !subscriptionLoaded;
  // Plans are bought and managed on the web. A plan bought earlier in the
  // Android app can't be changed here; it runs to the end of its paid period.
  const appSubscription = Boolean(subscription?.billingSource && subscription.billingSource !== "stripe");

  // Checks the server's record until it shows the plan, for up to 20 seconds.
  async function waitForPlan(planId) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const latest = await api("/api/billing/subscription", { cache: "no-store" }).catch(() => null);
      if (latest?.subscription?.tier === planId) return true;
    }
    return false;
  }

  async function purchase(planId) {
    if (publicPreview) { window.location.assign("/app?billing"); return; }
    if (checkingPlan || tier === planId) return;
    setBusy(true);
    setError("");
    try {
      const priceLookupKey = `vibhavgpt_${planId}_${annual ? "yearly" : "monthly"}`;
      const result =
        tier && tier !== "free"
          ? await api("/api/billing/change-plan", { method: "POST", body: JSON.stringify({ priceLookupKey }) })
          : await api("/api/billing/checkout", { method: "POST", body: JSON.stringify({ priceLookupKey, returnToApp: Capacitor.isNativePlatform() }) });
      if (result.url) {
        if (Capacitor.isNativePlatform()) await Browser.open({ url: result.url });
        else window.location.assign(result.url);
      }
      else if (result.pending) {
        // The server never grants a plan from this request: the new plan
        // starts once the payment is confirmed, so wait for that before
        // showing it.
        setNotice(result.trialing ? "Updating your trial…" : "Confirming your payment. Your new plan starts as soon as it goes through.");
        if (await waitForPlan(planId)) window.location.reload();
        else {
          setNotice("");
          setError("Your payment is still being confirmed. Refresh in a moment, or contact support if your plan doesn't change.");
        }
      }
    } catch (err) {
      const message = typeof err?.message === "string" ? err.message : "";
      setError(message || "Checkout could not be started. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function cancelPlan() {
    setManageBusy(true);
    setError("");
    try {
      const result = await api("/api/billing/cancel", { method: "POST" });
      setSubscription((current) => ({ ...current, ...result.subscription }));
      setCancelOpen(false);
    } catch (err) {
      setError(err.message || "Could not cancel the plan.");
    } finally {
      setManageBusy(false);
    }
  }

  async function openBillingPortal() {
    setManageBusy(true);
    setError("");
    try {
      const result = await api("/api/billing/portal", { method: "POST" });
      if (!result.url) throw new Error("The billing portal could not be opened.");
      window.location.assign(result.url);
    } catch (err) {
      setError(err.message || "The billing portal could not be opened.");
      setManageBusy(false);
    }
  }


  return (
    <main className="page page--wide pricing">
      <header className="pricing__header">
        <div>
          <h1 className="pricing__title"><RevealWords text="Plans" /></h1>
          <p className="pricing__lede">{appSubscription ? "Your current plan was bought in the Android app. It stays active until the end of its paid period, and you can choose a plan here after that." : publicPreview ? "Compare Free, Plus and Pro for AI chat, image creation and Study. Start free, choose monthly or yearly billing, and change or cancel your plan when you need to." : "Start free. Move up when you need more room, and change or cancel any time."}</p>
        </div>
        {subscriptionLoaded && !appSubscription && (
          <div className="pricing__period">
            <Segmented
              label="Billing period"
              value={period}
              onChange={setPeriod}
              options={[
                { value: "monthly", label: "Monthly" },
                { value: "yearly", label: "Yearly" },
              ]}
            />
            <span className="pricing__saving">Yearly saves about {yearlySaving(PLANS[1].monthly, PLANS[1].yearly)}%</span>
          </div>
        )}
      </header>

      {subscriptionLoaded && !appSubscription && <>
      <div className="plans rate-card">
        {PLANS.map((plan) => {
          const current = tier === plan.id || (tier === "paid" && plan.id === "pro");
          const price = annual ? plan.yearly : plan.monthly;
          const isDowngrade = tier === "pro" && plan.id === "plus";
          return (
            <article className="plan rate-card__plan" key={plan.id} data-current={current || undefined} data-featured={plan.featured || undefined}>
              <div className="plan__head">
                <h2 className="plan__name">{plan.name}</h2>
                {current ? <span className={`tag tag--${plan.id}`}>Current</span> : plan.featured ? <span className="tag tag--plus">Popular</span> : null}
              </div>
              <p className="plan__price">
                {plan.id === "free" ? "$0" : price}
                <small>{plan.id === "free" ? "forever" : `per ${annual ? "year" : "month"}`}</small>
              </p>
              <p className="plan__equivalent">{plan.id !== "free" && annual ? `About ${monthlyEquivalent(plan.yearly)} a month` : " "}</p>
              <p className="plan__blurb">{plan.description}</p>
              {current ? (
                <p className="plan__current" role="status"><Check size={16} strokeWidth={2.4} aria-hidden="true" />You're on {plan.name}.</p>
              ) : plan.id === "free" ? (
                <p className="plan__current plan__current--quiet">Included with every account.</p>
              ) : (
                <button
                  className={`btn ${plan.featured ? "btn--primary" : "btn--secondary"} btn--block`}
                  disabled={busy || manageBusy || checkingPlan}
                  onClick={() => purchase(plan.id)}
                >
                  {checkingPlan ? "Checking…" : busy || manageBusy ? "Opening checkout…" : isDowngrade ? "Move to Plus" : `Choose ${plan.name}`}
                </button>
              )}
            </article>
          );
        })}
      </div>

      <section className="compare" aria-labelledby="compare-title">
        <h2 id="compare-title" className="compare__title">Compare plans</h2>
        <div className="compare__scroll">
          <table className="compare__table">
            <thead>
              <tr>
                <td />
                {PLANS.map((plan) => <th key={plan.id} scope="col" data-current={(tier === plan.id || (tier === "paid" && plan.id === "pro")) || undefined}>{plan.name}</th>)}
              </tr>
            </thead>
            {COMPARISON_GROUPS.map((group) => (
              <tbody key={group.title}>
                <tr className="compare__group"><th scope="rowgroup" colSpan={PLANS.length + 1}>{group.title}</th></tr>
                {group.rows.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}{row.note && <small>{row.note}</small>}</th>
                    {row.values.map((value, index) => (
                      <td key={PLANS[index].id}>
                        {value === true ? <Check size={16} strokeWidth={2.4} aria-label="Included" />
                          : value ? value
                          : <span className="compare__none" aria-label="Not included">–</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
        <p className="compare__footnote">Input and output tokens both count toward an allowance. Monthly allowances reset on the first of the month at 00:00 UTC, and each model also has a rolling five-hour limit. Subscriptions and Flex Credits are bought on the web.</p>
      </section>

      <aside className="pricing__guarantee">
        <h2>Every plan comes with the VibhavGPT Guarantee</h2>
        <p>We never train on your chats. We never sell your data. We never show ads. Export everything or delete your account whenever you like.</p>
        <a href="/guarantee">Read the Guarantee</a>
      </aside>
      {publicPreview && <PublicFaq path="/pricing" />}
      {publicPreview && <footer className="note" style={{ color: "var(--muted)", marginTop: 24 }}>Made by Vibhav Thoota</footer>}
      </>}

      {publicPreview ? null : checkingPlan ? (
        <section className="subscription" aria-label="Current plan and billing">
          {subscriptionLoadError ? <p role="alert">Your subscription could not be checked. Refresh to try again.</p> : <p role="status">Checking your subscription…</p>}
        </section>
      ) : subscription ? (
        <section className="subscription" aria-label="Current plan and billing">
          <div>
            <p className="ui-eyebrow">Current plan</p>
            <strong>{TIER_LABEL[subscription.tier] ?? "Free"} plan</strong>
            <span>{appSubscription ? "Bought in the Android app" : "Billed on the web"}</span>
            <span>
              {subscription.status}
              {subscription.currentPeriodEndsAt ? ` · ${subscription.cancelAtPeriodEnd || appSubscription ? "access through" : ["active", "trialing"].includes(subscription.status) ? "renews" : "ended"} ${new Date(subscription.currentPeriodEndsAt).toLocaleDateString()}` : ""}
            </span>
          </div>
          {!appSubscription && (
            <div className="subscription__actions">
              <button type="button" className="btn btn--secondary" disabled={manageBusy} onClick={openBillingPortal}>
                Payment method & invoices
              </button>
              {["active", "trialing"].includes(subscription.status) && (
                <button
                  type="button"
                  className="btn btn--quiet"
                  disabled={manageBusy || subscription.cancelAtPeriodEnd}
                  onClick={() => setCancelOpen(true)}
                >
                  {subscription.cancelAtPeriodEnd ? "Cancellation scheduled" : "Cancel plan"}
                </button>
              )}
            </div>
          )}
        </section>
      ) : (
        <section className="subscription" aria-label="Current plan and billing">
          <div><p className="ui-eyebrow">Current plan</p><strong>Free plan</strong><span>No active subscription.</span></div>
        </section>
      )}

      {error && <p className="note note--error" role="alert">{error}</p>}

      {notice && <p className="note note--good" role="status">{notice}</p>}
      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        eyebrow="Subscription"
        title="Cancel at the period end?"
        description="You keep full access until the current billing period ends, then drop to Free."
      >
        <div className="ui-modal__actions">
          <button type="button" className="btn btn--ghost" disabled={manageBusy} onClick={() => setCancelOpen(false)}>Keep my plan</button>
          <button type="button" className="btn btn--danger" disabled={manageBusy} onClick={cancelPlan}>
            {manageBusy ? "Cancelling…" : "Cancel plan"}
          </button>
        </div>
      </Modal>
    </main>
  );
}
