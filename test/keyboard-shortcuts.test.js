// Shortcuts across web, Windows and Android (2026-11-17): the keyboard handler (frontend/src/keyboard-shortcuts.js), the PWA
// manifest's shortcuts, the Windows jump list and menus (desktop/main.js), and the Android launcher shortcuts. All of them open
// the same three addresses, and every copy of that list agrees.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { KEYBOARD_SHORTCUTS, LAUNCH_SHORTCUTS, isMacPlatform, isTypingTarget, launchPathFromLink, shortcutForEvent, shortcutRows } from "../frontend/src/keyboard-shortcuts.js";

const read = (file) => fs.readFileSync(file, "utf8");
const el = (tagName, extra = {}) => ({ nodeType: 1, tagName, isContentEditable: false, closest: () => null, ...extra });
const key = (k, extra = {}) => ({ key: k, code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, isComposing: false, target: el("BUTTON"), ...extra });
const ctrl = (k, extra) => key(k, { ctrlKey: true, ...extra });
const cmd = (k, extra) => key(k, { metaKey: true, ...extra });
const win = { mac: false };
const mac = { mac: true };

test("Ctrl on Windows and Cmd on a Mac: N, B, comma and slash map to their actions", () => {
  assert.equal(shortcutForEvent(ctrl("n"), win), "new-chat");
  assert.equal(shortcutForEvent(ctrl("N"), win), "new-chat", "Caps Lock");
  assert.equal(shortcutForEvent(ctrl("b"), win), "toggle-sidebar");
  assert.equal(shortcutForEvent(ctrl(","), win), "settings");
  assert.equal(shortcutForEvent(ctrl("/"), win), "shortcuts");
  // A layout where the key types another character still matches by its position.
  assert.equal(shortcutForEvent(ctrl(";", { code: "Comma" }), win), "settings");
  assert.equal(shortcutForEvent(ctrl("-", { code: "Slash" }), win), "shortcuts");
  assert.equal(shortcutForEvent(cmd("n"), mac), "new-chat");
  assert.equal(shortcutForEvent(cmd(","), mac), "settings");
  // The other platform's modifier does nothing (Ctrl+B is a text-editing key on a Mac; Win+N is the system's).
  assert.equal(shortcutForEvent(ctrl("n"), mac), null);
  assert.equal(shortcutForEvent(cmd("n"), win), null);
  assert.equal(shortcutForEvent(ctrl("n", { metaKey: true }), win), null, "both held");
});

test("Ctrl/Cmd+K opens search as before: either modifier, even while typing or with a dialog open", () => {
  for (const options of [win, mac]) {
    assert.equal(shortcutForEvent(ctrl("k"), options), "search");
    assert.equal(shortcutForEvent(cmd("k"), options), "search");
    assert.equal(shortcutForEvent(ctrl("k", { target: el("TEXTAREA") }), options), "search");
    assert.equal(shortcutForEvent(ctrl("k"), { ...options, modalOpen: true }), "search");
  }
  assert.equal(shortcutForEvent(ctrl("k", { shiftKey: true }), win), null);
});

test("nothing fires while typing in a field, behind a dialog, during IME composition, or with Alt/Shift", () => {
  for (const target of [el("TEXTAREA"), el("SELECT"), el("INPUT", { type: "text" }), el("INPUT", { type: "search" }), el("INPUT", { type: "" }), el("DIV", { isContentEditable: true }), el("SPAN", { closest: () => ({}) })]) {
    assert.equal(shortcutForEvent(ctrl("n", { target }), win), null, `${target.tagName} ${target.type ?? ""}`);
    assert.equal(shortcutForEvent(ctrl("b", { target }), win), null, "Ctrl+B stays bold in an editor");
  }
  // Buttons, checkboxes and the page itself are not typing.
  for (const target of [el("BUTTON"), el("INPUT", { type: "checkbox" }), el("INPUT", { type: "range" }), { nodeType: 9 }]) assert.equal(shortcutForEvent(ctrl("n", { target }), win), "new-chat");
  assert.equal(shortcutForEvent(ctrl("n"), { ...win, modalOpen: true }), null);
  assert.equal(shortcutForEvent(ctrl("/"), { ...win, modalOpen: true }), null);
  assert.equal(shortcutForEvent(ctrl("n", { isComposing: true }), win), null);
  assert.equal(shortcutForEvent(ctrl("n", { defaultPrevented: true }), win), null);
  assert.equal(shortcutForEvent(ctrl("n", { altKey: true }), win), null, "AltGr and Alt combinations are left alone");
  assert.equal(shortcutForEvent(ctrl("n", { shiftKey: true }), win), null, "Ctrl+Shift+N is the browser's private window");
  assert.equal(shortcutForEvent(key("n"), win), null, "a plain letter is typing");
  assert.equal(shortcutForEvent(key("Escape"), win), null, "Esc is left to the dialog on top");
  assert.equal(shortcutForEvent(null, win), null);
});

test("isTypingTarget and isMacPlatform", () => {
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget(el("INPUT", { type: "email" })), true);
  assert.equal(isTypingTarget(el("INPUT", { type: "button" })), false);
  assert.equal(isMacPlatform({ userAgentData: { platform: "macOS" } }), true);
  assert.equal(isMacPlatform({ platform: "MacIntel" }), true);
  assert.equal(isMacPlatform({ platform: "iPhone" }), true);
  assert.equal(isMacPlatform({ platform: "Win32" }), false);
  assert.equal(isMacPlatform(undefined), false);
});

test("the help dialog lists every shortcut with its keys, and Esc", () => {
  assert.deepEqual(shortcutRows(false).map((row) => [row.label, row.keys.join("+")]), [
    ["New chat", "Ctrl+N"], ["Search chats", "Ctrl+K"], ["Show or hide the sidebar", "Ctrl+B"], ["Open Settings", "Ctrl+,"], ["Keyboard shortcuts", "Ctrl+/"], ["Close the dialog or picker on top", "Esc"],
  ]);
  assert.deepEqual(shortcutRows(true).map((row) => row.keys[0]), ["⌘", "⌘", "⌘", "⌘", "⌘", "Esc"]);
  assert.equal(shortcutRows(false).length, KEYBOARD_SHORTCUTS.length + 1);
});

test("launch links: only vibhavgpt://open/app/chat, image and build", () => {
  assert.equal(launchPathFromLink("vibhavgpt://open/app/chat"), "/app/chat");
  assert.equal(launchPathFromLink("vibhavgpt://open/app/image"), "/app/image");
  assert.equal(launchPathFromLink("vibhavgpt://open/app/build"), "/app/build");
  for (const link of ["vibhavgpt://open/app/settings", "vibhavgpt://open/app/chat?conversation=x", "vibhavgpt://open/app/chat#x", "vibhavgpt://account/auth?code=1", "vibhavgpt://open//evil.example/app/chat", "https://open/app/chat", "vibhavgpt://user@open/app/chat", "", null, "not a url"]) {
    assert.equal(launchPathFromLink(link), null, String(link));
  }
});

test("the PWA manifest offers New Chat, New Image and New Build with 96px icons that exist", () => {
  const manifest = JSON.parse(read("frontend/public/brand/manifest.webmanifest"));
  assert.deepEqual(manifest.shortcuts.map((s) => [s.name, s.url]), LAUNCH_SHORTCUTS.map((s) => [s.name, s.path]));
  for (const shortcut of manifest.shortcuts) {
    assert.ok(shortcut.short_name && shortcut.description, shortcut.name);
    assert.equal(shortcut.icons.length, 1);
    const [icon] = shortcut.icons;
    assert.equal(icon.sizes, "96x96");
    assert.equal(icon.type, "image/png");
    const bytes = fs.readFileSync(`frontend/public${icon.src}`);
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [96, 96], icon.src);
  }
  assert.equal(manifest.start_url, "/", "the rest of the manifest is unchanged");
  assert.deepEqual(manifest.icons.map((i) => i.sizes), ["192x192", "512x512"]);
});

test("Windows: the jump list and menus use the same three paths, and the menu only names the keys", () => {
  const main = read("desktop/main.js");
  const block = main.slice(main.indexOf("const LAUNCH_SHORTCUTS"), main.indexOf("const LAUNCH_HOST"));
  assert.deepEqual([...block.matchAll(/title: "([^"]+)"[^}]*path: "([^"]+)"/g)].map((m) => [m[1], m[2]]), LAUNCH_SHORTCUTS.map((s) => [s.name, s.path]));
  assert.match(main, /registerAccelerator: false/, "the page handles the keys (and ignores them while typing)");
  for (const accelerator of ["CommandOrControl+N", "CommandOrControl+K", "CommandOrControl+B", "CommandOrControl+,", "CommandOrControl+/"]) assert.ok(main.includes(`accelerator: "${accelerator}"`), accelerator);
  const preload = read("desktop/preload.js");
  const allowed = preload.match(/SHORTCUT_ACTIONS = new Set\(\[([^\]]+)\]\)/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1)).sort();
  assert.deepEqual(allowed, ["new-build", "new-chat", "new-image", "search", "settings", "shortcuts", "toggle-sidebar"]);
});

test("Android: both apps declare the three launcher shortcuts for their own activity, with labels and icons", () => {
  for (const [dir, pkg] of [["mobile-capacitor", "com.pansophy.vibhavgpt"], ["mobile-capacitor-direct", "com.pansophy.vibhavgpt.direct"]]) {
    const res = `${dir}/android/app/src/main/res`;
    const xml = read(`${res}/xml-v25/shortcuts.xml`);
    const shortcuts = [...xml.matchAll(/android:shortcutId="([^"]+)"[\s\S]*?android:icon="@drawable\/([^"]+)"[\s\S]*?android:targetPackage="([^"]+)"[\s\S]*?android:targetClass="([^"]+)"[\s\S]*?android:data="([^"]+)"/g)];
    assert.deepEqual(shortcuts.map((m) => launchPathFromLink(m[5])), LAUNCH_SHORTCUTS.map((s) => s.path), dir);
    for (const [, id, icon, targetPackage, targetClass] of shortcuts) {
      assert.equal(targetPackage, pkg);
      assert.equal(targetClass, `${pkg}.MainActivity`);
      assert.ok(fs.existsSync(`${res}/drawable-nodpi/${icon}.png`), `${dir}: ${icon}`);
      const strings = read(`${res}/values/strings.xml`);
      assert.ok(strings.includes(`name="shortcut_${id}_short"`) && strings.includes(`name="shortcut_${id}_long"`), `${dir}: ${id} labels`);
    }
    const manifest = read(`${dir}/android/app/src/main/AndroidManifest.xml`);
    assert.match(manifest, /<meta-data\s+android:name="android\.app\.shortcuts"\s+android:resource="@xml\/shortcuts" \/>/);
    // No new intent filter: the shortcuts are explicit intents, so no other app can send these links.
    assert.equal((manifest.match(/<intent-filter>/g) ?? []).length, 2);
  }
});

test("the web app routes launch links and runs the shortcut actions from one handler", () => {
  const app = read("frontend/src/App.jsx");
  assert.match(app, /const launch = launchPathFromLink\(url\);\s*if \(launch\) \{ window\.location\.assign\(launch\); return; \}/);
  assert.match(app, /shortcutForEvent\(event, \{ modalOpen: Boolean\(document\.querySelector\('\[aria-modal="true"\]'\)\) \}\)/);
  for (const action of ["new-chat", "new-image", "new-build", "search", "toggle-sidebar", "settings", "shortcuts"]) assert.ok(app.includes(`"${action}": `) || app.includes(`${action}: `), action);
  assert.doesNotMatch(app, /localStorage\.setItem\([^)]*shortcut/i, "nothing about shortcuts is stored");
});
