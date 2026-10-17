import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { CODING_NUDGE_COPY, shouldSuggestNebula } from "../frontend/src/coding-nudge.js";

test("small coding requests suggest Nebula on every other model", () => {
  assert.equal(CODING_NUDGE_COPY, "Nebula writes better code.");
  for (const model of ["lumen", "nova", "study", "vesper", "spark"]) {
    for (const prompt of ["Write a Python function to reverse a string", "Give me a small script to rename files", "Show a CSS snippet for a centered div", "can you give me the code for a small html pacman game", "Fix this short JavaScript snippet"]) {
      assert.equal(shouldSuggestNebula(prompt, model), true, `${model}: ${prompt}`);
    }
  }
});

test("Nebula and its legacy alias never receive the suggestion", () => {
  for (const model of ["nebula", "ultra"]) assert.equal(shouldSuggestNebula("Write a small Python script", model), false);
});

test("the Chat nudge uses the persistent model switch and remains dismissible", async () => {
  const source = await readFile(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /mode === "chat" && codingNudge/);
  assert.match(source, /disabled=\{busy \|\| modelSaving\} onClick=\{\(\) => changeModel\("nebula"\)\}>Switch to Nebula/);
  assert.match(source, /label="Dismiss model suggestion" onClick=\{\(\) => setCodingNudge\(false\)\}/);
});

test("large work, non-coding requests and unclear attachment scope do not trigger", () => {
  for (const prompt of ["Build a full-stack application in Python", "Write a small script for a complex deployment platform", "Create an entire HTML game with authentication and a database", "Explain what Python is", "Write a short poem about code", "Show me the weather", "Write Python code " + "with many requirements ".repeat(25), "", null]) {
    assert.equal(shouldSuggestNebula(prompt, "nova"), false, String(prompt));
  }
  assert.equal(shouldSuggestNebula("Write a small Python script", "nova", 1), false);
});
