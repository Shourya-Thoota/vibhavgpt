// Keyboard shortcuts for the workspace (web and the Windows app), and the launch shortcuts the installed apps offer (the PWA
// manifest, the Windows jump list, Android's launcher). Nothing here is stored: the shortcuts are fixed.
//
// Ctrl on Windows and Linux, Cmd on a Mac. A shortcut is ignored while the person is typing in a field (except Ctrl/Cmd+K, which
// has always opened search from anywhere) and while a dialog is open; Esc is left to whatever dialog or picker is on top, each of
// which already closes on it. A browser keeps some combinations for itself (Ctrl+N opens a window in most browsers); a page never
// sees those, so they work in the Windows app and wherever the browser passes them on.

export const KEYBOARD_SHORTCUTS = Object.freeze([
  Object.freeze({ action: "new-chat", key: "n", label: "New chat" }),
  Object.freeze({ action: "search", key: "k", label: "Search chats" }),
  Object.freeze({ action: "toggle-sidebar", key: "b", label: "Show or hide the sidebar" }),
  Object.freeze({ action: "settings", key: ",", code: "Comma", label: "Open Settings" }),
  Object.freeze({ action: "shortcuts", key: "/", code: "Slash", label: "Keyboard shortcuts" }),
]);

/** The rows of the "Keyboard shortcuts" dialog, in order, with the keys as shown on this platform. */
export function shortcutRows(mac = isMacPlatform()) {
  const mod = mac ? "⌘" : "Ctrl";
  return [
    ...KEYBOARD_SHORTCUTS.map(({ action, key, label }) => ({ action, label, keys: [mod, key === "," || key === "/" ? key : key.toUpperCase()] })),
    { action: "close", label: "Close the dialog or picker on top", keys: ["Esc"] },
  ];
}

export function isMacPlatform(nav = globalThis.navigator) {
  const platform = nav?.userAgentData?.platform ?? nav?.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number", "date", "datetime-local", "month", "time", "week"]);

/** True when keys pressed in `target` are typing: a text field, a text area, a select, or editable content. */
export function isTypingTarget(target) {
  if (!target || target.nodeType !== 1) return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return TEXT_INPUT_TYPES.has(String(target.type ?? "").toLowerCase());
  return Boolean(target.closest?.('[contenteditable=""], [contenteditable="true"], [role="textbox"]'));
}

/**
 * The action a keydown asks for, or null. `modalOpen`: a dialog is open (a shortcut then does nothing, so it never acts behind
 * the dialog); `mac`: Cmd is the modifier.
 */
export function shortcutForEvent(event, { mac = isMacPlatform(), modalOpen = false } = {}) {
  if (!event || event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return null;
  const key = String(event.key ?? "").toLowerCase();
  // Search keeps its behaviour from before: either modifier, from anywhere, even while typing.
  if ((event.ctrlKey || event.metaKey) && key === "k") return "search";
  const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier) return null;
  const match = KEYBOARD_SHORTCUTS.find((shortcut) => shortcut.action !== "search" && (key === shortcut.key || (shortcut.code && event.code === shortcut.code)));
  if (!match || modalOpen || isTypingTarget(event.target)) return null;
  return match.action;
}

// Launch shortcuts: each opens a fresh session at an address the app already serves.
export const LAUNCH_SHORTCUTS = Object.freeze([
  Object.freeze({ id: "new-chat", name: "New Chat", description: "Start a new chat", path: "/app/chat", icon: "/brand/shortcuts/new-chat-96.png" }),
  Object.freeze({ id: "new-image", name: "New Image", description: "Create a new image", path: "/app/image", icon: "/brand/shortcuts/new-image-96.png" }),
  Object.freeze({ id: "new-build", name: "New Build", description: "Start a new build", path: "/app/build", icon: "/brand/shortcuts/new-build-96.png" }),
]);

// The Windows jump list and Android's launcher shortcuts open the app with vibhavgpt://open/app/chat (and image, build). Only
// these three paths are accepted; anything else is ignored.
export const LAUNCH_LINK_HOST = "open";

/** The app path a vibhavgpt://open/… link asks for, or null when it is not one of the launch shortcuts. */
export function launchPathFromLink(raw) {
  let url;
  try { url = new URL(String(raw ?? "")); } catch { return null; }
  if (url.protocol !== "vibhavgpt:" || url.hostname !== LAUNCH_LINK_HOST || url.search || url.hash || url.username || url.password) return null;
  return LAUNCH_SHORTCUTS.find((shortcut) => shortcut.path === url.pathname)?.path ?? null;
}
