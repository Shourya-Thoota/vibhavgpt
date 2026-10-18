import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The chat has no title row: the messages sit directly under the workspace
// tabs, and new chats start from the sidebar.
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("../frontend/src/App.jsx");

test("the chat opens straight onto its messages, with no title row or top new-chat button", () => {
  assert.doesNotMatch(app, /chat__header/);
  assert.doesNotMatch(app, /label="Start a new chat"/);
  assert.match(app, /<section className="chat" data-scrolled=\{scrolled\}>\s*<div\s+className="chat__scroll"/, "the message area is the chat's first child");
  for (const css of ["styles.css", "cosmos.css", "planetary.css"]) {
    assert.doesNotMatch(read(`../frontend/src/${css}`), /\.chat__header/, `${css} has no title row styles`);
  }
});

test("new chats still start from the sidebar", () => {
  assert.match(app, /<IconButton label=\{productMode === "study" \? "New study session" : "New chat"\} onClick=\{newChat\}>/);
  assert.match(app, /function newChat\(|const newChat = /);
});
