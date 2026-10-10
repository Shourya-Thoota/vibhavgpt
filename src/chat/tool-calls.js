const TOOL_CALL_OPEN = /<\s*tool(?:[_\s-]?call)\b[^>]*>/gi;
const TOOL_CALL_CLOSE = /<\s*\/\s*tool(?:[_\s-]?call)\s*>/gi;
const STANDALONE_FUNCTION_BLOCK = /<\s*function(?:\s*=|\s+name\s*=)[^>]*>[\s\S]*?<\s*\/\s*function\s*>/gi;
const CURRENT_TIME_TERMS = /\b(?:current|today(?:'s)?|now|right\s+now)\b/i;
const TIME_QUESTION_TERMS = /\b(?:utc|date|time)\b/i;

export const CHAT_TOOLS = [
  {
    type: "function",
    function: {
      name: "weather",
      description: "Get current weather for a named city or location. Use this instead of web search for current weather and conditions.",
      parameters: {
        type: "object",
        properties: { location: { type: "string", description: "City, region, or country to check." } },
        required: ["location"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "Create an image when the user clearly asks you to generate, draw, make, or create an image or picture.",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string", description: "A self-contained image prompt." } },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_document",
      description: "Create a downloadable file when the user asks for one. Supported types are Word DOCX, PowerPoint PPTX, PDF, Markdown, plain text TXT, CSV, JSON, and HTML. For Google Docs, use docx (it opens in Google Docs).",
      parameters: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["docx", "pptx", "pdf", "md", "txt", "csv", "json", "html"] },
          prompt: { type: "string", description: "A self-contained description of the document content." },
        },
        required: ["format", "prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the public web for current events, recent news, live facts, prices, schedules, sports scores, or other information that may have changed after your knowledge cutoff. Do not use this for stable general knowledge or casual conversation.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "A focused web-search query." } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "Save or update a lasting fact about the user in their VibhavGPT memory. Use it when the user asks you to remember, note, keep in mind, or update something about themselves (a preference, a detail about them, their studies, interests, work, tools or a project), or corrects something you already remember. Write the fact about the user in the third person, one fact per call. Never save passwords, secrets, payment details, or facts about you or other people.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "update"], description: "create for a new fact; update to change one already in memory." },
          content: { type: "string", description: "The fact, e.g. \"User prefers metric units.\"" },
          category: { type: "string", enum: ["preferences", "profile", "academics", "interests", "recent_work", "tools", "area"], description: "Where it belongs. Use area for a named recurring project or topic." },
          area: { type: "string", description: "The project or topic name, only when category is area." },
          replaces: { type: "string", description: "For update: the remembered fact being changed, as it appears in memory." },
        },
        required: ["action", "content", "category"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "utc_time",
      description: "Get the server's current UTC date and time when the user needs the current date or time.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

function normalizedName(name) {
  const value = String(name ?? "").trim().toLowerCase();
  if (["web_search", "search_web", "search"].includes(value)) return "web_search";
  if (["utc_time", "current_time", "get_current_time"].includes(value)) return "utc_time";
  if (["generate_image", "create_image", "image_generation"].includes(value)) return "generate_image";
  if (["generate_document", "create_document", "make_document", "document_generation"].includes(value)) return "generate_document";
  if (["weather", "get_weather", "current_weather"].includes(value)) return "weather";
  if (["save_memory", "remember", "update_memory", "add_memory", "memory_write", "write_memory"].includes(value)) return "save_memory";
  return null;
}

export function isImageGenerationRequest(message) {
  const text = String(message ?? "").trim();
  if (!text || /\b(?:how|what|where|can you explain)\b[\s\S]{0,30}\b(?:image generation|generating images)\b/i.test(text)) return false;
  return /\b(?:create|generate|make|draw|illustrate|render|produce)\b[\s\S]{0,100}\b(?:an?\s+)?(?:image|picture|illustration|photo|artwork)\b/i.test(text)
    || /\b(?:image|picture|illustration|photo|artwork)\s+of\b/i.test(text);
}

// Google Docs has no file format of its own to download; a Word .docx opens
// and converts in Google Docs, so that's what a Google Docs request gets.
export const GOOGLE_DOCS_REQUEST = /\bgoogle\s*docs?\b|\bgdocs?\b/i;

export function documentFormatFromRequest(message) {
  const text = String(message ?? "");
  if (GOOGLE_DOCS_REQUEST.test(text)) return "docx";
  if (/\b(?:word\s+(?:doc|document)|docx)\b/i.test(text)) return "docx";
  if (/\b(?:powerpoint|power\s*point|slide\s+deck|presentation|pptx)\b/i.test(text)) return "pptx";
  if (/\bpdf\b/i.test(text)) return "pdf";
  if (/\bmarkdown\b|\.md\b/i.test(text)) return "md";
  if (/\b(?:plain\s+)?text\s+file\b|\.txt\b/i.test(text)) return "txt";
  if (/\b(?:csv|comma[- ]separated)\b/i.test(text)) return "csv";
  if (/\bjson\b|\.json\b/i.test(text)) return "json";
  if (/\bhtml\b|(?:web\s*page|webpage)\s+file|\.html?\b/i.test(text)) return "html";
  return null;
}

export function isDocumentGenerationRequest(message) {
  const text = String(message ?? "").trim();
  if (!text || !documentFormatFromRequest(text)) return false;
  return /\b(?:create|make|generate|write|prepare|produce|build|put|convert|export|turn|save)\b/i.test(text)
    && !/^\s*(?:what|how|can you explain|where)\b/i.test(text);
}

function toolCallBlocks(content) {
  const blocks = [];
  TOOL_CALL_OPEN.lastIndex = 0;
  let open;
  while ((open = TOOL_CALL_OPEN.exec(content))) {
    TOOL_CALL_CLOSE.lastIndex = TOOL_CALL_OPEN.lastIndex;
    const close = TOOL_CALL_CLOSE.exec(content);
    const end = close ? TOOL_CALL_CLOSE.lastIndex : content.length;
    blocks.push(content.slice(open.index, end));
    // An unclosed marker is considered unsafe markup through the end of output.
    if (!close) break;
    TOOL_CALL_OPEN.lastIndex = end;
  }
  return blocks;
}

function functionNameFromRaw(block) {
  const candidates = [
    /(?:<\s*)?function\s*=\s*["']?([a-zA-Z0-9_.:-]+)["']?/i,
    /<\s*function\s+name\s*=\s*["']?([a-zA-Z0-9_.:-]+)["']?/i,
    /["']?(?:name|function)["']?\s*:\s*["']([a-zA-Z0-9_.:-]+)["']/i,
    /<\s*function\s*>\s*([a-zA-Z0-9_.:-]+)\s*<\s*\/\s*function\s*>/i,
  ];
  return candidates.map((pattern) => block.match(pattern)?.[1]).find(Boolean) ?? null;
}

function argumentsFromRaw(body, fallbackQuery) {
  const json = body.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const parsed = JSON.parse(json);
      // Memory fields may sit at the top level or under "arguments" (an
      // object or a JSON string), depending on the provider's raw syntax.
      let memory = parsed?.arguments ?? parsed;
      if (typeof memory === "string") { try { memory = JSON.parse(memory); } catch { memory = null; } }
      if (typeof memory?.content === "string" && memory.content.trim()) {
        return { action: memory.action === "update" ? "update" : "create", content: memory.content.trim().slice(0, 500), category: memory.category, area: memory.area, replaces: memory.replaces, query: fallbackQuery };
      }
      if (typeof parsed?.query === "string" && parsed.query.trim()) return { query: parsed.query.trim().slice(0, 500) };
      if (typeof parsed?.location === "string" && parsed.location.trim()) return { location: parsed.location.trim().slice(0, 120), query: fallbackQuery };
      if (typeof parsed?.prompt === "string" && parsed.prompt.trim()) return { prompt: parsed.prompt.trim().slice(0, 8_000), format: ["docx", "pptx", "pdf", "md", "txt", "csv", "json", "html"].includes(parsed.format) ? parsed.format : /google|gdoc/i.test(String(parsed.format ?? "")) ? "docx" : null };
    } catch {
      // Fall through to XML-style parameter parsing used by some compatible APIs.
    }
  }
  const parameter = body.match(/<\s*(?:parameter\s*=\s*(?:query|prompt)|query|prompt)\s*>\s*([\s\S]*?)\s*<\s*\/\s*(?:parameter|query|prompt)\s*>/i)?.[1];
  return { query: parameter?.trim().slice(0, 500) || fallbackQuery, location: parameter?.trim().slice(0, 120) || "", prompt: parameter?.trim().slice(0, 8_000) || fallbackQuery };
}

export function rawToolCalls(content, fallbackQuery) {
  if (typeof content !== "string") return [];
  return toolCallBlocks(content).map((block, index) => ({
    id: `raw-tool-${index}`,
    name: normalizedName(functionNameFromRaw(block)),
    originalName: functionNameFromRaw(block),
    arguments: argumentsFromRaw(block, fallbackQuery),
    raw: block,
    format: "raw",
  }));
}

export function structuredToolCalls(data, fallbackQuery) {
  return (data?.choices?.[0]?.message?.tool_calls ?? []).map((call, index) => {
    let args = {};
    try { args = JSON.parse(call.function?.arguments ?? "{}"); } catch { /* use fallback below */ }
    const prompt = typeof args.prompt === "string" && args.prompt.trim() ? args.prompt.trim().slice(0, 8_000) : fallbackQuery;
    return {
      id: call.id ?? `structured-tool-${index}`,
      name: normalizedName(call.function?.name),
      originalName: call.function?.name,
      arguments: { ...args, query: typeof args.query === "string" && args.query.trim() ? args.query.trim().slice(0, 500) : fallbackQuery, location: typeof args.location === "string" && args.location.trim() ? args.location.trim().slice(0, 120) : "", prompt, format: ["docx", "pptx", "pdf", "md", "txt", "csv", "json", "html"].includes(args.format) ? args.format : /google|gdoc/i.test(String(args.format ?? "")) ? "docx" : null },
      raw: call,
      format: "structured",
    };
  });
}

export function requestedToolCall(data, fallbackQuery) {
  const structured = structuredToolCalls(data, fallbackQuery)[0];
  if (structured) return structured;
  return rawToolCalls(data?.choices?.[0]?.message?.content, fallbackQuery)[0] ?? null;
}

export function stripRawToolCalls(content) {
  if (typeof content !== "string") return "";
  let clean = content;
  for (const block of toolCallBlocks(clean)) clean = clean.replace(block, "");
  // Defensive fallback for a provider that omits the outer tool-call marker.
  return clean.replace(STANDALONE_FUNCTION_BLOCK, "").trim();
}

export function currentUtcTimeResult() {
  return { utc: new Date().toISOString() };
}

export function needsCurrentUtcTime(message) {
  const text = String(message ?? "");
  return CURRENT_TIME_TERMS.test(text) && TIME_QUESTION_TERMS.test(text);
}
