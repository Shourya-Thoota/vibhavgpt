import assert from "node:assert/strict";
import test from "node:test";
import { buildActivitySummary } from "../src/chat/activity.js";

test("ordinary queries receive concise, query-aware labels without invented tools", () => {
  assert.deepEqual(buildActivitySummary({ query: "Compare these two options" }), ["Compared the options"]);
  assert.deepEqual(buildActivitySummary({ query: "What is the area of a triangle?" }), ["Reviewed your geometry problem"]);
  assert.deepEqual(buildActivitySummary({ query: "Calculate 14 percent of 80" }), ["Worked through the calculation"]);
  assert.deepEqual(buildActivitySummary({ query: "VibhavGPT settings question" }), ["Answered a VibhavGPT question"]);
});

test("activity labels disclose only actions represented by execution events", () => {
  assert.deepEqual(buildActivitySummary({ query: "Find the latest VibhavGPT pricing", actions: { productContext: true, memory: true, history: true, webSearch: true, currentSources: true } }), [
    "Reviewed VibhavGPT product information",
    "Reviewed saved memory",
    "Reviewed previous conversation context",
    "Searched the web",
    "Reviewed current sources",
    "Prepared response",
  ]);
  assert.deepEqual(buildActivitySummary({ query: "What is VibhavGPT?" }), ["Answered a VibhavGPT question"]);
});

test("file and generated-output actions are specific and non-duplicative", () => {
  assert.deepEqual(buildActivitySummary({ query: "Review my files", actions: { attachedDocuments: true, attachedImages: true, savedDocuments: true } }), [
    "Reviewed attached documents",
    "Reviewed the attached image",
    "Reviewed saved conversation documents",
    "Prepared response",
  ]);
  assert.deepEqual(buildActivitySummary({ query: "Make an image", actions: { imageGenerated: true } }), ["Created the requested image"]);
});
