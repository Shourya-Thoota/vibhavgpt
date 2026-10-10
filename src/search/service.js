import { config } from "../config.js";
import { SPORTS_DOMAINS, validateSportsEvidence } from "./sports-evidence.js";

const MAX_RESULTS = 5;
const CURRENT_INFO = /\b(?:current|latest|live|today(?:'s)?|tonight(?:'s)?|now|right\s+now|recent|breaking|last\s+night|yesterday|last\s+(?:game|match|fixture)|this\s+(?:morning|afternoon|evening|week)|tomorrow)\b/i;
const NEWS_OR_SPORTS = /\b(?:news|headlines?|politics|election|sports?|scores?|game|match|nba|nfl|mlb|nhl|mls|epl|premier\s+league|serie\s+a|la\s+liga|bundesliga|ligue\s*1|eredivisie|soccer|football|basketball|baseball|hockey|cricket|tennis)\b/i;
const RESULT_INTENT = /\b(?:score|scores|result|results|final|did\s+.+?\s+win|who\s+won|first\s+\d+\s+games?)\b/i;
const LOW_QUALITY_CURRENT_PAGE = /\b(?:prediction|forecast(?:ing)?|price\s+target|betting|odds|opinion|editorial|commentary|how\s+to)\b/i;

export function searchOptionsFor(query) {
  const text = String(query ?? "");
  // Scoreboards need not be recently published news articles. Restrict by
  // source authority here, and verify event date/status from content later.
  if (isSportsResultQuery(text)) return { topic: "general", searchDepth: "advanced" };
  const current = CURRENT_INFO.test(text);
  const news = NEWS_OR_SPORTS.test(text);
  if (current && news) return { topic: "news", timeRange: "day", searchDepth: "advanced" };
  if (current) return { searchDepth: "advanced" };
  // Sports result pages are often less text-dense than news stories. Shallow
  // retrieval finds previews and tournament chatter instead of the score.
  if (RESULT_INTENT.test(text) && NEWS_OR_SPORTS.test(text)) return { searchDepth: "advanced" };
  return { searchDepth: "basic" };
}

function requestedCompetition(query) {
  const text = String(query ?? "");
  if (/\bpremier\s+league\b|\bepl\b|\bthe\s+prem\b/i.test(text)) return "premier-league";
  return null;
}

function isWrongCompetition(result, competition) {
  if (competition !== "premier-league") return false;
  const title = result.title ?? "";
  // Keep general result pages (for example, a club's fixture/results page),
  // but remove a page whose *subject* is clearly a different competition.
  // Page snippets can mention many competitions, so using their whole text
  // here let Champions League prediction pages slip through.
  return /\b(?:champions\s+league|fa\s+cup|league\s+cup|carabao\s+cup|club\s+world\s+cup)\b/i.test(title)
    && !/\bpremier\s+league\b/i.test(title);
}

function trustedSportsDomains(query) {
  const text = String(query ?? "").split(/\b(?:Official|Exclude|Requested team:|Opening fixtures)/i)[0];
  if (/\b(?:brasileir[oa]|brasileir[aã]o|brazilian|campeonato brasileiro)\b/i.test(text)) {
    return ["ge.globo.com", "cbf.com.br", "espn.com.br", "espn.com", "reuters.com"];
  }
  if (/\bserie\s+a\b/i.test(text)) return ["legaseriea.it", "gazzetta.it", "espn.com", "apnews.com", "reuters.com"];
  if (/\b(?:champions league|real madrid.*inter|inter.*real madrid)\b/i.test(text)) {
    return ["uefa.com", "realmadrid.com", "inter.it", "espn.com", "bbc.com", "reuters.com"];
  }
  if (/\b(?:yankees|mlb|baseball)\b/i.test(text)) return ["mlb.com", "espn.com", "cbssports.com", "apnews.com", "reuters.com"];
  if (/\b(?:lakers|nba|basketball)\b/i.test(text)) return ["nba.com", "espn.com", "cbssports.com", "apnews.com", "reuters.com"];
  if (/\bcricket\b/i.test(text)) return ["espncricinfo.com", "cricbuzz.com", "cricket.com.au", "icc-cricket.com"];
  if (/\b(?:premier\s+league|epl)\b/i.test(text)) {
    return ["premierleague.com", "espn.com", "bbc.com", "liverpoolfc.com", "reuters.com", "apnews.com", "skysports.com"];
  }
  return SPORTS_DOMAINS;
}

export function isSportsResultQuery(query) {
  const text = String(query ?? "");
  return RESULT_INTENT.test(text) && /\b(?:vs\.?|v\.?|win|won|score|scores|sports?|game|match|matches|nba|nfl|mlb|nhl|mls|epl|premier\s+league|serie\s+a|la\s+liga|bundesliga|ligue\s*1|eredivisie|soccer|football|basketball|baseball|hockey|cricket|tennis)\b/i.test(text);
}

export function sportsRetrievalQuery(query, now = new Date()) {
  // Negative instructions containing "predictions/betting" were themselves
  // polluting semantic retrieval. Keep the event query; policy is enforced in
  // code and in the evidence gate, not sent as a list of unwanted search terms.
  const subject = query.split(/\b(?:Official|Exclude|Requested team:|Opening fixtures)/i)[0].trim();
  return /\b20\d{2}\b/.test(subject) ? subject
    : `${subject} as of ${now.toISOString().slice(0, 10)}`;
}

function currentCategory(query) {
  const text = String(query ?? "");
  if (/\b(?:news|headlines?|current\s+events?|election|politics?)\b/i.test(text)) return "news";
  if (/\b(?:weather|forecast|temperature|rain|snow|wind|humidity|conditions?)\b/i.test(text)) return "weather";
  if (/\b(?:stock|share\s+price|market|ticker|crypto|cryptocurrency|exchange\s+rate)\b/i.test(text)) return "market";
  if (/\b(?:schedule|flight|departure|arrival|timetable|opening\s+hours?)\b/i.test(text)) return "schedule";
  return null;
}

function trustedCurrentDomains(query) {
  switch (currentCategory(query)) {
    case "news": return ["reuters.com", "apnews.com", "bbc.com", "npr.org"];
    case "weather": return ["weather.gov", "weather.com", "accuweather.com"];
    case "market": return ["nasdaq.com", "finance.yahoo.com", "marketwatch.com", "reuters.com"];
    default: return null;
  }
}

function requestedSportsTeam(query) {
  const match = String(query ?? "").match(/\brequested\s+team:\s*([^\.\n]+)\./i);
  return match?.[1]?.trim() ?? null;
}

function resultMentionsRequestedTeam(result, team) {
  if (!team) return true;
  const normalized = team.replace(/[^\p{L}\p{N} ]/gu, " ").trim();
  if (!normalized) return true;
  const words = normalized.split(/\s+/).filter((word) => word.length > 2);
  if (!words.length) return true;
  const text = `${result.title ?? ""}\n${result.content ?? ""}`;
  // Teams are often rendered with either their full name or their distinctive
  // final word (for example, "New York Yankees" / "Yankees"). Requiring the
  // distinctive name prevents a search for one club from returning a random
  // league scoreboard while keeping legitimate result pages.
  return words.some((word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\\\]/g, "\\$&")}\\b`, "i").test(text));
}

function resultMatchesDomains(result, domains) {
  if (!domains?.length) return true;
  try {
    const host = new URL(result.url).hostname.toLowerCase();
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function isLowQualityForCurrentCategory(result, category) {
  const title = result.title ?? "";
  if (category === "weather") return /\b(?:monthly|climate|historical|seasonal)\b/i.test(title);
  if (category === "market") {
    return /\b(?:valuation|financial\s+statistics|key\s+statistics|price\s+history)\b/i.test(title)
      || /\/(?:history|key-statistics)(?:[/?]|$)/i.test(result.url ?? "");
  }
  return LOW_QUALITY_CURRENT_PAGE.test(title);
}

function uniqueResults(results) {
  const seen = new Set();
  return results.filter((result) => {
    try {
      const url = new URL(result.url);
      const key = `${url.hostname}${url.pathname}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    } catch {
      return false;
    }
  });
}

function isClearlyStaleSeason(result) {
  const text = `${result.title ?? ""}\n${result.content ?? ""}`;
  const currentYear = new Date().getUTCFullYear();
  return [...text.matchAll(/\b(20\d{2})\s*[-–/]\s*(?:20)?\d{2}\b/g)]
    .some((match) => Number(match[1]) < currentYear - 1);
}

export async function searchWeb(query, { fetchImpl = fetch, validateSports = validateSportsEvidence, onSources = () => {} } = {}) {
  if (!query?.trim()) throw new Error("A search query is required.");
  if (!config.searchApiKey || !config.searchApiUrl) throw new Error("Web search is not configured.");
  const options = searchOptionsFor(query);
  const sports = isSportsResultQuery(query);
  const request = {
    api_key: config.searchApiKey,
    query: sports ? sportsRetrievalQuery(query) : query.trim(),
    max_results: sports ? 8 : MAX_RESULTS,
    include_answer: !sports,
    search_depth: options.searchDepth,
  };
  if (options.topic) request.topic = options.topic;
  if (options.timeRange) request.time_range = options.timeRange;
  const includeDomains = sports ? trustedSportsDomains(query) : trustedCurrentDomains(query);
  if (sports) {
    request.include_raw_content = "text";
    request.chunks_per_source = 3;
  }
  if (includeDomains) request.include_domains = includeDomains;
  const response = await fetchImpl(config.searchApiUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(sports ? 20_000 : 10_000),
  });
  if (!response.ok) throw new Error("Web search is temporarily unavailable.");
  const data = await response.json();
  const competition = requestedCompetition(query);
  const category = sports ? null : currentCategory(query);
  const team = requestedSportsTeam(query);
  let results = uniqueResults((data.results ?? [])
    .map((r) => ({ title: r.title, url: r.url, content: sports
      ? `${(r.content ?? "").slice(0, 1500)}\n${(r.raw_content ?? "").slice(0, 6500)}`
      : (r.content ?? "").slice(0, 1_500), publishedDate: r.published_date ?? null }))
    // Historical questions are valid; sports date relevance is checked using
    // the requested event rather than deleting every older-season page.
    .filter((result) => sports || !isClearlyStaleSeason(result))
    .filter((result) => !isWrongCompetition(result, competition))
    .filter((result) => !category || !isLowQualityForCurrentCategory(result, category))
    .filter((result) => resultMentionsRequestedTeam(result, team))
    .filter((result) => resultMatchesDomains(result, includeDomains))
  ).slice(0, sports ? 8 : MAX_RESULTS);
  // Surface the actual sites while validation runs, without promoting their
  // unverified content into the answer's grounding context.
  onSources(results.map(({ title, url }) => ({ title, url })));
  // Do not pass legacy "Official results only" retrieval boilerplate to the
  // evidence model: it incorrectly disqualified ESPN/AP as non-league sites.
  let scheduledSources = [];
  if (sports) {
    const validated = await validateSports(query.split(/\b(?:Official|Exclude|Requested team:|Opening fixtures)/i)[0].trim(), results);
    scheduledSources = Array.isArray(validated?.scheduledSources) ? validated.scheduledSources : [];
    results = Array.isArray(validated) ? validated : [];
  }
  results = results.slice(0, MAX_RESULTS);
  // A provider-generated summary can reference a page later removed by our
  // season/recency filtering. For current information, pass only the retained
  // source material to the model.
  const payload = { answer: options.timeRange || sports || category ? null : data.answer ?? null, results };
  if (scheduledSources.length) payload.scheduledSources = scheduledSources;
  return payload;
}
