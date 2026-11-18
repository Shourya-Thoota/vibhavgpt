import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Dictation, as far as it can be tested without a person speaking. What is real here: the wording of every failure, the Brave
// decision (verified in a real Brave: start, audiostart, audioend, error "network", end, with the device online), and the privacy
// shape of the code. What is NOT tested here, and cannot be by a mock, is recognition itself: that needs a real browser, microphone
// and speech service.
globalThis.window = globalThis.window ?? globalThis;
const { describeDictationError, isBrave } = await import("../frontend/src/dictation.js");

test("'network' means offline only when the device is offline", () => {
  const online = describeDictationError("network", { online: true });
  const offline = describeDictationError("network", { online: false });
  assert.match(offline, /offline/i);
  assert.doesNotMatch(online, /offline|internet connection/i, "online with a network error is not blamed on the connection");
  assert.match(online, /speech service isn't available/);
  assert.notEqual(online, offline);
});

test("each failure has its own plain message, and a manual stop says nothing", () => {
  const codes = ["not-allowed", "service-not-allowed", "audio-capture", "no-speech", "network", "language-not-supported", "something-new"];
  const messages = codes.map((code) => describeDictationError(code));
  assert.equal(new Set(messages).size, codes.length, "every case reads differently");
  assert.match(describeDictationError("not-allowed"), /blocked/i, "permission denied");
  assert.match(describeDictationError("no-speech"), /No speech was heard/, "silence is told, not hidden");
  assert.match(describeDictationError("audio-capture"), /microphone/i);
  assert.equal(describeDictationError("aborted"), "", "stopping it yourself is not an error");
  assert.match(describeDictationError("not-allowed", { secure: false }), /secure \(HTTPS\)/, "an insecure page is named as the reason");
  for (const message of messages) assert.doesNotMatch(message, /Google|OpenAI|Gemini|Chrome/, "no provider names");
});

test("Brave is recognised, and the mic is not offered where it cannot work", () => {
  const original = globalThis.navigator;
  try {
    Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 Chrome/156", brave: { isBrave: async () => true } }, configurable: true });
    assert.equal(isBrave(), true);
    Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 Chrome/156" }, configurable: true });
    assert.equal(isBrave(), false, "other Chromium browsers are unaffected");
  } finally { Object.defineProperty(globalThis, "navigator", { value: original, configurable: true }); }
  const source = readFileSync(new URL("../frontend/src/dictation.js", import.meta.url), "utf8");
  assert.match(source, /if \(isBrave\(\)\) return null;/);
});

test("it stays on the device: no server request, no recording, no stored audio, and the mic has a Dictate tooltip", () => {
  const source = readFileSync(new URL("../frontend/src/dictation.js", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(source, /\/api\/|fetch\(|getUserMedia|MediaRecorder|localStorage|sessionStorage|console\./, "no upload, no capture of its own, no storage, no logging of transcripts");
  const app = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /title=\{dictation\.listening \? "Stop dictation" : "Dictate"\}/);
  assert.doesNotMatch(app, /accessKey|"Control\+Shift\+M"|ctrlKey && event\.key === "m"/, "no shortcut was added for it");
});
