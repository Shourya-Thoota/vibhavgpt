import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
const component = readFileSync(new URL("../frontend/src/components/ui/image-prompt-disclosure.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/src/components/ui/image-prompt-disclosure.css", import.meta.url), "utf8");

test("ImagePromptDisclosure component renders collapsed by default and displays prompt text only", () => {
  const code = component.replace(/^\s*\/\/.*$/gm, "");
  // Returns null when no prompt text is given
  assert.match(code, /if \(!text\) return null;/);
  // Collapsed by default
  assert.match(code, /const \[open, setOpen\] = React\.useState\(false\);/);
  // Button with Prompt used label and accessibility attributes
  assert.match(code, /<button[^>]*type="button"[^>]*className="image-prompt-disclosure__tag"[^>]*aria-expanded=\{open\}[^>]*aria-controls=\{panelId\}/);
  assert.match(code, /<span>Prompt used<\/span>/);
  // Panel only shown when open
  assert.match(code, /\{open && \(\s*<div id=\{panelId\} className="image-prompt-disclosure__panel"/);
  assert.match(code, /<p className="image-prompt-disclosure__text">\{text\}<\/p>/);
  // Zero vendor names in component code
  assert.doesNotMatch(component, /openai|dall-?e|anthropic|claude|gemini|stability|midjourney/i);
});

test("ImagePromptDisclosure styles support mobile touch targets, light/dark themes, and no zoom issues", () => {
  // Mobile 44px minimum touch target
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /min-width:\s*44px/);
  // Theme variables for light and dark support
  assert.match(css, /var\(--muted\)/);
  assert.match(css, /var\(--line\)/);
  assert.match(css, /var\(--ink-2/);
  // Keyboard accessible focus ring
  assert.match(css, /:focus-visible/);
  // No text inputs exist in disclosure, preventing iOS zoom
  assert.doesNotMatch(component, /<input|<textarea/);
});

test("App renders ImagePromptDisclosure after generated chat image attachments when imagePrompt exists", () => {
  // Check import exists in App.jsx
  assert.match(app, /import \{ ImagePromptDisclosure \} from "\.\/components\/ui\/image-prompt-disclosure\.jsx";/);

  // Check rendering logic in assistant turn
  const imageSnippet = app.indexOf('message.attachment.kind === "generated-image"');
  assert.ok(imageSnippet > 0, "found generated image attachment in App.jsx");

  assert.match(
    app,
    /\{message\.attachment\?\.kind === "generated-image" && Boolean\(message\.imagePrompt\) && \(\s*<ImagePromptDisclosure prompt=\{message\.imagePrompt\} \/>\s*\)\}/,
    "renders disclosure under generated image attachment when imagePrompt exists"
  );
});
