import assert from "node:assert/strict";
import test from "node:test";
import { interpretSearchIntent, shouldInterpretSearchIntent, validateSearchIntent } from "../src/search/intent.js";
import { buildConversationSearchPlan } from "../src/chat/web-search.js";
import { callSearchIntentModel } from "../src/chat/providers.js";
import { config } from "../src/config.js";

test("search interpreter uses the configured lightweight model", async () => {
  const originalKey = config.providerKeys.primaryFree;
  config.providerKeys.primaryFree = "test-key";
  const originalModel = config.searchIntentModel;
  config.searchIntentModel = "fixture-search";
  let request;
  try {
    await callSearchIntentModel([{ role: "user", content: "Return JSON" }], {
      fetchImpl: async (_url, options) => {
        request = JSON.parse(options.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });
      },
    });
    assert.equal(request.model, config.searchIntentModel);
    assert.equal(request.max_tokens, 320);
    assert.equal(request.reasoning_effort, "low");
    assert.equal(request.include_reasoning, false);
    assert.deepEqual(request.response_format, { type: "json_object" });
  } finally {
    config.providerKeys.primaryFree = originalKey;
    config.searchIntentModel = originalModel;
  }
});

test("structured intent accepts a compound-error Champions League result", async () => {
  assert.equal(shouldInterpretSearchIntent("who won the champiosn leage game yesterday"), true);
  const intent = await interpretSearchIntent("who won the champiosn leage game yesterday", [], {
    callModel: async () => ({ data: { choices: [{ message: { content: JSON.stringify({
      needs_search: true,
      topic: "Champions League",
      query_type: "match_result",
      timeframe: "yesterday",
      entities: [],
      search_query: "Champions League match results yesterday",
    }) } }] } }),
  });
  assert.deepEqual(intent, {
    needs_search: true,
    topic: "Champions League",
    query_type: "match_result",
    timeframe: "yesterday",
    entities: [],
    search_query: "Champions League match results yesterday",
  });
  const plan = buildConversationSearchPlan(`${intent.topic} ${intent.query_type.replaceAll("_", " ")} ${intent.timeframe}`);
  assert.equal(plan.sports, true);
  assert.match(plan.query, /Champions League/i);
});

test("malformed interpreter output is rejected without affecting the deterministic path", async () => {
  assert.equal(validateSearchIntent({ topic: "", search_query: "" }), null);
  const result = await interpretSearchIntent("latest champiosn leage result", [], {
    callModel: async () => ({ data: { choices: [{ message: { content: "not json" } }] } }),
  });
  assert.equal(result, null);
});

test("structured interpretation handles multiple messy current-info examples", async () => {
  const cases = [
    ["what was the weahter in Buffallo today", "weather", "weather in Buffalo today"],
    ["latest nasdaq prcie after the fed meeting", "market_price", "latest Nasdaq price after the Fed meeting"],
    ["did liverpol win yesterdy in the premir leauge", "match_result", "Liverpool Premier League result yesterday"],
  ];
  for (const [message, queryType, query] of cases) {
    const intent = await interpretSearchIntent(message, [], {
      callModel: async () => ({ data: { choices: [{ message: { content: JSON.stringify({
        needs_search: true,
        topic: query.split(" ").slice(0, 2).join(" "),
        query_type: queryType,
        timeframe: "today",
        entities: [],
        search_query: query,
      }) } }] } }),
    });
    assert.equal(intent.search_query, query);
    assert.equal(intent.query_type, queryType);
  }
});
