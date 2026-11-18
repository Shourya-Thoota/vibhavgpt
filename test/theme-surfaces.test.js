import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { THEME_KEYS, THEME_CHOSEN_KEY, readSurfaceThemes, savedTheme, surfaceForView } from "../frontend/src/theme-surfaces.js";

// Chat and Study each have their own background (sky), with a migration that copies today's value into both so nobody's look changes.
const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const storage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, String(v)); } };
};

test("the migration: Study starts as a copy of whatever Chat is, so nobody's look changes", () => {
  for (const [stored, expected] of [["light", "light"], ["dark", "dark"]]) {
    const s = storage({ [THEME_KEYS.chat]: stored });
    assert.deepEqual(readSurfaceThemes(s), { chat: expected, study: expected }, stored);
    assert.equal(s.getItem(THEME_KEYS.study), expected, "and it is written down, so this runs once");
    assert.equal(s.getItem(THEME_KEYS.chat), stored, "Chat's own value is untouched");
  }
  // "Match system" counts only when the reader chose it; both follow the same rule.
  const chosen = storage({ [THEME_KEYS.chat]: "system", [THEME_CHOSEN_KEY]: "1" });
  assert.deepEqual(readSurfaceThemes(chosen), { chat: "system", study: "system" });
  const notChosen = storage({ [THEME_KEYS.chat]: "system" });
  assert.deepEqual(readSurfaceThemes(notChosen), { chat: "dark", study: "dark" }, "an old unchosen \"system\" is Deep Space, as before, in both");
  // Nothing stored at all: the default sky, in both.
  assert.deepEqual(readSurfaceThemes(storage()), { chat: "dark", study: "dark" });
  // A garbage value for Study is replaced by Chat's.
  const bad = storage({ [THEME_KEYS.chat]: "light", [THEME_KEYS.study]: "neon" });
  assert.deepEqual(readSurfaceThemes(bad), { chat: "light", study: "light" });
});

test("once they differ, each keeps its own, and reading does not undo a choice", () => {
  const s = storage({ [THEME_KEYS.chat]: "dark", [THEME_KEYS.study]: "light", [THEME_CHOSEN_KEY]: "1" });
  assert.deepEqual(readSurfaceThemes(s), { chat: "dark", study: "light" });
  assert.deepEqual(readSurfaceThemes(s), { chat: "dark", study: "light" }, "reading twice changes nothing");
  assert.equal(s.getItem(THEME_KEYS.chat), "dark");
  assert.equal(s.getItem(THEME_KEYS.study), "light");
  const system = storage({ [THEME_KEYS.chat]: "dark", [THEME_KEYS.study]: "system", [THEME_CHOSEN_KEY]: "1" });
  assert.equal(readSurfaceThemes(system).study, "system");
  assert.equal(savedTheme(storage({ [THEME_KEYS.study]: "system" }), THEME_KEYS.study), "dark", "unchosen system is dark");
});

test("blocked storage never throws: both are the default sky", () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual(readSurfaceThemes(blocked), { chat: "dark", study: "dark" });
});

test("the screen on show decides which background applies: Study's only on the Study chat", () => {
  assert.equal(surfaceForView({ page: "chat", productMode: "study" }), "study");
  assert.equal(surfaceForView({ page: "chat", productMode: "chat" }), "chat");
  assert.equal(surfaceForView({ page: "chat", productMode: "image" }), "chat");
  for (const page of ["settings", "usage", "extensions", "library", "memory"]) assert.equal(surfaceForView({ page, productMode: "study" }), "chat", `${page} uses Chat's`);
  assert.equal(surfaceForView(), "chat");
});

test("Settings shows two clearly labelled controls with the same three options, and the app follows the screen", () => {
  const app = read("frontend/src/App.jsx");
  assert.match(app, /title: "Chat background", description: "The sky behind Chat, Image and everything outside Study\./);
  assert.match(app, /title: "Study background", description: "The sky behind Study\./);
  assert.match(app, /role="radiogroup" aria-label=\{surface\.title\}/);
  assert.match(app, /\{ id: "system", label: "Match system"/);
  assert.match(app, /\{ id: "light", label: "Daybreak"/);
  assert.match(app, /\{ id: "dark", label: "Deep Space"/);
  assert.match(app, /onClick=\{\(\) => setSurfaceTheme\(surface\.which, option\.id\)\}/);
  assert.match(app, /const themeSurface = surfaceForView\(\{ page, productMode \}\);/);
  assert.match(app, /appearance\.setSurface\?\.\(themeSurface\)/);
  // The setup questions ask once, for the app as a whole, so they set both.
  assert.match(app, /const setThemeId = useCallback\(\(value\) => \{ setSurfaceTheme\("chat", value\); setSurfaceTheme\("study", value\); \}/);
  assert.doesNotMatch(app, /title="Theme" description="Both choices apply instantly/, "the single Theme group is gone");
});

// The boot script runs before anything else, in a bare page: run it in a sandbox for each case.
function boot({ path: pathname, stored, light = false }) {
  const attributes = {};
  const sandbox = {
    document: { documentElement: { setAttribute: (k, v) => { attributes[k] = v; }, removeAttribute: (k) => { delete attributes[k]; } } },
    localStorage: storage(stored),
    location: { pathname },
    window: { matchMedia: () => ({ matches: light, addEventListener() {} }), addEventListener() {} },
  };
  sandbox.window.localStorage = sandbox.localStorage;
  vm.runInNewContext(read("frontend/src/theme/appearance-boot.js"), sandbox);
  return attributes["data-theme"];
}

test("before first paint, the Study route gets Study's sky and every other route gets Chat's", () => {
  const stored = { [THEME_KEYS.chat]: "dark", [THEME_KEYS.study]: "light", [THEME_CHOSEN_KEY]: "1" };
  assert.equal(boot({ path: "/app/study", stored }), "light");
  assert.equal(boot({ path: "/app/study/abc", stored }), "light");
  assert.equal(boot({ path: "/app/chat", stored }), "dark");
  assert.equal(boot({ path: "/app/settings/appearance", stored }), "dark");
  assert.equal(boot({ path: "/home", stored }), "dark");
  assert.equal(boot({ path: "/app/studyx", stored }), "dark", "only the Study route");
  // Not migrated yet: Study is Chat's, as before.
  assert.equal(boot({ path: "/app/study", stored: { [THEME_KEYS.chat]: "light" } }), "light");
  assert.equal(boot({ path: "/app/study", stored: {} }), "dark");
  // "Match system" follows the device, for Study too.
  assert.equal(boot({ path: "/app/study", stored: { [THEME_KEYS.study]: "system", [THEME_CHOSEN_KEY]: "1" }, light: true }), "light");
});
