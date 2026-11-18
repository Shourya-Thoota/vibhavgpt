import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The chat interface drawn to the owner's reference screenshot (frontend/src/chat-reference.css). The measurements the
// design rests on are in that file's comments; the browser test (browser-chat-reference.test.js) checks them on the
// rendered screen. This one guards what is true of the source: the typeface and its licence, the wording, the saved
// data staying as it was, and the things that went wrong while building it.
const src = (file) => fs.readFileSync(path.resolve("frontend/src", file), "utf8");

test("the typeface is Google Sans under the SIL Open Font License, self-hosted, with its licence kept beside it", () => {
  const dir = path.resolve("frontend/src/fonts");
  const licence = fs.readFileSync(path.join(dir, "OFL.txt"), "utf8");
  assert.match(licence, /Google Sans Project Authors/);
  assert.match(licence, /SIL Open Font License, Version 1\.1/);
  for (const file of ["GoogleSans-latin.woff2", "GoogleSans-latin-ext.woff2"]) {
    const bytes = fs.readFileSync(path.join(dir, file));
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "wOF2", `${file} is a woff2 file`);
    assert.ok(bytes.length > 10_000 && bytes.length < 120_000, `${file} is ${bytes.length} bytes`);
  }
  const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  assert.match(readme, /Licence: SIL Open Font License 1\.1/);
  assert.match(readme, /Google Sans Text[^.]*licence could not be established[^.]*not used/s, "the face whose licence is unknown is recorded as not used");
  const css = src("chat-reference.css");
  assert.equal([...css.matchAll(/@font-face/g)].length, 2, "two files: Latin and Latin extended");
  assert.doesNotMatch(css, /fonts\.(googleapis|gstatic)\.com|https?:\/\//, "no request to another site for type");
  assert.match(css, /src: url\("\.\/fonts\/GoogleSans-latin\.woff2"\) format\("woff2"\)/);
});

test("nothing in the new stylesheet or its fonts names another company's product or a model provider", () => {
  for (const [file, text] of [["chat-reference.css", src("chat-reference.css")], ["fonts/README.md", src("fonts/README.md")]]) {
    assert.doesNotMatch(text, /gemini|openai|anthropic|claude|chatgpt|deepseek|groq|openrouter/i, file);
  }
});

test("Unified projects in the sidebar with Learning and Work types, and saved data is untouched", () => {
  const library = src("components/ConversationLibrary.jsx");
  // User-facing terminology: Projects with Learning and Work types, one shared list
  for (const text of [
    "<span>Projects</span>",
    "<span>New project</span>",
    "Learning project",
    "Work project",
    ">Edit project</MenuItem>",
    ">Delete project</MenuItem>",
    `"Create project"`,
    `"Project name"`,
  ]) assert.ok(library.includes(text), text);
  // Folders UI removed
  assert.doesNotMatch(library, /<span>Folders<\/span>|"New folder"|Edit folder|Delete folder|Create folder|Folder name/);
  // What is stored: the kind is still "project", the same endpoints and fields, so every saved group keeps working.
  assert.match(library, /group\.kind === "project"/);
  assert.match(library, /startProject/);
  assert.match(library, /api\(`\/api\/chat\/groups\/\$\{(?:notebook|project|group)\.id\}`, \{ method: "DELETE" \}\)/);
});

test("the sidebar: New chat is the one selected row on a fresh chat, the account row ends in a gear, and the rows are the reference's 20px", () => {
  const sidebar = src("components/Sidebar.jsx");
  assert.match(sidebar, /const newChatSelected = variant !== "image" && page === "chat" && !activeConversationId;/);
  assert.match(sidebar, /data-selected=\{newChatSelected \? "true" : undefined\}/);
  assert.match(sidebar, /data-active=\{\(page === link\.id && !\(link\.id === "chat" && newChatSelected\)\) \|\| undefined\}/, "the Chat link is not also selected on a fresh chat");
  assert.match(sidebar, /<SettingsIcon className="account__gear"/);
  assert.doesNotMatch(sidebar, /size=\{17\} strokeWidth=\{1\.9\}/, "no row icon is left at the old size");
});

test("the composer says Ask VibhavGPT and keeps the model in its accessible name; the Chat home has no suggestion rows and Study's tools only fill the box", () => {
  const app = src("App.jsx");
  assert.match(app, /placeholder="Ask VibhavGPT"\s+aria-label=\{studyMode \? "Message VibhavGPT" : buildMode \? "Message VibhavGPT Tecton" : `Message \$\{modelInfo\.full\}`\}/);
  assert.doesNotMatch(app, /CHAT_STARTERS|chat-starters/, "the three suggested-question rows are gone from the Chat home");
  assert.doesNotMatch(src("chat-reference.css"), /chat-starters/, "and so is their CSS");
  const rows = app.match(/const startRows = empty && !loadingConversation && studyMode \? \([\s\S]*?\) : null;/)[0];
  assert.match(rows, /setDraft\(label\); inputRef\.current\?\.focus\(\)/);
  assert.doesNotMatch(rows, /\bsend\(|deliver\(|fetch\(|api\(/, "a tool chip fills the box; it never sends");
  assert.doesNotMatch(app, /<a className="get-app"/, "redundant standalone Get app button is removed from workspace");
});

test("the stylesheet holds the reference's measurements, and the sidebar width stays a plain number the collapse spring can read", () => {
  const css = src("chat-reference.css");
  // The reference's numbers, scaled by 0.84 (the app is about 16% smaller on a desktop): 825 by 80 became 693 by 67.
  assert.match(css, /width: min\(100%, 693px\);\s*min-height: 67px;/, "the composer is 693 by 67");
  assert.match(css, /border-radius: 33\.5px;\s*background: var\(--ref-composer\);/, "a full pill");
  assert.match(css, /font-size: 41\.5px;/, "the greeting");
  assert.match(css, /--ref-glow-shape: 62\.4% 56\.8% at 52\.1% 54%;/, "the glow keeps the reference's fitted centre and radii");
  assert.match(css, /--ref-glow-stops: color-mix\(in srgb, var\(--color-accent\) 24%, #ffffff\) 0%/, "in the selected accent: its peak colour");
  assert.doesNotMatch(css, /#daccfa|#c4e2fc|rgb\(58 104 170|rgb\(116 88 210/, "no fixed colour is left in the glow");
  // The width spring reads --sidebar-w with parseFloat: a clamp() or a var() there is NaN and the sidebar stops animating.
  const widths = [...css.matchAll(/--sidebar-w: ([^;]+);/g)].map((m) => m[1]);
  assert.ok(widths.length >= 4, "stepped by screen width");
  for (const width of widths) assert.match(width, /^\d+px$/, `--sidebar-w: ${width}`);
  assert.deepEqual(widths, ["235px", "252px", "274px", "295px"], "the reference's 280, 300, 326 and 351, scaled by 0.84; 295px at a 1900px window");
  const hook = src("components/useSidebarWidth.js");
  assert.match(hook, /parseFloat\(getComputedStyle\(workspace\)\.getPropertyValue\("--sidebar-w"\)\)/, "the reason for the rule above");
});
