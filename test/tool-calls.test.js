import assert from "node:assert/strict";
import test from "node:test";
import { currentUtcTimeResult, documentFormatFromRequest, isDocumentGenerationRequest, isImageGenerationRequest, needsCurrentUtcTime, rawToolCalls, requestedToolCall, stripRawToolCalls } from "../src/chat/tool-calls.js";

test("clear natural-language image requests trigger generation", () => {
  assert.equal(isImageGenerationRequest("Create an image of a cat in a car with sunglasses"), true);
  assert.equal(isImageGenerationRequest("What is image generation?"), false);
  assert.equal(isImageGenerationRequest("Explain how image generation works"), false);
});

test("clear natural-language document requests select the requested format", () => {
  assert.equal(isDocumentGenerationRequest("Make me a study guide as a Word doc"), true);
  assert.equal(documentFormatFromRequest("Make me a study guide as a Word doc"), "docx");
  assert.equal(documentFormatFromRequest("Create a slide deck about photosynthesis"), "pptx");
  assert.equal(documentFormatFromRequest("Generate a PDF summary of this topic"), "pdf");
  assert.equal(documentFormatFromRequest("Write this as a markdown file"), "md");
  assert.equal(documentFormatFromRequest("Create a CSV spreadsheet of the results"), "csv");
  assert.equal(documentFormatFromRequest("Make this a JSON file"), "json");
  assert.equal(documentFormatFromRequest("Generate a simple HTML page"), "html");
  assert.equal(documentFormatFromRequest("Save a plain text file"), "txt");
  assert.equal(isDocumentGenerationRequest("What is a PDF?"), false);
});

test("raw XML-like tool syntax is parsed and removed before it can reach chat", () => {
  const raw = "<tool_call> <function=utc_time> </function> </tool_call>";
  const call = rawToolCalls(raw, "What time is it?")[0];
  assert.equal(call.name, "utc_time");
  assert.equal(stripRawToolCalls(`${raw} Hello`), "Hello");
  assert.match(currentUtcTimeResult().utc, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(needsCurrentUtcTime("What is the current UTC time?"), true);
  assert.equal(needsCurrentUtcTime("Explain time zones."), false);
});

test("structured and raw web-search calls get a safe fallback query", () => {
  const structured = requestedToolCall({ choices: [{ message: { tool_calls: [{ id: "call-1", function: { name: "web_search", arguments: "{}" } }] } }] }, "latest headlines");
  assert.equal(structured.name, "web_search");
  assert.equal(structured.arguments.query, "latest headlines");

  const raw = requestedToolCall({ choices: [{ message: { content: "<tool_call><function=web_search><parameter=query>latest sports scores</parameter></function></tool_call>" } }] }, "fallback");
  assert.equal(raw.name, "web_search");
  assert.equal(raw.arguments.query, "latest sports scores");
});

test("malformed provider tool-call variants are executed or stripped", () => {
  const variants = [
    "<tool_call> function=search> </function> </tool_call>",
    "<tool-call><function name=web_search><query>latest headlines</query></function></tool-call>",
    '<tool call>{"name":"search_web","arguments":{"query":"live score"}}</tool call>',
  ];
  for (const raw of variants) {
    const call = rawToolCalls(raw, "fallback")[0];
    assert.equal(call.name, "web_search", raw);
    assert.equal(stripRawToolCalls(`Before ${raw} After`), "Before  After", raw);
  }
  assert.equal(stripRawToolCalls("Visible <tool_call> function=search> malformed"), "Visible");
  assert.equal(stripRawToolCalls("<function=web_search>raw</function> final"), "final");
});
