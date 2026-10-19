// Runs in every page the window loads, isolated from the page's own scripts.
// It tells the page it is in the desktop app, makes the top 38px of every
// page the window's title bar, and keeps the caption button symbols
// readable on the page's theme. Nothing else from Electron or Node is exposed.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", Object.freeze({ isDesktop: true, platform: process.platform }));

// Tray "New Chat": the app starts one on this event (see frontend App.jsx).
ipcRenderer.on("desktop:new-chat", () => window.dispatchEvent(new Event("desktop:new-chat")));

// The strip under the caption buttons drags the window; links, buttons and
// fields stay clickable wherever they sit in it. The strip itself takes no
// clicks, so it hides nothing on pages that do not leave room for it.
const TITLE_BAR_CSS = `
#desktop-title-bar {
  position: fixed; top: 0; left: 0; z-index: 2147483646;
  height: 38px; width: env(titlebar-area-width, calc(100% - 138px));
  pointer-events: none; -webkit-app-region: drag; app-region: drag;
}
html[data-desktop] :is(a, button, input, select, textarea, label, summary, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="combobox"], [contenteditable="true"]) {
  -webkit-app-region: no-drag; app-region: no-drag;
}`;

function toHex(value) {
  const text = String(value ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
  const rgb = text.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
  if (!rgb || (rgb[4] !== undefined && Number(rgb[4]) < 1)) return null;
  return `#${rgb.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, "0")).join("")}`;
}

// The caption buttons have a transparent background (main.js), so only
// their symbols need to read against the page: dark on a light theme,
// light on a dark one. The theme is judged by the page's paper colour (the
// theme token, else the body's background).
function pageColors() {
  const root = getComputedStyle(document.documentElement);
  const paper = toHex(root.getPropertyValue("--color-paper")) ?? toHex(document.body && getComputedStyle(document.body).backgroundColor);
  if (!paper) return null;
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(paper.slice(start, start + 2), 16) / 255);
  const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
  return { symbolColor: light ? "#1e293b" : "#94a3b8" };
}

let sent = "";
function syncTitleBarColors() {
  const colors = pageColors();
  if (!colors || colors.symbolColor === sent) return;
  sent = colors.symbolColor;
  ipcRenderer.send("desktop:title-bar-colors", colors);
}

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.desktop = process.platform;
  const style = document.createElement("style");
  style.textContent = TITLE_BAR_CSS;
  document.head.append(style);
  const bar = document.createElement("div");
  bar.id = "desktop-title-bar";
  bar.setAttribute("aria-hidden", "true");
  // First in the page, so every clickable element after it is cut out of it.
  document.body.prepend(bar);

  syncTitleBarColors();
  // The theme is set on <html> (data-theme and its style); follow changes.
  new MutationObserver(syncTitleBarColors).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncTitleBarColors);
});
