// Is this page running inside the VibhavGPT Windows app? Its preload exposes
// window.desktop (every version since 1.1.0) and window.desktopAPI (1.2.0
// and later); a browser has neither.
export const DESKTOP_APP_CLASS = "is-desktop-app";

export function isDesktopApp(scope = globalThis) {
  return Boolean(scope?.desktop?.isDesktop || scope?.desktopAPI);
}

// Marks <body> so the desktop app's own touches (desktop.css) apply there and
// nowhere else. Returns whether it did.
export function markDesktopApp(scope = globalThis) {
  if (!isDesktopApp(scope)) return false;
  scope.document?.body?.classList.add(DESKTOP_APP_CLASS);
  return true;
}

// The Apps links in the sidebar: inside the Windows app, its own download
// page is left out; everywhere else every link stays.
export const WINDOWS_DOWNLOAD_PATH = "/vibhavgpt-windows";
export function visibleAppLinks(links, desktop = isDesktopApp()) {
  return desktop ? links.filter((link) => link.href !== WINDOWS_DOWNLOAD_PATH) : links;
}
