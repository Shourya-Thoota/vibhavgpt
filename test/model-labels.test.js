import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createReplyLabels, IMAGE_REPLY_LABEL, NEUTRAL_REPLY_LABEL } from "../frontend/src/model-labels.js";

// Replies are labeled by the model that wrote them, never by the model
// selected now (frontend/src/model-labels.js and its use in App.jsx).
const app = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
// The picker's own list, read from App.jsx so the test follows any change.
const MODELS = [...app.slice(app.indexOf("const MODELS = ["), app.indexOf("];", app.indexOf("const MODELS = ["))).matchAll(/\{ value: "([a-z]+)", label: "([^"]+)", full: "([^"]+)"/g)]
  .map(([, value, label, full]) => ({ value, label, full }));
const { modelLabel, modelSwitches } = createReplyLabels(MODELS);

test("a reply's label comes from its own model, and anything unknown reads VibhavGPT", () => {
  assert.deepEqual(MODELS.map((entry) => entry.value), ["lumen", "nova", "nebula", "vesper"]);
  assert.deepEqual(["lumen", "nova", "nebula", "vesper"].map(modelLabel), ["VibhavGPT Lumen", "VibhavGPT Nova", "VibhavGPT Nebula", "VibhavGPT Vesper"]);
  assert.equal(modelLabel("image"), IMAGE_REPLY_LABEL);
  for (const key of [null, undefined, "", "gpt-4o", "spark", "study", "__proto__", "constructor"]) {
    assert.equal(modelLabel(key), NEUTRAL_REPLY_LABEL, `${String(key)} reads as VibhavGPT`);
  }
});

const turn = (role, model = null) => ({ role, content: "x", model });

test("a 'Now using' mark appears only where the replies' model changes", () => {
  assert.deepEqual([...modelSwitches([turn("user"), turn("assistant", "nova"), turn("user"), turn("assistant", "nova")])], [], "same model, no mark");
  assert.deepEqual([...modelSwitches([turn("user"), turn("assistant", "nova"), turn("user"), turn("assistant", "nebula")])], [[2, "Nebula"]], "above the message that started the Nebula reply");
  assert.deepEqual([...modelSwitches([turn("user"), turn("assistant", "nova"), turn("user"), turn("assistant", "nebula"), turn("user"), turn("assistant", "nova")])], [[2, "Nebula"], [4, "Nova"]]);
  assert.deepEqual([...modelSwitches([turn("user"), turn("assistant"), turn("user"), turn("assistant", "nebula")])], [], "an old reply with no model can't mark a switch");
  assert.deepEqual([...modelSwitches([turn("user"), turn("assistant", "nova"), turn("user"), turn("assistant", "image"), turn("user"), turn("assistant", "nova")])], [], "an image reply neither marks nor resets");
  assert.deepEqual([...modelSwitches([turn("user"), turn("assistant", "nova"), turn("user"), turn("assistant", "gpt-4o"), turn("user"), turn("assistant", "nebula")])], [[4, "Nebula"]], "unknown keys are skipped");
  assert.deepEqual([...modelSwitches([turn("assistant", "nova"), turn("assistant", "nebula")])], [[1, "Nebula"]], "with no user message before it, the mark sits on the reply");
  assert.deepEqual([...modelSwitches([])], []);
});

test("the chat labels saved, reloaded and live replies by their own model", () => {
  assert.match(app, /const \{ modelLabel, modelSwitches \} = createReplyLabels\(MODELS\);/, "one label helper, from the picker's models");
  assert.match(app, /thoughtSeconds: message\.thoughtSeconds \?\? null,\s*model: message\.model \?\? null,/, "a reloaded reply keeps its stored model");
  assert.match(app, /model: reply\.modelKey \?\? null, fresh: !streamedAny,/, "a new reply keeps the model the server saved");
  assert.match(app, /\{studyMode \? "VibhavGPT" : modelLabel\(message\.model\)\}/, "saved replies use their stored label; Study stays VibhavGPT");
  assert.doesNotMatch(app, /message\.model \?\? modelInfo\.full/, "a saved reply never falls back to the selected model");
  assert.match(app, /setStreamingModel\(sentModel\);\s*setBusy\(true\);/, "the pending reply remembers the model it was sent to");
  assert.match(app, /\{studyMode \? "VibhavGPT" : modelLabel\(streamingModel \?\? sentModel\)\}/, "the live byline uses that model");
});

test("the 'Now using' mark is worked out per render, never stored, and switching stays blocked while busy", () => {
  assert.match(app, /const replySwitches = useMemo\(\(\) => modelSwitches\(messages\), \[messages\]\);/);
  assert.match(app, /\{!studyMode && replySwitches\.has\(index\) && \(\s*<div className="model-switch" role="separator" aria-label=\{`Now using \$\{replySwitches\.get\(index\)\}`\}>/);
  assert.doesNotMatch(app, /replySwitches[^;\n]*api\(|api\([^)]*replySwitches/, "never sent to the server");
  assert.match(app, /async function changeModel\(nextModel\) \{\s*if \(modelSaving \|\| busyRef\.current \|\| nextModel === model\) return;/, "no switching while a reply streams");
  assert.match(app, /if \(conversationId\) \{\s*await api\(`\/api\/chat\/conversations\/\$\{conversationId\}`, \{\s*method: "PATCH",\s*body: JSON\.stringify\(\{ model: nextModel \}\),/, "a switch keeps the conversation");
  assert.match(readFileSync(new URL("../frontend/src/styles.css", import.meta.url), "utf8"), /\.model-switch \{/);
});

test("an interrupted reply kept on screen is labeled by the model it was sent to", async () => {
  const { interruptedStreamMessage } = await import("../frontend/src/stream-recovery.js");
  assert.match(app, /const partial = interruptedStreamMessage\(visibleStream \|\| previousStream, streamingModel \?\? sentModel\);/, "the model key, not a display name");
  assert.doesNotMatch(app, /interruptedStreamMessage\([^)]*modelInfo\.full\)/);
  const partial = interruptedStreamMessage("Half an answer", "nova");
  assert.equal(modelLabel(partial.model), "VibhavGPT Nova");
  assert.equal(modelLabel(interruptedStreamMessage("Half an answer", "VibhavGPT Nova").model), NEUTRAL_REPLY_LABEL, "a display name would have read as plain VibhavGPT");
  assert.match(app, /model: reply\.modelKey \?\? null, fresh: !streamedAny,/, "saved replies still keep the server's stored key");
  assert.match(app, /\{studyMode \? "VibhavGPT" : modelLabel\(message\.model\)\}/);
});
