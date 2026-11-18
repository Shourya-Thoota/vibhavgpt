// Shared context across tiers: the saved conversation is fitted into each request by one function, whatever model answers. These tests cover
// what happens when a long conversation no longer fits: later corrections must survive, assistant text must not read as the user's own
// facts, and the request must record which saved messages were abridged. No network is used: the abridged context is built locally.
import test from "node:test";
import assert from "node:assert/strict";
import { fitConversationContext } from "../src/chat/context-window.js";

const filler = (i) => `Turn ${i}: let's keep planning the trip itinerary with some more detail about museums, cafes and train times. `.repeat(6);
function longConversation({ correctionAt = 40, total = 120 } = {}) {
  const history = [];
  for (let i = 0; i < total; i += 1) {
    let user = filler(i);
    if (i === 1) user = "My favourite colour is teal and I always want answers in metric units.";
    if (i === correctionAt) user = "Correction: my favourite colour is actually amber, not teal.";
    history.push({ id: `u${i}`, role: "user", content: user });
    history.push({ id: `a${i}`, role: "assistant", content: i === 5 ? "I think you probably live in Paris." : `Noted for turn ${i}. ${filler(i).slice(0, 200)}` });
  }
  return history;
}
const fit = (history, maxInputTokens = 4000) => fitConversationContext({
  systemMessages: [{ role: "system", content: "You are VibhavGPT." }],
  history,
  currentMessage: { role: "user", content: "What is my favourite colour?" },
  maxInputTokens,
});
const allText = (result) => result.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

test("a later correction survives compaction, even when it is far back in a long conversation", () => {
  const result = fit(longConversation());
  assert.equal(result.ok, true);
  assert.equal(result.historySummarized, true, "this conversation had to be abridged");
  const text = allText(result);
  assert.match(text, /amber/, "the correction is kept");
  const teal = text.indexOf("teal"); const amber = text.lastIndexOf("amber");
  assert.ok(teal === -1 || amber > teal, "if the old value appears, the correction comes after it");
});

test("explicit constraints the user stated early are kept", () => {
  assert.match(allText(fit(longConversation())), /metric units/);
});

test("the abridged part labels earlier assistant text as possibly outdated, never as the user's own words", () => {
  const text = allText(fit(longConversation({ total: 60 })));
  const line = text.split("\n").find((l) => /probably live in Paris/.test(l));
  if (line) assert.doesNotMatch(line, /^User:/, "assistant speculation is not presented as the user's statement");
  assert.match(text, /later messages and corrections take precedence/i);
});

test("the request records which saved messages were abridged (provenance), without their content", () => {
  const history = longConversation();
  const result = fit(history);
  assert.ok(result.summaryProvenance, "provenance is returned");
  const { version, omittedMessageIds, includedMessageIds } = result.summaryProvenance;
  assert.equal(typeof version, "string");
  assert.ok(omittedMessageIds.length > 0 && includedMessageIds.length > 0);
  const known = new Set(history.map((m) => m.id));
  assert.ok([...omittedMessageIds, ...includedMessageIds].every((id) => known.has(id)), "ids point at real saved messages");
  assert.ok(includedMessageIds.every((id) => omittedMessageIds.includes(id)), "only abridged messages are listed as included in the extract");
  assert.ok(omittedMessageIds.includes("u40"), "the correction's message is among the abridged ones");
  assert.ok(includedMessageIds.includes("u40"), "and it made it into the extract");
  assert.doesNotMatch(JSON.stringify(result.summaryProvenance), /amber|teal|Paris/, "provenance holds ids only, no text");
});

test("deleting or editing a saved message changes the next request: the extract is rebuilt from what is saved now, never cached", () => {
  const history = longConversation();
  const edited = history.map((m) => (m.id === "u40" ? { ...m, content: "Correction: my favourite colour is actually violet." } : m));
  assert.match(allText(fit(edited)), /violet/);
  assert.doesNotMatch(allText(fit(edited)), /amber/, "the old correction is gone after the edit");
  const deleted = history.filter((m) => m.id !== "u40");
  assert.doesNotMatch(allText(fit(deleted)), /amber/, "a deleted message is not brought back");
});

test("the same saved conversation fits a smaller budget and still keeps the critical facts", () => {
  const small = fit(longConversation(), 2500);
  assert.equal(small.ok, true);
  assert.match(allText(small), /amber/);
  assert.ok(small.estimatedTokens <= 2500);
});
