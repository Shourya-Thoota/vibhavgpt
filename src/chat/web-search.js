const SPORTS_TERMS = /\b(?:sports?|football|basketball|baseball|hockey|soccer|cricket|tennis|golf|racing|formula\s*1|f1|nfl|nba|wnba|mlb|nhl|mls|epl|prem(?:ier)?\s+league|serie\s+a|la\s+liga|bundesliga|ligue\s*1|eredivisie|champions\s+league|ncaa|ufc|mma|boxing|olympics?)\b/i;
const FRESHNESS_TERMS = /\b(?:current|latest|live|today(?:'s)?|tonight(?:'s)?|now|right\s+now|yesterday(?:'s)?|last\s+night(?:'s)?)\b/i;
const SCORE_TERMS = /\b(?:score|scores|scoreboard|result|results|who\s+won|winner|winning|standings?|rankings?|fixture|fixtures|schedule|game|match|series)\b/i;
const WINNER_QUESTION = /\b(?:who\s+won|did\s+.+?\s+win)\b/i;
const MATCHUP = /\b[\p{L}\d][\p{L}\d .'-]{1,40}\s+(?:vs\.?|v\.?)\s+[\p{L}\d][\p{L}\d .'-]{1,40}\b/iu;
const CURRENT_TERMS = /\b(?:current|latest|live|today(?:'s)?|tonight(?:'s)?|now|right\s+now|recent|breaking|last\s+night|yesterday|this\s+(?:morning|afternoon|evening|week)|tomorrow)\b/i;
const CHANGING_FACTS = /\b(?:news|headlines?|events?|weather|forecast|prices?|stock|market|schedule|flight|election|politics|sports?|scores?|game|match|standings?|rankings?)\b/i;
const NEWS_TERMS = /\b(?:news|headlines?|current\s+events?|election|politics?)\b/i;
const WEATHER_TERMS = /\b(?:weather|forecast|temperature|rain|snow|wind|humidity|conditions?)\b/i;
const MARKET_TERMS = /\b(?:stock|share\s+price|market|ticker|crypto|cryptocurrency|exchange\s+rate)\b/i;
const SCHEDULE_TERMS = /\b(?:schedule|flight|departure|arrival|timetable|opening\s+hours?)\b/i;
const VAGUE_WEB_FOLLOW_UP = /^(?:please\s+)?(?:check(?:\s+(?:it|this|that|again|the\s+web|online|any\s+web\s+source\s+you\s+want))?|search(?:\s+(?:it|this|that|again|the\s+web|online))?|look(?:\s+(?:it|this|that|again|online|up))?|verify(?:\s+(?:it|this|that|again))?|try\s+again|use\s+(?:the\s+)?web|find\s+(?:a|any|another)\s+(?:web\s+)?source)(?:[.!?])?\s*$/i;

// Search-only vocabulary. This is intentionally bounded to entities and
// category terms whose correction improves routing; it is not a general
// spellchecker and never attempts to rewrite arbitrary user prose.
const SEARCH_VOCABULARY = Object.freeze([
  { canonical: "Premier League", aliases: ["Premier League", "EPL", "Prem League", "the Prem"] },
  { canonical: "Serie A", aliases: ["Serie A", "SerieA"] },
  { canonical: "La Liga", aliases: ["La Liga", "LaLiga"] },
  { canonical: "Bundesliga", aliases: ["Bundesliga"] },
  { canonical: "Ligue 1", aliases: ["Ligue 1"] },
  { canonical: "Champions League", aliases: ["Champions League"] },
  { canonical: "NFL", aliases: ["NFL"] },
  { canonical: "NBA", aliases: ["NBA"] },
  { canonical: "MLB", aliases: ["MLB"] },
  { canonical: "NHL", aliases: ["NHL"] },
  { canonical: "Liverpool", aliases: ["Liverpool"] },
  { canonical: "Barcelona", aliases: ["Barcelona"] },
  { canonical: "Real Madrid", aliases: ["Real Madrid"] },
  { canonical: "Inter Milan", aliases: ["Inter Milan"] },
  { canonical: "AC Milan", aliases: ["AC Milan"] },
  { canonical: "Monza", aliases: ["Monza"] },
  { canonical: "Cagliari", aliases: ["Cagliari"] },
  { canonical: "Lecce", aliases: ["Lecce"] },
  { canonical: "Yankees", aliases: ["Yankees"] },
  { canonical: "Lakers", aliases: ["Lakers"] },
  { canonical: "Celtics", aliases: ["Celtics"] },
  { canonical: "weather", aliases: ["weather"] },
  { canonical: "forecast", aliases: ["forecast"] },
  { canonical: "temperature", aliases: ["temperature"] },
  { canonical: "humidity", aliases: ["humidity"] },
  { canonical: "stock", aliases: ["stock"] },
  { canonical: "price", aliases: ["price"] },
  { canonical: "market", aliases: ["market"] },
  { canonical: "ticker", aliases: ["ticker"] },
  { canonical: "Nasdaq", aliases: ["Nasdaq"] },
  { canonical: "receive", aliases: ["receive"] },
]);

const normalizedForDistance = (value) => String(value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function levenshteinDistance(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function allowedEditDistance(length) {
  // Acronyms and very short words are exact-only. Longer known terms allow
  // the one or two keystroke mistakes users make in normal typing.
  if (length < 5) return 0;
  return length < 9 ? 2 : 2;
}

function vocabularyMatch(candidate) {
  const normalizedCandidate = normalizedForDistance(candidate);
  if (!normalizedCandidate) return null;
  let best = null;
  for (const entry of SEARCH_VOCABULARY) {
    for (const alias of entry.aliases) {
      const normalizedAlias = normalizedForDistance(alias);
      if (Math.abs(normalizedCandidate.length - normalizedAlias.length) > 2) continue;
      const distance = levenshteinDistance(normalizedCandidate, normalizedAlias);
      const exact = distance === 0;
      if (!exact && (normalizedCandidate.length < 5 || distance > allowedEditDistance(normalizedAlias.length))) continue;
      const match = { canonical: entry.canonical, distance, exact, aliasLength: normalizedAlias.length };
      if (!best || match.distance < best.distance || (match.distance === best.distance && match.aliasLength > best.aliasLength)) best = match;
    }
  }
  return best;
}

export function normalizeSearchSubject(value) {
  const text = String(value ?? "");
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
  if (!words.length) return text;
  let cursor = 0;
  let index = 0;
  let output = "";
  while (index < words.length) {
    let selected = null;
    // Entity names may be written as one malformed word ("serirea") or as
    // two/three words ("premier leauge"), so examine both forms.
    for (const span of [3, 2, 1]) {
      const endIndex = index + span - 1;
      if (endIndex >= words.length) continue;
      const candidate = text.slice(words[index].index, words[endIndex].index + words[endIndex][0].length);
      const match = vocabularyMatch(candidate);
      if (!match) continue;
      selected = { span, candidateStart: words[index].index, candidateEnd: words[endIndex].index + words[endIndex][0].length, match };
      break;
    }
    if (!selected) {
      index += 1;
      continue;
    }
    output += text.slice(cursor, selected.candidateStart);
    output += selected.match.canonical;
    cursor = selected.candidateEnd;
    index += selected.span;
  }
  return output ? `${output}${text.slice(cursor)}` : text;
}

function priorUserSubject(history = []) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item?.role !== "user" || typeof item.content !== "string") continue;
    const subject = item.content.trim();
    if (subject && !VAGUE_WEB_FOLLOW_UP.test(subject)) return subject;
  }
  return "";
}

/**
 * Resolves short web-search continuations ("check the web", "try again")
 * against the preceding user turn. This is intentionally deterministic: a
 * model may still decide to call a tool, but a manual or forced search must
 * never send an ambiguous pronoun-only query to the search provider.
 */
export function resolveSearchSubject(message, history = []) {
  const requested = String(message ?? "").trim();
  if (!requested || !VAGUE_WEB_FOLLOW_UP.test(requested)) return { subject: requested, isContinuation: false };
  const subject = priorUserSubject(history);
  return { subject: subject || requested, isContinuation: Boolean(subject) };
}

export function buildConversationSearchPlan(message, history = []) {
  const { subject, isContinuation } = resolveSearchSubject(message, history);
  const normalizedSubject = normalizeSearchSubject(subject);
  const sports = requiresFreshSportsSearch(normalizedSubject);
  const current = !sports && requiresFreshWebSearch(normalizedSubject);
  return {
    subject: normalizedSubject,
    isContinuation,
    sports,
    current,
    // A vague continuation should activate search automatically only when its
    // resolved subject is objectively time-sensitive. Normal follow-ups stay
    // under the model's ordinary conversational control.
    continuationNeedsSearch: isContinuation && (sports || current),
    query: sports ? buildSportsSearchQuery(normalizedSubject) : current ? buildCurrentInfoSearchQuery(normalizedSubject) : normalizedSubject,
  };
}

/**
 * Scores and recent results are a special case: even when a model does not
 * choose the web-search tool, answering from its training data is unsafe.
 */
export function requiresFreshSportsSearch(message) {
  if (typeof message !== "string") return false;
  const text = message.trim();
  if (!text || (!SCORE_TERMS.test(text) && !WINNER_QUESTION.test(text))) return false;

  return WINNER_QUESTION.test(text) || SPORTS_TERMS.test(text) || FRESHNESS_TERMS.test(text) || MATCHUP.test(text);
}

/** Deterministic safety net for questions that are inherently time-sensitive. */
export function requiresFreshWebSearch(message) {
  const text = String(message ?? "").trim();
  return requiresFreshSportsSearch(text) || (CURRENT_TERMS.test(text) && CHANGING_FACTS.test(text));
}

export function currentInfoCategory(message) {
  const text = String(message ?? "");
  if (NEWS_TERMS.test(text)) return "news";
  if (WEATHER_TERMS.test(text)) return "weather";
  if (MARKET_TERMS.test(text)) return "market";
  if (SCHEDULE_TERMS.test(text)) return "schedule";
  return null;
}

export function buildCurrentInfoSearchQuery(message) {
  const question = String(message ?? "").trim();
  switch (currentInfoCategory(question)) {
    case "news":
      return `${question} Latest confirmed reporting. Prioritize primary reporting and established news organizations. Exclude opinion, commentary, predictions, and tangential coverage.`;
    case "weather":
      return `${question} Current conditions and official forecast. Prioritize official weather agencies or direct weather observations. Exclude long-range speculation and unrelated climate articles.`;
    case "market":
      return `${question} Current quote or market data, including the timestamp and currency when available. Prioritize an exchange, company filing, or established financial-data source. Exclude price targets, predictions, and investment advice.`;
    case "schedule":
      return `${question} Current official schedule or status. Prioritize the operator's or organizer's direct schedule. Exclude speculation, old schedules, and commentary.`;
    default:
      return question;
  }
}

export const CURRENT_INFO_SEARCH_RULE =
  "This is a time-sensitive request. Treat the supplied web-search results as the only source of truth. Give a current fact only when it is directly supported by a relevant source. Do not fill gaps from memory, infer a value, or turn a prediction into a fact. If the sources do not clearly answer the question, say that you could not verify a reliable current answer and point the user to the sources below.";

export function safeCurrentInfoFallback() {
  return "I couldn't verify a reliable current answer from the available web sources. Please check the sources below or try again shortly.";
}

const NUMBER_WORDS = new Map([
  ["one", "1"], ["two", "2"], ["three", "3"], ["four", "4"], ["five", "5"],
]);

function currentFootballSeason() {
  const now = new Date();
  const year = now.getUTCFullYear();
  // Major European domestic seasons start in the middle of the calendar year.
  const startYear = now.getUTCMonth() >= 5 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

function normalizedCompetition(value = "") {
  const competition = value.trim();
  if (/^(?:the\s+)?(?:prem|epl|english\s+premier\s+league)$/i.test(competition)) return "Premier League";
  if (/^(?:the\s+)?(?:nba)$/i.test(competition)) return "NBA";
  if (/^(?:the\s+)?(?:nfl)$/i.test(competition)) return "NFL";
  if (/^(?:the\s+)?(?:mlb)$/i.test(competition)) return "MLB";
  if (/^(?:the\s+)?serie\s+a$/i.test(competition)) return "Serie A";
  if (/^(?:the\s+)?la\s+liga$/i.test(competition)) return "La Liga";
  if (/^(?:the\s+)?bundesliga$/i.test(competition)) return "Bundesliga";
  if (/^(?:the\s+)?ligue\s*1$/i.test(competition)) return "Ligue 1";
  return competition;
}

function competitionInQuestion(value = "") {
  const text = String(value);
  if (/\b(?:premier\s+league|epl|the\s+prem)\b/i.test(text)) return "Premier League";
  if (/\b(?:nba)\b/i.test(text)) return "NBA";
  if (/\b(?:nfl)\b/i.test(text)) return "NFL";
  if (/\b(?:mlb)\b/i.test(text)) return "MLB";
  if (/\bserie\s+a\b/i.test(text)) return "Serie A";
  if (/\bla\s+liga\b/i.test(text)) return "La Liga";
  if (/\bbundesliga\b/i.test(text)) return "Bundesliga";
  if (/\bligue\s*1\b/i.test(text)) return "Ligue 1";
  return "";
}

function currentSportsSeason(competition) {
  if (/\b(?:NFL|NBA|WNBA|MLB|NHL|MLS)\b/i.test(competition)) return String(new Date().getUTCFullYear());
  return currentFootballSeason();
}

function seasonFromQuestion(message) {
  const explicit = String(message).match(/\b(20\d{2})\s*[-–/]\s*(\d{2}|20\d{2})\b/);
  if (!explicit) return null;
  const end = explicit[2].length === 2 ? explicit[2] : explicit[2].slice(-2);
  return `${explicit[1]}-${end}`;
}

export function buildSportsSearchQuery(message) {
  const question = message.trim();
  const competition = competitionInQuestion(question);
  // Opening-match questions need an indexed fixture/result query rather than
  // a literal conversational phrase such as “first ... game this season”.
  if (competition && /\bfirst\b[\s\S]{0,50}\b(?:game|match)\b/i.test(question)
    && /\b(?:who\s+won|winner|result|score)\b/i.test(question)) {
    const season = seasonFromQuestion(question) ?? currentSportsSeason(competition);
    return `${competition} ${season} opening match first game result final score and winner. Official league results and match reports only. Exclude predictions, previews, fantasy, betting odds, transfer news, and unrelated competitions.`;
  }
  // Convert the common "first N games in the Prem" wording into the phrases
  // result databases actually index. It is intentionally narrow: other sports
  // questions keep the user's original wording rather than guessing a league.
  const openingGames = question.match(/^\s*did\s+(?:the\s+)?(.+?)\s+win\s+(?:(?:their|the)\s+)?first\s+(\d+|one|two|three|four|five)(?:\s+(.+?))?\s+games?(?:\s+.*)?[?!\.]*\s*$/i);
  if (openingGames) {
    const [, team, countValue, rawCompetition] = openingGames;
    const count = NUMBER_WORDS.get(countValue.toLowerCase()) ?? countValue;
    const competition = normalizedCompetition(rawCompetition || "") || competitionInQuestion(question);
    const season = seasonFromQuestion(question) ?? (/prem|epl|premier\s+league/i.test(competition) ? currentFootballSeason() : "");
    const seasonPart = season ? ` ${season}` : "";
    const competitionPart = competition || "league";
    return `${team.trim()} ${competitionPart}${seasonPart} first ${count} matches final scores and results. Requested team: ${team.trim()}. Opening fixtures (Matchweek 1 through Matchweek ${count}): did ${team.trim()} win every match? Official league fixture or result pages only. Exclude predictions, previews, fantasy, betting odds, transfer news, how-to-watch, Champions League, FA Cup, and other competitions.`;
  }
  const recentTeamResult = question.match(/^\s*did\s+(?:the\s+)?(.+?)\s+win\s+(?:their\s+)?(?:most\s+recent|last)\s+(?:completed\s+)?(?:game|match)[?!\.]*\s*$/i);
  if (recentTeamResult) {
    const team = recentTeamResult[1].trim();
    return `${team} latest completed game final score and result. Requested team: ${team}. Include the opponent, date, final score, and whether ${team} won. Official result pages only. Exclude predictions, previews, fantasy, betting odds, transfer news, and how-to-watch pages.`;
  }
  return `${question} completed match result and final score. Official results only. Exclude predictions, previews, fantasy, betting odds, transfer news, and how-to-watch pages.`;
}

export const SPORTS_SEARCH_RULE =
  "This is a sports-score or result request. Treat the supplied web-search results as the only source of truth. State a score, winner, game status, or result only when the exact teams and result are supported by those results. Write each score in the source's team order (for example, Ipswich 0-2 Liverpool), not as a reversed winner-first score. Use a written-out date, not an ISO numeric date. Never fill gaps from memory or make an educated guess. If the results do not clearly verify the requested game, say that you could not verify a reliable current result and direct the user to the sources below.";

function scoreClaims(reply) {
  return [...String(reply ?? "").matchAll(/\b(\d{1,3})\s*[-–—]\s*(\d{1,3})\b/g)].map((match) => [match[1], match[2]]);
}

function resultSupportsScore(result, [first, second]) {
  const text = `${result.title ?? ""}\n${result.content ?? ""}`;
  // Search sources commonly write a final as "Team A 7, Team B 0" while a
  // user-facing reply writes "7–0". Preserve number order and allow a short
  // team-name separator, but never accept the reverse score.
  return new RegExp(`\\b${first}\\b[\\s\\S]{0,60}?\\b${second}\\b`).test(text);
}

/** Returns a source that supports every numeric score stated in a reply. */
export function supportingSportsSource(reply, search) {
  const claims = scoreClaims(reply);
  if (!claims.length || !Array.isArray(search?.results)) return null;
  return search.results.find((result) => claims.every((claim) => resultSupportsScore(result, claim))) ?? null;
}

/**
 * Decides whether a sports reply may stand as written.
 *
 * The distinction that matters here is between "this reply states a score I
 * cannot corroborate" and "this reply states no score at all". Only the first
 * is a verification failure. Treating them the same is what made a correct
 * answer to "who won today's Inter vs Roma match" — which invites a winner,
 * not a scoreline — get discarded and replaced with the couldn't-verify
 * message, because a reply with no digits in it produces no claims to match.
 *
 * A reply with no score claim still has to have been grounded in something,
 * so it passes only when the search actually returned results; with nothing
 * retrieved there is no basis for naming a winner either.
 */
export function verifySportsReply(reply, search) {
  const results = Array.isArray(search?.results) ? search.results : [];
  if (!results.length) return { ok: false, reason: "no-results", source: null };

  const claims = scoreClaims(reply);
  if (!claims.length) return { ok: true, reason: "no-score-claim", source: null };

  const source = results.find((result) => claims.every((claim) => resultSupportsScore(result, claim))) ?? null;
  return source
    ? { ok: true, reason: "verified", source }
    : { ok: false, reason: "unsupported-score", source: null };
}

export function safeSportsFallback() {
  return "I couldn't verify a reliable current result from the available web sources. Please check the sources below for the latest update.";
}

function scheduledEventLabel(query) {
  const text = String(query ?? "");
  if (/\bnfl\b[\s\S]{0,24}\bweek\s*1\b|\bweek\s*1\b[\s\S]{0,24}\bnfl\b/i.test(text)) return "NFL Week 1";
  if (/\bnba\b[\s\S]{0,24}\bweek\s*1\b|\bweek\s*1\b[\s\S]{0,24}\bnba\b/i.test(text)) return "NBA Week 1";
  return "That event";
}

function scheduledDateText(eventDate, query, now = new Date()) {
  if (!eventDate) return "an upcoming date";
  const date = new Date(`${eventDate}T12:00:00Z`);
  const today = new Date(`${new Date(now).toISOString().slice(0, 10)}T12:00:00Z`);
  const days = Math.round((date - today) / 86_400_000);
  const formatted = date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  if (days === 0) return `${/tonight/i.test(query) ? "tonight" : "today"}, ${formatted}`;
  if (days === 1) return `tomorrow, ${formatted}`;
  return `on ${formatted}`;
}

export function scheduledSportsFallback(search, query, now = new Date()) {
  const source = search?.scheduledSources?.[0];
  if (!source) return safeSportsFallback();
  const excerpts = source.evidence?.excerpts ?? [];
  const evidence = excerpts.join(" ");
  const time = evidence.match(/\b\d{1,2}:\d{2}\s*(?:AM|PM)?\s*(?:ET|PT|CT|MT|UTC|GMT)?\b/i)?.[0]?.trim();
  const when = scheduledDateText(source.evidence?.eventDate, query, now);
  const timing = time ? `${when} at ${time}` : when;
  return `${scheduledEventLabel(query)} hasn't happened yet. It is scheduled ${timing}.`;
}
