import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const theme = readFileSync(new URL("../frontend/src/theme/vibhav.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
const home = readFileSync(new URL("../frontend/public/home/index.html", import.meta.url), "utf8");

test("phone chat keeps one mode switch and code stays inside the thread", () => {
  const shell = readFileSync(new URL("../frontend/src/chat-reference.css", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../frontend/src/settings.css", import.meta.url), "utf8");
  const chat = readFileSync(new URL("../frontend/src/styles.css", import.meta.url), "utf8");
  assert.match(shell, /@media \(max-width: 760px\) \{\s*\.workspace__main > \.mode-tabs-bar \{ display: none; \}/);
  assert.match(settings, /\.settings-back-btn--desktop \{ display: none; \}/);
  assert.match(chat, /\.code-block \{[^}]*min-width: 0;/);
});

test("the dark ground stays warm, the light ground is pure white, and the accent is not a hardcoded blue button", () => {
  assert.match(theme, /#120f0d/);
  assert.doesNotMatch(theme, /#f6f0e6/, "the old warm light paper is gone");
  assert.match(theme, /#e7b89a/);
  assert.match(theme, /#d7a3a8/);
  assert.doesNotMatch(theme, /#2b8cff/);
  assert.doesNotMatch(theme, /#0a1c44/);
  assert.match(theme, /:root:not\(\[data-theme="light"\]\) \{\s*--color-accent-ink: #1c1612;/);
  assert.match(theme, /:root\[data-accent="cerulean"\] \{\s*--color-accent-ink: #ffffff;/);
  assert.match(theme, /--gloss-primary: linear-gradient\(180deg, color-mix\(in srgb, var\(--color-accent\)/);
  assert.match(theme, /:root \{\s*--color-accent: var\(--color-accent-ember\)/);
  assert.match(app, /localStorage\.getItem\("vibhavgpt-accent"\) \|\| "ember"/);
  assert.doesNotMatch(home, /\.showcase\{[^}]*border-top/);
  assert.match(theme, /:root\[data-theme="light"\] \{[^}]*--color-paper: #ffffff;/);
  assert.match(theme, /--color-paper: #120f0d/);
  assert.match(theme, /--glass-solid: #221e1a/);
  assert.doesNotMatch(theme, /--glass-solid: #1c1c1e/);
});
