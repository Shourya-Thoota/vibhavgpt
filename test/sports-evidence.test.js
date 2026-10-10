import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config.js";
import { searchWeb } from "../src/search/service.js";
import { selectScheduledSportsSources, selectSupportedSportsSources, validateSportsEvidence } from "../src/search/sports-evidence.js";

const source = { title: "Laporan pertandingan", url: "https://www.antaranews.com/bola/123",
  content: "Pada 8 September 2026, pertandingan Tim A melawan Tim B berakhir 2-1. Statistik lain: 9-4." };
const decision = { index: 0, kind: "result_report", relevant: true, status: "final",
  eventDate: "2026-09-08", dateEvidence: "8 September 2026",
  evidence: ["Pada 8 September 2026, pertandingan Tim A melawan Tim B berakhir 2-1."] };

test("evidence accepts exact non-English excerpts and excludes unrelated article content", () => {
  const result = selectSupportedSportsSources([source], { sources: [decision] }, { now: new Date("2026-09-08T12:00:00Z") });
  assert.equal(result.length, 1);
  assert.ok(result[0].content.endsWith(decision.evidence[0]));
  assert.doesNotMatch(result[0].content, /9-4/);
});

test("publication-date URL cannot redate an undated historical highlights clip", () => {
  const article = { title: "Flamengo news", url: "https://ge.globo.com/noticia/2026/08/23/report.ghtml",
    content: "23/08/2026. Flamengo 0 x 3 Palmeiras | Melhores momentos | 17ª rodada | Brasileirão 2026." };
  const verdict = { ...decision, eventDate: "2026-08-23", dateEvidence: "2026/08/23",
    evidence: ["Flamengo 0 x 3 Palmeiras | Melhores momentos | 17ª rodada | Brasileirão 2026."] };
  assert.deepEqual(selectSupportedSportsSources([article], { sources: [verdict] }, { now: new Date("2026-09-08") }), []);
});

test("scoreboard dates split across a season header and result row are grounded in the original row", () => {
  const table = { title: "Liverpool 2026 Results", url: "https://www.espn.com/soccer/team/results/_/id/364/liverpool",
    content: "| Fri, Sep 4 | Ipswich Town | 0 - 2 | Liverpool | FT | English Premier League |" };
  const verdict = { ...decision, eventDate: "2026-09-04", dateEvidence: "Liverpool 2026 Results; Fri, Sep 4",
    evidence: [table.content] };
  assert.equal(selectSupportedSportsSources([table], { sources: [verdict] }, { now: new Date("2026-09-08") }).length, 1);
});

test("old results, fabricated recent dates and future fixtures cannot pass a latest-result query", () => {
  const old = { ...source, url: "https://ge.globo.com/jogo/25-05-2025/a-b.ghtml",
    content: "Tim A 2-1 Tim B. Final. 25-05-2025." };
  const verdict = { ...decision, eventDate: "2025-05-25", dateEvidence: "25-05-2025", evidence: [old.content] };
  const now = new Date("2026-09-08T12:00:00Z");
  assert.deepEqual(selectSupportedSportsSources([old], { sources: [verdict] }, { query: "latest score", now }), []);
  assert.deepEqual(selectSupportedSportsSources([old], { sources: [{ ...verdict, eventDate: "2026-09-08" }] }, { now }), []);
  assert.equal(selectSupportedSportsSources([old], { sources: [verdict] }, { query: "score on May 25 2025", now }).length, 1);
  assert.deepEqual(selectSupportedSportsSources([source], { sources: [decision] }, { now: new Date("2026-09-07") }), []);
});

test("future scheduled events are surfaced separately from completed-result evidence", () => {
  const fixture = {
    title: "NFL Week 1 schedule — Thursday, September 10, 2026",
    url: "https://www.nfl.com/schedules/2026/REG1/",
    content: "The season opener is scheduled for September 10, 2026 at 8:20 PM ET. The game has not started.",
  };
  const verdict = { sources: [{ index: 0, kind: "scoreboard", relevant: true, status: "scheduled", eventDate: "2026-09-10", dateEvidence: "September 10, 2026", evidence: [fixture.content] }] };
  const scheduled = selectScheduledSportsSources([fixture], verdict, { now: new Date("2026-09-09T12:00:00Z") });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].evidence.status, "scheduled");
  assert.deepEqual(selectSupportedSportsSources([fixture], verdict, { query: "NFL Week 1 results", now: new Date("2026-09-09T12:00:00Z") }), []);
});

test("same-day scheduled events with a kickoff time are surfaced as not-yet-played", () => {
  const fixture = {
    title: "NFL Week 1 schedule — Wednesday, September 9, 2026",
    url: "https://www.nfl.com/schedules/2026/REG1/",
    content: "The season opener is scheduled for September 9, 2026 at 8:20 PM ET. The game has not started.",
  };
  const verdict = { sources: [{ index: 0, kind: "scoreboard", relevant: true, status: "scheduled", eventDate: "2026-09-09", dateEvidence: "September 9, 2026", evidence: [fixture.content] }] };
  const scheduled = selectScheduledSportsSources([fixture], verdict, { now: new Date("2026-09-09T12:00:00Z") });
  assert.equal(scheduled.length, 1);
});

test("a completed Serie A opener is accepted when the source proves the dated score", () => {
  const result = {
    title: "Inter 4-1 Monza — Serie A 2026-27 opening match report",
    url: "https://www.legaseriea.it/en/match/2026-08-22/inter-monza",
    content: "On 22 August 2026, Inter Milan beat Monza 4-1 in the first Serie A match of the 2026-27 season. Final.",
  };
  const verdict = { sources: [{ index: 0, kind: "result_report", relevant: true, status: "final", eventDate: "2026-08-22", dateEvidence: "22 August 2026", evidence: [result.content] }] };
  const accepted = selectSupportedSportsSources([result], verdict, { query: "Serie A 2026-27 opening match first game result", now: new Date("2026-09-09T12:00:00Z") });
  assert.equal(accepted.length, 1);
  assert.match(accepted[0].content, /Inter Milan beat Monza 4-1/i);
});

test("missing, duplicate, invented, translated, speculative and undated verdicts fail closed", () => {
  for (const sources of [[], [decision, decision], [{ ...decision, kind: "preview" }],
    [{ ...decision, status: "unknown" }], [{ ...decision, relevant: false }],
    [{ ...decision, evidence: ["Team A won 2-1 on September 8, 2026."] }],
    [{ ...decision, evidence: ["invented final score 3-0"] }]]) {
    assert.deepEqual(selectSupportedSportsSources([source], { sources }), []);
  }
});

test("classifier receives query, clock and actual content; unavailable/malformed output fails closed", async () => {
  const now = new Date("2026-09-08T12:00:00Z");
  let classifierOptions;
  const result = await validateSportsEvidence("Tim A vs Tim B final score today", [source], {
    now, callModel: async (_model, messages, _tools, options) => {
      classifierOptions = options;
      const input = JSON.parse(messages[1].content);
      assert.equal(input.nowUtc, now.toISOString());
      assert.equal(input.sources[0].content, source.content);
      assert.match(messages[0].content, /preview quoting a real past head-to-head score/i);
      return { data: { choices: [{ message: { content: JSON.stringify({ sources: [decision] }) } }] } };
    },
  });
  assert.equal(result.length, 1);
  assert.equal(classifierOptions.maxTokens, 1_400);
  assert.equal(classifierOptions.reasoning, false);
  assert.equal(classifierOptions.timeoutMs, 15_000);
  for (const content of ["not json", '{"sources":[]}']) {
    assert.deepEqual(await validateSportsEvidence("score", [source], {
      callModel: async () => ({ data: { choices: [{ message: { content } }] } }),
    }), []);
  }
  assert.deepEqual(await validateSportsEvidence("score", [source], {
    callModel: async () => { throw new Error("unavailable"); },
  }), []);
});

test("unrecognized teams never cause unrestricted retrieval; trusted previews require evidence too", async () => {
  const previous = config.searchApiKey;
  config.searchApiKey = "test-only";
  try {
    let checked = false;
    const result = await searchWeb("Real Madrid vs Inter Milan current match final score", {
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        assert.ok(request.include_domains.includes("uefa.com"));
        assert.ok(request.include_domains.includes("espn.com"));
        assert.equal(request.include_raw_content, "text");
        assert.equal(request.include_answer, false);
        assert.equal(request.time_range, undefined);
        return Response.json({ answer: "Unchecked prediction", results: [
          { title: "Prediksi Skor", url: "https://unknown.example/bola", content: "2-1" },
          { title: "Result", url: "https://uefa.com.evil.example/match", content: "2-1" },
          { title: "Jadwal", url: "https://www.espn.com/bola/preview", content: "Forecast 2-1", raw_content: "Historical meeting finished 2-1" },
        ] });
      },
      validateSports: async (query, candidates) => {
        checked = true;
        assert.match(query, /Real Madrid vs Inter/);
        assert.equal(candidates.length, 1);
        assert.match(candidates[0].content, /Historical meeting/);
        return []; // A trusted hostname is insufficient to accept this preview.
      },
    });
    assert.equal(checked, true);
    assert.deepEqual(result, { answer: null, results: [] });
  } finally { config.searchApiKey = previous; }
});
