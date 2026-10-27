import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The corrected sidebar: the previous structure (Chat/Memory/Plan, then a Resources
// section, then the history in its previous order), three links instead of five, no
// group at the bottom, and the accessibility and scrolling fixes kept.
//
// Two kinds of check, labelled: rendered markup (the real Sidebar through
// react-dom/server) and CSS or source text. WHAT THIS DOES NOT PROVE: nothing here
// lays anything out, scrolls, hovers or focuses. How tall the history is, which
// element scrolls, and the rail tooltip's focus and hover behaviour were measured in a
// real browser against the real component and stylesheets (see the change notes); a
// future regression there needs that kind of check, not these.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

async function loadSidebar() {
  const require = createRequire(new URL("../frontend/package.json", import.meta.url));
  const esbuild = require("esbuild");
  const result = await esbuild.build({
    stdin: {
      contents: `import { renderToStaticMarkup } from "react-dom/server";
        import Sidebar from "./components/Sidebar.jsx";
        const noop = () => {};
        export const render = (props) => renderToStaticMarkup(<Sidebar api={async () => ({ conversations: [], groups: [] })} user={{ name: "Ada Learner", email: "ada@example.com" }}
          appearance={{}} rail={false} sidebarOpen={false} setSidebarOpen={noop} setCollapsed={noop} brand={<span>VibhavGPT</span>} tierKey="free" tierLabel="Free"
          page="chat" go={noop} newChat={noop} newChatInGroup={noop} openConversation={noop} onOpenImageSession={noop} onOpenWritingTools={noop} onSignOut={noop} {...props} />);`,
      resolveDir: new URL("../frontend/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      loader: "jsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", loader: { ".css": "empty" }, logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  });
  const dir = mkdtempSync(join(tmpdir(), "sidebar-structure-"));
  try {
    const file = join(dir, "sidebar.cjs");
    writeFileSync(file, result.outputFiles[0].text);
    return createRequire(import.meta.url)(file).render;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const render = await loadSidebar();

const styles = read("frontend/src/styles.css");
const planetary = read("frontend/src/planetary.css");
const mobile = read("frontend/src/mobile.css");
const rule = (css, selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} has a rule`);
  return css.slice(start, css.indexOf("}", start) + 1);
};

// --- Order (rendered markup) --------------------------------------------------

test("rendered: the history keeps its previous order, Projects, Folders, then the main list", () => {
  for (const [variant, last] of [["chat", "Recent chats"], ["study", "Study sessions"]]) {
    const html = render({ variant });
    const heads = [...html.matchAll(/<div class="library__head"><span>([^<]*)<\/span>/g)].map((match) => match[1]);
    assert.deepEqual(heads, ["Projects", "Folders", last], `${variant}: section order`);
  }
});

test("rendered: the chat column is head, New chat, Chat/Memory/Plan, Resources, history, foot", () => {
  const html = render({ variant: "chat" });
  const at = (needle) => { const index = html.indexOf(needle); assert.ok(index >= 0, `${needle} is present`); return index; };
  const order = [at('class="sidebar__head"'), at('class="sidebar__new"'), at('href="/app/memory"'), at('aria-label="Resources"'), at('class="conversation-history'), at('class="sidebar__foot"')];
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in the previous order, with Resources above the history");
});

test("rendered: Image keeps its simple session list, with no Projects or Folders", () => {
  const html = render({ variant: "image" });
  assert.equal(html.includes("library__head"), false);
  assert.match(html, /aria-label="Image sessions"/);
});

test("rendered and source: there is no bottom group and no More disclosure, in markup or in CSS", () => {
  for (const variant of ["chat", "study", "image"]) {
    for (const rail of [false, true]) {
      const html = render({ variant, rail });
      assert.equal(/sidebar__more|aria-label="Apps and links"|aria-haspopup="menu"[^>]*>More\b|>More</.test(html), false, `${variant}, rail ${rail}: no bottom group, no More`);
    }
  }
  for (const css of [styles, planetary, mobile]) assert.doesNotMatch(css, /sidebar__more/);
  const sidebar = read("frontend/src/components/Sidebar.jsx");
  assert.doesNotMatch(sidebar, /sidebar__more|SECONDARY_LINKS|More\b.*(disclosure|menu)/);
});

// --- The library's behaviour is untouched (source text) ------------------------

test("source: the library's order, grouping, saved state and actions are the code they were before", () => {
  const source = read("frontend/src/components/ConversationLibrary.jsx");
  for (const piece of [
    'const openKey = (mode) => `vibhavgpt-groups-open:${mode}`;',
    "const known = new Set(groups.map((group) => group.id));",
    "if (conversation.groupId && known.has(conversation.groupId)) {",
    "writeOpen(productMode, next);",
    'api(`/api/chat/groups?mode=${productMode}`).catch(() => ({ groups: [] }))',
    'await api(`/api/chat/conversations/${conversation.id}`, { method: "DELETE" });',
    "if (activeId === conversation.id) onNew();",
    "const startRename =", "const startMove =", "async function removeGroup(",
  ]) assert.ok(source.includes(piece), piece);
  assert.equal(source.split("{chatRows(unfiled)}").length - 1, 1, "the main list is still rendered once, from the same array");
  const render_ = source.slice(source.indexOf('<section className="conversation-history library"'));
  const order = ["<span>Projects</span>", "<span>Folders</span>", "{heading}</span>"].map((needle) => render_.indexOf(needle));
  assert.ok(order.every((index) => index > 0) && order[0] < order[1] && order[1] < order[2], "Projects, then Folders, then the main list");
});

// --- Rail names and the tooltip ------------------------------------------------

test("rendered: in the rail every control has an explicit name and the same tooltip text, with no native title", () => {
  const chat = render({ variant: "chat", rail: true });
  for (const name of ["New chat", "Chat", "Memory", "Plan", "Apps", "Sources", "Merch Store", "Account menu, Ada Learner"]) {
    assert.ok(chat.includes(`aria-label="${name}" data-rail-label="${name}"`), `${name}: named and tooltipped`);
  }
  assert.equal(chat.includes('title="New chat"'), false, "no native title doubling the tooltip");
  const study = render({ variant: "study", rail: true });
  assert.ok(study.includes('aria-label="Writing Tools" data-rail-label="Writing Tools"'));
  assert.ok(study.includes('aria-label="New study session" data-rail-label="New study session"'));
  // Every anchor and button in the rail that carries no visible text has an aria-label.
  const unnamed = [...chat.matchAll(/<(a|button) ([^>]*)>([\s\S]*?)<\/\1>/g)].filter(([, , attributes, inner]) => {
    const text = inner.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim();
    return !text && !/aria-label="[^"]+"/.test(attributes);
  });
  assert.deepEqual(unnamed.map((match) => match[2].slice(0, 60)), [], "no unnamed icon-only control");
});

test("rendered: expanded, those controls keep their visible text and gain no extra names; there is no tooltip", () => {
  const html = render({ variant: "chat", rail: false });
  assert.ok(html.includes('title="New chat"'));
  assert.equal(html.includes("data-rail-label"), false);
  assert.equal(html.includes("sidebar__tip"), false);
  assert.equal(html.includes('aria-label="Account menu'), false);
});

test("source: the rail tooltip is one label fixed to the window, shown for hover and focus, dismissed by Escape", () => {
  const sidebar = read("frontend/src/components/Sidebar.jsx");
  for (const piece of ["onMouseOver={showTip}", "onFocus={showTip}", "onBlur={() => setTip(null)}", "onMouseLeave={() => setTip(null)}", 'event.key === "Escape"']) assert.ok(sidebar.includes(piece), piece);
  assert.match(sidebar, /<span className="sidebar__tip" aria-hidden="true"/, "decorative: the control already has its name");
  assert.match(sidebar, /rail \? event\.target\.closest\?\.\("\[data-rail-label\]"\) : null/, "only in the rail");
  const tip = rule(styles, ".sidebar__tip");
  assert.match(tip, /position: fixed;/, "fixed, so the rail's own clipping cannot cut it off");
  assert.match(tip, /pointer-events: none;/);
  const keyframes = styles.match(/@keyframes sidebar-tip-in \{([^}]*\})\s*\}/)?.[1] ?? "";
  assert.deepEqual([...keyframes.matchAll(/([a-z-]+):/g)].map((match) => match[1]), ["opacity"], "fades only");
  assert.match(styles, /@media \(prefers-reduced-motion: no-preference\) \{\s*\.sidebar__tip \{ animation: sidebar-tip-in/, "and only when motion is allowed");
});

// --- The Resources section's CSS (source text) ---------------------------------

test("css: the Resources heading keeps its previous style, and its links are the ordinary stacked sidebar links", () => {
  const label = rule(styles, ".sidebar__apps-label");
  for (const piece of ["display: flex;", "align-items: center;", "min-height: 26px;", "padding: 0 11px 3px;", "color: var(--color-muted);", "font-size: 0.74rem;", "font-weight: 600;"]) assert.ok(label.includes(piece), piece);
  assert.match(rule(styles, ".sidebar__link"), /min-height: 40px;/);
  assert.match(planetary, /\.sidebar__link \{ border-radius: var\(--radius-pill\); min-height: 42px; \}/, "the previous 42px links on desktop");
  assert.match(mobile, /\.sidebar__link, \.conversation-item__open \{ min-height: 44px; \}/, "44px in the drawer");
  assert.match(styles, /\.sidebar__link:nth-child\(1\) \{ animation: lift-in 420ms/, "the previous entrance stagger is unchanged");
});

// --- Spacing, scrolling and the plan card (source text, plus one render) ---------

test("css: the desktop section gap is 14px, the drawer keeps 22px, and a short window keeps the pinned bar's 14px bottom padding", () => {
  assert.match(rule(planetary, ".sidebar"), /padding: 24px 14px 16px; gap: 14px;/);
  assert.match(planetary, /@media \(max-height: 720px\) \{\s*\.sidebar \{ padding-bottom: calc\(14px \+ var\(--safe-bottom\)\); \}/);
  assert.match(mobile, /\.sidebar \{[^}]*padding-bottom: calc\(14px \+ env\(safe-area-inset-bottom\)\);[^}]*gap: 22px;/, "safe areas are preserved");
});

test("css: the history may shrink, so the column never overflows at a normal height; the old 160px floor stays gone", () => {
  const history = rule(styles, ".conversation-history");
  assert.match(history, /flex: 1 1 0%;[\s\S]*min-height: 0;/);
  assert.doesNotMatch(history, /min-height: \d+px/);
  const block = styles.slice(styles.indexOf("@media (max-width: 760px), (max-height: 720px) {"));
  assert.match(block, /\.sidebar__foot > :first-child \{ margin-top: auto; \}/, "the footer settles at the bottom of a short column, as before");
});

test("rendered: the free plan shows as one quiet row, tier and plans link, with no card, no marketing copy and the same billing action", () => {
  const html = render({ variant: "chat" });
  assert.match(html, /<div class="plan-nudge"><span class="plan-nudge__tier">Free plan<\/span><button type="button" class="plan-nudge__action">See plans<\/button><\/div>/);
  for (const gone of ["plan-nudge__copy", "Get higher token", "You&#x27;re on Free", "You're on Free", "btn btn--secondary", "<strong>You"]) assert.equal(html.includes(gone), false, `no ${gone}`);
  assert.equal(html.split("See plans").length - 1, 1, "one plans link, not two");
  const source = read("frontend/src/components/Sidebar.jsx");
  assert.match(source, /<button type="button" className="plan-nudge__action" onClick=\{\(\) => go\("billing"\)\}>See plans<\/button>/, "it still goes to billing, through the same call");
  assert.match(source, /\{!rail && tierKey === "free" && \(/, "free accounts only, never in the rail");
  assert.equal(render({ variant: "chat", tierKey: "plus", tierLabel: "Plus" }).includes("plan-nudge"), false, "paid plans never had it");
  assert.equal(render({ variant: "chat", rail: true }).includes("plan-nudge"), false, "nor does the collapsed rail");
  assert.match(html, /<small>Free plan<\/small>/, "the account button keeps its own tier line, separate from the row");
});

test("css: the free-plan row has no card, no copy and no old styling anywhere; a pointer gets 36px, a phone or touch screen 44px", () => {
  const row = rule(styles, ".plan-nudge");
  assert.match(row, /display: flex;[\s\S]*justify-content: space-between;[\s\S]*min-height: 36px;/);
  assert.doesNotMatch(row, /background|border|box-shadow|border-radius/, "no card");
  const action = rule(styles, ".plan-nudge__action");
  assert.match(action, /min-height: 36px;/);
  assert.match(action, /color: var\(--accent\);/);
  assert.doesNotMatch(action, /transition: all/);
  assert.match(styles, /\.plan-nudge__action:focus-visible \{ outline: 2px solid var\(--color-focus\); outline-offset: -2px; \}/, "a visible keyboard ring");
  assert.match(styles, /@media \(max-width: 760px\), \(pointer: coarse\) \{\s*\.plan-nudge, \.plan-nudge__action \{ min-height: 44px; \}/, "44px on phones and touch screens");
  assert.doesNotMatch(styles, /plan-nudge__copy|\.plan-nudge strong|\.plan-nudge small|\.plan-nudge \.btn/, "the old card rules are gone");
  assert.doesNotMatch(planetary, /plan-nudge/, "the gradient card background is gone");
  assert.doesNotMatch(mobile, /plan-nudge/, "and so is the phone override for the old button");
  assert.match(rule(styles, ".sidebar__foot"), /gap: 4px;/, "the row sits close above the account button, which stays its own control");
});

test("css: project and folder rows are 36px for a mouse on a desktop-width window only; touch, the drawer and chat rows keep 44px", () => {
  const library = read("frontend/src/library.css");
  const block = /@media \(hover: hover\) and \(pointer: fine\) and \(min-width: 761px\) \{([^}]*\})\s*\}/.exec(library);
  assert.ok(block, "the rule sits in one media query: fine pointer, hover, and wider than the 760px drawer");
  assert.match(block[1], /\.library-group__row \.conversation-item__actions \{ height: 36px; \}/);
  assert.equal([...block[1].matchAll(/\{/g)].length, 1, "and it is the only rule in that query");
  // The base button stays 44px, so anything outside that query (touch, the drawer) is unchanged.
  assert.match(rule(styles, ".conversation-item__actions"), /width: 44px;\s*height: 44px;/);
  assert.match(rule(styles, ".conversation-item"), /min-height: 44px;/, "chat rows are untouched");
  assert.match(mobile, /\.sidebar__link, \.conversation-item__open \{ min-height: 44px; \}/);
  assert.doesNotMatch(library, /library-group__toggle \{[^}]*min-height: [0-2]\d?px/, "the row's own toggle was not shrunk below its 36px");
});

test("css: history spacing is tightened without reordering, hiding or shrinking anything", () => {
  const library = read("frontend/src/library.css");
  assert.match(library, /\.library__section \+ \.library__section \{ margin-top: var\(--space-xs\); \}/, "8px between sections, down from 16px");
  assert.match(library, /\.library__head \{[^}]*min-height: 26px;[^}]*padding: 0 var\(--space-2xs\) 0 11px;/, "headings keep their 26px height and text size");
  assert.match(library, /\.library__head \{[^}]*font-size: 0\.74rem;/);
  assert.doesNotMatch(rule(styles, ".conversation-history"), /padding-top/, "no padding above the list");
  assert.match(rule(styles, ".conversation-history__list"), /padding: 0 0 24px;/);
  assert.match(rule(styles, ".conversation-item"), /min-height: 44px;/, "chat rows keep their 44px height");
  assert.match(rule(planetary, ".sidebar"), /gap: 14px;/, "the 14px section gap is unchanged");
  const source = read("frontend/src/components/ConversationLibrary.jsx");
  const order = ["<span>Projects</span>", "<span>Folders</span>", "{heading}</span>"].map((needle) => source.indexOf(needle));
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], "Projects, Folders, then the main list, as before");
  assert.doesNotMatch(source, /setOpenIds\(new Set\(\)\)|defaultOpen|autoCollapse/, "no auto-collapse of the user's groups");
});
