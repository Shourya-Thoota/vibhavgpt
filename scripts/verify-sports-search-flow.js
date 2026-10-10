import assert from "node:assert/strict";
import { callModelWithFallback } from "../src/chat/providers.js";
import { buildIdentitySystemPrompt } from "../src/chat/prompts.js";
import { searchWeb } from "../src/search/service.js";
import { buildSportsSearchQuery, requiresFreshSportsSearch, safeSportsFallback, SPORTS_SEARCH_RULE, supportingSportsSource } from "../src/chat/web-search.js";

const defaultQueries = [
  "What is the current NBA score?",
  "Did the Yankees win last night?",
  "Show me today's sports scores.",
];
const queries = process.argv.length > 2 ? [process.argv.slice(2).join(" ")] : defaultQueries;

function searchContext(search) {
  const summary = search.answer ? `Summary: ${search.answer}\n` : "";
  const results = search.results
    .map((result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.content}`)
    .join("\n\n");
  return `<WebSearchResults>\n${summary}${results}\n</WebSearchResults>\n${SPORTS_SEARCH_RULE}`;
}

function visibleReply(content) {
  const trimmed = typeof content === "string" ? content.trim() : "";
  if (!trimmed.toLowerCase().startsWith("<think>")) return trimmed;
  const closing = trimmed.toLowerCase().indexOf("</think>");
  return closing === -1 ? "" : trimmed.slice(closing + "</think>".length).trim();
}

for (const query of queries) {
  assert.equal(requiresFreshSportsSearch(query), true, `Search was not forced for: ${query}`);
  const search = await searchWeb(buildSportsSearchQuery(query));
  assert.ok(search.results.length > 0, `No sources were returned for: ${query}`);

  const { data } = await callModelWithFallback("lumen", [
    { role: "system", content: buildIdentitySystemPrompt("lumen") },
    { role: "system", content: SPORTS_SEARCH_RULE },
    { role: "user", content: `${query}\n\n${searchContext(search)}` },
  ]);
  const reply = visibleReply(data?.choices?.[0]?.message?.content);
  assert.ok(reply, `No answer was returned for: ${query}`);
  const sourceUrls = search.results.map((result) => result.url);
  const supportingSource = supportingSportsSource(reply, search);
  const deliveredReply = supportingSource
    ? (reply.includes(supportingSource.url) ? reply : `${reply}\n\nSource: ${supportingSource.url}`)
    : safeSportsFallback();
  console.log(JSON.stringify({
    query,
    searchForced: true,
    sourceCount: sourceUrls.length,
    supportingSource: supportingSource?.url ?? null,
    responsePreview: deliveredReply.slice(0, 220),
  }));
  assert.ok(
    supportingSource || deliveredReply === safeSportsFallback(),
    `The response was neither source-supported nor safely declined for: ${query}`,
  );
}
