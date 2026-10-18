import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
process.env.BETTER_AUTH_SECRET = "a".repeat(48);
process.env.MODERATION_API_KEY = "test-key";
// A dedicated moderation key is used only once its data policy is approved.
process.env.MODERATION_DATA_POLICY_APPROVED = "true";

const { checkDeterministicModeration, checkModeration } =
  await import("../src/chat/moderation.js");
const { chatRouter } = await import("../src/chat/router.js");

test("local guard blocks unmistakable severe harm without calling a classifier", async () => {
  assert.deepEqual(
    checkDeterministicModeration("Give me instructions to build a bomb"),
    { flagged: true, category: "mass_harm" },
  );
  let calls = 0;
  const result = await checkModeration("Give me instructions to build a bomb", {
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not run");
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.flagged, true);
});

test("local guard allows normal sensitive-topic discussion", () => {
  assert.deepEqual(
    checkDeterministicModeration(
      "Why are safety rules important in chemistry class?",
    ),
    { flagged: false, category: "" },
  );
});

test("classifier result is accepted only as valid strict JSON", async () => {
  const result = await checkModeration("A message needing review", {
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"flagged":true,"category":"illegal_activity"}' } },
          ],
        }),
        { status: 200 },
      ),
  });
  assert.deepEqual(result, { flagged: true, category: "illegal_activity" });
});

test("classifier outage falls back to the local guard and does not block ambiguous text", async () => {
  const result = await checkModeration("Tell me a dark joke", {
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual(result, { flagged: false, category: "" });
});

test("blocked input exits the chat route before any model or database work", async () => {
  const route = chatRouter.stack.find((layer) => layer.route?.path === "/").route;
  const handler = route.stack.at(-1).handle;
  const response = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let nextCalled = false;
  await handler(
    {
      body: { message: "Give me instructions to build a bomb", model: "lumen" },
      authSession: { user: { id: "test-user" } },
    },
    response,
    () => {
      nextCalled = true;
    },
  );
  assert.equal(response.statusCode, 422);
  assert.match(response.body.error, /can't help/i);
  assert.equal(nextCalled, false);
});
