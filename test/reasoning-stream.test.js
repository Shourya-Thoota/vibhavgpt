import test from "node:test";
import assert from "node:assert/strict";
import { providerTerms, providerTermsPattern } from "./provider-terms.js";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
const { createReasoningForwarder, createThinkingRelay } = await import("../src/chat/reasoning-stream.js");
const { vendorNamePattern } = await import("../src/memory/service.js");
const { liveStatusLabel, thoughtLabel, elapsedSeconds } = await import("../frontend/src/live-status.js");

const term = providerTerms[0];
const scrubbing = () => ({ pattern: vendorNamePattern(), maxTermLength: Math.max(...providerTerms.map((name) => name.length)) });

test("with no name list, thinking is forwarded as it arrives", () => {
  const sent = [];
  const forwarder = createReasoningForwarder((text) => sent.push(text));
  forwarder.push("Step one. ");
  forwarder.push("Step two.");
  assert.deepEqual(sent, ["Step one. ", "Step two."]);
  forwarder.flush();
  assert.deepEqual(sent, ["Step one. ", "Step two."]);
});

test("provider names are replaced before thinking leaves the server, even split across chunks", () => {
  assert.ok(term, "the test setup lists at least one provider name");
  for (const chunks of [
    [`I am not ${term}, I am VibhavGPT. `, "Now the answer."],
    [`Comparing with ${term.slice(0, 2)}`, `${term.slice(2)} for a moment. `, "Done thinking."],
    ["One letter at a time: ", ...`${term} again`.split("")],
  ]) {
    const sent = [];
    const forwarder = createReasoningForwarder((text) => sent.push(text), scrubbing());
    for (const chunk of chunks) {
      forwarder.push(chunk);
      // Nothing sent so far, even mid-stream, may contain the name.
      assert.doesNotMatch(sent.join(""), providerTermsPattern);
    }
    forwarder.flush();
    const shown = sent.join("");
    assert.doesNotMatch(shown, providerTermsPattern, shown);
    assert.match(shown, /the model/);
    assert.equal(shown.replace(/the model/g, ""), chunks.join("").replace(providerTermsPattern, "").replace(new RegExp(providerTermsPattern.source, "gi"), ""));
  }
});

test("held-back text is sent on flush, and reset starts a fresh trace", () => {
  const sent = [];
  const forwarder = createReasoningForwarder((text) => sent.push(text), scrubbing());
  forwarder.push("short");
  assert.deepEqual(sent, [], "the tail waits in case a name continues");
  forwarder.flush();
  assert.deepEqual(sent, ["short"]);
  forwarder.reset();
  forwarder.push("next try");
  forwarder.flush();
  assert.deepEqual(sent, ["short", "next try"]);
});

function relayHarness() {
  const deltas = [], statuses = [];
  let clock = 0;
  const relay = createThinkingRelay({
    onDelta: (delta) => deltas.push(delta),
    onStatus: (phase, details) => statuses.push({ phase, ...details }),
    ...scrubbing(),
    now: () => clock,
  });
  return { relay, deltas, statuses, at: (ms) => { clock = ms; } };
}

test("thoughtSeconds runs from the answering call's start to its first visible text", () => {
  const { relay, deltas, at } = relayHarness();
  at(0); relay.startCall();
  at(1_000); relay.reasoning(`Weighing what ${term} would do here, then answering.`);
  at(36_200); relay.visible();
  at(40_000); relay.endCall({ answered: true });
  assert.equal(relay.thoughtSeconds, 36);
  const shown = deltas.filter((delta) => delta.reasoning).map((delta) => delta.reasoning).join("");
  assert.doesNotMatch(shown, providerTermsPattern);
  assert.match(shown, /Weighing what the model would do here/);
});

test("a call that only requests a tool, or never thinks, sets no thoughtSeconds", () => {
  const { relay, at } = relayHarness();
  at(0); relay.startCall();
  at(2_000); relay.reasoning("I should search first.");
  at(3_000); relay.endCall({ answered: false });
  assert.equal(relay.thoughtSeconds, null, "a tool step is not the answer");
  at(10_000); relay.startCall();
  at(12_000); relay.visible();
  relay.endCall({ answered: true });
  assert.equal(relay.thoughtSeconds, null, "the answering call did not think");
});

test("thinking across tool steps is kept, with a blank line between calls", () => {
  const { relay, deltas, at } = relayHarness();
  at(0); relay.startCall();
  relay.reasoning("First I will look this up.");
  relay.endCall({ answered: false });
  at(5_000); relay.startCall();
  relay.reasoning("Now I can answer.");
  at(9_000); relay.visible();
  relay.endCall({ answered: true });
  assert.equal(deltas.map((delta) => delta.reasoning ?? "").join(""), "First I will look this up.\n\nNow I can answer.");
  assert.equal(relay.thoughtSeconds, 4);
});

test("a retry clears the shown thinking and reports the attempt", () => {
  const { relay, deltas, statuses, at } = relayHarness();
  at(0); relay.startCall();
  relay.reasoning("Thinking about the first try.");
  at(15_000); relay.retry({ attempt: 2, maxAttempts: 3 });
  assert.deepEqual(deltas.at(-1), { reasoningReset: true });
  assert.deepEqual(statuses, [{ phase: "retrying", attempt: 2, maxAttempts: 3 }]);
  at(16_000); relay.reasoning("Second try.");
  at(20_000); relay.visible();
  relay.endCall({ answered: true });
  assert.equal(relay.thoughtSeconds, 5, "measured from the retry, not the first try");
});

test("live status labels name only the stage that was reported", () => {
  assert.equal(liveStatusLabel({ phase: "attachments" }), "Processing attachments...");
  assert.equal(liveStatusLabel({ phase: "searching" }), "Searching the web...");
  assert.equal(liveStatusLabel({ phase: "thinking", seconds: 12.7 }), "Thinking... (12 s)");
  assert.equal(liveStatusLabel({ phase: "retrying", attempt: 2, maxAttempts: 3 }), "Provider was slow, trying again (attempt 2 of 3)");
  assert.equal(thoughtLabel(36), "Thought for 36 s");
  assert.equal(elapsedSeconds(1_000, 37_400), 36);
  for (const phase of ["attachments", "searching", "thinking", "retrying", "weather", "calculating", "writing", "saving"]) {
    const label = liveStatusLabel({ phase, attempt: 2, maxAttempts: 3, seconds: 3 });
    assert.doesNotMatch(label, /—/, "no em dashes in UI copy");
    assert.doesNotMatch(label, providerTermsPattern);
  }
});
