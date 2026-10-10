import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { STUDY_TAGLINES, STUDY_STARTERS } from "../frontend/src/product-modes.js";

test("production image policy permits app-created blob previews", () => {
  const caddy = readFileSync(new URL("../frontend/Caddyfile", import.meta.url), "utf8");
  assert.match(caddy, /img-src[^;]*\bblob:/);
  assert.match(caddy, /object-src 'none'/);
});

test("thinking pill has a light-theme surface and visible orb glow", () => {
  const css = readFileSync(new URL("../frontend/src/components/ui/thinking-tool.css", import.meta.url), "utf8");
  assert.match(css, /:root\[data-theme="light"\] \.thinking-tool__toggle/);
  assert.match(css, /:root\[data-theme="light"\] \.thinking-tool__orb/);
});

test("Study has five welcome alternatives and preserves the requested suggestion labels", () => {
  assert.equal(new Set(STUDY_TAGLINES).size, 5);
  assert.deepEqual(STUDY_STARTERS, ["Explain a topic", "Flashcards", "Quiz me", "Summary", "Study plan"]);
  const router = readFileSync(new URL("../src/chat/router.js", import.meta.url), "utf8");
  assert.match(router, /conversationMode === "study" \? "friendly"/);
});

test("voice is gone: no dictation, Live Comet call, or voice module in the app", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const app = read("../frontend/src/App.jsx");
  const image = read("../frontend/src/components/ImageWorkspace.jsx");
  assert.doesNotMatch(app, /LiveCometPanel|requestMicrophone|toggleVoiceInput|\/api\/voice|Call Comet|Live Comet|Voice dictations/);
  assert.doesNotMatch(image, /ImageVoiceInput|\/api\/voice/);
  for (const path of ["../frontend/src/components/LiveCometPanel.jsx", "../frontend/src/components/ImageVoiceInput.jsx", "../frontend/src/voice/liveComet.js", "../frontend/src/voice/microphone.js"]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, `${path} should be removed`);
  }
});
