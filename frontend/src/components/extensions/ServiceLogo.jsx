/**
 * Local product marks for connector services.
 * These are simplified, sanitized SVGs rendered in the app. They are not
 * official trademark artwork and they do not load remote images.
 * Known products keep their own marks. Parent-company marks are only the
 * fallback for a legacy bundle or an unrecognized toolkit id.
 */

import { resolveServiceLogoId } from "./service-logo-id.js";

function Mark({ size, className, label, viewBox = "0 0 48 48", children }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      className={className}
      aria-label={label}
      role="img"
    >
      {children}
    </svg>
  );
}

export function ServiceLogo({ serviceId = "", size = 28, className = "" }) {
  const id = resolveServiceLogoId(serviceId);
  const logoClass = (slug) => `service-logo service-logo--${slug} ${className}`.trim();

  if (id === "googledocs") {
    return (
      <Mark size={size} className={logoClass("googledocs")} label="Google Docs">
        <path fill="#1A73E8" d="M28 4H12a4 4 0 0 0-4 4v32a4 4 0 0 0 4 4h24a4 4 0 0 0 4-4V16L28 4z" />
        <path fill="#A8C7FA" d="M28 4v8a4 4 0 0 0 4 4h8L28 4z" />
        <path fill="#fff" d="M16 24h16v2.2H16V24zm0 6h16v2.2H16V30zm0 6h10v2.2H16V36z" />
      </Mark>
    );
  }

  // ── Google Drive ───────────────────────────────────────────────────────────
  if (id === "googledrive") {
    return (
      <svg width={size} height={size} viewBox="0 0 87.3 78" fill="none"
        className={logoClass("googledrive")}
        aria-label="Google Drive" role="img">
        <path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3L27.5 53H0c0 1.55.4 3.1 1.2 4.5z" fill="#0066DA" />
        <path d="M43.65 25L29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3L1.2 48.5c-.8 1.4-1.2 2.95-1.2 4.5h27.5z" fill="#00AC47" />
        <path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75L86.1 57c.8-1.4 1.2-2.95 1.2-4.5H59.8L73.55 76.8z" fill="#EA4335" />
        <path d="M43.65 25L57.4 1.2C56.05.4 54.5 0 52.95 0H34.35c-1.55 0-3.1.45-4.45 1.2z" fill="#00832D" />
        <path d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.45 1.2h50.9c1.55 0 3.1-.45 4.45-1.2z" fill="#2684FC" />
        <path d="M73.4 26.5l-13.2-22.9c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25 59.8 53h26.3c0-1.55-.4-3.1-1.2-4.5z" fill="#FFBA00" />
      </svg>
    );
  }

  // ── Gmail ──────────────────────────────────────────────────────────────────
  if (id === "gmail") {
    return (
      <Mark size={size} className={logoClass("gmail")} label="Gmail">
        <path fill="#4caf50" d="M45 16.2l-5 2.75-5 4.75L35 40h7c1.657 0 3-1.343 3-3V16.2z" />
        <path fill="#1e88e5" d="M3 16.2l3.614 1.71L13 23.7V40H6c-1.657 0-3-1.343-3-3V16.2z" />
        <polygon fill="#e53935" points="35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17" />
        <path fill="#c62828" d="M3 12.298V16.2l10 7.5V11.2L9.876 8.859C9.132 8.301 8.228 8 7.298 8h0C4.924 8 3 9.924 3 12.298z" />
        <path fill="#fbc02d" d="M45 12.298V16.2l-10 7.5V11.2l3.124-2.341C38.868 8.301 39.772 8 40.702 8h0C43.076 8 45 9.924 45 12.298z" />
      </Mark>
    );
  }

  // ── Google Calendar ────────────────────────────────────────────────────────
  if (id === "googlecalendar") {
    return (
      <Mark size={size} className={logoClass("googlecalendar")} label="Google Calendar">
        <rect x="7" y="8" width="34" height="34" rx="4" fill="#fff" stroke="#1A73E8" strokeWidth="2" />
        <path fill="#1A73E8" d="M7 12a4 4 0 0 1 4-4h26a4 4 0 0 1 4 4v8H7v-8z" />
        <rect x="15" y="4" width="3.2" height="8" rx="1.6" fill="#1A73E8" />
        <rect x="29.8" y="4" width="3.2" height="8" rx="1.6" fill="#1A73E8" />
        <text x="24" y="35" textAnchor="middle" fontSize="15" fontWeight="700" fill="#1A73E8" fontFamily="Arial, Helvetica, sans-serif">31</text>
      </Mark>
    );
  }

  // ── Google Sheets ──────────────────────────────────────────────────────────
  if (id === "googlesheets") {
    return (
      <Mark size={size} className={logoClass("googlesheets")} label="Google Sheets">
        <path fill="#0F9D58" d="M28 4H12a4 4 0 0 0-4 4v32a4 4 0 0 0 4 4h24a4 4 0 0 0 4-4V16L28 4z" />
        <path fill="#87CEAC" d="M28 4v8a4 4 0 0 0 4 4h8L28 4z" />
        <rect x="15" y="22" width="18" height="16" rx="1" fill="#fff" />
        <path stroke="#0F9D58" strokeWidth="1.3" d="M21 22v16M27 22v16M15 27.3h18M15 32.6h18" />
      </Mark>
    );
  }

  if (id === "googleslides") {
    return (
      <Mark size={size} className={logoClass("googleslides")} label="Google Slides">
        <path fill="#F4B400" d="M28 4H12a4 4 0 0 0-4 4v32a4 4 0 0 0 4 4h24a4 4 0 0 0 4-4V16L28 4z" />
        <path fill="#FDE293" d="M28 4v8a4 4 0 0 0 4 4h8L28 4z" />
        <rect x="16" y="24" width="16" height="10" rx="1" fill="#fff" />
      </Mark>
    );
  }

  if (id === "googletasks") {
    return (
      <Mark size={size} className={logoClass("googletasks")} label="Google Tasks">
        <rect x="8" y="6" width="32" height="36" rx="6" fill="#1A73E8" />
        <path d="M16 18l4 4 8-8" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M16 30h16" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      </Mark>
    );
  }

  if (id === "youtube") {
    return (
      <Mark size={size} className={logoClass("youtube")} label="YouTube" viewBox="0 0 48 34">
        <rect width="48" height="34" rx="8" fill="#FF0000" />
        <path fill="#fff" d="M20 9l14 8-14 8V9z" />
      </Mark>
    );
  }

  if (id === "asana") {
    return (
      <Mark size={size} className={logoClass("asana")} label="Asana">
        <circle cx="24" cy="14" r="6" fill="#F06A6A" />
        <circle cx="15" cy="30" r="6" fill="#F06A6A" />
        <circle cx="33" cy="30" r="6" fill="#F06A6A" />
      </Mark>
    );
  }

  if (id === "todoist") {
    return (
      <Mark size={size} className={logoClass("todoist")} label="Todoist">
        <circle cx="24" cy="24" r="16" fill="#E44332" />
        <path d="M16 24h16M20 18h8M18 30h12" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      </Mark>
    );
  }

  if (id === "calendly") {
    return (
      <Mark size={size} className={logoClass("calendly")} label="Calendly">
        <circle cx="24" cy="24" r="16" fill="#006BFF" />
        <path d="M24 14v10l6 4" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </Mark>
    );
  }

  if (id === "figma") {
    return (
      <Mark size={size} className={logoClass("figma")} label="Figma">
        <path fill="#F24E1E" d="M18 8a6 6 0 0 1 6 6 6 6 0 0 1-6 6H12V14a6 6 0 0 1 6-6z" />
        <path fill="#A259FF" d="M12 20a6 6 0 1 0 12 0 6 6 0 0 0-6-6H12v6z" />
        <path fill="#1ABCFE" d="M30 8a6 6 0 1 1 0 12 6 6 0 0 1 0-12z" />
        <path fill="#0ACF83" d="M18 32a6 6 0 0 1-6 6 6 6 0 0 1-6-6 6 6 0 0 1 6-6h6v6z" />
      </Mark>
    );
  }

  if (id === "zoom") {
    return (
      <Mark size={size} className={logoClass("zoom")} label="Zoom">
        <rect x="6" y="12" width="26" height="24" rx="6" fill="#2D8CFF" />
        <path fill="#2D8CFF" d="M32 20l10-6v20l-10-6V20z" />
      </Mark>
    );
  }

  if (id === "clickup") {
    return (
      <Mark size={size} className={logoClass("clickup")} label="ClickUp">
        <path fill="#7B68EE" d="M8 28l8-10 8 6 8-12 8 16H8z" />
        <path fill="#49CCF9" d="M14 30l6-6 4 3 6-8 4 11H14z" />
      </Mark>
    );
  }

  // ── Google Workspace (legacy bundle, not shown in catalog) ─────────────────
  if (id === "google_workspace" || id.startsWith("google")) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
        className={logoClass("google")}
        aria-label={id === "google_workspace" ? "Google Workspace" : "Google"} role="img">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05" />
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335" />
      </svg>
    );
  }

  // ── Outlook ────────────────────────────────────────────────────────────────
  if (id === "outlook") {
    return (
      <Mark size={size} className={logoClass("outlook")} label="Outlook">
        <path fill="#28A8EA" d="M20 8h20a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H20V8z" />
        <path fill="#fff" d="M22 16h18l-9 7-9-7z" opacity="0.95" />
        <rect x="4" y="12" width="24" height="24" rx="3" fill="#0F6CBD" />
        <ellipse cx="16" cy="24" rx="6" ry="7" stroke="#fff" strokeWidth="2.4" />
      </Mark>
    );
  }

  // ── OneDrive ───────────────────────────────────────────────────────────────
  if (id === "one_drive") {
    return (
      <Mark size={size} className={logoClass("onedrive")} label="OneDrive" viewBox="0 0 48 32">
        <path fill="#0364B8" d="M19 3.5a9.2 9.2 0 0 1 8.6 6 7.4 7.4 0 0 1 6.8-1.1A7.6 7.6 0 0 1 36.8 23H15.4A8.4 8.4 0 0 1 19 3.5z" />
        <path fill="#28A8EA" d="M18.5 7.2A9.4 9.4 0 0 0 9.6 14 6.8 6.8 0 0 0 8.2 27.2h26.2A6.6 6.6 0 0 0 37.4 15 8.2 8.2 0 0 0 23.2 11a9.4 9.4 0 0 0-4.7-3.8z" />
      </Mark>
    );
  }

  // ── Microsoft 365 (legacy bundle) ─────────────────────────────────────────
  if (id === "microsoft") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
        className={`service-logo service-logo--microsoft ${className}`}
        aria-label="Microsoft 365" role="img">
        <rect x="2" y="2" width="9.5" height="9.5" fill="#F25022" />
        <rect x="12.5" y="2" width="9.5" height="9.5" fill="#7FBA00" />
        <rect x="2" y="12.5" width="9.5" height="9.5" fill="#00A4EF" />
        <rect x="12.5" y="12.5" width="9.5" height="9.5" fill="#FFB900" />
      </svg>
    );
  }

  // ── GitHub ─────────────────────────────────────────────────────────────────
  if (id === "github") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"
        className={`service-logo service-logo--github ${className}`}
        aria-label="GitHub" role="img">
        <path fillRule="evenodd" clipRule="evenodd"
          d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
      </svg>
    );
  }

  // ── Notion ─────────────────────────────────────────────────────────────────
  if (id === "notion") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"
        className={`service-logo service-logo--notion ${className}`}
        aria-label="Notion" role="img">
        <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l11.378-.84c1.12-.093 1.586.374 1.586 1.213v12.783c0 1.026-.56 1.586-1.773 1.68l-12.032.84c-1.213.093-1.68-.467-1.68-1.494V5.421c0-.746.374-1.026 1.093-.213zM6.605 6.915v10.45l2.427-.186V8.501l6.158 8.491 3.08-.28V6.449l-2.426.186v8.492L9.497 6.729l-2.892.186z" />
      </svg>
    );
  }

  // ── Slack ──────────────────────────────────────────────────────────────────
  if (id === "slack") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
        className={`service-logo service-logo--slack ${className}`}
        aria-label="Slack" role="img">
        <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52-2.523 2.52 2.52 0 0 1 2.52-2.52h2.52v2.52c0 1.394-1.126 2.523-2.52 2.523z" fill="#E01E5A" />
        <path d="M6.303 15.165a2.52 2.52 0 0 1 2.52-2.523 2.52 2.52 0 0 1 2.52 2.523v6.313A2.52 2.52 0 0 1 8.823 24a2.528 2.528 0 0 1-2.52-2.522v-6.313z" fill="#E01E5A" />
        <path d="M8.823 5.042a2.52 2.52 0 0 1-2.52-2.52A2.528 2.528 0 0 1 8.823 0a2.52 2.52 0 0 1 2.52 2.52v2.522H8.823z" fill="#36C5F0" />
        <path d="M8.823 6.303a2.528 2.528 0 0 1 2.52 2.52 2.52 2.52 0 0 1-2.52 2.52H2.522A2.52 2.52 0 0 1 0 8.823a2.528 2.528 0 0 1 2.522-2.52h6.3z" fill="#36C5F0" />
        <path d="M18.956 8.823a2.52 2.52 0 0 1 2.522 2.52 2.528 2.528 0 0 1-2.522 2.523h-2.52V11.343c0-1.394 1.126-2.52 2.52-2.52z" fill="#2EB67D" />
        <path d="M17.697 8.823a2.528 2.528 0 0 1-2.52 2.52 2.52 2.52 0 0 1-2.52-2.52V2.522A2.52 2.52 0 0 1 15.177 0a2.528 2.528 0 0 1 2.52 2.522v6.301z" fill="#2EB67D" />
        <path d="M15.177 18.956a2.528 2.528 0 0 1 2.52 2.522 2.52 2.52 0 0 1-2.52 2.522h-2.52v-2.522c0-1.394 1.126-2.522 2.52-2.522z" fill="#ECB22E" />
        <path d="M15.177 17.697a2.52 2.52 0 0 1-2.52-2.522 2.528 2.528 0 0 1 2.52-2.52h6.302A2.528 2.528 0 0 1 24 15.175a2.52 2.52 0 0 1-2.521 2.522h-6.302z" fill="#ECB22E" />
      </svg>
    );
  }

  // ── GitLab ─────────────────────────────────────────────────────────────────
  if (id === "gitlab") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24"
        className={`service-logo ${className}`} aria-label="GitLab" role="img">
        <path fill="#E24329" d="M12 21.5L16.5 8.2h-9L12 21.5z" />
        <path fill="#FC6D26" d="M12 21.5l4.5-13.3H22L12 21.5zM12 21.5L2 8.2h5.5L12 21.5z" />
        <path fill="#FCA326" d="M2 8.2l1.7-4.3c.2-.5.8-.7 1.2-.4L7.5 8.2H2zM22 8.2l-1.7-4.3c-.2-.5-.8-.7-1.2-.4L16.5 8.2H22z" />
      </svg>
    );
  }

  // ── Linear ─────────────────────────────────────────────────────────────────
  if (id === "linear") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24"
        className={`service-logo ${className}`} aria-label="Linear" role="img">
        <path fill="#5E6AD2" d="M3.5 12.2A8.5 8.5 0 0 1 11.8 3.9L20.1 12.2A8.5 8.5 0 1 1 3.5 12.2z" />
      </svg>
    );
  }

  // ── Jira ───────────────────────────────────────────────────────────────────
  if (id === "jira") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24"
        className={`service-logo ${className}`} aria-label="Jira" role="img">
        <path fill="#2684FF" d="M12 2l7.5 7.5c-2.1 2.1-5.4 2.1-7.5 0L4.5 2H12zm0 20l-7.5-7.5c2.1-2.1 5.4-2.1 7.5 0L19.5 22H12z" />
      </svg>
    );
  }

  // ── Trello ─────────────────────────────────────────────────────────────────
  if (id === "trello") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24"
        className={`service-logo ${className}`} aria-label="Trello" role="img">
        <rect width="24" height="24" rx="4" fill="#0079BF" />
        <rect x="4" y="4" width="6" height="12" rx="1.5" fill="#fff" />
        <rect x="14" y="4" width="6" height="8" rx="1.5" fill="#fff" />
      </svg>
    );
  }

  // ── Dropbox ────────────────────────────────────────────────────────────────
  if (id === "dropbox") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24"
        className={`service-logo ${className}`} aria-label="Dropbox" role="img">
        <path fill="#0061FF" d="M6 2l6 3.8L6 9.6 0 5.8 6 2zm12 0l6 3.8-6 3.8-6-3.8L18 2zM0 13.4l6 3.8 6-3.8-6-3.8-6 3.8zm18-3.8l6 3.8-6 3.8-6-3.8 6-3.8zM6 18.4l6 3.8 6-3.8-6-3.8-6 3.8z" />
      </svg>
    );
  }

  // ── Airtable ───────────────────────────────────────────────────────────────
  if (id === "airtable") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24"
        className={`service-logo ${className}`} aria-label="Airtable" role="img">
        <path fill="#18BFFF" d="M12 3l10 4.2-10 4.2L2 7.2 12 3z" />
        <path fill="#F82B60" d="M11 12.2V21L2 16.6v-8.8l9 4.4z" />
        <path fill="#FFD012" d="M13 12.2l9-4.4v8.8L13 21v-8.8z" />
      </svg>
    );
  }

  // ── Weather ────────────────────────────────────────────────────────────────
  if (id === "weather") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
        className={`service-logo service-logo--weather ${className}`}
        aria-label="Weather" role="img">
        <circle cx="12" cy="10" r="4" fill="#F59E0B" />
        <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4c-3.72 0-6.84 2.72-7.44 6.33C1.98 10.98 0 13.25 0 16c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"
          fill="#94A3B8" fillOpacity="0.85" />
      </svg>
    );
  }

  // ── Web Search ─────────────────────────────────────────────────────────────
  if (id === "web_search" || id === "web") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
        className={`service-logo service-logo--web ${className}`}
        aria-label="Web Search" role="img">
        <circle cx="12" cy="12" r="9.5" stroke="#3B82F6" strokeWidth="1.8" />
        <ellipse cx="12" cy="12" rx="4.5" ry="9.5" stroke="#3B82F6" strokeWidth="1.6" />
        <path d="M2.5 12h19" stroke="#3B82F6" strokeWidth="1.6" />
      </svg>
    );
  }

  // ── Fallback ───────────────────────────────────────────────────────────────
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      className={`service-logo service-logo--fallback ${className}`}
      aria-label={serviceId || "Connector"} role="img">
      <rect width="24" height="24" rx="6" fill="var(--color-bg-subtle, #f3f4f6)" />
      <path d="M12 6v4m0 4v4m-4-6h8"
        stroke="var(--color-text-secondary, #6b7280)"
        strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default ServiceLogo;
