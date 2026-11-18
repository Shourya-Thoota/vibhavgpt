import { Children, createContext, Fragment, isValidElement, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { App as CapacitorApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import ReactMarkdown from "react-markdown";
import { attachmentGuidance, perFileProblem } from "./upload-guidance.js";
import BuildThreads from "./components/threads/BuildThreads.jsx";
import BuildProject from "./components/BuildProject.jsx";
import { visibleBuildStream } from "./build-stream.js";
import { IMAGES_PER_MONTH, IMAGES_PER_WEEK, countText } from "./plan-entitlements.js";
import { backgroundReply, liveRepliesSnapshot, liveReplyForConversation, readReplyEvents, seedLiveReplies, subscribeLiveReplies, trackLiveReply, untrackLiveReply } from "./live-replies.js";
import remarkGfm from "remark-gfm";
import { loadedMath, loadMath, needsMath } from "./math-loader.js";
import {
  AlignJustify, AlignLeft, ArrowLeft, ArrowRight, ArrowUp, BarChart3, Brain, Check, ChevronDown, ChevronRight, Copy, CreditCard, Eye, EyeOff, FileText, Fingerprint,
  Image as ImageIcon, Layers, LogOut, MapPin, Mail, Menu as MenuIcon, Mic,
  Moon, Paperclip, Plug, Plus, RotateCw, Settings as SettingsIcon,
  Download, Lock, MessageSquareText, Palette, Search, ShieldCheck, SlidersHorizontal, Sparkles, SquarePen, Sun, Trash2, UserRound, X,
  PenLine, ScanSearch, Wand2, BookOpen, GraduationCap, ListChecks,
  HatGlasses, Square,
} from "lucide-react";
import { canonicalModelKey } from "./token-quotas.js";
import SecurityPanel from "./components/SecurityPanel.jsx";
import ImageWorkspace from "./components/ImageWorkspace.jsx";
import { imageJobs } from "./image-jobs.js";
import Sidebar from "./components/Sidebar.jsx";
import ChatSearch from "./components/ChatSearch.jsx";
import KeyboardShortcutsDialog from "./components/KeyboardShortcutsDialog.jsx";
import { launchPathFromLink, shortcutForEvent } from "./keyboard-shortcuts.js";
import ProfilePicture from "./components/ProfilePicture.jsx";
import Library from "./components/Library.jsx";
import SavedAvatars from "./components/SavedAvatars.jsx";
import LocationSettings from "./components/LocationSettings.jsx";
import ConnectorsSettings from "./components/ConnectorsSettings.jsx";
import ActionApprovalCard from "./components/ActionApprovalCard.jsx";
import ModelSelector from "./components/catalog/ModelSelector.jsx";
import Extensions from "./components/extensions/Extensions.jsx";
import {
  ComposerMentionChips,
  ComposerMentionsPopover,
  connectorDisplayName,
  detectMentionTrigger,
  filterConnectorsForPicker,
  filterSkillsForPicker,
} from "./components/composer/ComposerMentions.jsx";
import MentionMirror from "./components/composer/MentionMirror.jsx";
import { useMentionedDraft } from "./components/composer/useMentionedDraft.js";
import { connectorsFromMentions } from "./composer-mentions.js";
import { useDrawerSwipe } from "./components/useDrawerSwipe.js";
import { useSidebarWidth } from "./components/useSidebarWidth.js";
import { visibleAppLinks } from "./desktop-app.js";
import { PublicNav } from "./components/PublicNav.jsx";
import "./study.css";
import "./auth.css";
import "./signin.css";
import "./composer.css";
import "./cosmos.css";
import "./settings.css";
import "./pricing.css";
import "./plans-clean.css";
import { BUILD_MODEL, buildIncluded, productModeFromPath, productPath, STUDY_TAGLINES, STUDY_STARTERS } from "./product-modes.js";
import { passkeysSupported, signInWithPasskey as runPasskeySignIn } from "./passkey-auth.js";
import { Banner, MenuGroup, BottomSheet, ChoiceCards, dismissTopOverlay, Field, IconButton, Menu, MenuItem, MenuSeparator, Modal, NARROW_QUERY, Segmented, Select, SettingsSelect, useMediaQuery } from "./components/ui.jsx";
import { RevealWords, TypingDots, useTypewriter } from "./components/Typing.jsx";
import { copyText } from "./clipboard.js";
import { joinDictation, useDictation } from "./dictation.js";
import { protectPlainDollarSigns, normalizeTexDelimiters } from "./markdown.js";
import { emailOtpVerificationRequest } from "./auth-code-endpoint.js";
import { api, apiRequest, responseError } from "./api.js";
import { accessStatus } from "./access-status.js";
import WorkspaceNotice from "./components/notice/WorkspaceNotice.jsx";
import { PrivateFileLink, PrivateImage, ResourceLink, saveFile } from "./components/PrivateMedia.jsx";
import { ThinkingTool } from "./components/ui/thinking-tool.jsx";
import { LiveStatusLabel, ReasoningTrace } from "./components/ui/reasoning-trace.jsx";
import { SourcesDisclosure } from "./components/ui/sources-disclosure.jsx";
import { citationLabel, remarkCitations, sourcesByNumber } from "./citations.js";
import { ImagePromptDisclosure } from "./components/ui/image-prompt-disclosure.jsx";
import { elapsedSeconds } from "./live-status.js";
import { applyPageMetadata } from "./seo.js";
import { DELETION_PLAN_NOTICE } from "./public-pages.js";
import { PublicFaq } from "./components/PublicPageDetails.jsx";
import { resetPageScroll } from "./page-scroll.js";
import { SETTINGS_SECTIONS, settingsPath, settingsRoute } from "./settings-routes.js";
import { updateStatusLabel, updateStore } from "./desktop-updates.js";
import { parseStudyBlock, STUDY_BLOCK_LANGUAGES } from "./study-widgets.js";
import InteractiveFlashcards from "./components/InteractiveFlashcards.jsx";
import InteractiveQuiz from "./components/InteractiveQuiz.jsx";
import StudyWritingTools from "./components/StudyWritingTools.jsx";
import { createReplyLabels } from "./model-labels.js";
import { DiscordMark, GitHubMark, MicrosoftMark } from "./components/SocialSignInMarks.jsx";
import {
  HOUSE_INTELLIGENCE, HOUSE_MIN_PLAN, HOUSE_MODELS, HOUSE_PLAN_COPY, INTELLIGENCE_LABELS, INTELLIGENCE_TONES, RETIRED_HOUSE_NAMES, isRetiredHouseKey,
  PICKER_SECTIONS, PROVIDER_MARK_FILES, COLOR_MARKS, RETIRED_THIRD_PARTY_IDS, RETIRED_THIRD_PARTY_NAMES, inheritedThinkingLevel, thirdPartyReplacement, THIRD_PARTY_BILLING_NOTE, THIRD_PARTY_MODELS, THIRD_PARTY_PROVIDERS, THINKING_LEVEL_LABELS, currentThirdPartyKey, marketplaceThinking, resolveMarketplaceThinking, intelligenceRank, providerLogo, providerName, thirdPartyPlanCopy,
} from "./model-marketplace.js";
import { mergeOlderPage, messageKey, restoredScrollTop } from "./conversation-pages.js";
import DiagramViewer from "./components/DiagramViewer.jsx";
import { isDiagramLanguage } from "./diagrams.js";
import { productKnowledgeFor } from "./product-knowledge.js";
import { FLEX_DASHBOARD_BLURB_CREDITS, FLEX_DASHBOARD_BLURB_LEGACY, USAGE_NAV_DESCRIPTION_LEGACY, creditsPricingFootnote, usageNavDescription, usageSettingsDescription } from "./credits-copy.js";
import { useCreditsMode } from "./credits-runtime.js";
import { CreditPurchase } from "./components/CreditPurchase.jsx";
import { usageCounters } from "./usage-counters.js";
import { usagePercentage, combinedTokenUsage } from "./usage-percentage.js";
import { interruptedStreamMessage } from "./stream-recovery.js";
import { createReplyStreamGuard } from "./reasoning-guard.js";
import SiteFooter from "./components/SiteFooter.jsx";
import EligibilityGate from "./components/EligibilityGate.jsx";
import { DEFAULT_UNIFIED_LEVEL, THINKING_CHOICES, toUnified, unifiedLabel } from "./thinking-levels.js";
import { THEME_KEYS, THEME_CHOSEN_KEY, readSurfaceThemes, surfaceForView } from "./theme-surfaces.js";
import { ChatTopography } from "./components/ChatTopography.jsx";
import { MOTION_KEY, STUDY_TOPOGRAPHY_KEY, TOPOGRAPHY_KEY, readMotionPreference, readStudyTopographyPreference, readTopographyPreference, resolveReducedMotion } from "./chat-topography.js";
// Development-only catalog preview.
// The dev-only catalog preview and the "Browse models" modal are retired (Slice 7): the composer's picker, fed by the model catalog
// API, is the one model picker.
import "./components/catalog/catalog.css";
import { AllowancePanel } from "./components/allowance/AllowancePanel.jsx";
import { AllowanceExhaustedNotice } from "./components/allowance/AllowanceExhaustedNotice.jsx";
import { allowanceViewFromChatError } from "./components/allowance/allowance-view.js";
import { isAllowanceUiEnabled } from "./components/allowance/allowance-gate.js";
import "./components/allowance/allowance.css";
import "./chat-reference.css";
import "./compact.css";
import "./menus.css";
import "./usage-limits.css";
import Onboarding, { PersonalitySlider } from "./components/Onboarding.jsx";
import {
  accentForTheme, CAPABILITY_OPTIONS, landingModeFor, mergeInstructions, personalityHeadline,
  defaultOnboarding, EXPERTISE_OPTIONS, onboardingForUser, PERSONALITY_AXES, readOnboarding, responseStyleForPersonality, ROLE_OPTIONS, stripManagedInstructions,
  THEME_OPTIONS, UNIT_OPTIONS, writeOnboarding,
} from "./onboarding.js";
import { checkDirectAndroidUpdate } from "./direct-distribution.js";
import { NAMELESS_GREETING, workspaceNames } from "./display-names.js";
import { comparisonGroupsFor, monthlyEquivalent, yearlySaving } from "./plan-comparison.js";
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

async function startNativeSocialSignIn(provider) {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const verifierHash = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  // localStorage rather than memory: Android may kill the backgrounded app
  // while the browser is open, and the return link then cold-starts it.
  localStorage.setItem(NATIVE_OAUTH_VERIFIER_KEY, verifier);
  const { url } = await api(`/api/native-auth/${encodeURIComponent(provider)}/start`, { method: "POST", body: JSON.stringify({ verifierHash }) });
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
      // A launcher shortcut (Android res/xml/shortcuts.xml): vibhavgpt://open/app/chat, image or build, and nothing else.
      const launch = launchPathFromLink(url);
      if (launch) { window.location.assign(launch); return; }
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
  { id: "light", label: "Daybreak", description: "Light grey grounds and dark ink." },
  { id: "dark", label: "Deep Space", description: "Deep neutral grounds and light ink." },
];

const prefersLight = () => window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;

// Deep Space is the default sky. Older builds saved "system" for every reader
// who never opened the setting, so "system" counts only once the reader has
// picked a sky themselves (vibhavgpt-theme-chosen). Mirrors
// theme/appearance-boot.js. Chat and Study each keep their own sky (theme-surfaces.js).
function resolveSavedThemes() {
  try { return readSurfaceThemes(localStorage); } catch { return { chat: "dark", study: "dark" }; }
}

// Appearance lives above sign-in so the login screen honours it too. Theme and
// accent are independent: theme picks the sky, accent picks the light running
// through it, and the accent's value depends on which sky resolved.
function useAppearance() {
  const [accentId, setAccentIdLocal] = useState(() => localStorage.getItem("vibhavgpt-accent") || "ember");
  // The reader's choice is also saved to the account, so it follows them to another device. Signed out there is no account:
  // the request is refused and the choice stays on this device only until they sign in.
  const setAccentId = useCallback((id) => {
    setAccentIdLocal(id);
    api("/api/me/preferences", { method: "PATCH", body: JSON.stringify({ accent: id }) }).catch(() => {});
  }, []);
  // Adopting the account's accent, or going back to the default, is not a choice to save.
  const adoptAccent = useCallback((id) => setAccentIdLocal(ACCENTS.some((option) => option.id === id) ? id : "ember"), []);
  // Chat and Study each have their own sky. `surface` is the one on screen (see surfaceForView); `themeId` is its choice.
  const [themeIds, setThemeIds] = useState(resolveSavedThemes);
  const [surface, setSurface] = useState("chat");
  const themeId = themeIds[surface];
  // Every sky the reader picks (Settings, onboarding) goes through here, so a later
  // "Match system" is known to be deliberate. One surface's choice leaves the other's alone.
  const setSurfaceTheme = useCallback((which, value) => {
    try { localStorage.setItem(THEME_CHOSEN_KEY, "1"); localStorage.setItem(THEME_KEYS[which], value); } catch { /* storage blocked */ }
    setThemeIds((current) => ({ ...current, [which]: value }));
  }, []);
  // The setup questions ask once, for the app as a whole: that sets both.
  const setThemeId = useCallback((value) => { setSurfaceTheme("chat", value); setSurfaceTheme("study", value); }, [setSurfaceTheme]);
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
  }, [resolved]);
  useEffect(() => {
    try { localStorage.setItem(THEME_KEYS.chat, themeIds.chat); localStorage.setItem(THEME_KEYS.study, themeIds.study); } catch { /* storage blocked */ }
  }, [themeIds]);

  // The boot script in each HTML entry already set data-accent before first
  // paint; this keeps it in step with the picker from then on.
  useEffect(() => {
    const accent = ACCENTS.find((option) => option.id === accentId) ?? ACCENTS[0];
    document.documentElement.setAttribute("data-accent", accent.id);
    localStorage.setItem("vibhavgpt-accent", accent.id);
  }, [accentId]);

  // Glass or solid floating controls. The boot script applies the saved
  // choice before first paint; this keeps it in step with the setting.
  const [effects, setEffects] = useState(() => {
    try { return localStorage.getItem("vibhavgpt-effects") === "solid" ? "solid" : "glass"; } catch { return "glass"; }
  });
  useEffect(() => {
    if (effects === "solid") document.documentElement.setAttribute("data-effects", "solid");
    else document.documentElement.removeAttribute("data-effects");
    try { localStorage.setItem("vibhavgpt-effects", effects); } catch { /* storage blocked */ }
  }, [effects]);

  // Chat's decorative background (contour lines behind the conversation): on unless this device turned it off. It sits over the sky
  // and never replaces it, and Study never shows it.
  const [topography, setTopographyState] = useState(() => { try { return readTopographyPreference(localStorage); } catch { return "on"; } });
  const setTopography = useCallback((value) => {
    const next = value === "off" ? "off" : "on";
    setTopographyState(next);
    try { localStorage.setItem(TOPOGRAPHY_KEY, next); } catch { /* storage blocked */ }
  }, []);

  // Study's own contour background, chosen separately (off unless turned on here).
  const [studyTopography, setStudyTopographyState] = useState(() => { try { return readStudyTopographyPreference(localStorage); } catch { return "on"; } });
  const setStudyTopography = useCallback((value) => {
    const next = value === "on" ? "on" : "off";
    setStudyTopographyState(next);
    try { localStorage.setItem(STUDY_TOPOGRAPHY_KEY, next); } catch { /* storage blocked */ }
  }, []);

  // Motion: follow the device, or stop background movement, or allow it. Applied at once to the whole page (data-motion on <html>).
  const [motion, setMotionState] = useState(() => { try { return readMotionPreference(localStorage); } catch { return "system"; } });
  const [deviceReducesMotion, setDeviceReducesMotion] = useState(() => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } });
  useEffect(() => {
    let list = null;
    try { list = window.matchMedia("(prefers-reduced-motion: reduce)"); } catch { return undefined; }
    const update = () => setDeviceReducesMotion(list.matches);
    list.addEventListener?.("change", update);
    return () => list.removeEventListener?.("change", update);
  }, []);
  const setMotion = useCallback((value) => {
    const next = ["system", "reduce", "full"].includes(value) ? value : "system";
    setMotionState(next);
    try { localStorage.setItem(MOTION_KEY, next); } catch { /* storage blocked */ }
  }, []);
  const reducedMotion = resolveReducedMotion(motion, deviceReducesMotion);
  useEffect(() => {
    if (reducedMotion) document.documentElement.setAttribute("data-motion", "reduce");
    else document.documentElement.removeAttribute("data-motion");
  }, [reducedMotion]);

  return { accentId, setAccentId, adoptAccent, themeId, themeIds, setThemeId, setSurfaceTheme, setSurface, surface, systemTheme, resolved, effects, setEffects, topography, setTopography, studyTopography, setStudyTopography, motion, setMotion, reducedMotion };
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
                <h1 className="auth__title" id="bridge-title">Security check</h1>
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


async function streamChat(payload, onStatus, { signal, onDelta, onConversation, onReply } = {}) {
  let response;
  try {
    response = await apiRequest("/api/chat/stream", {
      method: "POST",
      credentials: "include",
      // X-Reply-Detach: the reply keeps running if this page goes away; it is stopped only by the Stop button (src/chat/live-replies.js).
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-Reply-Detach": "1" },
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
    if (event === "reply") onReply?.(data);
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

/**
 * Follows a reply that is already running (after a reload, or from a chat opened while it runs). Nothing is sent: the reply's events so
 * far are replayed and the rest follow. Returns the complete event, or null when the reply is no longer running (the conversation then
 * has everything that was saved). Throws the reply's own error, if it ended in one.
 */
async function attachReplyStream(replyId, { signal, onStatus, onDelta, onConversation } = {}) {
  let response;
  try {
    response = await apiRequest(`/api/chat/replies/${encodeURIComponent(replyId)}/events?after=0`, { method: "GET", credentials: "include", headers: { Accept: "text/event-stream" }, signal });
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    if (error?.status === 404) return null;
    throw error;
  }
  if (!response.ok || !response.body) return null;
  let complete = null;
  let replayGone = false;
  await readReplyEvents(response, (event, data) => {
    if (event === "status") onStatus?.(data.phase, data);
    if (event === "delta") onDelta?.(data);
    if (event === "conversation") onConversation?.(data);
    if (event === "error") { if (data?.reload) { replayGone = true; return; } throw responseError(data, data.status); }
    if (event === "complete") complete = data;
  });
  return replayGone ? null : complete;
}

// Social sign-in (Slice 8): the page offers only the providers the server says are set up (GET /api/sign-in-options), in this order.
const SOCIAL_SIGN_IN = [
  { id: "google", label: "Google", Mark: () => <GoogleMark /> },
  { id: "github", label: "GitHub", Mark: GitHubMark },
  { id: "microsoft", label: "Microsoft", Mark: MicrosoftMark },
  { id: "discord", label: "Discord", Mark: DiscordMark },
];
const SOCIAL_PROVIDER_KEY = "vibhavgpt-social-provider";
const socialLabel = (id) => SOCIAL_SIGN_IN.find((provider) => provider.id === id)?.label ?? "Social";

// The words for a social sign-in that came back with ?error= (Better Auth's codes, the native app's, and ours).
function socialSignInErrorMessage(code, provider) {
  const label = socialLabel(provider);
  switch (code) {
    case "access_denied":
      return `${label} sign-in was cancelled.`;
    case "email_not_verified":
      return `${label} hasn't verified your email address, so an account can't be created from it. Verify your email with ${label}, or sign up with your email.`;
    case "account_not_linked":
      return `An account with this email already exists, and ${label} hasn't confirmed the email is yours, so we can't sign you in with ${label}. Sign in with your email instead.`;
    default:
      return `${label} sign-in didn't finish. Please try again.`;
  }
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
  const [mode, setMode] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return (params.get("mode") === "signup" || window.location.pathname === "/signup") ? "signup" : "signin";
  });
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
  // The accent saved to the account wins over this device's copy, so a second device shows the same colours.
  useEffect(() => {
    if (user?.accent) appearance.adoptAccent(user.accent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?.accent]);


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
  if (user && window.location.pathname === "/onboarding" && onboardingForUser(user).onboarding_completed) {
    window.history.replaceState(null, "", "/app");
  }
  if (user && (window.location.pathname === "/login" || window.location.pathname === "/signup")) {
    window.history.replaceState(null, "", "/app");
  }
  return user ? (
    <EligibilityGate key={user.id} onLegal={openLegal} onSignOut={async () => { await api("/api/auth/sign-out", { method: "POST" }).catch(() => {}); window.history.replaceState(null, "", "/app"); setUser(null); }}>
    <Workspace
      user={user}
      appearance={appearance}
      onSignOut={async () => {
        await api("/api/auth/sign-out", { method: "POST" });
        // The next person on this device starts from the default accent, not this account's.
        appearance.adoptAccent("ember");
        window.history.replaceState(null, "", "/app");
        setUser(null);
      }}
      onDeleted={() => {
        // The account is gone on the server; nothing of it should stay on
        // this device either. Appearance choices are not account data.
        clearAccountLocalData(user?.id);
        appearance.adoptAccent("ember");
        // On the web, the deletion page confirms it in words; the app shell
        // has no such page, so it returns to sign-in.
        if (!Capacitor.isNativePlatform()) { window.location.replace("/account-deletion?deleted=1"); return; }
        window.history.replaceState(null, "", "/app");
        setUser(null);
      }}
      onLegal={openLegal}
      onUserChange={async () => { const fresh = await api("/api/me", { cache: "no-store" }); if (fresh?.user) setUser(fresh.user); }}
    />
    </EligibilityGate>
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
  const [step, setStep] = useState("password");
  const [signInMethod, setSignInMethod] = useState("password");
  const [factorMethod, setFactorMethod] = useState("otp");
  const [factorMethods, setFactorMethods] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // Which social sign-in is starting (its id), or null.
  const [socialBusy, setSocialBusy] = useState(null);
  const googleBusy = socialBusy !== null;
  // The social sign-in providers the server has set up; none until it answers, so a button never appears that cannot work.
  const [socialProviders, setSocialProviders] = useState([]);
  useEffect(() => {
    let cancelled = false;
    api("/api/sign-in-options")
      .then((options) => { if (!cancelled) setSocialProviders(Array.isArray(options?.socialProviders) ? options.socialProviders : []); })
      .catch(() => { if (!cancelled) setSocialProviders([]); });
    return () => { cancelled = true; };
  }, []);
  // The buttons this page offers: the known providers the server reports, in the page's order (an unknown name shows nothing).
  const offeredSocial = SOCIAL_SIGN_IN.filter((provider) => socialProviders.includes(provider.id));
  const [codeSent, setCodeSent] = useState(false);
  const [resendUntil, setResendUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [passwordResetDialogOpen, setPasswordResetDialogOpen] = useState(false);
  const [passwordResetStep, setPasswordResetStep] = useState("request");
  const [passwordResetEmail, setPasswordResetEmail] = useState("");
  const [passwordResetCode, setPasswordResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [passwordResetNotice, setPasswordResetNotice] = useState("");

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
    // Set by a failed social sign-in (Better Auth's errorURL, or the native app's return link). The provider is the one this page
    // started; an error that arrives without one is worded for Google, the only provider before Slice 8.
    if (params.has("error")) {
      let provider = "google";
      try { provider = sessionStorage.getItem(SOCIAL_PROVIDER_KEY) || localStorage.getItem(SOCIAL_PROVIDER_KEY) || "google"; } catch { /* storage unavailable */ }
      setError(socialSignInErrorMessage(params.get("error"), provider));
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

  async function sendSignInCode(address) {
    const requestedEmail = String(address ?? "").trim().toLowerCase();
    if (!requestedEmail) return;
    setBusy(true);
    resetMessage();
    try {
      await api("/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        body: JSON.stringify({ email: requestedEmail, type: "sign-in" }),
      });
      setEmail(requestedEmail);
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

  async function signInWithProvider(provider) {
    setSocialBusy(provider);
    resetMessage();
    // Remembered so an error that comes back names the right provider (localStorage too: the native app may be restarted on return).
    try { sessionStorage.setItem(SOCIAL_PROVIDER_KEY, provider); localStorage.setItem(SOCIAL_PROVIDER_KEY, provider); } catch { /* storage unavailable */ }
    try {
      if (Capacitor.isNativePlatform()) {
        await startNativeSocialSignIn(provider);
        return;
      }
      const result = await api("/api/auth/sign-in/social", {
        method: "POST",
        // Land in the workspace after sign-in, not on the public homepage that
        // now owns a bare /. A brand-new account opens onboarding from there.
        body: JSON.stringify({ provider, callbackURL: `${window.location.origin}/app`, errorCallbackURL: `${window.location.origin}/app` }),
      });
      if (result?.url) window.location.assign(result.url);
      else setError(`${socialLabel(provider)} sign-in could not be started. Please try again.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setSocialBusy(null);
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
  const emailCode = !signUp && signInMethod === "code";
  const submitEmailCode = (event) => { event.preventDefault(); sendSignInCode(email); };

  return (
    <div className="auth auth--signin">
      <div className="auth__backdrop" aria-hidden="true">
        <span className="auth__blob auth__blob--a" />
        <span className="auth__blob auth__blob--b" />
        <span className="auth__blob auth__blob--c" />
        <span className="auth__dots" />
      </div>
      <main className="auth__main">
        <div className="auth__center">
          <section className="auth__card" aria-labelledby="auth-title">
            <header className="auth__logo"><Brand size="brand--lg" /></header>
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
                    <h1 className="auth__title" id="auth-title">{signUp ? "Create your account" : "Welcome back"}</h1>
                    <p className="auth__subtitle">
                      {signUp
                        ? "One account for chat, study and image creation."
                        : "Your chats, memory and files are where you left them."}
                    </p>
                  </div>
                  {offeredSocial.length > 0 && (
                    <div className="auth__social">
                      {offeredSocial.map(({ id, label, Mark }) => (
                        <button key={id} className={`btn btn--secondary btn--lg btn--block auth__provider auth__${id}`} type="button" data-provider={id} disabled={busy || googleBusy} onClick={() => signInWithProvider(id)}>
                          <Mark />
                          {socialBusy === id ? "Connecting…" : `Continue with ${label}`}
                        </button>
                      ))}
                    </div>
                  )}
                  {offeredSocial.length > 0 && <div className="auth__divider">or</div>}
                  {!signUp && (
                    <Segmented
                      className="auth__method"
                      label="Sign-in method"
                      value={signInMethod}
                      onChange={(next) => { setSignInMethod(next); resetMessage(); }}
                      options={[
                        { value: "password", label: "Password" },
                        { value: "code", label: "Email code" },
                      ]}
                    />
                  )}
                  <form className="auth__form" onSubmit={emailCode ? submitEmailCode : submit}>
                    {signUp && (
                      <Field label="Name" htmlFor="auth-name">
                        <span className="input-affix input-affix--lead">
                          <UserRound className="input-affix__icon" size={17} aria-hidden="true" />
                          <input id="auth-name" className="input" required value={name} autoComplete="name" onChange={(event) => setName(event.target.value)} placeholder="Your name" />
                        </span>
                      </Field>
                    )}
                    <Field label="Email" htmlFor="auth-email">
                      <span className="input-affix input-affix--lead">
                        <Mail className="input-affix__icon" size={17} aria-hidden="true" />
                        <input
                          id="auth-email"
                          className="input"
                          required
                          type="email"
                          value={email}
                          autoComplete={signUp ? "email" : "username webauthn"}
                          onChange={(event) => setEmail(event.target.value)}
                          placeholder="you@example.com"
                        />
                      </span>
                    </Field>
                    {!emailCode && (
                      <Field
                        label="Password"
                        htmlFor="auth-password"
                        aside={!signUp ? (
                          <button
                            className="auth__forgot"
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
                        ) : undefined}
                      >
                        <span className="input-affix input-affix--lead">
                          <Lock className="input-affix__icon" size={17} aria-hidden="true" />
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
                    )}
                    {signUp && (
                      <>
                        {/* The age question and the Terms acceptance come next, for every way of signing up (components/EligibilityGate.jsx). */}
                        <p className="auth__consent">
                          After you create your account, we’ll ask your month and year of birth and for you to accept our{" "}
                          <LegalLink page="terms" onOpen={onLegal}>Terms of Service</LegalLink> and{" "}
                          <LegalLink page="privacy" onOpen={onLegal}>Privacy Policy</LegalLink>.
                        </p>
                      </>
                    )}
                    {/* The bot check guards the password and create-account forms; asking for an email code needs none. */}
                    {!emailCode && (
                      <TurnstileWidget
                        key={`${signUp}-${turnstileCycle}`}
                        resetKey={turnstileCycle}
                        theme={theme}
                        onToken={handleTurnstileToken}
                        onError={handleTurnstileError}
                      />
                    )}
                    {!emailCode && turnstileError && (
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
                    <button className="btn btn--primary btn--lg btn--block auth__submit" disabled={busy || googleBusy || (emailCode && !email.trim())}>
                      {busy ? "One moment…" : (<>{emailCode ? "Email me a code" : signUp ? "Create account" : "Sign in"}<ArrowRight size={16} aria-hidden="true" /></>)}
                    </button>
                  </form>
                  {/* Offered only where the browser can run passkeys at all; any
                      warning appears only after someone chooses it. */}
                  {!signUp && passkeysSupported() && (
                    <button className="btn btn--secondary btn--lg btn--block auth__passkey" type="button" disabled={busy || googleBusy} onClick={signInWithPasskey}>
                      <Fingerprint size={17} aria-hidden="true" /> Use a passkey
                    </button>
                  )}
                </>
              )}
            </div>
          </section>
          {!codeStep && (
            <p className="auth__switchline">
              {signUp ? "Already have an account?" : "New to VibhavGPT?"}{" "}
              <button type="button" className="auth__switchlink" onClick={() => switchMode(signUp ? "signin" : "signup")}>{signUp ? "Sign in" : "Create account"}</button>
            </p>
          )}
        </div>
      </main>

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

// The picker's lineup (model-marketplace.js): the house models first, then each provider's third-party models under the provider's
// name. Each row is the maker's mark, the exact name, one line on what it is for, and a lock with "Upgrade" or a check; no badges.
// Study is a product mode, not a row. The marks are local files (frontend/public/brand), never hotlinked.
const HOUSE_GROUP = { id: "house", label: "VibhavGPT" };
const BRAND_MARKS = { vibhavgpt: BRAND_ICON, ...PROVIDER_MARK_FILES };
// The makers' official marks are single-colour (black on transparent); data-mono lets the dark sky draw them in white.
const MONO_MARKS = new Set(Object.keys(PROVIDER_MARK_FILES).filter((logo) => !COLOR_MARKS.includes(logo)));
function BrandMark({ logo, size = 20 }) {
  const src = BRAND_MARKS[logo] ?? BRAND_ICON;
  return <img className="model-brand" data-brand={logo} data-mono={MONO_MARKS.has(logo) || undefined} src={src} width={size} height={size} alt="" aria-hidden="true" decoding="async" draggable="false" />;
}
// The mark above a reply: the maker's for a third-party model (GPT-6: OpenAI; GLM: Z.AI), VibhavGPT's for the house tiers and Study.
// A retired third-party id reads as its replacement's maker, which is the same maker.
function replyLogo(modelKey) {
  const entry = THIRD_PARTY_MODELS.find((model) => model.id === currentThirdPartyKey(modelKey));
  return entry ? providerLogo(entry.provider) ?? "vibhavgpt" : "vibhavgpt";
}
function ReplyMark({ model }) {
  const logo = replyLogo(model);
  return <span className="turn__mark" data-brand={logo}><img src={BRAND_MARKS[logo] ?? BRAND_ICON} data-mono={MONO_MARKS.has(logo) || undefined} alt="" /></span>;
}
const intelligenceBadge = (level) => ({ label: INTELLIGENCE_LABELS[level], tone: INTELLIGENCE_TONES[level] });
const MODELS = HOUSE_MODELS.map((entry) => ({
  value: entry.id,
  label: entry.name,
  full: `VibhavGPT ${entry.name}`,
  description: entry.description,
  badges: [intelligenceBadge(HOUSE_INTELLIGENCE[entry.id])],
  house: true,
  logo: "vibhavgpt",
  lockedCopy: HOUSE_PLAN_COPY[entry.id],
  group: HOUSE_GROUP,
}));
// Every third-party model the app knows; the picker shows the ones the server lists now (guard verified, capable, live price known).
const THIRD_PARTY_OPTIONS = THIRD_PARTY_MODELS.map((entry) => ({
  value: entry.id,
  label: entry.name,
  full: entry.name,
  description: entry.description,
  badges: [intelligenceBadge(entry.intelligence)],
  house: false,
  providerLabel: providerName(entry.provider),
  logo: providerLogo(entry.provider),
  minPlan: entry.minPlan,
  lockedCopy: thirdPartyPlanCopy(entry.id),
  group: { id: entry.provider, label: providerName(entry.provider) },
}));
// A provider's section header is drawn only when enough of its models are listed (GPT-6: two or more); otherwise its rows stand alone.
function withSectionHeaders(entries) {
  const counts = entries.reduce((map, entry) => map.set(entry.group?.id, (map.get(entry.group?.id) ?? 0) + 1), new Map());
  return entries.map((entry) => {
    const provider = THIRD_PARTY_PROVIDERS.find((item) => item.id === entry.group?.id);
    if (!provider || (counts.get(provider.id) ?? 0) >= (provider.headerMinEntries ?? 1)) return entry;
    return { ...entry, group: { id: entry.group.id, label: null } };
  });
}
// Saved replies are labeled by the model that wrote them (model-labels.js): a third-party reply by its own name.
// A reply saved under a retired third-party id keeps that model's own name (it is never relabelled as its replacement).
const RETIRED_REPLY_LABELS = [
  ...Object.entries(RETIRED_THIRD_PARTY_NAMES).map(([value, name]) => ({ value, label: name, full: name })),
  // Nova and Nebula replies keep "VibhavGPT Nova" / "VibhavGPT Nebula" (never relabelled as another tier).
  ...Object.entries(RETIRED_HOUSE_NAMES).map(([value, name]) => ({ value, label: name, full: `VibhavGPT ${name}` })),
];
// Models that are not picker rows but write replies: Build's VibhavGPT Tecton. A reply is named by the model recorded with it
// (metadata.model), never by the tab on screen; a reply with no recorded model keeps the plain "VibhavGPT".
const BUILD_REPLY_LABELS = [{ value: "tecton", label: "Tecton", full: "VibhavGPT Tecton" }];
const { modelLabel, modelSwitches } = createReplyLabels([...MODELS, ...THIRD_PARTY_OPTIONS, ...RETIRED_REPLY_LABELS, ...BUILD_REPLY_LABELS]);
// The least plan each picker model needs: house models by plan (Zenith: Max), third-party models by their own floor (GLM and GPT-6
// Luna: Plus; GPT-6.1 Terra: Pro; GPT-6.1 Sol and Astra: Max). The server enforces the same floors.
const CATALOG_MODELS = [
  ...MODELS.map((entry) => ({ value: entry.value, label: entry.label, minTier: HOUSE_MIN_PLAN[entry.value] })),
  ...THIRD_PARTY_OPTIONS.map((entry) => ({ value: entry.value, label: entry.label, minTier: entry.minPlan ?? "max" })),
];

const VISION_MODELS = [...HOUSE_MODELS.filter((entry) => entry.vision).map((entry) => entry.id), ...THIRD_PARTY_MODELS.filter((entry) => entry.vision).map((entry) => entry.id)];
const STUDY_MODEL = "study";

// The four models are one ladder, Lumen to Vulcan, so the picker draws each as
// an orb whose size is its rung: the comparison reads before the words do.
const MODEL_RANK = Object.fromEntries([
  ...MODELS.map((entry, index) => [entry.value, index + 1]),
  // A third-party model's orb is sized by its intelligence label, on the same ladder.
  ...THIRD_PARTY_MODELS.map((entry) => [entry.id, intelligenceRank(entry.intelligence) + 1]),
]);
const READS_IMAGES = / Reads images\.$/;

function ModelOrb({ model, size = "md" }) {
  return <span className="model-orb" data-size={size} style={{ "--rank": MODEL_RANK[model] ?? 1 }} aria-hidden="true"><span /></span>;
}

// One row of the model picker, shared by the desktop dropdown and the phone
// sheet so both describe a model the same way.
function ModelRow({ entry, allowed, selected }) {
  const vision = VISION_MODELS.includes(entry.value);
  const lockedDesc = entry.lockedCopy ?? HOUSE_PLAN_COPY[entry.value] ?? "Available with Plus, Pro, or Max.";
  return (
    <span className="model-row" data-locked={!allowed || undefined}>
      <BrandMark logo={entry.logo} />
      <span className="model-row__text">
        <span className="model-row__head">
          <span className="model-row__name">{entry.label}</span>
        </span>
        <span className="model-row__desc">{allowed ? (entry.description || "").replace(READS_IMAGES, "") : lockedDesc}</span>
      </span>
      <span className="model-row__meta">
        {vision && <span className="model-row__vision" title="Reads images"><Eye size={14} strokeWidth={1.9} aria-hidden="true" /><span className="sr-only">Reads images</span></span>}
        {!allowed && <span className="model-row__lock"><Lock size={12} strokeWidth={2.2} aria-hidden="true" />Upgrade</span>}
        {selected && <Check className="model-row__check" size={16} strokeWidth={2.6} aria-hidden="true" />}
      </span>
    </span>
  );
}
const THINKING_MODELS = ["vesper", "zenith"];

// The model picker: a centered dialog (not an anchored dropdown), in sections by maker. VibhavGPT's own models first, then OpenAI, then
// Z.AI. Each row: the maker's mark, the exact name, one line on what it is for, the image capability, and a lock with "Upgrade" or a
// check. Arrow keys, Home and End move between rows; Escape or a click outside closes it. A marketplace model's thinking level is chosen
// here, from the levels that exact model documents (model-marketplace.js), or shown as "Not adjustable".
// Each marketplace model's thinking level, remembered on this device per model, so reopening a conversation keeps it.
const THINKING_LEVELS_KEY = "vibhavgpt-marketplace-thinking";
function readThinkingLevels() {
  try { const value = JSON.parse(localStorage.getItem(THINKING_LEVELS_KEY) || "{}"); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}
function writeThinkingLevels(levels) {
  try { localStorage.setItem(THINKING_LEVELS_KEY, JSON.stringify(levels)); } catch { /* storage unavailable: kept for this session only */ }
}
/** The level a marketplace model uses now: the remembered one if it is still supported, otherwise its documented default. */
const marketplaceLevelFor = (model, levels) => {
  if (!model || !marketplaceThinking(model)) return null;
  // Nothing remembered for this model yet: the level remembered for the model it replaced, as the maker's migration guide maps it.
  const inherited = levels?.[model] == null
    ? Object.entries(RETIRED_THIRD_PARTY_IDS).filter(([, to]) => to === model).map(([from]) => inheritedThinkingLevel(from, levels?.[from])).find(Boolean)
    : null;
  return toUnified(levels?.[model] ?? inherited) ?? DEFAULT_UNIFIED_LEVEL;
};

function ModelPickerModal({ open, onClose, entries, selected, allowedFor, onSelect, onUpgrade, disabled }) {
  const listRef = useRef(null);
  const sections = PICKER_SECTIONS
    .map((section) => ({ ...section, rows: entries.filter((entry) => (entry.house ? "house" : entry.group?.id) === section.id) }))
    .filter((section) => section.rows.length > 0);
  const onKeyDown = (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(listRef.current?.querySelectorAll("[data-model-option]") ?? [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : Math.max(0, Math.min(items.length - 1, (index < 0 ? -1 : index) + (event.key === "ArrowDown" ? 1 : -1)));
    items[next].focus();
    event.preventDefault();
  };
  const selectedEntry = entries.find((entry) => entry.value === selected) ?? null;
  return (
    <Modal open={open} onClose={onClose} title="Choose a model" size="lg">
      <div className="model-modal" onKeyDown={onKeyDown}>
        {/* The list is the only part that scrolls, and its scrolling stops at its own edges (owner request, 2026-11-16). */}
        <div className="model-modal__list" ref={listRef}>
        {sections.map((section) => (
          <section key={section.id} className="model-modal__section" data-section={section.id}>
            <h3 className="model-modal__heading" id={`model-section-${section.id}`}>{section.label}</h3>
            <div role="radiogroup" aria-labelledby={`model-section-${section.id}`} className="model-modal__rows">
              {section.rows.map((entry) => {
                const allowed = allowedFor(entry.value);
                const isSelected = entry.value === selected;
                return (
                  <button
                    key={entry.value}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    data-model-option={entry.value}
                    className="model-modal__option"
                    aria-disabled={!allowed || disabled || undefined}
                    tabIndex={isSelected || (!selected && entry === entries[0]) ? 0 : -1}
                    autoFocus={isSelected}
                    onClick={() => {
                      if (disabled) return;
                      if (!allowed) { onUpgrade(); return; }
                      onSelect(entry.value);
                      if (entry.house) onClose();
                    }}
                  >
                    <ModelRow entry={entry} allowed={allowed} selected={isSelected} />
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        </div>
        {/* A thinking level is chosen in the composer, next to the model, for every model that has one (owner request, 2026-11-14). The
            Done bar is the dialog's footer, outside the list: it stays put while the list scrolls. */}
        {selectedEntry && !selectedEntry.house && (
          <div className="model-modal__thinking" data-model={selectedEntry.value}>
            <button type="button" className="btn btn--primary model-modal__done" onClick={onClose}>Done</button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// The composer's model control: the maker's mark, the exact name, the thinking level in muted text, and a chevron. It opens the picker.
// The model button shows the maker's mark, the model's name and a chevron only. The thinking level has its own dropdown beside it, so it is
// shown once (owner request, 2026-11-15).
function ModelTrigger({ entry, levelLabel = null, onOpen, disabled }) {
  return (
    <button type="button" className="model-trigger" aria-haspopup="dialog" aria-label={`Model: ${entry?.label ?? "none chosen"}${levelLabel ? `, thinking ${levelLabel}` : ""}. Change model`} onClick={onOpen} disabled={disabled}>
      <span className="model-trigger__logo"><BrandMark logo={entry?.logo ?? "vibhavgpt"} size={20} /></span>
      <span className="model-trigger__name">{entry?.label ?? "Choose a model"}</span>
      {levelLabel && <span className="model-trigger__level">{levelLabel}</span>}
      <ChevronDown className="model-trigger__chevron" size={16} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
// One thinking control for every model (thinking-levels.js): Low, Medium, High.
const THINKING_OPTIONS = THINKING_CHOICES;

const STUDY_STARTER_ICON = { "Explain a topic": BookOpen, Flashcards: Layers, "Quiz me": ListChecks, Summary: FileText, "Study plan": GraduationCap };
const GREETINGS = ["Good to see you", "Where should we start", "What's on your mind", "Ready when you are"];

const RESPONSE_MODES = [
  { value: "concise", label: "Concise", icon: <AlignLeft size={19} strokeWidth={1.9} /> },
  { value: "detailed", label: "Detailed", icon: <FileText size={19} strokeWidth={1.9} /> },
  { value: "friendly", label: "Learning", icon: <GraduationCap size={19} strokeWidth={1.9} /> },
];

const PRODUCT_TABS = [
  { value: "chat", label: "Chat" },
  { value: "image", label: "Image" },
  { value: "build", label: "Build" },
  { value: "study", label: "Study" },
];

const TIER_LABEL = { free: "Free", plus: "Plus", pro: "Pro", max: "Max" };

function modelAllowedForTier(model, tier, creditBalance = 0) {
  const normTier = String(tier || "free").toLowerCase();
  const catalogList = typeof CATALOG_MODELS !== "undefined" ? CATALOG_MODELS : [];
  const catalogEntry = catalogList.find((entry) => entry.value === model);
  if (catalogEntry) {
    if (catalogEntry.minTier === "free") return true;
    if (catalogEntry.minTier === "plus") return normTier !== "free";
    if (catalogEntry.minTier === "pro") return normTier === "pro" || normTier === "max";
    if (catalogEntry.minTier === "max") return normTier === "max";
    return true;
  }
  if (!MODELS.some((entry) => entry.value === model)) return false;
  // Without the catalog list (it is always there in the app), the same floors: Vulcan needs Pro, Zenith needs Max.
  if (model === "lumen") return true;
  if (normTier === "free") return false;
  if (model === "zenith") return normTier === "max";
  if (normTier === "plus") return model !== "vesper";
  return true;
}

// A selection that names a retired tier, carried from the saved preference to the chat, which then asks for a model.
const RETIRED_PREFIX = "retired:";
const retiredFrom = (value) => (typeof value === "string" && value.startsWith(RETIRED_PREFIX) ? value.slice(RETIRED_PREFIX.length) : null);

function preferredModelForProfile(preferences, tier, creditBalance = 0) {
  const currentKey = (key) => key === "spark" ? "lumen" : key ? currentThirdPartyKey(key) : key;
  // The model this account last chose (a fixed default first). If that was a retired tier (Nova, Nebula), nothing is chosen for it:
  // the chat asks for a model rather than quietly sending to another one.
  const saved = [preferences?.retiredModel, preferences?.preferredModel, preferences?.lastUsedModel].find(Boolean);
  if (saved && isRetiredHouseKey(saved)) return `${RETIRED_PREFIX}${String(saved).toLowerCase()}`;
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

const MOBILE_PAGE_TITLES = { library: "Library", memory: "Memory", billing: "Plan", usage: "Usage & limits", settings: "Settings", extensions: "Extensions" };

const ONBOARDING_PATH = "/onboarding";

// The survey needs no new endpoints: the personality axes become personal
// instructions plus a response style (both already reach the system prompt via
// buildPreferenceSystemPrompt), and the capability answer becomes the stored
// product mode. The existing instructions are read first so a user's own text
// in Settings survives — mergeInstructions only rewrites its own block.
// Survey completion (and the answers, when there are any) is saved on the
// account so every device knows. A skip sends no answers.
function saveSurveyStatus(answers) {
  return api("/api/profile/onboarding", {
    method: "PATCH",
    body: JSON.stringify(answers ? { completed: true, answers } : { completed: true }),
  });
}

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

function Workspace({ user, appearance, onSignOut, onDeleted, onLegal, onUserChange = async () => {} }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [productMode, setProductMode] = useState(() => productModeFromPath(window.location.pathname));
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState("");
  const modeHydrated = useRef(false);
  const modeSessions = useRef({});
  // The text being typed. It travels between Chat and Study; a new chat or another conversation starts empty.
  const draftRef = useRef("");
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
  // Study shows either its conversation ("chat") or VibhavGPT Writing Tools
  // ("writing"). The tools need no session, so they open straight away.
  const [studyView, setStudyView] = useState("chat");
  const studyViewRef = useRef("chat");
  studyViewRef.current = studyView;
  // Which tool the Writing Tools screen opens on.
  const [writingToolsTab, setWritingToolsTab] = useState("detector");
  useEffect(() => { if (productMode !== "study") setStudyView("chat"); }, [productMode]);
  const [lastSelectedModel, setLastSelectedModel] = useState(null);
  // A saved model that has been replaced (thirdPartyReplacement): said in the chat, never moved silently.
  const [modelReplacement, setModelReplacement] = useState(null);
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
  // Sidebar items this person hid (Settings > Appearance > Sidebar). Saved to the account; this device remembers it for a quick first paint.
  const [sidebarHidden, setSidebarHiddenState] = useState(() => { try { const saved = JSON.parse(localStorage.getItem("vibhavgpt-sidebar-hidden") || "[]"); return Array.isArray(saved) ? saved : []; } catch { return []; } });
  useEffect(() => {
    api("/api/me/preferences").then((result) => {
      const saved = result?.preferences?.sidebarHidden;
      if (!Array.isArray(saved)) return;
      setSidebarHiddenState(saved);
      try { localStorage.setItem("vibhavgpt-sidebar-hidden", JSON.stringify(saved)); } catch { /* this device only */ }
    }).catch(() => {});
  }, []);
  const setSidebarHidden = useCallback((next) => {
    setSidebarHiddenState(next);
    try { localStorage.setItem("vibhavgpt-sidebar-hidden", JSON.stringify(next)); } catch { /* this device only */ }
    api("/api/me/preferences", { method: "PATCH", body: JSON.stringify({ sidebarHidden: next }) }).catch(() => {});
  }, []);
  // Replies still running anywhere in the app (live-replies.js), for the "reply in progress" indicator.
  const liveReplies = useSyncExternalStore(subscribeLiveReplies, liveRepliesSnapshot);
  useEffect(() => {
    let stopped = false;
    const refresh = () => api("/api/chat/replies").then((result) => { if (!stopped) seedLiveReplies(result?.replies); }).catch(() => {});
    refresh();
    window.addEventListener("focus", refresh);
    return () => { stopped = true; window.removeEventListener("focus", refresh); };
  }, []);
  // A reply this page is not reading (one started before a reload) finishes on the server; check now and then so the indicator goes.
  const hasUnreadReply = liveReplies.some((entry) => !entry.local);
  useEffect(() => {
    if (!hasUnreadReply) return undefined;
    const timer = setInterval(() => { api("/api/chat/replies").then((result) => seedLiveReplies(result?.replies)).catch(() => {}); }, 8000);
    return () => clearInterval(timer);
  }, [hasUnreadReply]);
  // An image being made (or finished) while another tab is open.
  const { job: imageJob } = useSyncExternalStore(imageJobs.subscribe, imageJobs.get);
  // Signing out ends this workspace; its image job must not carry over.
  useEffect(() => () => imageJobs.clear(), []);
  const [upgradeConfirmation, setUpgradeConfirmation] = useState(() => new URLSearchParams(window.location.search).get("upgraded") === "true" ? "confirming" : null);
  const [directUpdate, setDirectUpdate] = useState(null);
  // The survey runs in front of the workspace rather than above sign-in, so it
  // can read the account's tier (for the honest credit-cost hints), write the
  // landing tab straight into productMode, and reuse the live appearance.
  // Whether it shows is the account's answer (user.surveyCompleted); this
  // browser's copy is refreshed from it and only fills in when it is silent.
  const [onboarding, setOnboarding] = useState(() => writeOnboarding(user.id, onboardingForUser(user)));
  const [surveyOpen, setSurveyOpen] = useState(() => !onboarding.onboarding_completed);
  const surveySaving = useRef(false);
  const [surveyToast, setSurveyToast] = useState("");
  const [memoryToast, setMemoryToast] = useState(null);
  const [pendingRecap, setPendingRecap] = useState(null);
  const [pendingSkillAttach, setPendingSkillAttach] = useState(null);
  // The background follows the screen on show: Study's own on the Study chat, Chat's everywhere else.
  const themeSurface = surfaceForView({ page, productMode });
  useEffect(() => { appearance.setSurface?.(themeSurface); }, [themeSurface]); // eslint-disable-line react-hooks/exhaustive-deps
  // The contour-line background: Chat by its own setting, Study by a separate one (off unless chosen), never Image, Settings or Usage.
  const chatTopographyOn = page === "chat" && ((productMode === "chat" && appearance.topography !== "off") || (productMode === "study" && appearance.studyTopography === "on"));
  const currentWorkspace = useRef({ productMode, activeConversationId, chatKey });
  currentWorkspace.current = { productMode, activeConversationId, chatKey };

  useDrawerSwipe({ enabled: narrow, open: sidebarOpen, setOpen: setSidebarOpen, rootRef: workspaceRef });
  useEffect(() => {
    if (!narrow || !sidebarOpen) return undefined;
    const opener = document.activeElement;
    const drawer = workspaceRef.current?.querySelector(".sidebar");
    const first = drawer?.querySelector("a[href], button:not([disabled]), input, [tabindex]:not([tabindex='-1'])");
    first?.focus?.({ preventScroll: true });
    const onKey = (event) => { if (event.key === "Escape") { event.preventDefault(); setSidebarOpen(false); } };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [narrow, sidebarOpen]);

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
  useSidebarWidth({ rail, narrow, workspaceRef });

  useEffect(() => {
    localStorage.setItem("vibhavgpt-sidebar-collapsed", String(collapsed));
  }, [collapsed]);

  const refreshUsageAccess = useCallback(() => {
    const requestId = ++usageRequest.current;
    return api("/api/usage")
    .then((usage) => {
      if (requestId !== usageRequest.current) return null;
      setTier(usage.tier === "paid" ? "pro" : ["plus", "pro", "max"].includes(usage.tier) ? usage.tier : "free");
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
    const access = (event) => {
      const detail = event.detail;
      if (!detail) return;
      setAccessNotice((current) => {
        if (current && current.reason === detail.reason && current.feature === detail.feature && current.message === detail.message) {
          return current;
        }
        return detail;
      });
    };
    window.addEventListener("vibhavgpt:subscription-changed", changed);
    window.addEventListener("vibhavgpt:access-status", access);
    return () => {
      window.removeEventListener("vibhavgpt:subscription-changed", changed);
      window.removeEventListener("vibhavgpt:access-status", access);
    };
  }, [user?.id, refreshUsageAccess]);

  // Clear mode-specific access notices when switching between Chat and Image modes
  useEffect(() => {
    setAccessNotice((current) => {
      if (!current) return null;
      if (productMode === "image" && (current.reason === "plan" || current.feature?.includes("Vulcan") || current.feature?.includes("Nebula"))) {
        return null;
      }
      if (productMode === "chat" && current.feature?.toLowerCase().includes("image")) {
        return null;
      }
      return current;
    });
  }, [productMode]);

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
          setModelReplacement(thirdPartyReplacement(preferences?.preferredModel) ?? thirdPartyReplacement(preferences?.lastUsedModel));
          if (!modeHydrated.current) {
            const explicit = Boolean(settingsRoute(window.location.pathname, window.location.search)) || window.location.pathname.startsWith("/app/study") || window.location.pathname.startsWith("/app/image") || window.location.pathname.startsWith("/app/build") || new URLSearchParams(window.location.search).has("conversation");
            const restored = explicit ? productModeFromPath(window.location.pathname) : ["study", "image", "build"].includes(preferences.productMode) ? preferences.productMode : "chat";
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
  const tierKey = tier ?? "free";

  const go = (next, section = "profile") => {
    const path = next === "settings" ? settingsPath(section) : next === "usage" ? "/app/usage" : next === "chat" ? productPath(productMode, activeConversationId) : `/app/${next}`;
    const workspacePath = /^\/app(?:\/(?:chat|study|image|build))?\/?$/.test(window.location.pathname);
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

  // A new chat can start already temporary (the header's temporary-chat button inside a saved chat).
  const [startTemporary, setStartTemporary] = useState(false);
  const newChat = () => {
    draftRef.current = "";
    setStudyView("chat");
    setPendingGroup(null);
    setStartTemporary(false);
    setActiveConversationId(null);
    modeSessions.current[productMode] = null;
    window.history.pushState(null, "", productPath(productMode));
    setChatKey((key) => key + 1);
    go("chat");
  };
  const startTemporaryChat = () => {
    newChat();
    setStartTemporary(true);
  };
  // `mode` defaults to whatever's already active, which is right for every
  // same-mode history click (Chat opening a chat, Study opening a study
  // session). Image's sidebar passes "chat" explicitly: ImageWorkspace has no
  // per-conversation thread view, so reopening one of its past sessions means
  // switching into Chat to view that actual conversation, not staying on the
  // image page. This is a one-off navigation, not a change to the user's
  // sticky default mode, so it updates state directly rather than going
  // through switchMode's /api/profile/product-mode write.
  const writingToolsOpen = page === "chat" && productMode === "study" && studyView === "writing";
  // The composer's + menu asks for a tool by name; the chip and the sidebar
  // pass a click event, which opens the Detector.
  const openWritingTools = (tab) => {
    const first = studyViewRef.current !== "writing";
    // The tools live on the Study home, under the chips: from a conversation, start a fresh Study home first.
    if (activeConversationId) newChat();
    setWritingToolsTab(tab === "humanizer" ? "humanizer" : "detector");
    setStudyView("writing");
    setSidebarOpen(false);
    go("chat");
    // One history entry, so the browser's Back closes the panel instead of leaving Study.
    if (first) window.history.pushState({ writingTools: true }, "", `${window.location.pathname}${window.location.search}`);
  };
  const closeWritingTools = () => {
    if (window.history.state?.writingTools) window.history.back();
    else setStudyView("chat");
  };
  const newChatInGroup = (group) => {
    const targetMode = group?.mode === "study" ? "study" : "chat";
    setStudyView("chat");
    setPendingGroup(group);
    setActiveConversationId(null);
    modeSessions.current[targetMode] = null;
    if (productMode !== targetMode) {
      setProductMode(targetMode);
      api("/api/profile/product-mode", { method: "PATCH", body: JSON.stringify({ productMode: targetMode }) }).catch(() => {});
    }
    window.history.pushState(null, "", productPath(targetMode));
    setChatKey((key) => key + 1);
    go("chat");
  };
  // "New Chat" in the Windows desktop app's tray menu (desktop/preload.js).
  const newChatRef = useRef(newChat);
  newChatRef.current = newChat;
  // Math in replies loads apart from the first download (math-loader.js); fetch it once the browser is idle, so a reply with a
  // formula seldom renders before it is there.
  useEffect(() => {
    const warm = () => { void loadMath().catch(() => {}); };
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(warm, { timeout: 4000 });
      return () => window.cancelIdleCallback?.(handle);
    }
    const timer = setTimeout(warm, 2000);
    return () => clearTimeout(timer);
  }, []);
  // Keyboard shortcuts (keyboard-shortcuts.js): Ctrl/Cmd+N new chat, +K search (from anywhere, as before), +B the sidebar,
  // +, Settings, +/ this list. The Windows app's menu sends the same actions (desktop/preload.js "desktop:shortcut"), and
  // can also start a new image or build.
  const shortcutActionsRef = useRef({});
  shortcutActionsRef.current = {
    "new-chat": () => newChat(),
    "new-image": () => startNewIn("image"),
    "new-build": () => startNewIn("build"),
    search: () => { setSidebarOpen(false); setSearchOpen(true); },
    "toggle-sidebar": () => { if (narrow) setSidebarOpen((open) => !open); else setCollapsed((value) => !value); },
    settings: () => go("settings"),
    shortcuts: () => { setSidebarOpen(false); setShortcutsOpen(true); },
  };
  useEffect(() => {
    const onKey = (event) => {
      const action = shortcutForEvent(event, { modalOpen: Boolean(document.querySelector('[aria-modal="true"]')) });
      if (!action) return;
      event.preventDefault();
      shortcutActionsRef.current[action]?.();
    };
    const onDesktopShortcut = (event) => {
      const action = event.detail;
      if (typeof action === "string" && Object.hasOwn(shortcutActionsRef.current, action)) shortcutActionsRef.current[action]();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("desktop:shortcut", onDesktopShortcut);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("desktop:shortcut", onDesktopShortcut);
    };
  }, []);
  useEffect(() => {
    const onDesktopNewChat = () => newChatRef.current();
    window.addEventListener("desktop:new-chat", onDesktopNewChat);
    return () => window.removeEventListener("desktop:new-chat", onDesktopNewChat);
  }, []);
  const openConversation = (conversationId, mode = productMode) => {
    draftRef.current = "";
    setStudyView("chat");
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
      // Back from the Writing tools entry only closes the panel: nothing else is rebuilt, so a half-typed message stays.
      if (studyViewRef.current === "writing" && !window.history.state?.writingTools) { setStudyView("chat"); return; }
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

  // A browser that finished the survey before completion lived on the account
  // tells the account once, so its other devices stop asking. Only completion
  // is sent: an old copy cannot tell real answers from a skip's defaults.
  useEffect(() => {
    if (user.surveyCompleted !== true && readOnboarding(user.id).onboarding_completed) void saveSurveyStatus().catch(() => {});
  }, [user.id, user.surveyCompleted]);

  // Finishing and skipping save to the account before the survey closes. A
  // failed save still lets the user in: this browser's copy remembers, and the
  // effect above retries on the next load.
  const finishSurvey = useCallback(async (record) => {
    if (surveySaving.current) return;
    surveySaving.current = true;
    try {
      await saveSurveyStatus({ ...record, onboarding_completed: true }).catch(() => null);
    } finally {
      surveySaving.current = false;
    }
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

  // Skipping records on the account that the survey has been seen, so no
  // device shows it again, but saves no answers or settings: a skip is not an answer.
  const skipSurvey = useCallback(async () => {
    if (surveySaving.current) return;
    surveySaving.current = true;
    try {
      await saveSurveyStatus().catch(() => null);
    } finally {
      surveySaving.current = false;
    }
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
    void saveSurveyStatus(saved).catch(() => {});
    try {
      await persistOnboardingProfile(saved);
    } catch (error) {
      if (error?.code === "name-not-allowed") setOnboarding(writeOnboarding(user.id, { ...saved, preferred_name: "" }));
      throw error;
    }
  }, [appearance, user.id]);

  // A fresh session in `mode`: New Chat when that is the mode on screen, otherwise that mode with no conversation open.
  function startNewIn(mode) {
    if (mode === productMode) { newChat(); return; }
    modeSessions.current[mode] = null;
    switchMode(mode);
  }
  // Switching is immediate: the app changes mode on the spot, with no page load, and the choice is saved in the background.
  // Each mode keeps its own conversation, so nothing from one is shown in another; the text being typed travels with the switch.
  function switchMode(next) {
    if (next === productMode) { go("chat"); return; }
    modeSessions.current[productMode] = activeConversationId;
    const id = modeSessions.current[next] ?? null;
    setModeError("");
    setProductMode(next); setActiveConversationId(id); setChatKey((key) => key + 1);
    window.history.pushState(null, "", productPath(next, id)); go("chat");
    api("/api/profile/product-mode", { method: "PATCH", body: JSON.stringify({ productMode: next }) }).catch(() => {});
  }
  // Persistent top tabs for the three workspaces (was a dropdown in the
  // drawer head). Tapping the current tab returns to its conversation.
  // Two controls, never one list of three. At the top of the workspace: Chat | Image (Study is a kind of chat, so it shows Chat).
  // Under the Chat and Study composer: Chat | Study.
  const buildTabs = (values, label, selected, variant = "notch") => {
    const tabs = PRODUCT_TABS.filter((tab) => values.includes(tab.value));
    const activeIndex = tabs.findIndex((tab) => tab.value === selected);
    return (
      <div
        className={`mode-tabs mode-tabs--${variant}`}
        data-variant={variant}
        role="tablist"
        aria-label={label}
        style={{ "--tab-count": tabs.length, "--tab-index": Math.max(0, activeIndex) }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            className={`mode-tabs__tab mode-tabs__tab--${variant}`}
            aria-selected={tab.value === selected && page === "chat"}
            disabled={!profileModelReady}
            onClick={() => switchMode(tab.value)}
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
  };
  const modeTabs = buildTabs(["chat", "image", "build"], "Workspace", productMode === "study" ? "chat" : productMode, "notch");
  const studyTabs = buildTabs(["chat", "study"], "Chat or Study", productMode, "study");
  // A Learning project is Study only (owner request, 2026-11-14): its new chat opens in Study (newChatInGroup) and offers no Chat | Study switch.
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
    if (currentWorkspace.current.productMode !== productMode || currentWorkspace.current.chatKey !== chatKey || !/^\/app(?:\/(?:chat|study|image|build))?\/?$/.test(window.location.pathname)) return;
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

  const renderChat = (studyProps = {}) => <Chat key={chatKey} user={user} userName={firstName} tier={tier} creditBalance={creditBalance} initialConversationId={activeConversationId} initialModel={lastSelectedModel} modelReplacement={modelReplacement} onDismissModelReplacement={() => setModelReplacement(null)} onModelChange={setLastSelectedModel} onUsageChanged={refreshUsageAccess} onOpenSettings={() => go("settings")} onOpenExtensions={() => go("extensions")} onOpenBilling={() => go("billing")} go={go} onConversationSaved={saveSession} onBackgroundTask={setBackgroundTask} autoPrompt={pendingRecap} onAutoPromptSent={() => setPendingRecap(null)} pendingSkillAttach={pendingSkillAttach} onPendingSkillAttachConsumed={() => setPendingSkillAttach(null)} group={pendingGroup} onCloseWritingTools={closeWritingTools} toolsPanel={writingToolsOpen ? <div className="writing-tools-inline"><StudyWritingTools key={writingToolsTab} api={api} initialTab={writingToolsTab} onBack={closeWritingTools} /></div> : null} {...studyProps} tabsBelow={pendingGroup?.mode === "study" || productMode === "build" ? null : studyTabs} initialDraft={draftRef.current} onDraftChange={(text) => { draftRef.current = text; }} initialTemporary={startTemporary} onStartTemporaryChat={startTemporaryChat} onExitTemporaryChat={newChat} onOpenInMode={(id, mode) => openConversation(id, mode)} />;

  return (
    <div className="workspace" ref={workspaceRef} data-collapsed={rail} data-page={page} data-topography={chatTopographyOn ? "on" : undefined} data-build-threads={page === "chat" && productMode === "build" ? "on" : undefined}>
      {chatTopographyOn && <ChatTopography resolved={appearance.resolved} motion={appearance.motion} />}
      <Sidebar
        variant={productMode}
        onSwitchMode={switchMode}
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
        onSearch={() => { setSidebarOpen(false); setSearchOpen(true); }}
        activeConversationId={activeConversationId}
        historyRevision={historyRevision}
        onSignOut={onSignOut}
        hiddenItems={sidebarHidden}
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
          {/* Build's background (BuildThreads): behind Build's own column only, never under the sidebar. */}
          {page === "chat" && productMode === "build" && <BuildThreads reducedMotion={appearance.reducedMotion} />}
        <WorkspaceNotice
          access={accessNotice}
          tier={tier}
          onAction={(action) => {
            if (action === "plans" || action === "restore") go("billing");
            else if (action === "credits" || action === "usage") go("usage");
            else if (action === "storage") go("chat");
            else if (action === "support") window.location.assign("mailto:support@pansophy.com");
            else setAccessNotice(null);
          }}
          onDismiss={() => setAccessNotice(null)}
        />
        {page === "chat" && <div className="mode-tabs-bar">{modeTabs}<div className="chat-header-actions" id="chat-header-actions" /></div>}
        {modeError && <Banner tone="error">{modeError}</Banner>}
        {upgradeConfirmation === "confirming" && <Banner tone="info" title="Confirming your plan…" help="Your payment went through checkout. We're waiting for the payment provider to confirm the new plan; this page checks every few seconds and updates by itself. If it isn't confirmed within about 20 seconds, you'll see what to do next." />}
        {upgradeConfirmation === "confirmed" && <Banner tone="success" title="Your new plan is ready to use." />}
        {upgradeConfirmation === "delayed" && <Banner tone="warning" title="Payment still confirming" live="status">Your payment is still being confirmed. Refresh this page in a minute. If your plan has not changed, email support@pansophy.com.</Banner>}
        {directUpdate && (
          <Banner
            tone="info"
            title={`VibhavGPT ${directUpdate.versionName} is available.`}
            className="direct-update"
            onDismiss={() => setDirectUpdate(null)}
            dismissLabel="Dismiss update notice"
            help="A newer version of the VibhavGPT Android app is available to download. Your chats, projects and memory are saved to your account, so updating doesn't lose them."
            action={<a className="btn btn--secondary" href={directUpdate.downloadPage || "/android"} target="_blank" rel="noreferrer">View update</a>}
          >
            {directUpdate.releaseNotes || null}
          </Banner>
        )}
        <DesktopUpdateBanner />
        {(() => {
          // A reply in progress somewhere other than the chat on screen: say so, and open the chat it belongs to.
          const live = backgroundReply(liveReplies, { page, activeConversationId });
          const task = live ?? (backgroundTask && page !== "chat" ? backgroundTask : null);
          if (!task) return null;
          return (
            <div className="background-task" role="status" data-reply={live?.replyId || undefined}>
              <strong>{live ? (live.label || "Writing a reply") : task.label}</strong>
              <span>{live ? (live.detail || "A reply is in progress in another chat.") : task.detail}</span>
              {live?.conversationId && (
                <button type="button" className="background-task__open" onClick={() => openConversation(live.conversationId, ["study", "build"].includes(live.mode) ? live.mode : "chat")}>
                  Open chat
                </button>
              )}
            </div>
          );
        })()}
        <header className="topbar-mobile">
          <IconButton label="Open navigation" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}><MenuIcon size={21} strokeWidth={1.9} /></IconButton>
          {page === "chat" ? modeTabs : <h1 className="topbar-mobile__title">{mobileTitle}</h1>}
          <div className="topbar-mobile__actions">
            {page === "chat" && <div className="chat-header-actions" id="chat-header-actions-mobile" />}
            <IconButton label={productMode === "study" ? "New study session" : "New chat"} onClick={newChat}><SquarePen size={20} strokeWidth={1.9} /></IconButton>
          </div>
        </header>

        <div className="screen" key={screenKey} data-direction={lastScreen.current.direction}>
        {page === "chat" && !profileModelReady ? (
          <main className="page page--centered"><TypingDots label="Opening your workspace" /></main>
        ) : page === "chat" ? (
          productMode === "image" ? <ImageWorkspace api={api} />
          : renderChat({ mode: productMode, onOpenWritingTools: productMode === "study" ? openWritingTools : undefined })
        ) : page === "library" ? (
          <Library api={api} onOpenConversation={openConversation} />
        ) : page === "memory" ? (
          <Memory onMemoriesAdded={(added) => setMemoryToast(added)} onOpenConversation={openConversation} />
        ) : page === "billing" ? (
          <Billing tier={tier} userId={user.id} onEntitlementChanged={refreshUsageAccess} />
        ) : page === "usage" ? (
          <UsageDashboard userId={user?.id} onOpenSettings={() => go("settings")} onOpenPlans={() => go("billing")} onLegal={onLegal} />
        ) : page === "extensions" ? (
          <Extensions
            api={api}
            user={user}
            tier={tier}
            onBack={() => go("chat")}
            onOpenSettings={(sec) => go("settings", sec)}
            onUseSkill={(skill) => {
              setPendingSkillAttach(skill);
              go("chat");
            }}
          />
        ) : (
          <Settings
            section={settingsSection}
            onSectionChange={(section) => go("settings", section)}
            onBack={() => go("chat")}
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
            onUserChange={onUserChange}
            sidebarHidden={sidebarHidden}
            onSidebarHiddenChange={setSidebarHidden}
          />
        )}
        </div>
      </div>

      <KeyboardShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <ChatSearch open={searchOpen} api={api} scope={productMode === "build" ? "build" : "chat"} onClose={() => setSearchOpen(false)} onOpenResult={(id, mode) => { setSearchOpen(false); openConversation(id, mode); }} />

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

// Whether the reply around a block has finished arriving (AssistantBody).
const ReplySettledContext = createContext(true);
// Sends a follow-up message from a widget (a quiz's "Ask VibhavGPT to
// explain"); null where replies are only shown, not continued.
const ReplyAskContext = createContext(null);
// Records a finished flashcard review or quiz with its reply, so later turns
// know how it went (src/chat/study-results.js); null where nothing is saved.
const ReplyResultContext = createContext(null);

// A ```flashcards or ```quiz block (study-widgets.js) becomes its widget.
// Until it parses, a reply still arriving shows a placeholder; a finished
// reply whose block never parsed shows it as ordinary code.
function StudyBlock({ language, text, fallback }) {
  const settled = useContext(ReplySettledContext);
  const onAsk = useContext(ReplyAskContext);
  const onResult = useContext(ReplyResultContext);
  const parsed = useMemo(() => parseStudyBlock(language, text), [language, text]);
  if (parsed?.kind === "flashcards") return <InteractiveFlashcards deck={parsed} onResult={onResult} />;
  if (parsed?.kind === "quiz") return <InteractiveQuiz quiz={parsed} onAsk={onAsk} onResult={onResult} />;
  if (!settled) return <div className="study-widget study-widget--pending" role="status">{language === "quiz" ? "Preparing your quiz..." : "Preparing your flashcards..."}</div>;
  return fallback;
}

// A ```mermaid block (diagrams.js) is drawn once its reply has arrived.
function DiagramBlock({ text, fallback }) {
  const settled = useContext(ReplySettledContext);
  return <DiagramViewer source={text} settled={settled} fallback={fallback} />;
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

  const block = (
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
  if (isDiagramLanguage(language)) return <DiagramBlock text={text} fallback={block} />;
  return STUDY_BLOCK_LANGUAGES.has(language.toLowerCase()) ? <StudyBlock language={language.toLowerCase()} text={text} fallback={block} /> : block;
}

// The math plugins (remark-math, rehype-katex and KaTeX's stylesheet) for a reply, from math-loader.js. A reply with no unescaped $
// renders the same with or without them, so it never waits for them; one with math loads them once (the workspace also warms them
// when the browser is idle, so they are usually there already).
function useMath(text) {
  const needed = needsMath(text);
  const [math, setMath] = useState(loadedMath);
  useEffect(() => {
    if (!needed || math) return undefined;
    let live = true;
    loadMath().then((plugins) => { if (live) setMath(plugins); }, () => {});
    return () => { live = false; };
  }, [needed, math]);
  return math;
}

// `streaming`: the reply is still arriving from the server. `onAsk` lets
// its widgets send a follow-up message.
function AssistantBody({ text, animate, onTick, streaming = false, onAsk = null, onStudyResult = null, sources = [] }) {
  const { shown, done } = useTypewriter(text, { enabled: animate, onTick });
  // [n] in the reply cites the nth web source under it (citations.js): a small numbered link to that page.
  const citations = useMemo(() => sourcesByNumber(sources), [sources]);
  const settled = !streaming && (!animate || done);
  // Models sometimes use HTML line-break tags. Convert only that harmless
  // formatting shorthand to Markdown before rendering; do not enable raw HTML
  // from model output in the DOM.
  const rendered = protectPlainDollarSigns(normalizeTexDelimiters(shown).replace(/<br\s*\/?\s*>/gi, "  \n"));
  const math = useMath(rendered);
  return (
    <ReplySettledContext.Provider value={settled}>
    <ReplyAskContext.Provider value={onAsk}>
    <ReplyResultContext.Provider value={onStudyResult}>
    <div className="prose" data-typing={animate && !done ? "true" : undefined}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, ...(math ? [[math.remarkMath, { singleDollarTextMath: true }]] : []), [remarkCitations, { sources }]]}
        rehypePlugins={math ? [math.rehypeKatex] : []}
        components={{
          a: ({ href, children, ...props }) => {
            const source = citations.get(Number(props["data-citation"] ?? props.dataCitation));
            if (source) return <a className="citation" href={source.href} target="_blank" rel="noopener noreferrer" aria-label={citationLabel(source)} title={citationLabel(source)}>{source.n}</a>;
            return <ResourceLink href={href}>{children}</ResourceLink>;
          },
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
    </ReplyResultContext.Provider>
    </ReplyAskContext.Provider>
    </ReplySettledContext.Provider>
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

// A saved message as the chat shows it, from any page of history.
function historyMessage(message) {
  return {
    id: message.id ?? null,
    role: message.role,
    content: message.content,
    attachment: message.attachment ?? null,
    imagePrompt: message.imagePrompt ?? null,
    sources: message.sources ?? [],
    activitySummary: message.activitySummary ?? [],
    thoughtSeconds: message.thoughtSeconds ?? null,
    model: message.model ?? null,
    createdAt: message.createdAt,
    fresh: false,
  };
}

// Only a cursor the server says leads somewhere opens "Load earlier messages";
// a server that sends neither field has no earlier pages to offer.
const olderCursorFrom = (result) => (result?.hasMore === true && typeof result.nextCursor === "string" ? result.nextCursor : null);

function Chat({ initialDraft = "", onDraftChange, user, userName, tier = "free", creditBalance = 0, initialConversationId = null, initialModel = null, modelReplacement = null, onDismissModelReplacement, onModelChange, onUsageChanged, onOpenSettings, onOpenExtensions, onOpenBilling, go: goProp, onConversationSaved, onBackgroundTask, mode = "chat", autoPrompt = null, onAutoPromptSent, pendingSkillAttach = null, onPendingSkillAttachConsumed = null, group = null, onOpenWritingTools, onCloseWritingTools, toolsPanel = null, tabsBelow = null, initialTemporary = false, onStartTemporaryChat, onExitTemporaryChat, onOpenInMode }) {
  const go = goProp || onOpenBilling || (() => {});
  // null: no model chosen yet (a retired tier was selected before); the person is asked to choose one, and nothing is sent until they do.
  const [model, setModel] = useState(retiredFrom(initialModel) ? null : initialModel || "lumen");
  const [retiredSelection, setRetiredSelection] = useState(retiredFrom(initialModel));
  // A conversation last on a replaced model opens on its replacement, and says so (the profile's own replacement comes as a prop).
  const [conversationReplacement, setConversationReplacement] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [thinkingLevels, setThinkingLevels] = useState(readThinkingLevels);
  const changeThinkingLevel = useCallback((key, level) => {
    setThinkingLevels((current) => { const next = { ...current, [key]: level }; writeThinkingLevels(next); return next; });
  }, []);
  // Set once the person picks a model here, so a conversation that finishes loading afterwards does not replace their pick.
  const userPickedModelRef = useRef(false);
  // The third-party models the server lists now (GET /api/models/catalog, Slice 7). Until it answers, the picker shows the house models.
  const [listedThirdParty, setListedThirdParty] = useState([]);
  const studyMode = mode === "study";
  // Build: VibhavGPT Tecton, always, and only on Pro and up (the server refuses it below Pro before any inference or charge).
  const buildMode = mode === "build";
  const buildLocked = buildMode && !buildIncluded(tier);
  const sentModel = studyMode ? STUDY_MODEL : buildMode ? BUILD_MODEL : model;
  const [messages, setMessages] = useState([]);
  const [conversationId, setConversationId] = useState(initialConversationId);
  // A temporary chat: chosen before the first message, fixed after it. The server enforces it (no memory used or saved, not listed,
  // deleted after 24 hours); this only chooses it and shows it.
  const [temporaryChat, setTemporaryChat] = useState(Boolean(initialTemporary) && !initialConversationId);
  const [leaveTemporaryOpen, setLeaveTemporaryOpen] = useState(false);
  // The header slot the temporary-chat button goes in: the desktop tab bar, or the phone's top bar.
  const [headerSlot, setHeaderSlot] = useState(null);
  // Shown in the header once a saved conversation loads; a new chat's first
  // reply does not return its title, so it keeps the generic label.
  const [loadingConversation, setLoadingConversation] = useState(Boolean(initialConversationId));
  // Memory is controlled in Settings (Personalization) and on the Memory page. The composer's + menu no longer has a per-chat
  // "Use memory" switch, so this component neither sends nor reads a per-conversation memory choice. The server still accepts and
  // applies one (the stored per-conversation value is kept), so a chat where someone once chose Off stays Off.
  // The draft and the mentions inside it, together: every change to the text moves, keeps or drops the mentions with it.
  const { draft, mentions, setDraft, insertMention, deleteMention, read: readDraft } = useMentionedDraft(initialDraft);
  useEffect(() => { onDraftChange?.(draft); }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  // Counts sends; the composer's data-send-pulse flips with it so its pop
  // (desktop.css, Windows app only) restarts on every send.
  const [sendPulse, setSendPulse] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // The model the pending reply was requested from, for its live byline.
  const [streamingModel, setStreamingModel] = useState(null);
  // Earlier pages of a long conversation (conversation-pages.js).
  const [olderCursor, setOlderCursor] = useState(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState("");
  const [reachedStart, setReachedStart] = useState(false);
  const olderInFlightRef = useRef(false);
  const prependAnchorRef = useRef(null);
  const skipBottomScrollRef = useRef(false);
  // Messages added on this screen get a stable key until they have an id.
  const clientKeyRef = useRef(0);
  const nextClientKey = () => `local-${(clientKeyRef.current += 1)}`;
  const activeRequestRef = useRef(null);
  // Set when the person cancels a reply that is still waiting for a free slot (nothing of it was saved, reserved or sent yet).
  const cancelledWaitRef = useRef(false);
  // The running reply on screen (live-replies.js): its id once the server names it, whether Stop was pressed, and an attached view's reader.
  const replyIdRef = useRef(null);
  const stopRequestedRef = useRef(false);
  // The Stop response button's state: "stopping" while the server is asked, "failed" if it refused (the reply is still running).
  const [stopState, setStopState] = useState("idle");
  // Build: read the project card again after a reply that saved (or tried to save) files.
  const [buildRefresh, setBuildRefresh] = useState(0);
  const streamStartedRef = useRef(false);
  const attachRef = useRef(null);
  const [error, setError] = useState("");
  // Warning for a busy or rate-limited moment (nothing went wrong with the message); error for everything else.
  const [errorTone, setErrorTone] = useState("error");
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
  // The chat's refusal when the paid allowance cannot fund a request. It only offers
  // choices: nothing is switched or sent until the customer clicks.
  const [allowanceBlock, setAllowanceBlock] = useState(null);
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
  // The connectors a message is routed to come only from the mentions still intact in the text, never from reading names out of it: edit or
  // delete a mention and its routing goes with it, and typing "@YouTube" by hand routes nothing.
  const selectedConnectors = useMemo(() => connectorsFromMentions(mentions), [mentions]);
  const [selectedSkills, setSelectedSkills] = useState([]);
  useEffect(() => {
    if (!pendingSkillAttach?.id) return undefined;
    setSelectedSkills((prev) => {
      if (prev.some((entry) => entry.id === pendingSkillAttach.id)) return prev;
      return [...prev, { id: pendingSkillAttach.id, name: pendingSkillAttach.name }];
    });
    onPendingSkillAttachConsumed?.();
    return undefined;
  }, [pendingSkillAttach, onPendingSkillAttachConsumed]);
  const [mentionTrigger, setMentionTrigger] = useState(null);
  const [mentionHighlight, setMentionHighlight] = useState(0);
  const [connectorsCatalog, setConnectorsCatalog] = useState([]);
  const [skillsCatalog, setSkillsCatalog] = useState([]);
  const [mentionsLoading, setMentionsLoading] = useState(false);
  const imeComposingRef = useRef(false);
  const mentionSuppressRef = useRef(false);
  // Where the caret goes after the draft changes under it (a mention inserted or removed). It is set in a layout effect, before anything else
  // can be typed, so a letter typed straight away is never put in front of it.
  const pendingCaretRef = useRef(null);
  // The "@" the person closed the list for with Escape. Key-up and click would otherwise find the same "@query" and open it again.
  const mentionDismissedRef = useRef(null);
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
  const [quickPreferences, setQuickPreferences] = useState({ responseStyle: "balanced", customInstructions: "", thinkingEffort: "low" });
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  // Keep the server's explicit preferred default separate from the transient
  // last-used model. A model-picker change must not silently erase a fixed
  // default selected in Settings.
  const preferredModelRef = useRef(undefined);

  const selectedEntry = model ? (MODELS.find((entry) => entry.value === model) || THIRD_PARTY_OPTIONS.find((entry) => entry.value === model) || null) : null;
  const modelInfo = selectedEntry ?? { value: null, label: "Choose a model", full: "Choose a model", description: "" };
  // The thinking level this message will be sent with: a marketplace model's own level, or the house tier's effort where it applies.
  const marketplaceLevel = model && !buildMode ? marketplaceLevelFor(model, thinkingLevels) : null;
  const replySwitches = useMemo(() => modelSwitches(messages), [messages]);
  const activeConversationRef = useRef(conversationId);
  activeConversationRef.current = conversationId;
  useEffect(() => {
    if (!user?.id) return undefined;
    let cancelled = false;
    api("/api/models/catalog")
      .then((catalog) => {
        if (cancelled) return;
        const listed = new Set((catalog?.lineup?.providers ?? []).flatMap((provider) => (provider.models ?? []).map((entry) => entry.id)));
        setListedThirdParty(THIRD_PARTY_OPTIONS.filter((entry) => listed.has(entry.value)).map((entry) => entry.value));
      })
      .catch(() => { if (!cancelled) setListedThirdParty([]); });
    return () => { cancelled = true; };
  }, [user?.id]);

  // The picker: house models first, then each provider's listed models under its name (GPT-6's header from two models up).
  const pickerModels = useMemo(() => withSectionHeaders([...MODELS, ...THIRD_PARTY_OPTIONS.filter((entry) => listedThirdParty.includes(entry.value))]), [listedThirdParty]);
  const modelOptions = useMemo(() => pickerModels.map((entry) => {
    const allowed = modelAllowedForTier(entry.value, tier, creditBalance);
    return {
      ...entry,
      icon: <Sparkles size={14} strokeWidth={1.9} />,
      disabled: !allowed,
      description: allowed ? entry.description : (entry.lockedCopy ?? HOUSE_PLAN_COPY[entry.value] ?? "Available with Plus, Pro, or Max."),
    };
  }), [pickerModels, tier, creditBalance]);
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
        // Build and Chat keep their own conversations (the stored mode). Opened in the other one, it reopens where it belongs, with that
        // workspace's sidebar and model, instead of being continued on the wrong model.
        const storedMode = result.conversation.mode === "build" ? "build" : null;
        if ((storedMode === "build") !== (mode === "build") && onOpenInMode) {
          onOpenInMode(result.conversation.id, storedMode ?? "chat");
          return;
        }
        setConversationId(result.conversation.id);
        setTemporaryChat(result.conversation.temporary === true);
        const restoredModel = result.conversation.model === "spark" ? "lumen" : result.conversation.model ? currentThirdPartyKey(result.conversation.model) : result.conversation.model;
        setConversationReplacement(thirdPartyReplacement(result.conversation.model));
        const conversationModel = modelAllowedForTier(restoredModel, tier, creditBalance) ? restoredModel : "lumen";
        // A model picked while the conversation was still loading stays picked. A conversation last on a retired tier keeps its
        // history, and asks for a model: it is never moved to another tier on its own.
        if (!userPickedModelRef.current) {
          if (isRetiredHouseKey(result.conversation.model)) {
            setModel(null);
            setRetiredSelection(String(result.conversation.model).toLowerCase());
          } else {
            setModel(conversationModel);
            onModelChange?.(conversationModel);
          }
        }
        setMessages((result.history ?? []).map(historyMessage));
        setOlderCursor(olderCursorFrom(result));
        // A reply still being written for this conversation (started before a reload, or in this chat before leaving it): follow it.
        const loadedId = result.conversation.id;
        const known = liveReplyForConversation(loadedId);
        const findRunning = known ? Promise.resolve(known) : api("/api/chat/replies").then((list) => { seedLiveReplies(list?.replies); return liveReplyForConversation(loadedId); }).catch(() => null);
        void findRunning.then((running) => { if (!cancelled && running?.replyId) void attachToRunningReply(running.replyId, result.conversation.model ?? conversationModel, running.startedAt); });
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

  // After an earlier page goes in above, keep the message the reader was on
  // exactly where it was, before the browser paints.
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    const node = scrollRef.current;
    if (!anchor || !node) return;
    prependAnchorRef.current = null;
    skipBottomScrollRef.current = true;
    node.scrollTop = restoredScrollTop({ ...anchor, afterHeight: node.scrollHeight });
  }, [messages]);

  useEffect(() => {
    // An earlier page was just added above: stay put instead of jumping down.
    if (skipBottomScrollRef.current) {
      skipBottomScrollRef.current = false;
      return;
    }
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, busy]);

  // The server's limits for this account; read again when the plan changes, so the guidance follows an upgrade or a downgrade.
  useEffect(() => {
    api("/api/uploads/limits").then(setUploadLimits).catch(() => null);
  }, [tier]);

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
          thinkingEffort: preferences.thinkingEffort ?? "low",
        });
        preferredModelRef.current = preferences.preferredModel ?? null;
        setPreferencesLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setPreferencesLoaded(true);
      });
    return () => { cancelled = true; };
  }, [initialConversationId, initialModel, tier, creditBalance]);

  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret === null) return;
    pendingCaretRef.current = null;
    const node = inputRef.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(caret, caret);
  });

  // Grow the composer with its content instead of scrolling a one-line box.
  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [draft]);

  // Images and documents have different per-file limits (upload-guidance.js): the line names the ones that apply to what is attached.
  const attachmentLabel = attachmentGuidance(uploadLimits, attachments.map((attachment) => attachment.file));
  const hasImages = attachments.some((attachment) => attachment.file.type.startsWith("image/"));
  const visionModelRequired = !studyMode && hasImages && !VISION_MODELS.includes(model);
  // The first model in the picker that reads images and that this plan includes (and is listed now), to offer when an image needs one.
  const imageModelForPlan = pickerModels.find((entry) => VISION_MODELS.includes(entry.value) && modelAllowedForTier(entry.value, tier, creditBalance)) ?? null;

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
      const tooLarge = perFileProblem(uploadLimits, next.map((attachment) => attachment.file));
      if (tooLarge) {
        setError(tooLarge);
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

  const selectedConnectorIdSet = useMemo(() => new Set(selectedConnectors.map((entry) => entry.id)), [selectedConnectors]);
  const selectedSkillIdSet = useMemo(() => new Set(selectedSkills.map((entry) => entry.id)), [selectedSkills]);

  const mentionPickerItems = useMemo(() => {
    if (!mentionTrigger) return [];
    if (mentionTrigger.kind === "connector") {
      return filterConnectorsForPicker(connectorsCatalog, mentionTrigger.query, selectedConnectorIdSet);
    }
    return filterSkillsForPicker(skillsCatalog, mentionTrigger.query, selectedSkillIdSet);
  }, [mentionTrigger, connectorsCatalog, skillsCatalog, selectedConnectorIdSet, selectedSkillIdSet]);

  useEffect(() => {
    setMentionHighlight(0);
  }, [mentionTrigger?.kind, mentionTrigger?.query]);

  useEffect(() => {
    if (!mentionTrigger) return undefined;
    let cancelled = false;
    const loadCatalog = async () => {
      setMentionsLoading(true);
      try {
        if (mentionTrigger.kind === "connector" && connectorsCatalog.length === 0) {
          const res = await api("/api/connectors");
          if (!cancelled) setConnectorsCatalog(res.connectors || []);
        }
        if (mentionTrigger.kind === "skill" && skillsCatalog.length === 0) {
          const res = await api("/api/skills");
          if (!cancelled) setSkillsCatalog(res.skills || []);
        }
      } catch {
        /* empty picker is acceptable */
      } finally {
        if (!cancelled) setMentionsLoading(false);
      }
    };
    void loadCatalog();
    return () => { cancelled = true; };
  }, [mentionTrigger, connectorsCatalog.length, skillsCatalog.length]);

  const closeMentionPicker = useCallback(() => {
    setMentionTrigger(null);
  }, []);

  const removeMentionTriggerText = useCallback((trigger) => {
    if (!trigger) return;
    setDraft((current) => `${current.slice(0, trigger.replaceStart)}${current.slice(trigger.replaceEnd)}`);
  }, []);

  const syncMentionTrigger = useCallback((text, cursor) => {
    const next = detectMentionTrigger(text, cursor, { suppress: mentionSuppressRef.current, mentions: readDraft().mentions });
    if (next && next.replaceStart === mentionDismissedRef.current) { setMentionTrigger(null); return; }
    mentionDismissedRef.current = null;
    setMentionTrigger(next);
  }, [readDraft]);

  // Choosing a connector puts "@Name" into the sentence where "@query" was and leaves the caret after it, ready to keep typing.
  const mentionConnectorInline = useCallback((trigger, connector) => {
    pendingCaretRef.current = insertMention(trigger, { id: connector.id, label: connectorDisplayName(connector) });
    mentionDismissedRef.current = null;
    setMentionTrigger(null);
  }, [insertMention]);

  const pickHighlightedMention = useCallback(() => {
    if (!mentionTrigger || !mentionPickerItems.length) return false;
    const item = mentionPickerItems[Math.min(mentionHighlight, mentionPickerItems.length - 1)];
    if (!item) return false;
    if (mentionTrigger.kind === "connector") {
      if (item.status !== "connected") {
        removeMentionTriggerText(mentionTrigger);
        closeMentionPicker();
        onOpenExtensions?.();
        return true;
      }
      mentionConnectorInline(mentionTrigger, item);
      return true;
    }
    setSelectedSkills((prev) => (
      prev.some((entry) => entry.id === item.id)
        ? prev
        : [...prev, { id: item.id, name: item.name }]
    ));
    removeMentionTriggerText(mentionTrigger);
    closeMentionPicker();
    return true;
  }, [mentionTrigger, mentionPickerItems, mentionHighlight, onOpenExtensions, closeMentionPicker, removeMentionTriggerText, mentionConnectorInline]);

  function handleComposerChange(event) {
    const { value, selectionStart } = event.target;
    setDraft(value);
    if (!imeComposingRef.current) syncMentionTrigger(value, selectionStart);
  }

  function handleComposerKeyDown(event) {
    if (mentionTrigger) {
      if (event.key === "Escape") {
        event.preventDefault();
        mentionDismissedRef.current = mentionTrigger.replaceStart;
        closeMentionPicker();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionHighlight((index) => (mentionPickerItems.length ? (index + 1) % mentionPickerItems.length : 0));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionHighlight((index) => (mentionPickerItems.length ? (index - 1 + mentionPickerItems.length) % mentionPickerItems.length : 0));
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        pickHighlightedMention();
        return;
      }
    }
    // Backspace at the end of a mention, or Delete at its start, removes all of it, as one thing.
    if ((event.key === "Backspace" || event.key === "Delete") && !event.nativeEvent.isComposing) {
      const node = event.currentTarget;
      if (node.selectionStart === node.selectionEnd) {
        const caret = deleteMention(node.selectionStart, event.key === "Backspace" ? "backward" : "forward");
        if (caret !== null) {
          event.preventDefault();
          pendingCaretRef.current = caret;
          return;
        }
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send({ preventDefault() {} });
    }
  }

  function handlePaste(event) {
    if (event.clipboardData?.types?.includes("text/plain")) {
      mentionSuppressRef.current = true;
      requestAnimationFrame(() => { mentionSuppressRef.current = false; });
    }
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

  // One earlier page above what is shown. One request at a time, never while
  // a reply streams, and a reply for a conversation no longer open is dropped.
  async function loadEarlier() {
    if (olderInFlightRef.current || !olderCursor || busyRef.current || !conversationId) return;
    const requestedFor = conversationId;
    olderInFlightRef.current = true;
    setLoadingOlder(true);
    setOlderError("");
    try {
      const result = await api(`/api/chat/conversations/${encodeURIComponent(requestedFor)}?before=${encodeURIComponent(olderCursor)}`);
      if (!mountedRef.current || activeConversationRef.current !== requestedFor) return;
      const node = scrollRef.current;
      // Measured as the page goes in, so scrolling during the request is kept too.
      prependAnchorRef.current = node ? { beforeHeight: node.scrollHeight, beforeTop: node.scrollTop } : null;
      setMessages((current) => mergeOlderPage(current, (result.history ?? []).map(historyMessage)));
      const next = olderCursorFrom(result);
      setOlderCursor(next);
      if (!next) setReachedStart(true);
    } catch {
      // The cursor stays, so the same button tries again.
      if (mountedRef.current && activeConversationRef.current === requestedFor) setOlderError("Couldn't load earlier messages.");
    } finally {
      olderInFlightRef.current = false;
      if (mountedRef.current) setLoadingOlder(false);
    }
  }

  // The selected model is the one source of truth: the picker's check, the model the next message sends, and (because a chosen model
  // never answers from another tier) the reply's label all read it. A click selects at once; saving it as this conversation's model and
  // as the remembered default happens behind it, and a save that fails never moves the selection back: the message may already have
  // gone with it, and the picker must keep saying what was sent.
  async function changeModel(nextModel) {
    nextModel = canonicalModelKey(nextModel);
    if (modelSaving || busyRef.current || nextModel === model) return;
    if (!modelAllowedForTier(nextModel, tier, creditBalance)) {
      go("billing");
      return;
    }
    userPickedModelRef.current = true;
    setRetiredSelection(null);
    setModelSaving(true);
    setModel(nextModel);
    onModelChange?.(nextModel);
    setError("");
    // Use the same full preference upsert as Settings. Preserve an explicit
    // fixed default; when Settings is in Last-used mode, preferredModel is
    // null and the remembered model is what the next session restores.
    const payload = { ...quickPreferences, lastUsedModel: nextModel };
    if (preferredModelRef.current !== undefined) {
      payload.preferredModel = preferredModelRef.current ? canonicalModelKey(preferredModelRef.current) : null;
    }
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
    } catch {
      const name = [...MODELS, ...THIRD_PARTY_OPTIONS].find((entry) => entry.value === nextModel)?.label ?? nextModel;
      setError(conversationSaved
        ? `This conversation is using ${name}. We couldn't update your default model, but the conversation is saved.`
        : `Your next message will use ${name}. We couldn't save it as your default model just now.`);
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

  // Explicit stop. A reply keeps running when the page goes away, so closing the connection is not enough: the server is told to stop it,
  // and only then is the stream closed. A Stop pressed before the server named the reply is sent as soon as it does.
  async function requestStop(id) {
    setStopState("stopping");
    try {
      await api(`/api/chat/replies/${encodeURIComponent(id)}/stop`, { method: "POST" });
    } catch (error) {
      // 404: the reply had already finished, so there is nothing left to stop. Anything else: the server did not stop it, so the reply
      // keeps running and the page says so, rather than claiming it stopped.
      if (error?.status !== 404) {
        stopRequestedRef.current = false;
        setStopState("failed");
        setError("Couldn't stop this response. It's still running; try Stop again.");
        setErrorTone("warning");
        return false;
      }
    }
    activeRequestRef.current?.abort();
    attachRef.current?.abort();
    return true;
  }
  function stopReply({ waiting = false } = {}) {
    if (stopState === "stopping") return;
    if (waiting) cancelledWaitRef.current = true;
    stopRequestedRef.current = true;
    setStopState("stopping");
    const id = replyIdRef.current;
    if (id) return void requestStop(id);
    // Nothing reached the server yet (files still uploading): closing the request is the whole stop.
    if (!streamStartedRef.current) { activeRequestRef.current?.abort(); attachRef.current?.abort(); }
  }

  // A chat opened (or reloaded) while its reply is still running follows that reply instead of looking finished. Nothing is sent again.
  // The run keeps the time it started on the server, so its timer carries on from there instead of starting again at 0.
  async function attachToRunningReply(id, model, startedAt = null) {
    if (busyRef.current) return;
    const runStartedAt = Number.isFinite(Date.parse(startedAt ?? "")) ? Math.min(Date.parse(startedAt), Date.now()) : Date.now();
    busyRef.current = true;
    const controller = new AbortController();
    attachRef.current = controller;
    replyIdRef.current = id;
    stopRequestedRef.current = false;
    trackLiveReply(id, { local: true });
    setStreamingModel(model ?? sentModel);
    setBusy(true);
    setStreamText("");
    setLiveReasoning("");
    setLiveThought(null);
    setLivePhase({ phase: "thinking", startedAt: runStartedAt });
    const thoughtGuard = createReplyStreamGuard();
    let visible = "";
    let reasoningSoFar = "";
    try {
      const reply = await attachReplyStream(id, {
        signal: controller.signal,
        // Replayed and new status events keep the run's own start time: reopening never resets the timer.
        onStatus: (phase, details) => { if (mountedRef.current) setLivePhase({ phase, attempt: details?.attempt, maxAttempts: details?.maxAttempts, service: details?.service, tier: details?.tier, startedAt: runStartedAt }); },
        onDelta: (delta) => {
          if (!mountedRef.current) return;
          if (typeof delta.reasoning === "string") { reasoningSoFar += delta.reasoning; setLiveReasoning(reasoningSoFar); return; }
          if (delta.reasoningReset) { reasoningSoFar = ""; setLiveReasoning(""); return; }
          if (delta.reset) { visible = ""; thoughtGuard.reset(); setStreamText(""); return; }
          if (typeof delta.text !== "string") return;
          const guarded = thoughtGuard.push(delta.text);
          if (guarded.discardEarlier) { visible = ""; setStreamText(""); }
          if (!guarded.text) return;
          visible += guarded.text;
          setStreamText(visible);
        },
      });
      if (!mountedRef.current) return;
      if (reply) {
        if (reply.artifact) setBuildRefresh((value) => value + 1);
        // The saved reply, once: a reply already in the loaded history is not added again.
        setMessages((current) => (reply.messageId && current.some((message) => message.id === reply.messageId)) ? current : [
          ...current,
          { id: reply.messageId ?? null, clientKey: nextClientKey(), role: "assistant", content: reply.reply, sources: reply.sources ?? [], activitySummary: reply.activitySummary ?? [], attachment: reply.attachment ?? null, imagePrompt: reply.imagePrompt ?? null, model: reply.modelKey ?? null, fresh: !visible, pendingAction: reply.pendingAction ?? null, reasoning: reasoningSoFar.trim() ? reasoningSoFar : undefined, thoughtSeconds: reply.thoughtSeconds ?? null, contextReduced: reply.contextReduced === true },
        ]);
      } else {
        await reloadSavedHistory();
      }
    } catch (err) {
      if (!mountedRef.current) return;
      if (stopRequestedRef.current) {
        const partial = interruptedStreamMessage(visible, model ?? sentModel, { stopped: true });
        if (partial) setMessages((current) => [...current, { ...partial, clientKey: nextClientKey() }]);
      } else if (err?.name !== "AbortError") {
        setError(err?.message || "The reply couldn't be followed. Reload the chat to see what was saved.");
      }
    } finally {
      stopRequestedRef.current = false;
      busyRef.current = false;
      setStopState("idle");
      if (attachRef.current === controller) attachRef.current = null;
      if (replyIdRef.current === id) replyIdRef.current = null;
      if (mountedRef.current) { setBusy(false); setStreamText(""); setLiveReasoning(""); setLiveThought(null); }
    }
  }

  async function reloadSavedHistory() {
    const id = activeConversationRef.current ?? conversationId;
    if (!id) return;
    try {
      const result = await api(`/api/chat/conversations/${encodeURIComponent(id)}`);
      if (mountedRef.current) { setMessages((result.history ?? []).map(historyMessage)); setOlderCursor(olderCursorFrom(result)); }
    } catch { /* the chat keeps what it shows */ }
  }

  // Delivery is separate from send so a failed attempt can be replayed without
  // appending the user's message to the thread a second time.
  async function deliver(content, selectedAttachments, turnMentions = {}) {
    const turnConnectors = turnMentions.selectedConnectors ?? selectedConnectors;
    const turnSkills = turnMentions.selectedSkills ?? selectedSkills;
    if (busyRef.current) return;
    busyRef.current = true;
    const controller = new AbortController();
    activeRequestRef.current = controller;
    cancelledWaitRef.current = false;
    stopRequestedRef.current = false;
    streamStartedRef.current = false;
    replyIdRef.current = null;
    let replyId = null;
    setStreamingModel(sentModel);
    setBusy(true);
    setError("");
    setAllowanceBlock(null);
    setLiveSources([]);
    setActivity(selectedAttachments.length ? "Thinking" : "Thinking");
    onBackgroundTask?.({ label: "Thinking", detail: selectedAttachments.length ? "Reading your files and preparing a reply." : "Preparing a reply in the background." });
    let uploaded = [];
    let visibleStream = "";
    let previousStream = "";
    // The reply text, through the same filter the server uses, before any of it is shown or kept.
    const thoughtGuard = createReplyStreamGuard();
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
      streamStartedRef.current = true;
      const reply = await streamChat(
        {
          message: content,
          model: sentModel,
          conversationId,
          mode,
          ...(group && !conversationId ? { groupId: group.id } : {}),
          ...(temporaryChat && !conversationId && !studyMode ? { temporary: true } : {}),
          ...(recapRef.current ? { memoryRecap: recapRef.current } : {}),
          attachmentIds: uploaded.map((file) => file.id),
          // Send the currently selected mode with this turn as well as saving
          // it in Settings. This avoids a PATCH/send race when someone changes
          // the mode and immediately sends their next message.
          responseStyle: mode === "study" ? "friendly" : quickPreferences.responseStyle,
          thinkingEffort: quickPreferences.thinkingEffort,
          // A marketplace model's thinking level, as chosen when this message was sent (a later change applies to the next message).
          ...(marketplaceLevel && !studyMode ? { thinkingLevel: marketplaceLevel } : {}),
          ...(turnConnectors.length ? { selectedConnectors: turnConnectors.map((entry) => entry.id) } : {}),
          ...(turnSkills.length ? { selectedSkillIds: turnSkills.map((entry) => entry.id) } : {}),
        },
        (phase, details) => {
          if (mountedRef.current && details?.sources) setLiveSources(details.sources);
          const next = phase === "searching" ? "Searching the web" : phase === "calculating" ? "Calculating" : phase === "writing" ? "Writing" : phase === "queued" ? "Waiting for a free slot" : "Thinking";
          if (mountedRef.current) setActivity(next);
          if (phase !== currentPhase) {
            currentPhase = phase;
            // The counter shows thinking time, or, while every slot is taken, how long the reply has been waiting.
            if (phase === "thinking" || phase === "queued") thinkingStartedAt = Date.now();
          }
          if (mountedRef.current) setLivePhase({ phase, attempt: details?.attempt, maxAttempts: details?.maxAttempts, service: details?.service, tier: details?.tier, startedAt: thinkingStartedAt });
          if (replyId) trackLiveReply(replyId, { label: next === "Thinking" ? "Writing a reply" : next });
          onBackgroundTask?.({ label: next === "Writing" ? "Writing your document" : next, detail: phase === "searching" ? "Checking web sources for up-to-date information." : phase === "calculating" ? "Running the calculation in an isolated sandbox." : phase === "writing" ? "Writing your document. Longer documents take up to a minute." : phase === "queued" ? "Every slot is in use right now. Your reply starts as soon as one is free." : "Preparing a reply in the background." });
        },
        {
          signal: controller.signal,
          onReply: (data) => {
            if (!data?.replyId) return;
            replyId = data.replyId;
            if (mountedRef.current) replyIdRef.current = replyId;
            trackLiveReply(replyId, { conversationId: conversationId ?? null, mode, local: true });
            // Stop was pressed before the server named the reply: stop it now.
            if (stopRequestedRef.current) void requestStop(replyId);
          },
          // A first message's conversation exists before the reply does, so
          // a failed reply's Retry (and the next message) continue it
          // instead of starting another.
          onConversation: (saved) => {
            if (!saved?.conversationId || saved.conversationId === conversationId) return;
            setConversationId(saved.conversationId);
            onConversationSaved?.(saved.conversationId, !mountedRef.current);
            // A new chat's running reply now belongs to it (an existing chat's was recorded when the reply was named).
            if (replyId) trackLiveReply(replyId, { conversationId: saved.conversationId });
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
            if (delta.reset) { previousStream = delta.withdraw ? "" : (visibleStream || previousStream); visibleStream = ""; thoughtGuard.reset(); setStreamText(""); return; }
            if (typeof delta.text !== "string") return;
            const guarded = thoughtGuard.push(delta.text);
            // A closing reasoning tag with no opening one: what was shown before it was reasoning. Clear it, and keep no copy.
            if (guarded.discardEarlier) { visibleStream = ""; previousStream = ""; setStreamText(""); }
            if (!guarded.text) return;
            if (!streamedAny && reasoningSoFar) setLiveThought(elapsedSeconds(thinkingStartedAt));
            streamedAny = true;
            visibleStream += guarded.text;
            setStreamText((current) => current + guarded.text);
          },
        },
      );
      if (mountedRef.current) setActivity("Almost done");
      onBackgroundTask?.({ label: "Almost done", detail: "Saving the completed response to this conversation." });
      await new Promise((resolve) => setTimeout(resolve, 240));
      setConversationId(reply.conversationId);
      if (reply.artifact) setBuildRefresh((value) => value + 1);
      if (typeof reply.temporary === "boolean") setTemporaryChat(reply.temporary);
      onConversationSaved?.(reply.conversationId, !mountedRef.current);
      if (mountedRef.current) setMessages((current) => [
        ...current,
        // A reply already read as it streamed isn't typed out a second time.
        { id: reply.messageId ?? null, clientKey: nextClientKey(), role: "assistant", content: reply.reply, sources: reply.sources ?? [], activitySummary: reply.activitySummary ?? [], attachment: reply.attachment ?? null, imagePrompt: reply.imagePrompt ?? null, model: reply.modelKey ?? null, fresh: !streamedAny,
          pendingAction: reply.pendingAction ?? null,
          // Thinking text exists only when a route is verified to show a summary
          // (none is today); otherwise it is empty and the pill has no drawer.
          reasoning: reasoningSoFar.trim() ? reasoningSoFar : undefined,
          // How long the model thought, as the server measured it. It does not
          // depend on any thinking text being shown: with none, the reply keeps
          // a "Thought for X s" pill that has nothing to expand. No measured
          // time means no pill.
          thoughtSeconds: reply.thoughtSeconds ?? null,
          // Older messages were summarized (or long references shortened) to fit this reply: say so under it.
          contextReduced: reply.contextReduced === true },
      ]);
      if (mountedRef.current) { setStreamText(""); setLiveReasoning(""); setLiveThought(null); }
      selectedAttachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
      if (mountedRef.current) setFailed(null);
    } catch (err) {
      // The files could not be stored (storage full, or a file over the plan's per-file size): nothing reached the model, so the message
      // and its files go back to the composer, the one storage notice says why, and there is no Retry (retrying cannot fix it).
      const uploadBlocked = !uploaded.length && ["storage-limit", "upload-plan-limit"].includes(err?.code);
      if (uploadBlocked) {
        if (mountedRef.current) {
          if (turnMentions.userKey) setMessages((current) => current.filter((message) => message.clientKey !== turnMentions.userKey));
          setDraft((current) => current || content);
          if (selectedAttachments?.length) setAttachments(selectedAttachments);
          setFailed(null);
          // The notice at the top (access status, with the server's own sentence) says it once: no second banner here.
          setError("");
        }
      } else if (stopRequestedRef.current && !cancelledWaitRef.current) {
        // Stopped on purpose: what was written so far stays on screen, with no error.
        stopRequestedRef.current = false;
        if (mountedRef.current) {
          const partial = interruptedStreamMessage(visibleStream || previousStream, streamingModel ?? sentModel, { stopped: true });
          if (partial) setMessages((current) => [...current, { ...partial, clientKey: nextClientKey() }]);
          setFailed(null);
          setError("");
        }
      } else if (cancelledWaitRef.current) {
        // Cancelled while waiting for a slot: the reply never started, so the message goes back to the composer to edit or resend.
        cancelledWaitRef.current = false;
        if (mountedRef.current) {
          setDraft((current) => current || content);
          if (selectedAttachments?.length) setAttachments(selectedAttachments);
          setFailed(null);
          setError("");
        }
      } else if (mountedRef.current) {
        const partial = interruptedStreamMessage(visibleStream || previousStream, streamingModel ?? sentModel);
        if (partial) setMessages((current) => [...current, { ...partial, clientKey: nextClientKey() }]);
        const block = err.code === "allowance_exceeded" ? allowanceViewFromChatError(err) : null;
        setAllowanceBlock(block);
        const isPlanRestriction = err.access?.reason === "plan" || err.code === "free_restricted_to_green_dot" || err.code === "plan-required";
        setError(err.access?.reason === "quota" || err.access?.reason === "rate" || isPlanRestriction || block ? "" : err.message);
        setErrorTone(["high_demand", "upstream_busy", "capacity_user_waiting"].includes(err.code) ? "warning" : "error");
        if (isPlanRestriction) {
          setDraft(content);
          if (selectedAttachments?.length) setAttachments(selectedAttachments);
          setFailed(null);
        } else {
          setFailed({ content, attachments: selectedAttachments, selectedConnectors: turnConnectors, selectedSkills: turnSkills });
        }
      }
      await Promise.all(uploaded.map((file) => api(`/api/uploads/${file.id}`, { method: "DELETE" }).catch(() => null)));
    } finally {
      busyRef.current = false;
      setStopState("idle");
      if (activeRequestRef.current === controller) activeRequestRef.current = null;
      if (replyId) untrackLiveReply(replyId);
      if (replyIdRef.current === replyId) replyIdRef.current = null;
      streamStartedRef.current = false;
      // Refresh after both a successful reservation and an automatic refund so
      // Free users' paid-model availability always reflects the real balance.
      void onUsageChanged?.();
      // Any open allowance view re-reads the server's figures after a request outcome.
      if (isAllowanceUiEnabled()) window.dispatchEvent(new CustomEvent("vibhavgpt:allowance-changed"));
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
    setMessages((current) => [...current, { clientKey: nextClientKey(), role: "user", content: autoPrompt.text }]);
    void deliver(autoPrompt.text, []).finally(() => { recapRef.current = null; });
    onAutoPromptSent?.();
  // Runs once per opened recap; deliver reads current state through refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPrompt]);

  async function send(event) {
    event.preventDefault();
    closeMentionPicker();
    const content = draft.trim();
    if (!content && attachments.length === 0) {
      inputRef.current?.focus();
      return;
    }
    if (!sentModel) {
      setError("Choose a model to send this message.");
      return;
    }
    // Build below Pro: nothing is sent (the server would refuse it too, before any inference or charge).
    if (buildLocked) {
      setError("Build with VibhavGPT Tecton is available on Pro or Max.");
      return;
    }
    if (visionModelRequired) {
      setError("Choose a model that supports images to ask about an image.");
      return;
    }
    // A reply is still coming in: the Send button is Stop response until it ends, and the draft stays in the box, untouched (owner
    // request, 2026-11-15). Nothing is sent or queued behind the person's back.
    if (busyRef.current || busy) return;
    const selectedAttachments = attachments;
    const turnConnectors = selectedConnectors;
    const turnSkills = selectedSkills;
    if (dictation.listening) dictation.stop();
    setSendPulse((count) => count + 1);
    setDraft("");
    setAttachments([]);
    setSelectedSkills([]);
    closeMentionPicker();
    await startTurn(content, selectedAttachments, { selectedConnectors: turnConnectors, selectedSkills: turnSkills });
  }

  // A follow-up sent from a widget in a reply (a quiz's "Ask VibhavGPT to
  // explain"): queued like a typed message while a reply is still coming in.
  // The widget's own state is untouched, since the reply it lives in stays.
  const askFromWidget = (content) => {
    setSendPulse((count) => count + 1);
    if (busyRef.current || busy) {
      queueId.current += 1;
      setQueue((current) => [...current, { id: queueId.current, content, attachments: [] }]);
      requestAnimationFrame(() => stickToBottom());
      return;
    }
    void startTurn(content, []);
  };

  // A finished flashcard review or quiz is kept with its reply, so the next
  // turn, on whichever model, knows how it went. Best effort: a failure here
  // never interrupts the learner.
  const recordStudyResult = (messageId, result) => {
    api(`/api/chat/conversations/${conversationId}/messages/${messageId}/study-results`, { method: "POST", body: JSON.stringify(result) }).catch(() => {});
  };

  function startTurn(content, selectedAttachments, turnMentions = {}) {
    setFailed(null);
    const userKey = nextClientKey();
    setMessages((current) => [
      ...current,
      {
        clientKey: userKey,
        role: "user",
        content: content || "Attached file(s)",
        attachments: selectedAttachments.map((attachment) => ({
          name: attachment.file.name,
          image: attachment.file.type.startsWith("image/"),
        })),
      },
    ]);
    return deliver(content, selectedAttachments, { ...turnMentions, userKey });
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
    void startTurn(next.content, next.attachments, {
      selectedConnectors: next.selectedConnectors ?? [],
      selectedSkills: next.selectedSkills ?? [],
    });
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

  // Temporary chat. One notice, shown on the new-chat screen once it is on and at the top of the thread while it lasts.
  const temporaryNotice = (
    <p className="temporary-banner" role="note"><HatGlasses size={14} strokeWidth={1.8} aria-hidden="true" /> Temporary chat. Memory isn't used or saved, it isn't in your chat list, and it's deleted after 24 hours.</p>
  );
  useEffect(() => {
    setHeaderSlot(document.getElementById(narrow ? "chat-header-actions-mobile" : "chat-header-actions"));
  }, [narrow]);
  const inThread = Boolean(conversationId) || messages.length > 0;
  function temporaryButtonClick() {
    if (inThread && temporaryChat) setLeaveTemporaryOpen(true);
    else if (inThread) onStartTemporaryChat?.();
    else setTemporaryChat((value) => !value);
  }
  const temporaryButton = !studyMode && headerSlot ? createPortal(
    <IconButton
      className="temporary-chat-button"
      label="Temporary chat"
      title="Temporary chat — no memory used or saved, not kept."
      active={temporaryChat}
      aria-pressed={temporaryChat}
      disabled={busy}
      onClick={temporaryButtonClick}
    >
      <HatGlasses size={20} strokeWidth={1.8} aria-hidden="true" />
    </IconButton>,
    headerSlot,
  ) : null;
  const effortApplies = tier !== "free" && THINKING_MODELS.includes(sentModel);
  // A marketplace model's thinking levels, exactly as its maker documents them (none for a model without levels).
  // Every model whose thinking can be adjusted shows the same three levels; each maps to that model's own (thinking-levels.js).
  const levelOptions = !studyMode && !buildMode && model && marketplaceThinking(model)?.levels?.length > 1 ? THINKING_CHOICES : null;
  const houseLevel = toUnified(quickPreferences.thinkingEffort) ?? DEFAULT_UNIFIED_LEVEL;

  // Suggestions on a new chat. Each one only fills the box (nothing is sent), as the Study buttons always did.
  // Study home: the tools sit below the composer and the Chat/Study control, in the same flow on phone and desktop.
  // Each one only fills the box (nothing is sent). Writing tools opens its panel right here, under the chips.
  const startRows = empty && !loadingConversation && studyMode ? (
    <>
      <div className="study-starters" role="group" aria-label="Study tools">
        {STUDY_STARTERS.map((label) => <button type="button" className="btn btn--secondary" key={label} onClick={() => { setDraft(label); inputRef.current?.focus(); }}>{(() => { const Icon = STUDY_STARTER_ICON[label] ?? Sparkles; return <Icon size={16} strokeWidth={1.7} aria-hidden="true" />; })()}{label}</button>)}
        {onOpenWritingTools && <button type="button" className="btn btn--secondary study-starters__tool" aria-expanded={Boolean(toolsPanel)} onClick={() => (toolsPanel ? onCloseWritingTools?.() : onOpenWritingTools("detector"))}><PenLine size={16} strokeWidth={1.7} aria-hidden="true" />Writing tools</button>}
      </div>
      {toolsPanel}
    </>
  ) : null;

  // Composer parts, shared by the desktop bar and the phone pill so the two
  // layouts cannot drift apart in behaviour, only in arrangement.
  const mentionChips = (
    <ComposerMentionChips
      skills={selectedSkills}
      onRemoveSkill={(id) => setSelectedSkills((current) => current.filter((entry) => entry.id !== id))}
    />
  );
  const composerInput = (
    <div className="composer__input-wrap">
      {mentionChips}
      {mentionTrigger && (
        <ComposerMentionsPopover
          kind={mentionTrigger.kind}
          query={mentionTrigger.query}
          connectors={connectorsCatalog}
          skills={skillsCatalog}
          selectedConnectorIds={selectedConnectorIdSet}
          selectedSkillIds={selectedSkillIdSet}
          highlightIndex={mentionHighlight}
          onHighlight={setMentionHighlight}
          loading={mentionsLoading}
          onClose={closeMentionPicker}
          onConnectConnector={() => {
            removeMentionTriggerText(mentionTrigger);
            closeMentionPicker();
            onOpenExtensions?.();
          }}
          onSelectConnector={(connector) => mentionConnectorInline(mentionTrigger, connector)}
          onSelectSkill={(skill) => {
            setSelectedSkills((prev) => (
              prev.some((entry) => entry.id === skill.id)
                ? prev
                : [...prev, { id: skill.id, name: skill.name }]
            ));
            removeMentionTriggerText(mentionTrigger);
            closeMentionPicker();
          }}
        />
      )}
      {mentions.length > 0 && <MentionMirror inputRef={inputRef} text={draft} mentions={mentions} />}
      {selectedConnectors.length > 0 && <span id="composer-mention-note" className="sr-only">Connectors mentioned: {selectedConnectors.map((entry) => entry.name).join(", ")}</span>}
      <textarea
        ref={inputRef}
        className="composer__input"
        aria-describedby={selectedConnectors.length > 0 ? "composer-mention-note" : undefined}
        value={draft}
        onChange={handleComposerChange}
        onPaste={handlePaste}
        onCompositionStart={() => { imeComposingRef.current = true; }}
        onCompositionEnd={(event) => {
          imeComposingRef.current = false;
          syncMentionTrigger(event.target.value, event.target.selectionStart);
        }}
        onFocus={() => {
          if (!empty || !studyMode) return;
          inputRef.current?.closest(".composer")?.scrollIntoView({ block: "nearest", inline: "nearest" });
        }}
        onKeyDown={handleComposerKeyDown}
        onClick={(event) => syncMentionTrigger(event.currentTarget.value, event.currentTarget.selectionStart)}
        onKeyUp={(event) => syncMentionTrigger(event.currentTarget.value, event.currentTarget.selectionStart)}
        placeholder="Ask VibhavGPT"
        aria-label={studyMode ? "Message VibhavGPT" : buildMode ? "Message VibhavGPT Tecton" : `Message ${modelInfo.full}`}
        rows="1"
      />
    </div>
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
      {/* Grouped (Slice 6): what to attach, a divider, (Study) the writing tools, a divider, how the reply is written as one named group,
          a divider, and Custom (which opens Settings). Same rows, same actions. */}
      <MenuItem icon={<ImageIcon size={16} />} description="Images from your device" onSelect={() => imageInputRef.current?.click()}>Photos</MenuItem>
      <MenuItem icon={<FileText size={16} />} description="PDF, Word, text, CSV or JSON" onSelect={() => fileInputRef.current?.click()}>Files</MenuItem>
      {onOpenWritingTools && <>
        <MenuSeparator />
        <MenuGroup label="Writing tools">
          <MenuItem icon={<ScanSearch size={16} />} description="Check text for AI writing patterns" onSelect={() => onOpenWritingTools("detector")}>AI Detector</MenuItem>
          <MenuItem icon={<Wand2 size={16} />} description="Rewrite robotic text into natural human prose" onSelect={() => onOpenWritingTools("humanizer")}>AI Humanizer</MenuItem>
        </MenuGroup>
      </>}
      {mode !== "study" && <>
        <MenuSeparator />
        <MenuGroup label="Response mode">
          <MenuItem icon={<AlignLeft size={16} />} description="Short, direct answers" selected={quickPreferences.responseStyle === "concise"} onSelect={() => changeResponseStyle("concise")} disabled={busy || !preferencesLoaded}>Concise</MenuItem>
          <MenuItem icon={<AlignJustify size={16} />} description="Thorough context and examples" selected={quickPreferences.responseStyle === "detailed"} onSelect={() => changeResponseStyle("detailed")} disabled={busy || !preferencesLoaded}>Detailed</MenuItem>
          <MenuItem icon={<GraduationCap size={16} />} description="Step by step, beginner-friendly" selected={quickPreferences.responseStyle === "friendly"} onSelect={() => changeResponseStyle("friendly")} disabled={busy || !preferencesLoaded}>Learning</MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem icon={<SettingsIcon size={16} />} description="Your own instructions in Settings" trailing={<span className="ui-menu__aside">Settings</span>} onSelect={onOpenSettings}>Custom</MenuItem>
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
      title={dictation.listening ? "Stop dictation" : "Dictate"}
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
  // While this conversation's reply runs, Send is Stop response, in the same place: it stops that exact reply on the server (requestStop),
  // or, while it is still waiting for a free slot, cancels the wait. It is never shown for another conversation's reply.
  const sendButton = busy ? (
    <button
      type="button"
      className="composer__send composer__send--stop"
      aria-label={stopState === "stopping" ? "Stopping response" : "Stop response"}
      title={stopState === "stopping" ? "Stopping…" : "Stop response"}
      data-state={stopState}
      aria-busy={stopState === "stopping" || undefined}
      disabled={stopState === "stopping"}
      onClick={() => stopReply({ waiting: livePhase.phase === "queued" && !streamText })}
    >
      <Square size={14} strokeWidth={0} fill="currentColor" aria-hidden="true" />
    </button>
  ) : (
    <button className="composer__send" aria-label="Send message" title="Send message" disabled={!draft.trim() && !attachments.length}>
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
            {buildMode ? (
              <>
                <h1 className="opening__title"><RevealWords text="What are we building?" /></h1>
                <p className="opening__lede">Build is VibhavGPT's coding model for prototypes, powered by VibhavGPT Tecton. Describe the app, page or tool, and get working code.</p>
                {buildLocked && (
                  <div className="build-gate" role="note" data-locked="true">
                    <p><strong>Build is included with Pro and Max.</strong> Upgrade to prototype with VibhavGPT Tecton.</p>
                    <button type="button" className="btn btn--primary" onClick={() => goProp?.("billing")}>See plans</button>
                  </div>
                )}
              </>
            ) : <>
            <h1 className="opening__title">
              <RevealWords text={mode !== "study" && !userName ? NAMELESS_GREETING : greeting} />
              {mode !== "study" && userName ? <em>, {userName}</em> : null}
            </h1>
            <p className="opening__lede">{mode === "study" ? "Paste your notes or name a topic below, or start from one of the tools under Chat and Study." : "Type a question below, or use + to attach a file."}</p>
            </>}
            {!studyMode && temporaryChat && temporaryNotice}
          </div>
        ) : (
          <div className="chat__thread">
            {temporaryChat && temporaryNotice}
            {olderCursor ? (
              <div className="load-earlier">
                {olderError && <p className="load-earlier__error" role="alert">{olderError}</p>}
                <button type="button" className="btn btn--secondary load-earlier__button" onClick={loadEarlier} disabled={loadingOlder || busy} aria-busy={loadingOlder || undefined}>
                  {loadingOlder ? "Loading earlier messages…" : olderError ? "Try again" : "Load earlier messages"}
                </button>
              </div>
            ) : reachedStart ? (
              <p className="history-start">Start of conversation</p>
            ) : null}
            {messages.map((message, index) => (
              <Fragment key={messageKey(message)}>
              {!studyMode && replySwitches.has(index) && (
                <div className="model-switch" role="separator" aria-label={`Now using ${replySwitches.get(index)}`}>
                  <span>Now using {replySwitches.get(index)}</span>
                </div>
              )}
              {message.role === "user" ? (
                <article className="turn turn--user">
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
                <article className="turn">
                  <div className="turn__byline">
                    <ReplyMark model={studyMode ? null : message.model} />
                    {studyMode ? "VibhavGPT" : modelLabel(message.model)}
                  </div>
                  <div className="bubble bubble--assistant bubble--wide">
                    <ReasoningTrace text={message.reasoning ?? ""} seconds={message.thoughtSeconds ?? null} />
                    <AssistantBody
                      text={message.content}
                      sources={message.sources ?? []}
                      animate={Boolean(message.fresh) && index === messages.length - 1}
                      onTick={stickToBottom}
                      onAsk={askFromWidget}
                      onStudyResult={message.id && conversationId ? (result) => recordStudyResult(message.id, result) : null}
                    />
                    {message.incomplete && <p className="response-interrupted" role="status">{message.stopped ? "You stopped this response. This partial answer is not saved." : "Response interrupted. This partial answer is not saved; retry for a complete response."}</p>}
                    {message.pendingAction && (
                      <ActionApprovalCard
                        pendingAction={message.pendingAction}
                        onResolved={() => onUsageChanged?.()}
                      />
                    )}
                    <SourcesDisclosure sources={message.sources ?? []} steps={message.activitySummary ?? []} />
                    {message.contextReduced && (
                      <p className="turn__context-note" role="note">This conversation is long, so earlier messages were summarized to fit. Your instructions and latest message were sent in full; restate any earlier requirement that matters.</p>
                    )}
                    {message.attachment && (
                      <PrivateFileLink className="generated-attachment" href={message.attachment.downloadUrl} name={message.attachment.name}>
                        {message.attachment.kind === "generated-image" ? <PrivateImage lazy loading="lazy" src={message.attachment.previewUrl ?? message.attachment.downloadUrl} alt={message.attachment.name} /> : <FileText size={22} />}
                        <span><strong>{message.attachment.name}</strong><small>Download file</small></span>
                      </PrivateFileLink>
                    )}
                    {message.attachment?.kind === "generated-image" && Boolean(message.imagePrompt) && (
                      <ImagePromptDisclosure prompt={message.imagePrompt} />
                    )}
                  </div>
                  <div className="turn__tools">
                    <CopyButton text={message.content} />
                  </div>
                </article>
              )}
              </Fragment>
            ))}
            {busy && (
              <article className="turn">
                <div className="turn__byline">
                  <ReplyMark model={studyMode ? null : streamingModel ?? sentModel} />
                  {studyMode ? "VibhavGPT" : modelLabel(streamingModel ?? sentModel)}
                </div>
                <div className={`bubble bubble--assistant${streamText ? " bubble--wide" : ""}`}>
                  {liveReasoning && streamText && <ReasoningTrace text={liveReasoning} seconds={liveThought} />}
                  {streamText
                    ? <AssistantBody text={buildMode ? visibleBuildStream(streamText) : streamText} animate={false} streaming sources={liveSources} />
                    : <ThinkingTool state="thinking" label={<LiveStatusLabel {...livePhase} />} sources={liveSources} />}
                  {stopState === "stopping" && <p className="chat__stopping" role="status">Stopping…</p>}
                  {liveReasoning && !streamText && <ReasoningTrace text={liveReasoning} live />}
                </div>
              </article>
            )}
            {/* The project card comes after the conversation: the person's prompt, then the reply, then the files it made. */}
            {buildMode && conversationId && <BuildProject conversationId={conversationId} refreshKey={buildRefresh} />}
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
        {materials.length > 0 && <div className="chat-materials" aria-label="Conversation materials">
          {materials.map((file) => <PrivateFileLink key={file.id} href={file.downloadUrl} name={file.name} className="btn btn--quiet"><FileText size={14} />{file.name}</PrivateFileLink>)}
        </div>}
        {allowanceBlock && (
          <AllowanceExhaustedNotice view={allowanceBlock} compact onChooseFreeModel={(choice) => changeModel(choice.modelKey)}>
            <div className="allowance-exhausted__actions">
              <button type="button" className="btn btn--ghost" onClick={() => { setAllowanceBlock(null); setFailed(null); }}>Dismiss</button>
              {failed && (
                <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => deliver(failed.content, failed.attachments, { selectedConnectors: failed.selectedConnectors ?? [], selectedSkills: failed.selectedSkills ?? [] })}>
                  <RotateCw size={14} strokeWidth={2} /> Send again with {MODELS.find((entry) => entry.value === model)?.label ?? "the selected model"}
                </button>
              )}
            </div>
          </AllowanceExhaustedNotice>
        )}
        {error && (
          <Banner
            tone={errorTone}
            title={errorTone === "warning" ? "High demand" : "Couldn't reply"}
            className="chat-banner"
            onDismiss={() => { setError(""); setFailed(null); }}
            action={failed && (
              <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => deliver(failed.content, failed.attachments, { selectedConnectors: failed.selectedConnectors ?? [], selectedSkills: failed.selectedSkills ?? [] })}>
                <RotateCw size={14} strokeWidth={2} /> Retry
              </button>
            )}
          >
            {error}
          </Banner>
        )}
        {(() => {
          const replacement = conversationReplacement ?? modelReplacement;
          if (!replacement || model !== replacement.to) return null;
          return (
            <Banner tone="info" title={`${replacement.fromName} is now ${replacement.toName}.`} onDismiss={() => { setConversationReplacement(null); onDismissModelReplacement?.(); }} dismissLabel="Dismiss model update notice">
              Your next message uses {replacement.toName}. Earlier replies keep the name of the model that wrote them.
            </Banner>
          );
        })()}
        {retiredSelection && !model && (
          <Banner tone="info" title={`VibhavGPT ${RETIRED_HOUSE_NAMES[retiredSelection] ?? "That model"} has been retired.`} help="This model is no longer offered, so nothing is sent until you choose another. Your conversation and the replies it already wrote are kept, with their original names.">Choose an available model to continue. Your conversation is kept.</Banner>
        )}
        {visionModelRequired && (
          <Banner tone="info" title="Choose a model that supports images." help="The selected model reads text only, so it can't see the image you attached. Switch to a model that reads images, or remove the image to send just your text." action={imageModelForPlan ? <button type="button" className="btn btn--primary" onClick={() => changeModel(imageModelForPlan.value)}>Switch to {imageModelForPlan.label}</button> : null} />
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
                    className="composer__effort composer__level"
                    label="Thinking level for your next response"
                    value={houseLevel}
                    onChange={changeThinkingEffort}
                    disabled={busy || !preferencesLoaded}
                    placement="top"
                    options={THINKING_OPTIONS}
                  />
                )}
                {levelOptions && (
                  <Select
                    size="sm"
                    className="composer__effort composer__level"
                    label="Thinking level for your next response"
                    value={marketplaceLevel}
                    onChange={(value) => changeThinkingLevel(model, value)}
                    disabled={busy}
                    placement="top"
                    options={levelOptions}
                  />
                )}
                {!studyMode && !buildMode && <ModelTrigger entry={selectedEntry} onOpen={() => setPickerOpen(true)} disabled={busy || modelSaving} />}
                {micButton}
                {sendButton}
              </div>
            </div>
          </form>
        )}
        {/* On a new chat, one line of real context under the box: the model
            the next message goes to, what it is for, and how to send. */}
        {empty && !loadingConversation && (
          <p className="composer-context">
            <span><strong>{MODELS.find((entry) => entry.value === model)?.label ?? "Lumen"}</strong> {MODELS.find((entry) => entry.value === model)?.description}</span>
            {!narrow && <span className="composer-context__keys"><kbd>Enter</kbd> to send, <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line</span>}
          </p>
        )}
        {empty && !loadingConversation && (
          <div className="start-below">
            {tabsBelow && <div className="start-below__tabs">{tabsBelow}</div>}
            {startRows}
          </div>
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
          {onOpenWritingTools && <><p className="add-sheet__label">Writing tools</p>
          <div className="add-sheet__list">
            <button type="button" className="add-sheet__row" onClick={() => { closeSheet(); onOpenWritingTools("detector"); }}>
              <ScanSearch size={19} strokeWidth={1.9} />
              <span className="add-sheet__copy">AI Detector<small>Check text for AI writing patterns</small></span>
              <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
            </button>
            <button type="button" className="add-sheet__row" onClick={() => { closeSheet(); onOpenWritingTools("humanizer"); }}>
              <Wand2 size={19} strokeWidth={1.9} />
              <span className="add-sheet__copy">AI Humanizer<small>Rewrite robotic text into natural human prose</small></span>
              <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          </div></>}
          {mode !== "study" && <><div className="add-sheet__list">
            <button type="button" className="add-sheet__row" disabled={busy} onClick={() => { closeSheet(); setPickerOpen(true); }}>
              <SlidersHorizontal size={19} strokeWidth={1.9} />
              <span className="add-sheet__copy">Model<small>{modelInfo.label}</small></span>
              <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
            </button>
            {levelOptions && (
              <button type="button" className="add-sheet__row" disabled={busy} onClick={() => setSheet("level")}>
                <Brain size={19} strokeWidth={1.9} />
                <span className="add-sheet__copy">Thinking level<small>{unifiedLabel(marketplaceLevel)}</small></span>
                <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
            {effortApplies && (
              <button type="button" className="add-sheet__row" disabled={busy || !preferencesLoaded} onClick={() => setSheet("effort")}>
                <Brain size={19} strokeWidth={1.9} />
                <span className="add-sheet__copy">Thinking level<small>{unifiedLabel(houseLevel)}</small></span>
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
      <ModelPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        entries={pickerModels}
        selected={model}
        allowedFor={(value) => modelAllowedForTier(value, tier, creditBalance)}
        onSelect={(value) => void changeModel(value)}
        onUpgrade={() => { setPickerOpen(false); go("billing"); }}
        disabled={busy || modelSaving}
      />
      <BottomSheet open={narrow && sheet === "level" && Boolean(levelOptions)} onClose={closeSheet} title="Thinking level">
        <div className="model-sheet" role="radiogroup" aria-label="Thinking level for your next response">
          {(levelOptions ?? []).map((option) => (
            <button key={option.value} type="button" role="radio" aria-checked={marketplaceLevel === option.value} className="model-sheet__option" disabled={busy} onClick={() => { changeThinkingLevel(model, option.value); closeSheet(); }}>
              <span className="model-sheet__icon" aria-hidden="true"><Brain size={16} strokeWidth={1.9} /></span>
              <span className="model-sheet__copy"><span className="model-sheet__name">{option.label}</span></span>
              {marketplaceLevel === option.value && <Check className="model-sheet__check" size={18} strokeWidth={2.6} aria-hidden="true" />}
            </button>
          ))}
        </div>
      </BottomSheet>
      <BottomSheet open={narrow && sheet === "effort"} onClose={closeSheet} title="Thinking level">
        <div className="model-sheet" role="radiogroup" aria-label="Thinking level for your next response">
          {THINKING_OPTIONS.map((option) => {
            const selected = houseLevel === option.value;
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
      {temporaryButton}
      <Modal
        open={leaveTemporaryOpen}
        onClose={() => setLeaveTemporaryOpen(false)}
        eyebrow="Temporary chat"
        title="Leave this temporary chat?"
        description="It isn't saved to your chat list and is deleted within 24 hours. Your next chat can use and save memory as usual."
      >
        <div className="ui-modal__actions">
          <button type="button" className="btn btn--ghost" onClick={() => setLeaveTemporaryOpen(false)}>Stay here</button>
          <button type="button" className="btn btn--primary" onClick={() => { setLeaveTemporaryOpen(false); onExitTemporaryChat?.(); }}>Start a normal chat</button>
        </div>
      </Modal>
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

// Settings: using saved memories and saving new ones are separate switches; clear-all. Turning either off deletes nothing.
// Settings > Media: the VibhavGPT mark on generated images (owner policy, 2026-11-16; enforced on the server in
// src/generation/watermark.js). On the Free plan it is always on, so the switch is shown on and locked. On paid plans it is off unless
// turned on here. It applies wherever a picture is opened or downloaded, including ones made before; the stored originals don't change.
function MediaSettingsCard() {
  const [state, setState] = useState({ loading: true, enabled: false, locked: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const read = (preferences) => ({ loading: false, enabled: preferences?.imageWatermark?.enabled === true, locked: preferences?.imageWatermark?.locked === true });
  useEffect(() => {
    let cancelled = false;
    api("/api/me/preferences", { cache: "no-store" })
      .then(({ preferences }) => { if (!cancelled) setState(read(preferences)); })
      .catch(() => { if (!cancelled) { setState((current) => ({ ...current, loading: false })); setError("Your media settings could not be loaded."); } });
    return () => { cancelled = true; };
  }, []);
  async function choose(value) {
    const enabled = value === "on";
    if (state.locked || enabled === state.enabled) return;
    const previous = state.enabled;
    setSaving(true); setError("");
    setState((current) => ({ ...current, enabled }));
    try {
      const { preferences } = await api("/api/me/preferences", { method: "PATCH", body: JSON.stringify({ imageWatermark: enabled }) });
      setState(read(preferences));
    } catch (err) {
      setState((current) => ({ ...current, enabled: previous }));
      setError(err.message || "That setting couldn't be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="settings-stack">
      <SettingsGroup title="Image watermark" description="A small black-and-white VibhavGPT mark in the bottom-right corner of images made for you, on screen and in downloads.">
        <SettingsRow label="Add the VibhavGPT mark" description={state.locked ? "Images on the Free plan always carry the mark. Paid plans can turn it off." : "Off unless you turn it on. Applies to all your images, including ones already made, whenever they're opened or downloaded."}>
          <Segmented
            label="Watermark"
            value={state.enabled ? "on" : "off"}
            onChange={(value) => void choose(value)}
            disabled={state.loading || saving || state.locked}
            options={[{ value: "on", label: "On" }, { value: "off", label: "Off" }]}
          />
        </SettingsRow>
        {error && <p className="note note--error" role="alert">{error}</p>}
      </SettingsGroup>
    </div>
  );
}

function MemorySettingsCard() {
  const [state, setState] = useState({ loading: true, use: true, save: true, count: 0 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [clearOpen, setClearOpen] = useState(false);
  const load = useCallback(async () => {
    try {
      const result = await api("/api/memory");
      setState({ loading: false, use: (result.useEnabled ?? result.enabled) !== false, save: (result.saveEnabled ?? result.enabled) !== false, count: result.facts?.length ?? 0 });
    } catch {
      setState((current) => ({ ...current, loading: false }));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function toggle(key, value) {
    const next = value === "on";
    if (next === state[key]) return;
    setSaving(true);
    setError("");
    const previous = state[key];
    setState((current) => ({ ...current, [key]: next }));
    try {
      await api("/api/memory/settings", { method: "PUT", body: JSON.stringify({ [key]: next }) });
    } catch (err) {
      setState((current) => ({ ...current, [key]: previous }));
      setError(err.message || "That setting couldn't be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }
  const countLabel = state.loading ? "Checking saved memory…" : state.count === 0 ? "No saved memories" : `${state.count} saved ${state.count === 1 ? "memory" : "memories"}`;
  const onOff = [{ value: "on", label: "On" }, { value: "off", label: "Off" }];
  return (
    <div className="settings-stack">
      <SettingsGroup title="How memory works" description="Using memories and saving new ones are separate. Turning either off deletes nothing: your saved memories stay until you delete or clear them. A project's memories are used only in that project's chats, and temporary chats never use or save memory.">
        <SettingsRow label="Use memory when answering" description="Include your saved memories in your chats. Off: none are read or sent with your messages.">
          <Segmented label="Use memory when answering" value={state.use ? "on" : "off"} onChange={(value) => void toggle("use", value)} options={onOff} />
        </SettingsRow>
        <SettingsRow label="Save new memories" description="Let VibhavGPT save lasting details you share, and things you ask it to remember. Off: nothing new is saved.">
          <Segmented label="Save new memories" value={state.save ? "on" : "off"} onChange={(value) => void toggle("save", value)} options={onOff} />
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

// Where a memory came from, in words. Rows saved before provenance existed say only what is known.
const MEMORY_ORIGIN_LABEL = {
  explicit: "You asked VibhavGPT to remember this",
  inferred: "VibhavGPT saved this from a chat",
  manual: "Added by you",
  import: "Imported by you",
};
function memoryOrigin(fact) {
  return MEMORY_ORIGIN_LABEL[fact.origin] ?? (fact.source === "assistant" ? "Saved in a chat" : "Saved earlier");
}
function memoryDay(value) {
  const date = value ? new Date(value) : null;
  return !date || Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
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

function Memory({ onMemoriesAdded, onOpenConversation }) {
  const [facts, setFacts] = useState([]);
  const [memoryEnabled, setMemoryEnabled] = useState(null);
  const [saveEnabled, setSaveEnabled] = useState(null);
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
      setMemoryEnabled((result.useEnabled ?? result.enabled) !== false);
      setSaveEnabled((result.saveEnabled ?? result.enabled) !== false);
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

  // The only way a project's memory is used outside that project.
  async function makePersonal(id) {
    try {
      const result = await api(`/api/memory/${id}`, { method: "PATCH", body: JSON.stringify({ scope: "personal" }) });
      setFacts((current) => current.map((fact) => (fact.id === id ? { ...fact, ...result.fact, projectName: null } : fact)));
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
        <h1 className="page__title">Memory</h1>
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
      {memoryEnabled === false && saveEnabled === false && (
        <p className="note note--info">Memory is off. VibhavGPT isn't using or saving memories in your chats. Your saved memories are kept. Turn it back on in Settings.</p>
      )}
      {memoryEnabled === false && saveEnabled !== false && (
        <p className="note note--info">Using memory is off: these memories aren't included in your chats, but new ones can still be saved. Nothing here was deleted.</p>
      )}
      {memoryEnabled !== false && saveEnabled === false && (
        <p className="note note--info">Saving new memories is off: these are still used in your chats, but nothing new is saved.</p>
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
              <h2>Import memories from another assistant</h2>
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
                                  <p className="memory-fact__meta">
                                    <span className="memory-fact__scope" data-scope={fact.scope === "project" ? "project" : "personal"}>{fact.scope === "project" ? `Project: ${fact.projectName ?? "a project"}` : "Personal"}</span>
                                    <span>{memoryOrigin(fact)}</span>
                                    {fact.sourceConversationId && onOpenConversation && (
                                      <button type="button" className="memory-fact__source" onClick={() => onOpenConversation(fact.sourceConversationId, "chat")}>Open the chat</button>
                                    )}
                                    {memoryDay(fact.createdAt) && <span>Saved {memoryDay(fact.createdAt)}{memoryDay(fact.updatedAt) && memoryDay(fact.updatedAt) !== memoryDay(fact.createdAt) ? `, updated ${memoryDay(fact.updatedAt)}` : ""}</span>}
                                  </p>
                                  <div className="fact__actions">
                                    <button className="btn btn--quiet" onClick={() => { setEditing(fact.id); setText(fact.content); }}>Edit</button>
                                    {fact.scope === "project" && <button className="btn btn--quiet" onClick={() => makePersonal(fact.id)}>Make personal</button>}
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

// The sidebar items a person can hide (the ids match SIDEBAR_ITEM_IDS in src/profile/preferences.js).
const SIDEBAR_ITEMS = [
  { id: "projects", label: "Projects", description: "Your projects, above your chats." },
  { id: "library", label: "Library", description: "Files and images from your chats." },
  { id: "memory", label: "Memory", description: "What VibhavGPT remembers about you." },
  { id: "billing", label: "Plan", description: "Your plan and billing." },
  { id: "extensions", label: "Extensions", description: "Connectors and skills." },
  { id: "apps", label: "Apps", description: "The Android and Windows apps." },
  { id: "sources", label: "Sources", description: "The public source code." },
  { id: "merch", label: "Merch Store", description: "VibhavGPT merchandise." },
];

function Settings({
  section = "profile", onSectionChange, onBack = () => {}, user, appearance, tier = "free", creditBalance = 0, onDeleted, onLegal, onOpenUsage, onOpenBilling = () => {},
  onboarding = defaultOnboarding(), onSaveOnboarding = async () => {}, onRerunOnboarding = () => {}, onUserChange = async () => {},
  sidebarHidden = [], onSidebarHiddenChange = () => {},
}) {
  const { accentId, setAccentId, themeIds = { chat: appearance.themeId, study: appearance.themeId }, setSurfaceTheme = (_which, value) => appearance.setThemeId?.(value), systemTheme = appearance.resolved, effects = "glass", setEffects = () => {}, topography = "on", setTopography = () => {}, studyTopography = "on", setStudyTopography = () => {}, motion = "system", setMotion = () => {} } = appearance;
  const creditsMode = useCreditsMode();
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
  const [thinkingEffort, setThinkingEffort] = useState("low");
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
        setThinkingEffort(preferences.thinkingEffort ?? "low");
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
      setThinkingEffort(saved.thinkingEffort ?? "low");
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
          <SettingsIndex current={section} onChange={onSectionChange} onBack={onBack} />
        </header>

        <div className="settings__sections">
          <div className="settings__content" id={`settings-${section === "your-data" || section === "data-controls" ? "data" : section === "delete-account" ? "delete" : section}`}>
            <SettingsSectionHeader title={meta.title} tone={meta.tone}>
              {section === "personality" || section === "personalization" ? `${personalityHeadline(personality)} These are the answers from your setup. Change any of them here, or run the whole thing again.` : meta.description}
            </SettingsSectionHeader>

            {error && <p className="note note--error" role="alert">{error}</p>}

            {(section === "account" || section === "profile") && (
              <div className="settings-stack">
                <SettingsGroup title="Profile" id="profile-picture">
                  <SettingsRow label="Picture" stacked><ProfilePicture user={user} displayName={names.displayName} onChanged={onUserChange} /></SettingsRow>
                  <SettingsRow label="Name" id="profile-name"><span className="settings-value">{names.settingsName}</span></SettingsRow>
                  <SettingsRow label="Email"><span className="settings-value">{user.email}</span></SettingsRow>
                </SettingsGroup>
                <SettingsGroup title="Saved avatars" id="saved-avatars">
                  <SettingsRow stacked><SavedAvatars onProfilePictureChanged={onUserChange} /></SettingsRow>
                </SettingsGroup>
                <SettingsGroup title="Plan usage">
                  <SettingsRow label="Usage and limits" description={usageSettingsDescription(creditsMode)}>
                    <a href="/app/settings/usage" className="btn btn--secondary" onClick={(event) => {
                      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                      event.preventDefault(); onSectionChange("usage");
                    }}>
                      <BarChart3 size={16} /> View usage & limits
                    </a>
                  </SettingsRow>
                </SettingsGroup>
                <div id="desktop-updates"><DesktopUpdateSettings /></div>
              </div>
            )}

            {section === "appearance" && (
              <div className="settings-stack">
                {[
                  { which: "chat", title: "Chat background", description: "The sky behind Chat, Image and everything outside Study. Remembered on this device.", id: "theme-picker" },
                  { which: "study", title: "Study background", description: "The sky behind Study. It can differ from Chat. Remembered on this device.", id: "study-theme-picker" },
                ].map((surface) => (
                  <SettingsGroup key={surface.which} title={surface.title} description={surface.description} id={surface.id}>
                    <SettingsRow stacked>
                      <div className="theme-picker" role="radiogroup" aria-label={surface.title}>
                        {THEMES.map((option) => (
                          <button
                            key={option.id}
                            type="button"
                            role="radio"
                            className="theme-option"
                            // "system" has no fixed look, so it previews whichever sky
                            // the device resolves to rather than a third invented one.
                            data-preview={option.id === "system" ? systemTheme : option.id}
                            aria-checked={themeIds[surface.which] === option.id}
                            onClick={() => setSurfaceTheme(surface.which, option.id)}
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
                ))}
                <SettingsGroup title="Accent" description="The colour used for buttons and highlights." id="accent-picker">
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
                <SettingsGroup title="Surfaces" description="The message box, menus and sheets sit over your chat." id="surfaces-material">
                  <SettingsRow label="Material" description="Solid replaces the translucent glass with opaque panels. Reduced transparency or increased contrast on your device does this automatically.">
                    <Segmented
                      label="Material"
                      value={effects}
                      onChange={setEffects}
                      options={[{ value: "glass", label: "Glass" }, { value: "solid", label: "Solid" }]}
                    />
                  </SettingsRow>
                  <SettingsRow label="Chat background" description="Soft contour lines behind your conversation. They sit over your sky. They are off to save data on slower devices.">
                    <Segmented
                      label="Chat background"
                      value={topography}
                      onChange={setTopography}
                      options={[{ value: "on", label: "Contours" }, { value: "off", label: "Plain" }]}
                    />
                  </SettingsRow>
                  <SettingsRow label="Study contours" description="The same contour lines behind Study, chosen separately from Chat.">
                    <Segmented
                      label="Study contours"
                      value={studyTopography}
                      onChange={setStudyTopography}
                      options={[{ value: "on", label: "Contours" }, { value: "off", label: "Plain" }]}
                    />
                  </SettingsRow>
                </SettingsGroup>
                <SettingsGroup title="Sidebar" description="Choose what the sidebar shows. New chat, search and your account always stay. Saved to your account." id="sidebar-items">
                  {SIDEBAR_ITEMS.map((item) => (
                    <SettingsRow key={item.id} label={item.label} description={item.description}>
                      <Segmented
                        label={`${item.label} in the sidebar`}
                        value={sidebarHidden.includes(item.id) ? "hide" : "show"}
                        onChange={(value) => onSidebarHiddenChange(value === "hide" ? [...new Set([...sidebarHidden, item.id])] : sidebarHidden.filter((id) => id !== item.id))}
                        options={[{ value: "show", label: "Show" }, { value: "hide", label: "Hide" }]}
                      />
                    </SettingsRow>
                  ))}
                </SettingsGroup>
                <SettingsGroup title="Motion" description="For comfort, including motion sensitivity." id="motion">
                  <SettingsRow label="Reduce motion" description="Stop animated backgrounds and reduce movement. Backgrounds stay, standing still.">
                    <Segmented
                      label="Reduce motion"
                      value={motion}
                      onChange={setMotion}
                      options={[{ value: "system", label: "Match device" }, { value: "reduce", label: "Reduce" }, { value: "full", label: "Allow" }]}
                    />
                  </SettingsRow>
                </SettingsGroup>
              </div>
            )}

            {(section === "replies" || section === "general") && (
              <div className="settings-stack">
                <SettingsGroup title="Response style" id="response-style">
                  <SettingsRow stacked>
                    <ChoiceCards label="Response style" value={responseStyle} onChange={setResponseStyle} options={RESPONSE_STYLES} />
                  </SettingsRow>
                </SettingsGroup>
                <SettingsGroup title="Personal instructions" description="Anything VibhavGPT should always keep in mind when it answers you." id="custom-instructions">
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
                  id="preferred-default-model"
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
                    <SettingsRow label="Default thinking level" description="Low, Medium or High. You can override this beside the model picker for any response." id="thinking-effort">
                      <SettingsSelect
                        label="Default thinking level"
                        value={toUnified(thinkingEffort) ?? DEFAULT_UNIFIED_LEVEL}
                        onChange={setThinkingEffort}
                        align="end"
                        options={THINKING_OPTIONS}
                      />
                    </SettingsRow>
                  )}
                </SettingsGroup>
              </div>
            )}

            {(section === "personality" || section === "personalization") && (
              <div className="settings-stack">
                <SettingsGroup
                  title="How VibhavGPT talks to you"
                  id="personality-sliders"
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
                <SettingsGroup title="Your setup answers" description="From the questions you answered when you joined." id="setup-answers">
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
                <div id="memory-settings"><MemorySettingsCard /></div>
              </div>
            )}

            {section === "memory" && <div id="memory-settings"><MemorySettingsCard /></div>}
            {section === "media" && <div id="image-watermark"><MediaSettingsCard /></div>}
            {section === "location" && <div className="settings-stack" id="location-settings"><SettingsGroup title="Your location"><SettingsRow stacked><LocationSettings /></SettingsRow></SettingsGroup></div>}

            {section === "security" && <div id="security-passkeys"><SecurityPanel user={user} /></div>}

            {section === "connectors" && (
              <div className="settings-stack" id="connectors-settings">
                <ConnectorsSettings />
              </div>
            )}

            {section === "usage" && (
              <div className="settings-stack" id="usage-dashboard">
                <UsageDashboard userId={user?.id} onOpenSettings={() => onSectionChange("profile")} onLegal={onLegal} />
              </div>
            )}

            {section === "billing" && (
              <div className="settings-stack" id="billing-plans">
                <Billing tier={tier} userId={user?.id} onEntitlementChanged={() => {}} />
              </div>
            )}

            {(section === "your-data" || section === "data-controls") && (
              <div className="settings-stack">
                <SettingsGroup title="Export" id="export-data">
                  <SettingsRow label="Download your data" description={exported ? "Your export has been downloaded." : "A copy of your account, conversations, memory, usage, and subscription records."}>
                    <button className="btn btn--secondary" disabled={exporting} onClick={exportData}>
                      <Download size={15} /> {exporting ? "Preparing export…" : "Export my data"}
                    </button>
                  </SettingsRow>
                </SettingsGroup>
                <SettingsGroup tone="danger" title="Delete your account" id="delete-account-setting">
                  <SettingsRow
                    label="Permanently delete"
                    description={<>Permanently delete your VibhavGPT account and active account data. Restricted recovery backups expire within 12 months; billing providers may retain transaction records. <a href="https://vibhavgpt.com/account-deletion" target="_blank" rel="noreferrer">Learn about account deletion</a></>}
                  >
                    <button className="btn btn--danger" onClick={openDeleteDialog}>
                      <Trash2 size={15} /> Delete account
                    </button>
                  </SettingsRow>
                </SettingsGroup>
                {!deleteOpen && <p className="settings-notice">{DELETION_PLAN_NOTICE}</p>}
              </div>
            )}

            {section === "delete-account" && (
              <div className="settings-stack">
                <SettingsGroup tone="danger" title="Delete your account" id="delete-account-setting">
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
          <SiteFooter className="site-footer--in-app" />
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
  general: { group: "Personal", icon: SettingsIcon, title: "General", description: "How replies are written and defaults for new chats." },
  appearance: { group: "Personal", icon: Palette, title: "Appearance", description: "Choose a theme, accent colour and surfaces." },
  profile: { group: "Personal", icon: UserRound, title: "Profile", description: "Your picture, name, email and saved avatars." },
  personalization: { group: "Personal", icon: SlidersHorizontal, title: "Personalization", description: "How VibhavGPT talks to you, setup answers and memory." },
  location: { group: "Personal", icon: MapPin, title: "Location", description: "Optional. Lets answers use your city, and nothing more." },
  media: { group: "Personal", icon: ImageIcon, title: "Media", description: "The VibhavGPT mark on images made for you." },
  security: { group: "Security & Access", icon: ShieldCheck, title: "Security", description: "Passkeys and two-step verification for signing in." },
  connectors: { group: "Security & Access", icon: Plug, title: "Connectors", description: "Productivity tools, code repositories and external plugins with human approval." },
  "data-controls": { group: "Security & Access", icon: Download, title: "Data controls", description: "Download your data or delete your account." },
  usage: { group: "Billing & Usage", icon: BarChart3, title: "Usage", description: "How much of your plan allowance you have used." },
  billing: { group: "Billing & Usage", icon: CreditCard, title: "Billing", description: "Your plan, subscriptions and payment methods." },
  // Backward-compatible keys:
  account: { group: "Personal", icon: UserRound, title: "Profile", description: "Your picture, name, email and saved avatars." },
  replies: { group: "Personal", icon: MessageSquareText, title: "General", description: "How replies are written and defaults for new chats." },
  personality: { group: "Personal", icon: SlidersHorizontal, title: "Personalization", description: "How VibhavGPT talks to you and setup answers." },
  memory: { group: "Personal", icon: Brain, title: "Memory", description: "What VibhavGPT remembers between chats." },
  "your-data": { group: "Security & Access", icon: Download, title: "Data controls", description: "Take a copy of everything in your account." },
  "delete-account": { group: "Security & Access", icon: Trash2, title: "Delete account", description: "Permanently remove your account and everything in it.", tone: "danger" },
};
const SETTINGS_GROUPS = ["Personal", "Security & Access", "Billing & Usage"];

const SETTINGS_SEARCH_INDEX = [
  { id: "response-style", section: "general", label: "Response style", group: "Personal", description: "How VibhavGPT responds: balanced, concise, detailed or learning" },
  { id: "custom-instructions", section: "general", label: "Personal instructions", group: "Personal", description: "Custom instructions VibhavGPT should always keep in mind" },
  { id: "preferred-default-model", section: "general", label: "Preferred default model", group: "Personal", description: "Default starting model for new chats" },
  { id: "thinking-effort", section: "general", label: "Default thinking effort", group: "Personal", description: "Default reasoning effort for responses" },
  { id: "theme-picker", section: "appearance", label: "Chat background", group: "Personal", description: "Light, dark, or system sky behind Chat" },
  { id: "study-theme-picker", section: "appearance", label: "Study background", group: "Personal", description: "Light, dark, or system sky behind Study" },
  { id: "accent-picker", section: "appearance", label: "Accent colour", group: "Personal", description: "Button and highlight colour swatches" },
  { id: "surfaces-material", section: "appearance", label: "Surfaces & Material", group: "Personal", description: "Glass or solid panel transparency" },
  { id: "motion", section: "appearance", label: "Reduce motion", group: "Personal", description: "Stop animated backgrounds and reduce movement (motion sickness)" },
  { id: "profile-picture", section: "profile", label: "Profile picture", group: "Personal", description: "Avatar and profile picture upload" },
  { id: "profile-name", section: "profile", label: "Display name", group: "Personal", description: "Your account name and email" },
  { id: "saved-avatars", section: "profile", label: "Saved avatars", group: "Personal", description: "Avatars saved for image generation references" },
  { id: "desktop-updates", section: "profile", label: "Desktop app updates", group: "Personal", description: "Windows desktop application updates and version" },
  { id: "personality-sliders", section: "personalization", label: "Personality sliders", group: "Personal", description: "How VibhavGPT talks to you: warmth, technical level, directness" },
  { id: "setup-answers", section: "personalization", label: "Setup answers", group: "Personal", description: "Onboarding answers, role, units, and preferences" },
  { id: "memory-settings", section: "personalization", label: "Memory & details", group: "Personal", description: "Remember details across chats and clear saved memories" },
  { id: "location-settings", section: "location", label: "Location", group: "Personal", description: "City location for local weather and relevant answers" },
  { id: "image-watermark", section: "media", label: "Image watermark", group: "Personal", description: "The VibhavGPT mark on generated images" },
  { id: "security-passkeys", section: "security", label: "Passkeys & 2FA", group: "Security & Access", description: "Biometric passkeys and two-step verification" },
  { id: "connectors-settings", section: "connectors", label: "Connectors & Plugins", group: "Security & Access", description: "GitHub, Google Workspace, weather and external plugin integrations" },
  { id: "export-data", section: "data-controls", label: "Export data", group: "Security & Access", description: "Download a copy of your account data and chats" },
  { id: "delete-account-setting", section: "data-controls", label: "Delete account", group: "Security & Access", description: "Permanently delete account and associated data" },
  // The description follows the active credits wording where it is shown (see SettingsIndex).
  { id: "usage-dashboard", section: "usage", label: "Usage & limits", group: "Billing & Usage", description: USAGE_NAV_DESCRIPTION_LEGACY },
  { id: "billing-plans", section: "billing", label: "Plan & Billing", group: "Billing & Usage", description: "Subscription tier, Free, Plus, Pro, and Stripe billing" },
];

function canonicalSectionSlug(slug) {
  if (slug === "account") return "profile";
  if (slug === "replies") return "general";
  if (slug === "personality" || slug === "memory") return "personalization";
  if (slug === "your-data" || slug === "delete-account") return "data-controls";
  return slug;
}

// The section's name and its line of help. The navigation beside it carries
// the section's icon, so the heading is type alone.
function SettingsSectionHeader({ title, tone, children }) {
  return (
    <header className="settings-section__head" data-tone={tone}>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </header>
  );
}

// A titled panel of rows. The title and help sit above the panel; a footer
// holds the action that saves what the panel contains.
function SettingsGroup({ id, title, description, tone, footer, children }) {
  return (
    <section className="settings-group" id={id} data-tone={tone}>
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
    <Banner
      tone="info"
      title={state.version ? `VibhavGPT ${state.version} is ready.` : "An update is ready."}
      className="direct-update"
      onDismiss={() => setDismissed(state.version ?? "")}
      dismissLabel="Install later"
      help="The new version of the VibhavGPT app has already downloaded. Restarting installs it; if you'd rather not now, it installs the next time you quit. Your chats are saved to your account."
      action={<button className="btn btn--secondary" type="button" onClick={store.install}>Install & Restart</button>}
    >
      Restart to install it, or it installs the next time you quit.
    </Banner>
  );
}

// URL-backed navigation keeps every section available as its own page: a
// dock of icon tiles in three clusters. Where it scrolls sideways (phones),
// the current tile is kept in view.
function SettingsIndex({ current, onChange, onBack }) {
  const navigationRef = useRef(null);
  const [searchQuery, setSearchQuery] = useState("");
  const creditsMode = useCreditsMode();

  const filteredResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return SETTINGS_SEARCH_INDEX
      .map((item) => (item.id === "usage-dashboard" ? { ...item, description: usageNavDescription(creditsMode) } : item))
      .filter((item) =>
        item.label.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.section.toLowerCase().includes(q) ||
        item.group.toLowerCase().includes(q)
      );
  }, [searchQuery, creditsMode]);

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

  const canonical = canonicalSectionSlug(current);

  return (
    <div className="settings-sidebar">
      <div className="settings-mobile-bar">
        <button className="settings-back-btn" type="button" onClick={onBack} aria-label="Back to app">
          <ArrowLeft size={16} strokeWidth={2.2} aria-hidden="true" />
          <span>Back</span>
        </button>
        <select
          className="settings-mobile-picker"
          value={canonical}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Select settings section"
        >
          {SETTINGS_GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {SETTINGS_SECTIONS.filter((s) => !s.legacy && (SETTINGS_META[s.slug]?.group ?? "Personal") === group).map((s) => (
                <option key={s.slug} value={s.slug}>{s.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <button className="settings-back-btn settings-back-btn--desktop" type="button" onClick={onBack} aria-label="Back to app">
        <ArrowLeft size={16} strokeWidth={2.2} aria-hidden="true" />
        <span>Back to app</span>
      </button>

      <div className="settings-search">
        <Search size={15} className="settings-search__icon" aria-hidden="true" />
        <input
          type="search"
          className="settings-search__input"
          placeholder="Search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search settings"
        />
        {searchQuery && (
          <button type="button" className="settings-search__clear" onClick={() => setSearchQuery("")} aria-label="Clear search">
            <X size={13} />
          </button>
        )}
      </div>

      {searchQuery.trim() ? (
        <div className="settings-search__results" role="listbox" aria-label="Search results">
          {filteredResults.length === 0 ? (
            <p className="settings-search__empty">No settings match &ldquo;{searchQuery}&rdquo;</p>
          ) : (
            filteredResults.map((item) => (
              <button
                key={item.id}
                type="button"
                className="settings-search__result"
                onClick={() => {
                  onChange(item.section);
                  setSearchQuery("");
                  setTimeout(() => {
                    const el = document.getElementById(item.id);
                    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
                  }, 60);
                }}
              >
                <span className="settings-search__result-label">{item.label}</span>
                <span className="settings-search__result-desc">{item.description}</span>
                <span className="settings-search__result-meta">{item.group} &rsaquo; {item.section}</span>
              </button>
            ))
          )}
        </div>
      ) : (
        <nav ref={navigationRef} className="settings-dock" aria-label="Settings sections">
          {SETTINGS_GROUPS.map((group) => (
            <div className="settings-dock__group" key={group} role="group" aria-label={group}>
              <span className="settings-dock__label" aria-hidden="true">{group}</span>
              <div className="settings-dock__items">
                {SETTINGS_SECTIONS.filter((section) => !section.legacy && (SETTINGS_META[section.slug]?.group ?? "Personal") === group).map((section) => {
                  const Icon = SETTINGS_META[section.slug]?.icon ?? SettingsIcon;
                  return (
                    <a key={section.slug} href={settingsPath(section.slug)}
                      className="settings-dock__item"
                      data-section={section.slug}
                      aria-current={canonical === section.slug ? "page" : undefined}
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
      )}
    </div>
  );
}

/* -- Usage ---------------------------------------------------------------- */


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

// The soonest moment tokens used in the rolling window start to free up, from the server's own per-model release times.
// Null when nothing has been used in the window: there is then no reset to show, and none is made up.
function earliestRelease(releases) {
  const times = Object.values(releases ?? {}).map((value) => new Date(value).getTime()).filter((time) => Number.isFinite(time) && time > Date.now());
  return times.length ? new Date(Math.min(...times)) : null;
}

function formatUsageRemaining(date) {
  const minutes = Math.max(1, Math.ceil((date.getTime() - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

// One window of usage: how much of its allowance is used, a thin bar, and when it resets.
function UsageCard({ title, used, limit, reset }) {
  const percentage = usagePercentage(used, limit);
  return (
    <article className="usage-card">
      <h2 className="usage-card__title">{title}</h2>
      <p className="usage-card__percent"><strong>{percentage}%</strong> used</p>
      <div className="usage-card__track" role="progressbar" aria-label={`${title}: ${percentage}% used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}>
        <span style={{ width: `${percentage}%` }} />
      </div>
      {reset && <p className="usage-card__reset">{reset}</p>}
    </article>
  );
}

function UsageDashboard({ userId, onOpenSettings, onOpenPlans }) {
  const [usage, setUsage] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);
  useEffect(() => { if (usage) setLoadedAt(new Date()); }, [usage]);
  const [error, setError] = useState("");
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
      setError("Purchases are available on VibhavGPT web.");
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
      setError(err.message || "Checkout could not be started. You were not charged.");
      setCreditBusy(false);
    }
  }

  const tier = usage?.tier === "paid" ? "pro" : usage?.tier;
  // The server decides whether AI credits are active; the counters read whichever allowance applies.
  const creditsActive = Boolean(usage?.credits?.active);

  const counters = usageCounters(usage);

  return (
    <main className="page usage-page">
      <header className="usage-head">
        <h1 className="usage-head__title">Usage{usage && <span className="usage-head__plan">{TIER_LABEL[tier] ?? "Free"} plan</span>}</h1>
        <p className="usage-head__lede">What you've used on your plan.</p>
        {loadedAt && <p className="usage-head__updated">Updated {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(loadedAt)}</p>}
      </header>

      {error && <p className="note note--error" role="alert">{error}</p>}
      {creditResult === "success" && <p className="note note--good">Thanks for your purchase. Your image & document credits will show in your balance once the payment is confirmed.</p>}
      {creditResult === "cancelled" && <p className="note">Purchase canceled. You were not charged.</p>}
      {!creditsActive && <>{isAllowanceUiEnabled() && userId && <AllowancePanel key={userId} userId={userId} />}</>}
      {!usage && !error ? <TypingDots label="Loading usage" /> : !usage ? (<div className="uo-section" data-uo-state="unavailable"><p className="uo-text" role="status">Your usage could not be loaded, so no numbers are shown. Try again in a moment.</p></div>) : (
        <>
          <ul className="usage-counters" aria-label="Usage">
            {counters.rows.map((row) => (
              <li key={row.id} className="usage-counter" data-counter={row.id} data-unlimited={row.unlimited || undefined}>
                <span className="usage-counter__label">{row.label}</span>
                <strong className="usage-counter__value">{row.value}</strong>
              </li>
            ))}
          </ul>
          <CreditPurchase
            flex={usage.overview?.flex}
            balance={usage.creditBalance ?? 0}
            purchases={creditPurchases}
            purchasesLoading={creditPurchasesLoading}
            busy={creditBusy}
            native={isNativeApp}
            onBuy={buyCredits}
            onSeePlans={onOpenPlans}
          />
        </>
      )}

      <button type="button" className="btn btn--ghost usage-page__back" onClick={onOpenSettings}>Back to settings</button>
      <SiteFooter className="site-footer--in-app" />
    </main>
  );
}

/* -- Billing -------------------------------------------------------------- */

// The plan cards for a credits mode (null: the existing wording). The running page asks for the
// mode the server reports (useCreditsMode), so a rollback or activation changes the wording
// without a frontend deployment; the prerendered pages use the build's mode (see credits-runtime.js).
const planCardCache = new Map();
function plansFor(creditsMode) {
  if (!planCardCache.has(creditsMode ?? "off")) {
    planCardCache.set(creditsMode ?? "off", productKnowledgeFor(creditsMode).plans.map((plan) => ({ ...plan, featured: plan.id === "plus" })));
  }
  return planCardCache.get(creditsMode ?? "off");
}

// One short line per plan card (owner request, 2026-11-14: cards that scan at a glance). The full allowances are in Compare all features,
// from the same product facts; the image counts here come from the same entitlement numbers.
const PLAN_CARD_LINE = {
  free: `Lumen and Study, and ${countText(IMAGES_PER_WEEK.free)} images a week`,
  plus: `More Lumen and Study, and ${countText(IMAGES_PER_MONTH.plus)} images a month`,
  pro: `Adds Vulcan, ${countText(IMAGES_PER_MONTH.pro)} images a month and unlimited documents`,
  max: `Adds Zenith, ${countText(IMAGES_PER_MONTH.max)} images a month and our highest limits`,
};

function AccessNotice(props) {
  return <WorkspaceNotice {...props} />;
}

// The public /pricing page: the homepage's floating glass navigation over a
// calm canvas, so the plans themselves carry the page (pricing.css).
export function PublicPricing({ signedIn = false }) {
  return (
    <div className="pricing-page">
      <PublicNav current="pricing" />
      <Billing tier="visitor" publicPreview />
    </div>
  );
}

function Billing({ tier, userId, onEntitlementChanged, publicPreview = false }) {
  const creditsMode = useCreditsMode();
  const PLANS = plansFor(creditsMode);
  const [period, setPeriod] = useState("monthly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [subscription, setSubscription] = useState(null);
  // { tier, source }: the account's plan from the server's one plan resolver, and where it comes from ("stripe", "google_play",
  // "internal", "complimentary" or "none"). The current-plan card reads this, never a guess from the stored row.
  const [planInfo, setPlanInfo] = useState(null);
  // Max is sold once checkout is configured; public preview shows active plan actions.
  const [maxAvailable, setMaxAvailable] = useState(publicPreview ? true : false);
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
      .then(({ subscription: value, plan: resolvedPlan, maxAvailable: maxReady }) => {
        if (mounted && requestId === version) { setSubscription(value); setPlanInfo(resolvedPlan ?? null); setMaxAvailable(maxReady === true); setSubscriptionLoaded(true); }
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
  // A complimentary plan (COMP_PLAN_ACCOUNTS) is Max with nothing to manage or cancel; it is not an app purchase, so plans can still be bought.
  const planSource = planInfo?.source ?? (subscription ? (subscription.billingSource ?? "stripe") : "none");
  const complimentaryPlan = planSource === "complimentary";
  // Only a store purchase that still verifies is shown as bought in the Android app (the server decides; a leftover row shows nothing).
  const appSubscription = planSource === "google_play";
  // Access granted by VibhavGPT directly: no store, no checkout, nothing to manage or cancel.
  const grantedPlan = planSource === "internal";
  const currentPlanTier = planInfo?.tier ?? subscription?.tier;

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
          <p className="pricing__lede">{appSubscription ? "Your current plan was bought in the Android app. It stays active until the end of its paid period, and you can choose a plan here after that." : publicPreview ? "Start free. Pay monthly or yearly, and change or cancel any time." : "Start free. Move up when you need more room, and change or cancel any time."}</p>
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
          const price = annual && plan.yearly ? plan.yearly : plan.monthly;
          const isDowngrade = (tier === "max" && (plan.id === "pro" || plan.id === "plus"))
            || (tier === "pro" && plan.id === "plus");
          return (
            <article className="plan rate-card__plan" key={plan.id} data-current={current || undefined} data-featured={plan.featured || undefined}>
              <div className="plan__head">
                <h2 className="plan__name">{plan.name}</h2>
              </div>
              <p className="plan__price">
                {plan.id === "free" ? "$0" : price}
                <small>{plan.id === "free" ? "forever" : annual && !plan.yearly ? "per month (billed monthly)" : `per ${annual ? "year" : "month"}`}</small>
              </p>
              {plan.id !== "free" && annual && plan.yearly && <p className="plan__equivalent">About {monthlyEquivalent(plan.yearly)} a month</p>}
              <p className="plan__blurb">{plan.description}</p>
              {/* The plan's principal allowance in one short line; the details are in Compare all features below. */}
              {(PLAN_CARD_LINE[plan.id] ?? plan.features?.[0]) && <p className="plan__allowance">{PLAN_CARD_LINE[plan.id] ?? plan.features[0]}</p>}
              {current ? (
                <p className="plan__current" role="status"><Check size={16} strokeWidth={2.4} aria-hidden="true" />You're on {plan.name}.</p>
              ) : plan.id === "free" ? (
                <p className="plan__current plan__current--quiet">Included with every account.</p>
              ) : plan.id === "max" && !maxAvailable ? (
                <p className="plan__current plan__current--quiet" role="status">Max is not available to purchase yet.</p>
              ) : (
                <button
                  className={`btn ${plan.featured ? "btn--primary" : "btn--secondary"} btn--block`}
                  disabled={busy || manageBusy || checkingPlan}
                  onClick={() => purchase(plan.id)}
                >
                  {checkingPlan ? "Checking…" : busy || manageBusy ? "Opening checkout…" : isDowngrade ? (plan.id === "pro" ? "Move to Pro" : "Move to Plus") : "Upgrade"}
                </button>
              )}
            </article>
          );
        })}
      </div>

      <details className="compare">
        <summary className="compare__summary">Compare all features</summary>
        <div className="compare__scroll">
          <table className="compare__table">
            <thead>
              <tr>
                <td />
                {PLANS.map((plan) => <th key={plan.id} scope="col" data-current={(tier === plan.id || (tier === "paid" && plan.id === "pro")) || undefined}>{plan.name}</th>)}
              </tr>
            </thead>
            {comparisonGroupsFor(creditsMode).map((group) => (
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
        <p className="compare__footnote">{creditsMode ? creditsPricingFootnote(creditsMode) : "Plus, Pro, and Max list monthly token allowances. Input and output tokens both count, and each Plus, Pro, or Max model also has a rolling five-hour limit. Free is up to 15 AI requests in any 24-hour period, subject to a shared $0.25 included allowance each UTC calendar month. Lumen and Study share this allowance, and one message or action can use more than one AI request. Subscriptions and image & document credits are bought on the web. Max includes every model Pro has, plus Zenith, with our highest monthly token allowances. " + THIRD_PARTY_BILLING_NOTE}</p>
      </details>

      <aside className="pricing__guarantee">
        <h2>Every plan comes with the VibhavGPT Guarantee</h2>
        <p>We never train on your chats. We never sell your data. We never show ads. Export everything or delete your account whenever you like.</p>
        <a href="/guarantee">Read the Guarantee</a>
      </aside>
      {publicPreview && <PublicFaq path="/pricing" />}
      {publicPreview && <SiteFooter />}
      </>}

      {publicPreview ? null : checkingPlan ? (
        <section className="subscription" aria-label="Current plan and billing">
          {subscriptionLoadError ? <p role="alert">Your subscription could not be checked. Refresh to try again.</p> : <p role="status">Checking your subscription…</p>}
        </section>
      ) : subscription ? (
        <section className="subscription" aria-label="Current plan and billing">
          <div>
            <p className="ui-eyebrow">Current plan</p>
            <strong>{TIER_LABEL[currentPlanTier] ?? "Free"} plan</strong>
            {complimentaryPlan ? (
              <span className="subscription__note">Complimentary</span>
            ) : grantedPlan ? (
              <span className="subscription__note">Access granted by VibhavGPT</span>
            ) : <>
            <span>
              {subscription.status}
              {subscription.currentPeriodEndsAt ? ` · ${subscription.cancelAtPeriodEnd || appSubscription ? "access through" : ["active", "trialing"].includes(subscription.status) ? "renews" : "ended"} ${new Date(subscription.currentPeriodEndsAt).toLocaleDateString()}` : ""}
            </span>
            </>}
          </div>
          {!appSubscription && !complimentaryPlan && !grantedPlan && (
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
