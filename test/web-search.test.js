import assert from "node:assert/strict";
import test from "node:test";
import { buildConversationSearchPlan, buildCurrentInfoSearchQuery, buildSportsSearchQuery, currentInfoCategory, normalizeSearchSubject, requiresFreshSportsSearch, requiresFreshWebSearch, safeSportsFallback, scheduledSportsFallback, supportingSportsSource, verifySportsReply } from "../src/chat/web-search.js";

test("current sports score requests always force web search", () => {
  for (const query of [
    "What is the current NBA score?",
    "Did the Yankees win last night?",
    "Did Liverpool win their first 2 games in the Prem?",
    "Lakers vs. Celtics score today",
    "Show me today's sports scores",
    "What was the result of the football match?",
  ]) {
    assert.equal(requiresFreshSportsSearch(query), true, query);
  }
});

test("stable or non-sports questions do not force a sports search", () => {
  for (const query of [
    "Explain how basketball scoring works.",
    "Write a score for my short film.",
    "What is the capital of New York?",
  ]) {
    assert.equal(requiresFreshSportsSearch(query), false, query);
  }
});

test("current events are also forced to the web without a manual toggle", () => {
  assert.equal(requiresFreshWebSearch("What are the latest major headlines today?"), true);
  assert.equal(requiresFreshWebSearch("What is the current weather in Boston?"), true);
  assert.equal(requiresFreshWebSearch("Explain the history of basketball."), false);
});

test("current-info queries are categorized and rewritten for direct answers", () => {
  assert.equal(currentInfoCategory("What is the latest news today?"), "news");
  assert.equal(currentInfoCategory("What is the weather in Boston right now?"), "weather");
  assert.equal(currentInfoCategory("What is the current AAPL stock price?"), "market");
  assert.match(buildCurrentInfoSearchQuery("What is the current AAPL stock price?"), /timestamp and currency/i);
  assert.match(buildCurrentInfoSearchQuery("What is the weather in Boston right now?"), /official forecast/i);
});

test("sports search queries explicitly request a current result", () => {
  const query = buildSportsSearchQuery("Lakers vs Celtics score");
  assert.match(query, /completed match result and final score/i);
  assert.match(query, /exclude predictions/i);
});

test("opening Premier League questions expand informal wording into a result query", () => {
  const query = buildSportsSearchQuery("Did Liverpool win their first 2 games in the Prem?");
  assert.match(query, /Liverpool Premier League.*first 2 matches/i);
  assert.match(query, /20\d{2}-\d{2}/i);
  assert.match(query, /Requested team: Liverpool\./i);
  assert.match(query, /official league fixture or result pages only/i);
  assert.match(query, /Champions League, FA Cup/i);
});

test("a vague follow-up resolves against the prior topic and keeps its sports search intent", () => {
  const history = [
    { role: "user", content: "Did Liverpool win their first 2 games in the Prem?" },
    { role: "assistant", content: "I couldn't verify a reliable current result from the available web sources." },
  ];
  const plan = buildConversationSearchPlan("Check any web source you want", history);
  assert.equal(plan.isContinuation, true);
  assert.equal(plan.continuationNeedsSearch, true);
  assert.match(plan.subject, /Liverpool.*first 2 games.*Prem/i);
  assert.match(plan.query, /Liverpool Premier League.*first 2 matches/i);
  assert.match(plan.query, /Requested team: Liverpool\./i);
  assert.match(plan.query, /official league fixture or result pages only/i);
  assert.doesNotMatch(plan.query, /check any web source/i);
});

test("a sports score must preserve the number order from a search result", () => {
  const search = { results: [{ title: "Game final", url: "https://scores.example/game", content: "Yankees 7, Giants 0 on opening day." }] };
  assert.equal(supportingSportsSource("The Yankees won 7-0.", search)?.url, "https://scores.example/game");
  assert.equal(supportingSportsSource("The Yankees won 0-7.", search), null);
  assert.match(safeSportsFallback(), /couldn't verify/i);
});

test("a winner-only reply is not discarded just because it states no score", () => {
  const search = { results: [{ title: "Inter 2-1 Roma", url: "https://scores.example/inter-roma", content: "Inter beat Roma 2-1 at San Siro." }] };

  // The reported bug: "who won ...?" invites a winner, not a scoreline, and a
  // reply with no digits produced zero claims, which the old gate treated as
  // a verification failure and replaced with the couldn't-verify message.
  const winnerOnly = verifySportsReply("Inter won today's match against Roma.", search);
  assert.equal(winnerOnly.ok, true);
  assert.equal(winnerOnly.reason, "no-score-claim");
  assert.equal(winnerOnly.source, null);

  // A stated score still has to be corroborated, in the source's own order.
  assert.equal(verifySportsReply("Inter beat Roma 2-1.", search).ok, true);
  assert.equal(verifySportsReply("Inter beat Roma 2-1.", search).source?.url, "https://scores.example/inter-roma");
  assert.equal(verifySportsReply("Roma beat Inter 4-0.", search).ok, false);
  assert.equal(verifySportsReply("Roma beat Inter 4-0.", search).reason, "unsupported-score");

  // With nothing retrieved there is no grounding for naming a winner either.
  assert.equal(verifySportsReply("Inter won.", { results: [] }).ok, false);
  assert.equal(verifySportsReply("Inter won.", { results: [] }).reason, "no-results");
});

test("opening Serie A questions use a current-season opener query", () => {
  for (const question of [
    "Who won the first Serie A game of the season this season?",
    "Who won the first Serie A match this season?",
    "What was the result of the first game in Serie A this season?",
  ]) {
    const plan = buildConversationSearchPlan(question, []);
    assert.equal(plan.sports, true, question);
    assert.match(plan.query, /Serie A 2026-27 opening match first game result final score and winner/i, question);
  }
});

test("obvious search typos are normalized before intent and query construction", () => {
  const serie = buildConversationSearchPlan("who won the first game of the serirea this season", []);
  assert.equal(serie.sports, true);
  assert.match(serie.subject, /Serie A/i);
  assert.match(serie.query, /Serie A 2026-27 opening match/i);

  const prem = buildConversationSearchPlan("did Liverpol win the first two games in the premir league?", []);
  assert.equal(prem.sports, true);
  assert.match(prem.subject, /Liverpool.*Premier League/i);
  assert.match(prem.query, /Liverpool Premier League.*first 2 matches/i);

  const weather = buildConversationSearchPlan("what's the weahter in Boston today?", []);
  assert.equal(weather.current, true);
  assert.match(weather.query, /weather in Boston today/i);

  const market = buildConversationSearchPlan("what's the latest stcok price for AAPL?", []);
  assert.equal(market.current, true);
  assert.match(market.query, /stock price for AAPL/i);
  assert.equal(normalizeSearchSubject("recieve latest news"), "receive latest news");
});

function seededIndex(length, seed) {
  return (seed * 1103515245 + 12345 >>> 0) % length;
}

function transpose(value, seed) {
  const index = seededIndex(value.length - 1, seed);
  return `${value.slice(0, index)}${value[index + 1]}${value[index]}${value.slice(index + 2)}`;
}

function removeCharacter(value, seed) {
  const index = seededIndex(value.length, seed);
  return `${value.slice(0, index)}${value.slice(index + 1)}`;
}

function doubleCharacter(value, seed) {
  const index = seededIndex(value.length, seed);
  return `${value.slice(0, index)}${value[index]}${value.slice(index)}`;
}

function adjacentKey(value, seed) {
  const rightKey = { q: "w", w: "e", e: "r", r: "t", t: "y", y: "u", u: "i", i: "o", o: "p", p: "[", a: "s", s: "d", d: "f", f: "g", g: "h", h: "j", j: "k", k: "l", l: ";", z: "x", x: "c", c: "v", v: "b", b: "n", n: "m", m: "," };
  const indexes = [...value].map((character, index) => rightKey[character] ? index : -1).filter((index) => index >= 0);
  const index = indexes[seededIndex(indexes.length, seed)];
  return `${value.slice(0, index)}${rightKey[value[index]]}${value.slice(index + 1)}`;
}

test("fuzzy search normalization resolves a generated typo matrix across domains", () => {
  const matrix = [
    { canonical: "Serie A", base: "seriea", operation: transpose, seed: 7 },
    { canonical: "Premier League", base: "premierleague", operation: removeCharacter, seed: 12 },
    { canonical: "Bundesliga", base: "bundesliga", operation: doubleCharacter, seed: 4 },
    { canonical: "Liverpool", base: "liverpool", operation: adjacentKey, seed: 8 },
    { canonical: "Real Madrid", base: "realmadrid", operation: transpose, seed: 3 },
    { canonical: "weather", base: "weather", operation: transpose, seed: 2 },
    { canonical: "forecast", base: "forecast", operation: removeCharacter, seed: 5 },
    { canonical: "temperature", base: "temperature", operation: doubleCharacter, seed: 9 },
    { canonical: "stock", base: "stock", operation: adjacentKey, seed: 4 },
    { canonical: "Nasdaq", base: "nasdaq", operation: adjacentKey, seed: 2 },
  ];
  for (const item of matrix) {
    const typo = item.operation(item.base, item.seed);
    const normalized = normalizeSearchSubject(`please search ${typo} today`);
    assert.match(normalized, new RegExp(item.canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), `${item.canonical}: ${typo} -> ${normalized}`);
  }
});

test("scheduled sports fallback explains that NFL Week 1 has not happened yet", () => {
  const search = {
    scheduledSources: [{
      title: "NFL Week 1 schedule",
      url: "https://www.nfl.com/schedules/2026/REG1/",
      evidence: { status: "scheduled", eventDate: "2026-09-10", excerpts: ["The season opener is scheduled for September 10, 2026 at 8:20 PM ET."] },
    }],
  };
  const reply = scheduledSportsFallback(search, "What are the NFL Week 1 results?", new Date("2026-09-09T12:00:00Z"));
  assert.match(reply, /NFL Week 1 hasn't happened yet/i);
  assert.match(reply, /September 10, 2026 at 8:20 PM ET/i);
});

test("scheduled-event handling is model-agnostic for all branded tiers", () => {
  const search = {
    scheduledSources: [{
      title: "NFL Week 1 schedule",
      url: "https://www.nfl.com/schedules/2026/REG1/",
      evidence: { status: "scheduled", eventDate: "2026-09-10", excerpts: ["The season opener is scheduled for September 10, 2026 at 8:20 PM ET."] },
    }],
  };
  for (const model of ["lumen", "nova", "nebula"]) {
    const reply = scheduledSportsFallback(search, `NFL Week 1 winner (${model})`, new Date("2026-09-09T12:00:00Z"));
    assert.match(reply, /hasn't happened yet/i, model);
    assert.match(reply, /September 10, 2026 at 8:20 PM ET/i, model);
  }
});
