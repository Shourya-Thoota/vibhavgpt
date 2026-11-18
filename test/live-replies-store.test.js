// The page's record of replies still being written (frontend/src/live-replies.js): what the "reply in progress" indicator offers.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { backgroundReply, liveRepliesSnapshot, liveReplyForConversation, seedLiveReplies, trackLiveReply, untrackLiveReply, resetLiveRepliesForTest } from "../frontend/src/live-replies.js";

beforeEach(() => resetLiveRepliesForTest());

test("the indicator offers a running reply only when its chat is not the one on screen", () => {
  trackLiveReply("r1", { conversationId: "c1", local: true });
  assert.equal(backgroundReply(liveRepliesSnapshot(), { page: "chat", activeConversationId: "c1" }), null, "you are looking at it");
  assert.equal(backgroundReply(liveRepliesSnapshot(), { page: "chat", activeConversationId: "c2" })?.replyId, "r1", "another chat is open");
  assert.equal(backgroundReply(liveRepliesSnapshot(), { page: "settings", activeConversationId: "c1" })?.replyId, "r1", "another page is open");
  untrackLiveReply("r1");
  assert.equal(backgroundReply(liveRepliesSnapshot(), { page: "settings", activeConversationId: null }), null, "a finished reply is gone");
});

test("the server's list adds replies started before a reload and drops finished ones, but keeps one this page is reading", () => {
  trackLiveReply("reading", { conversationId: "c1", local: true, label: "Searching the web" });
  trackLiveReply("stale", { conversationId: "c9" });
  seedLiveReplies([{ replyId: "from-before-reload", conversationId: "c2", startedAt: "2026-11-14T10:00:00.000Z" }]);
  const ids = liveRepliesSnapshot().map((entry) => entry.replyId).sort();
  assert.deepEqual(ids, ["from-before-reload", "reading"]);
  assert.equal(liveReplyForConversation("c2").replyId, "from-before-reload");
  assert.equal(liveReplyForConversation("c1").label, "Searching the web");
  assert.equal(liveReplyForConversation(null), null);
});
