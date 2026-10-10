import assert from "node:assert/strict";
import { callModelWithFallback } from "../src/chat/providers.js";
import { buildIdentitySystemPrompt } from "../src/chat/prompts.js";
import { currentUtcTimeResult, stripRawToolCalls } from "../src/chat/tool-calls.js";
import { searchOptionsFor, searchWeb } from "../src/search/service.js";

function visibleReply(content) {
  const withoutTools = stripRawToolCalls(content);
  if (!withoutTools.toLowerCase().startsWith("<think>")) return withoutTools;
  const closing = withoutTools.toLowerCase().indexOf("</think>");
  return closing === -1 ? "" : withoutTools.slice(closing + "</think>".length).trim();
}

const newsQuery = "What are the latest major headlines today?";
const newsSearch = await searchWeb(newsQuery);
assert.deepEqual(searchOptionsFor(newsQuery), { topic: "news", timeRange: "day", searchDepth: "advanced" });
assert.ok(newsSearch.results.length > 0, "No current-news sources were returned.");
const newsContext = newsSearch.results.map((item, index) => `${index + 1}. ${item.title}\n${item.url}\n${item.content}`).join("\n\n");
const newsResult = await callModelWithFallback("lumen", [
  { role: "system", content: `${buildIdentitySystemPrompt("lumen")} Use only the supplied current sources. Give a short answer and include one supplied source URL.` },
  { role: "user", content: `${newsQuery}\n\n<WebSearchResults>\n${newsContext}\n</WebSearchResults>` },
]);
const newsReply = visibleReply(newsResult.data?.choices?.[0]?.message?.content);
assert.ok(newsReply, "No final news reply was returned.");
assert.equal(/<tool_call>|<function=/i.test(newsReply), false, "Raw tool syntax reached the reply.");

const currentTime = currentUtcTimeResult();
const timeQuery = "What is the current UTC date and time?";
const timeResult = await callModelWithFallback("lumen", [
  { role: "system", content: `${buildIdentitySystemPrompt("lumen")} Use the trusted server time supplied by the user. Give a short final answer only.` },
  { role: "user", content: `${timeQuery}\n\n<CurrentUtcTime>${JSON.stringify(currentTime)}</CurrentUtcTime>` },
]);
const timeReply = visibleReply(timeResult.data?.choices?.[0]?.message?.content);
assert.ok(timeReply, "No final time reply was returned.");
assert.equal(/<tool_call>|<function=/i.test(timeReply), false, "Raw tool syntax reached the reply.");

console.log(JSON.stringify({
  news: { sourceCount: newsSearch.results.length, reply: newsReply.slice(0, 500) },
  utcTime: { trustedValue: currentTime.utc, reply: timeReply.slice(0, 300) },
}));
