import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config.js";
import { searchOptionsFor, searchWeb } from "../src/search/service.js";
import { buildConversationSearchPlan } from "../src/chat/web-search.js";

test("sports use general retrieval for scoreboards; news retains recency filtering", () => {
  assert.deepEqual(searchOptionsFor("What is the live NBA score today?"), { topic: "general", searchDepth: "advanced" });
  assert.deepEqual(searchOptionsFor("Did the Lakers win their last game?"), { topic: "general", searchDepth: "advanced" });
  assert.deepEqual(searchOptionsFor("latest breaking news"), { topic: "news", timeRange: "day", searchDepth: "advanced" });
  assert.deepEqual(searchOptionsFor("Liverpool first 2 Premier League matches 2026-27 results"), { topic: "general", searchDepth: "advanced" });
  assert.deepEqual(searchOptionsFor("Explain basketball rules"), { searchDepth: "basic" });
});

test("current information keeps only authoritative, direct-answer sources", async () => {
  const originalKey = config.searchApiKey;
  config.searchApiKey = "test-key";
  let request;
  try {
    const result = await searchWeb("What is the current AAPL stock price? Current quote or market data.", {
      fetchImpl: async (_url, options) => {
        request = JSON.parse(options.body);
        return new Response(JSON.stringify({
          answer: "An unverified summary",
          results: [
            { title: "AAPL price target prediction", url: "https://example.com/aapl", content: "Speculation" },
            { title: "Apple Inc. (AAPL) Stock Price", url: "https://finance.yahoo.com/quote/AAPL", content: "Direct quote" },
            { title: "Apple Inc. (AAPL)", url: "https://finance.yahoo.com/quote/AAPL/history", content: "Not a quote" },
            { title: "AAPL stock discussion", url: "https://forum.example/aapl", content: "Opinion" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    assert.deepEqual(request.include_domains, ["nasdaq.com", "finance.yahoo.com", "marketwatch.com", "reuters.com"]);
    assert.deepEqual(result.results.map((item) => item.url), ["https://finance.yahoo.com/quote/AAPL"]);
    assert.equal(result.answer, null);
  } finally {
    config.searchApiKey = originalKey;
  }
});

test("search removes clearly stale season pages before they reach chat", async () => {
  const originalKey = config.searchApiKey;
  config.searchApiKey = "test-key";
  let request;
  try {
    const result = await searchWeb("live Premier League score today", {
      validateSports: async (_query, candidates) => candidates,
      fetchImpl: async (_url, options) => {
        request = JSON.parse(options.body);
        return new Response(JSON.stringify({
          answer: "A stale 2024-25 summary",
          results: [
            { title: "2024-25 standings", url: "https://stale.example", content: "Old season" },
            { title: "Lakers prediction and betting odds", url: "https://prediction.example", content: "Not a final result" },
            { title: "Liverpool Champions League result", url: "https://ucl.example", content: "A different competition" },
            { title: "Live game", url: "https://www.espn.com/current", content: "Current result" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    assert.equal(request.topic, "general");
    assert.equal(request.time_range, undefined);
    assert.equal(request.search_depth, "advanced");
    assert.ok(request.include_domains.includes("premierleague.com"));
    assert.deepEqual(result.results.map((item) => item.url), ["https://www.espn.com/current"]);
    assert.equal(result.answer, null);
  } finally {
    config.searchApiKey = originalKey;
  }
});

test("a switched-model vague follow-up sends the search provider the original sports subject, not the follow-up alone", async () => {
  const originalKey = config.searchApiKey;
  config.searchApiKey = "test-key";
  let request;
  try {
    const plan = buildConversationSearchPlan("Check any web source you want", [
      { role: "user", content: "Did Liverpool win their first 2 games in the Prem?" },
      { role: "assistant", content: "I couldn't verify a reliable current result." },
    ]);
    await searchWeb(plan.query, {
      fetchImpl: async (_url, options) => {
        request = JSON.parse(options.body);
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    assert.match(request.query, /Liverpool Premier League.*first 2 matches/i);
    assert.doesNotMatch(request.query, /Exclude|predictions|betting|Requested team/i);
    assert.doesNotMatch(request.query, /check any web source/i);
    assert.ok(request.include_domains.includes("premierleague.com"));
  } finally {
    config.searchApiKey = originalKey;
  }
});

test("opening-game and recent-team questions generate a team-scoped result query", () => {
  const opening = buildConversationSearchPlan("Did Liverpool win their first two Premier League games this season?");
  assert.match(opening.query, /Liverpool Premier League.*first 2 matches/i);
  assert.match(opening.query, /Requested team: Liverpool\./i);
  assert.match(opening.query, /Opening fixtures/i);

  const recent = buildConversationSearchPlan("Did the Yankees win their most recent completed game?");
  assert.match(recent.query, /Yankees latest completed game final score/i);
  assert.match(recent.query, /Requested team: Yankees\./i);
});

test("Serie A opener queries use advanced sports retrieval and Italian-league sources", async () => {
  const originalKey = config.searchApiKey;
  config.searchApiKey = "test-key";
  let request;
  try {
    await searchWeb("Serie A 2026-27 opening match first game result final score and winner. Official league results only.", {
      validateSports: async (_query, candidates) => candidates,
      fetchImpl: async (_url, options) => {
        request = JSON.parse(options.body);
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    assert.match(request.query, /Serie A 2026-27 opening match first game result/i);
    assert.equal(request.topic, "general");
    assert.equal(request.search_depth, "advanced");
    assert.ok(request.include_domains.includes("legaseriea.it"));
    assert.ok(request.include_domains.includes("gazzetta.it"));
  } finally {
    config.searchApiKey = originalKey;
  }
});

test("team-scoped sports retrieval drops unrelated result pages", async () => {
  const originalKey = config.searchApiKey;
  config.searchApiKey = "test-key";
  try {
    const result = await searchWeb("Yankees latest completed game final score. Requested team: Yankees.", {
      validateSports: async (_query, candidates) => candidates.filter((item) => item.url.endsWith("/yankees")),
      fetchImpl: async () => new Response(JSON.stringify({
        results: [
          { title: "Yankees September predictions", url: "https://www.espn.com/prediction", content: "Yankees might win" },
          { title: "Angels at Pirates final", url: "https://www.mlb.com/game/other", content: "Final score" },
          { title: "Yankees at Red Sox final", url: "https://www.mlb.com/game/yankees", content: "New York Yankees won 4-2" },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    assert.deepEqual(result.results.map((item) => item.url), ["https://www.mlb.com/game/yankees"]);
  } finally {
    config.searchApiKey = originalKey;
  }
});

test("sports result retrieval rejects international pronostics and preview domains", async () => {
  const originalKey = config.searchApiKey;
  config.searchApiKey = "test-key";
  try {
    const result = await searchWeb("Cagliari vs Lecce latest result final score", {
      validateSports: async (_query, candidates) => candidates,
      fetchImpl: async () => new Response(JSON.stringify({
        results: [
          { title: "Cagliari vs Lecce pronostics and betting tips", url: "https://www.football-pronostics.example/cagliari-lecce", content: "Predictions and odds" },
          { title: "Cagliari - Lecce match preview", url: "https://www.example.com/preview/cagliari-lecce", content: "Preview and probable lineups" },
          { title: "Cagliari 2-1 Lecce: Serie A match report", url: "https://www.reuters.com/sports/soccer/cagliari-lecce-result", content: "Final score and match report" },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    assert.deepEqual(result.results.map((item) => item.url), ["https://www.reuters.com/sports/soccer/cagliari-lecce-result"]);
  } finally {
    config.searchApiKey = originalKey;
  }
});
