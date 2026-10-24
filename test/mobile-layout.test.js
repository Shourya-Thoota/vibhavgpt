import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Phone layout (max-width 760px, NARROW_QUERY in components/ui.jsx): thumb-
// sized targets, fields that don't make iOS zoom, dialogs and the composer
// clear of the gesture bar, and Writing Tools in one column.
const read = (path) => readFileSync(new URL(`../frontend/${path}`, import.meta.url), "utf8");
const styles = read("src/styles.css");
const mobile = read("src/mobile.css");
const phone = mobile.slice(mobile.indexOf("@media (max-width: 760px)"));

test("the viewport reaches under the notch and keeps pinch zoom", () => {
  const viewport = read("index.html").match(/<meta name="viewport" content="([^"]+)"/)[1];
  assert.match(viewport, /width=device-width/);
  assert.match(viewport, /viewport-fit=cover/);
  assert.doesNotMatch(viewport, /user-scalable=no|maximum-scale=1/, "zoom stays available for people who need it");
});

test("the root never scrolls sideways and the safe areas are shared tokens", () => {
  assert.match(styles, /\*, \*::before, \*::after \{ box-sizing: border-box; \}/);
  assert.match(styles, /html \{[^}]*overflow-x: clip;/, "clip, not hidden, so sticky bars keep working");
  assert.match(styles, /body \{[^}]*overflow-x: clip;/);
  assert.match(styles, /--safe-top: env\(safe-area-inset-top, 0px\);/);
  assert.match(styles, /--safe-bottom: env\(safe-area-inset-bottom, 0px\);/);
});

test("on phones everything a thumb presses is at least 44px", () => {
  assert.match(phone, /\.btn,\s*\.btn--quiet,\s*\.ui-segmented__option,\s*\.swatch,\s*\.ui-select__trigger,\s*\.code-block__copy \{ min-height: 44px; \}/);
  assert.match(phone, /\.composer__row \.composer__send \{ width: 44px; height: 44px; \}/);
  for (const rule of [/\.input-affix__button \{[^}]*width: 44px; height: 44px;/, /\.conversation-item__actions \{ width: 44px; height: 44px;/, /\.library__add \{ width: 44px; height: 44px;/, /\.turn__tools \.ui-icon-button \{ width: 44px; height: 44px; \}/, /\.survey-slider__input \{ height: 44px; \}/, /\.checkbox \{ min-height: 44px;/]) {
    assert.match(phone, rule);
  }
  assert.match(phone, /\.mode-tabs__tab::after \{ content: ""; position: absolute; inset: -6px 0; \}/, "the slim title-bar tabs get a 44px hit area");
  assert.doesNotMatch(read("src/components/Sidebar.jsx"), /minHeight: 34/, "no inline size the phone rule can't override");
});

test("fields are 16px on phones, so iOS doesn't zoom when one takes focus", () => {
  assert.match(phone, /\.input,\s*\.textarea,\s*\.ui-select__trigger \{ font-size: 1rem; \}/);
});

test("the composer, dialogs and settings clear the gesture bar", () => {
  assert.match(phone, /\.composer-wrap \{\s*padding: 4px 12px max\(12px, var\(--safe-bottom\)\);/);
  assert.match(phone, /\.ui-modal \{\s*width: min\(100%, 420px\);\s*max-height: 90vh;\s*max-height: 90dvh;\s*margin: auto;\s*padding: 24px 20px max\(20px, var\(--safe-bottom\)\);/);
  assert.match(phone, /\.ui-scrim \{ padding: max\(16px, var\(--safe-top\)\) 16px max\(16px, var\(--safe-bottom\)\); \}/);
  assert.match(phone, /\.ui-modal__actions \{ flex-wrap: wrap; \}/);
  assert.match(phone, /\.settings__layout \{ padding-bottom: max\(32px, var\(--safe-bottom\)\); \}/);
  assert.match(phone, /\.bubble--user \{\s*max-width: 88%;\s*overflow-wrap: anywhere;/);
});

test("Writing Tools stack in one column on phones", () => {
  const css = read("src/writing-tools.css");
  const narrow = css.slice(css.indexOf("@media (max-width: 760px)"));
  assert.match(narrow, /\.writing-tools__bar \{ flex-direction: column;/);
  assert.match(narrow, /\.writing-tools__bar > \.ui-segmented \{[^}]*max-width: 100%;[^}]*overflow-x: auto;/, "the tabs scroll inside themselves, never widen the page");
  assert.match(narrow, /\.writing-tools-widget-wrapper iframe \{ min-width: 0; max-width: 100%; \}/);
});

test("passkey sign-in is offered only where the browser supports it", () => {
  const app = read("src/App.jsx");
  assert.match(app, /\{passkeysSupported\(\) && \(\s*<button className="btn btn--quiet" type="button" disabled=\{busy \|\| googleBusy\} onClick=\{signInWithPasskey\}>/);
});
