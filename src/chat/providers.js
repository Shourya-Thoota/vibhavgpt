import { config } from "../config.js";
import { redactSensitive } from "../../frontend/src/sentry-scrub.js";
import { replyTokenEstimate, requestTokenEstimate } from "./context-window.js";
import { stripThoughts } from "./thought-filter.js";
import { reasoningParameter } from "./reasoning-effort.js";

// Each stage's endpoint is its configured base URL plus the standard
// chat-completions path; an unconfigured stage is skipped like a missing key.
const chatCompletionsUrl = (stage) => {
  const base = config.providerBaseUrls[stage];
  return base ? `${base}/chat/completions` : undefined;
};

export class InferenceUnavailableError extends Error {
  constructor() {
    super("VibhavGPT is temporarily unavailable. Please try again shortly.");
    this.code = "inference-unavailable";
    this.status = 503;
  }
}

function writeInferenceLog(level, event, fields) {
  console[level](JSON.stringify({ event, ...fields }));
}

// What a provider said when it failed, safe to log: its code and one short
// line of its message, with emails and anything key- or token-like removed.
export function providerErrorSummary(error) {
  if (!error || typeof error !== "object") return null;
  const code = typeof error.code === "string" || Number.isInteger(error.code) ? String(error.code).slice(0, 40) : null;
  // The same redaction rules as error monitoring (frontend/src/sentry-scrub.js).
  // A long quoted run is replaced too: a provider that rejects a request can
  // quote part of it back, and that part may be the user's own words.
  const message = typeof error.message === "string"
    ? redactSensitive(error.message.replace(/[\u0000-\u001f\u007f]+/g, " "))
      .replace(/(["'`])[^"'`]{24,}\1/g, "[quoted]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160)
    : "";
  return { code, message: message || null };
}

// Why a provider refused a request (a 4xx), safe to log. Only the start of
// the body is read, so a large or endless body cannot hold the request; a
// body that cannot be read leaves the status alone to explain it.
async function rejectionSummary(response) {
  let text = "";
  try {
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      while (text.length < 2_048) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      void reader.cancel().catch(() => {});
    }
  } catch { /* The status is still logged. */ }
  let error = { message: text };
  try {
    // OpenAI-style bodies are { error }; some providers send [{ error }].
    const parsed = JSON.parse(text);
    const detail = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error;
    if (typeof detail === "string") error = { message: detail };
    else if (detail && typeof detail === "object") error = detail;
  } catch { /* Not JSON: summarize the text itself. */ }
  return providerErrorSummary(error);
}

// Models whose context window (input and output together) is smaller than a
// reply's usual budget. A request to one gets an output ceiling that fits,
// and one that cannot fit is not sent at all.
const CONTEXT_WINDOW_TOKENS = { "allam-2-7b": 4_096 };
const CONTEXT_MARGIN_TOKENS = 256;
const MIN_OUTPUT_TOKENS = 256;

export function outputTokenCeiling(model, messages, tools, maxTokens) {
  const window = CONTEXT_WINDOW_TOKENS[model];
  if (!window) return maxTokens;
  const room = window - requestTokenEstimate(messages, tools) - CONTEXT_MARGIN_TOKENS;
  if (room < MIN_OUTPUT_TOKENS) throw new ProviderStageError("context-too-large");
  return Math.min(maxTokens, room);
}

// Token counts the provider actually reported. A failed try without them is
// released, never settled: settling would refuse it as unconfirmed usage and
// hide the real failure.
function confirmedUsage(usage) {
  return [usage?.prompt_tokens ?? usage?.input_tokens, usage?.completion_tokens ?? usage?.output_tokens]
    .every((value) => Number.isSafeInteger(value) && value >= 0);
}

// The usage a successful reply is settled at. A reply that reached the user
// never becomes an error because its provider left out the token counts: it
// is settled at an estimate (the request and the reply, UTF-8 bytes / 3) and
// the gap is logged.
function successUsage(data, messages, tools, fields) {
  if (confirmedUsage(data.usage)) return data.usage;
  const estimate = { prompt_tokens: requestTokenEstimate(messages, tools), completion_tokens: replyTokenEstimate(data.choices?.[0]?.message) };
  writeInferenceLog("warn", "usage_unreported_on_success", { ...fields, ...estimate });
  data.usage = { ...data.usage, ...estimate, estimated: true };
  return data.usage;
}

class ProviderStageError extends Error {
  constructor(code, { status = null, retryable = false, retryDelayMs = null } = {}) {
    super(code);
    this.name = "ProviderStageError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryDelayMs = retryDelayMs;
  }
}

export const SEARCH_INTENT_MODEL = config.searchIntentModel;

// The routed tiers may use only their configured provider allow-lists
// (CHAT_NOVA_ROUTE_PROVIDERS, CHAT_NEBULA_ROUTE_PROVIDERS), which the router
// sorts by price on each call. An empty list leaves the tier unconfigured.
const privateRoute = (providers) => ({ only: [...providers], sort: "price", allow_fallbacks: true, data_collection: "deny" });
const lumenRoute = (provider, key, extra = {}) => ({
  provider,
  get model() { return config.chatModels[key]; },
  approved: () => lumenStageApproval(provider).approved,
  ...extra,
});

/* Data-policy gates for Lumen's stages. Each stage's provider receives the
   whole conversation, so it is used only after its training and retention
   terms have been reviewed, and only for the model that was reviewed: a
   fallback's approval names that model (CHAT_LUMEN_<STAGE>_APPROVED_MODEL),
   and changing the configured model revokes it. A model the provider picks
   for itself (auto, auto:free) can never be approved, since its terms cannot
   be known in advance. An unapproved stage is skipped without a request; with
   none approved, Lumen fails closed as unavailable. */
const LUMEN_STAGES = {
  primaryFree: { modelKey: "lumen", approval: () => ({ approved: config.lumenPrimaryApproved, model: config.lumenApprovals.primaryModel, pinRequired: false }) },
  gatewayFree: { modelKey: "lumenFallback1", approval: () => ({ ...config.lumenApprovals.gateway, pinRequired: true }) },
  secondaryFree: { modelKey: "lumenFallback2", approval: () => ({ ...config.lumenApprovals.secondary, pinRequired: true }) },
  reserveFree: { modelKey: "lumenFallback3", approval: () => ({ ...config.lumenApprovals.reserve, pinRequired: true }) },
};
const PROVIDER_SELECTED_MODEL = /^auto(?:$|[:/-])/i;

export function lumenStageApproval(stage) {
  const definition = LUMEN_STAGES[stage];
  const model = definition && config.chatModels[definition.modelKey];
  if (!model) return { approved: false, reason: "not-configured" };
  if (PROVIDER_SELECTED_MODEL.test(model)) return { approved: false, reason: "provider-selected-model" };
  const { approved, model: pinned, pinRequired } = definition.approval();
  if (!approved) return { approved: false, reason: "not-approved" };
  if (!pinned) return pinRequired ? { approved: false, reason: "model-not-pinned" } : { approved: true, reason: "approved-unpinned" };
  if (pinned !== model) return { approved: false, reason: "pinned-model-mismatch" };
  return { approved: true, reason: "approved" };
}

// The primary stage's provider also runs search intent, memory extraction
// and (on the shared key) moderation. Those send user text there too, so
// they need the same approval. Only the provider is approved here, not a
// model: each of those tasks uses a model of its own.
export function primaryProviderApproved() {
  return config.lumenPrimaryApproved === true;
}

// Each Lumen stage's policy state, for the boot log. Names only: no keys,
// URLs or model ids.
export function lumenPolicySummary() {
  return Object.keys(LUMEN_STAGES).map((stage) => ({
    stage,
    configured: Boolean(config.providerKeys[stage] && config.providerBaseUrls[stage] && config.chatModels[LUMEN_STAGES[stage].modelKey]),
    ...lumenStageApproval(stage),
  }));
}

export const MODEL_CONFIGS = {
  lumen: { displayName: "VibhavGPT Lumen", supportsVision: false, chain: [
    lumenRoute("primaryFree", "lumen", { supportsTools: false }),
    lumenRoute("gatewayFree", "lumenFallback1"),
    lumenRoute("secondaryFree", "lumenFallback2"),
    lumenRoute("reserveFree", "lumenFallback3"),
  ] },
  nova: { displayName: "VibhavGPT Nova", supportsVision: true, chain: [{
    provider: "paid", get model() { return config.chatModels.nova; },
    get providerRouting() { return privateRoute(config.routeProviders.nova); },
    approved: () => config.routeProviders.nova.length > 0,
  }] },
  study: { displayName: "VibhavGPT Study", supportsVision: true, chain: [{ provider: "study", get model() { return config.chatModels.study; } }] },
  nebula: { displayName: "VibhavGPT Nebula", supportsVision: true, chain: [{
    provider: "paid", get model() { return config.chatModels.nebula; },
    get providerRouting() { return privateRoute(config.routeProviders.nebula); },
    approved: () => config.nebulaDataPolicyVerified && config.routeProviders.nebula.length > 0,
  }] },
  vesper: { displayName: "VibhavGPT Vesper", supportsVision: true, chain: [{
    provider: "paid", get model() { return config.chatModels.vesper; },
    providerRouting: { allow_fallbacks: false, data_collection: "deny" },
  }] },
};

// The byline over a generated image, in the same "VibhavGPT <name>" form as
// the chat models above. It is a label only: not a model key, so nothing
// routes on it and the model picker never offers it.
export const IMAGE_DISPLAY_NAME = "VibhavGPT Image";

export function getModelConfig(modelKey) {
  if (modelKey === "spark") modelKey = "lumen";
  return MODEL_CONFIGS[modelKey] ?? MODEL_CONFIGS.lumen;
}

function checkRoute(entry) {
  if (!entry.model || (entry.approved && !entry.approved())) throw new ProviderStageError("route-not-configured");
}

function requestBody(entry, messages, tools, maxTokens, reasoning, extraBody = {}) {
  checkRoute(entry);
  const compatibleMessages = messages.map((message) => {
    if (entry.supportsTools === false && message.role === "tool") return { role: "system", content: `Trusted server tool result: ${message.content}` };
    if (!message.tool_calls) return message;
    if (entry.supportsTools === false) return { role: "assistant", content: message.content || `Requested tools: ${message.tool_calls.map((call) => call.function?.name).join(", ")}` };
    return { ...message, tool_calls: message.tool_calls.map((call) => {
      const { extra_content, ...standard } = call;
      return entry.provider === "reserveFree" ? call : standard;
    }) };
  });
  const body = { model: entry.model, messages: compatibleMessages, ...extraBody };
  if (entry.provider === "study") {
    body.max_completion_tokens = maxTokens;
    body.reasoning_effort = "none";
    body.store = false;
  } else {
    body.max_tokens = outputTokenCeiling(entry.model, compatibleMessages, entry.supportsTools === false ? undefined : tools, maxTokens);
    if (entry.providerRouting) body.provider = entry.providerRouting;
    // The paid tiers always send a reasoning setting the model accepts (see
    // reasoning-effort.js); Normal is a real level, never left to the model.
    // Thinking is billed whether or not it is returned, so it is returned and
    // streams to the user as live thinking; only internal steps that pass
    // reasoning: false hide it. Other routes send no reasoning parameter.
    if (entry.provider === "paid") {
      const parameter = reasoningParameter(entry.model, reasoning);
      if (parameter) body.reasoning = parameter;
    }
  }
  if (tools?.length && entry.supportsTools !== false) { body.tools = tools; body.tool_choice = "auto"; }
  return body;
}

function requestHeaders(entry, apiKey) {
  return { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json",
    ...(entry.provider === "gatewayFree" ? { "X-Free-Fallback": "false" } : {}) };
}

function visibleText(content) {
  if (typeof content !== "string") return "";
  // A reply that is only reasoning (in any envelope; see thought-filter.js)
  // is not a usable answer, so the chain can provide a proper one.
  return stripThoughts(content).trim();
}

function hasUsableResponse(data) {
  const message = data?.choices?.[0]?.message;
  const hasText = visibleText(message?.content).length > 0;
  const hasTools = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
  return hasText || hasTools;
}

function isProviderQuota(error, status) {
  if ([402, 429].includes(status) || [402, 429].includes(Number(error?.code))) return true;
  const detail = typeof error === "string" ? error : [error?.code, error?.type, error?.status, error?.message].filter(Boolean).join(" ");
  return /quota|rate[ _-]?limit|resource[ _-]?exhausted|insufficient[ _-]?(?:credits|balance)|credits[ _-]?(?:exhausted|depleted)/i.test(detail);
}

async function callProvider(
  entry,
  messages,
  tools,
  fetchImpl,
  maxTokens,
  reasoning,
  extraBody = {},
  { timeoutMs = 18_000, imageInput = false, signal } = {},
) {
  const apiKey = config.providerKeys[entry.provider];
  const endpoint = chatCompletionsUrl(entry.provider);
  if (!apiKey || !endpoint) throw new ProviderStageError("missing-credential");

  const body = requestBody(entry, messages, tools, maxTokens, reasoning, extraBody);

  let response;
  // The timeout also covers reading the body, so a long reply can be cut off
  // after the headers arrive; that must be reported as a timeout.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  try {
    const headers = requestHeaders(entry, apiKey);
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new ProviderStageError("client-aborted"), { inferenceStarted: true });
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw Object.assign(new ProviderStageError(timedOut ? "provider-timeout" : "provider-network-error", { retryable: true }), { inferenceStarted: true });
  }

  if (!response.ok) {
    const status = response.status;
    let retryDelayMs = null;
    if (status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const seconds = Number(retryAfter);
      const retryAt = Date.parse(retryAfter ?? "");
      if (Number.isFinite(seconds) && seconds >= 0) retryDelayMs = Math.ceil(seconds * 1_000);
      else if (Number.isFinite(retryAt)) retryDelayMs = Math.max(0, retryAt - Date.now());
    }
    const providerError = status >= 400 && status < 500 ? await rejectionSummary(response) : null;
    if (!providerError) void response.body?.cancel?.().catch(() => {});
    throw Object.assign(new ProviderStageError("provider-http-error", {
      status,
      retryable: status === 408 || status === 425 || status === 429 || status >= 500,
      retryDelayMs,
    }), { quotaExceeded: isProviderQuota(null, status), providerError });
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new ProviderStageError("client-aborted"), { inferenceStarted: true });
    if (timeoutSignal.aborted || error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw Object.assign(new ProviderStageError("provider-timeout", { retryable: true }), { inferenceStarted: true });
    }
    throw Object.assign(new ProviderStageError("provider-invalid-json", { retryable: false }), { inferenceStarted: true });
  }
  if (data?.error) {
    const quotaExceeded = isProviderQuota(data.error);
    throw Object.assign(new ProviderStageError(quotaExceeded ? "provider-quota" : "provider-response-error", { retryable: !quotaExceeded }), {
      quotaExceeded, inferenceStarted: !quotaExceeded, usage: data.usage,
    });
  }
  if (!hasUsableResponse(data)) {
    throw Object.assign(new ProviderStageError("provider-empty-response", { retryable: true }), { usage: data.usage, inferenceStarted: true });
  }
  return data;
}

export async function callSearchIntentModel(
  messages,
  { fetchImpl = fetch, maxTokens = 320, timeoutMs = 7_000, signal, requestId = "unknown" } = {},
) {
  // The message and its context go to the primary provider: only once its
  // data policy is approved. The caller falls back to the built-in rules.
  if (!primaryProviderApproved()) throw new ProviderStageError("route-not-configured");
  const data = await callProvider(
    { provider: "primaryFree", model: config.searchIntentModel },
    messages,
    undefined,
    fetchImpl,
    maxTokens,
    null,
    { reasoning_effort: "low", include_reasoning: false, response_format: { type: "json_object" } },
    { timeoutMs, maxRetries: 0, signal, requestId },
  );
  return { data, internalStage: "primaryFree" };
}

// The image prompt rewriter (generation/image-handoff.js): the same
// lightweight model and gate as the search-intent step, plain text out.
export async function callImagePromptModel(
  messages,
  { fetchImpl = fetch, maxTokens = 420, timeoutMs = 8_000, signal, requestId = "unknown" } = {},
) {
  if (!primaryProviderApproved()) throw new ProviderStageError("route-not-configured");
  const data = await callProvider(
    { provider: "primaryFree", model: config.searchIntentModel },
    messages,
    undefined,
    fetchImpl,
    maxTokens,
    null,
    { reasoning_effort: "low", include_reasoning: false },
    { timeoutMs, maxRetries: 0, signal, requestId },
  );
  return { data, internalStage: "primaryFree" };
}

export async function callModelWithFallback(
  modelKey,
  messages,
  tools,
  {
    fetchImpl = fetch,
    maxTokens = 2_048,
    reasoning = null,
    responseFormat,
    timeoutMs = 18_000,
    overallTimeoutMs = 90_000,
    deadlineAt = Date.now() + overallTimeoutMs,
    maxRetries = 1,
    imageInput = false,
    signal,
    requestId = "unknown",
    usageTracker,
  } = {},
) {
  const modelConfig = getModelConfig(modelKey);
  let attempts = 0;

  for (const entry of modelConfig.chain) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (signal?.aborted) throw new InferenceUnavailableError();
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        writeInferenceLog("warn", "inference_request_budget_exhausted", { requestId, attempts });
        throw new InferenceUnavailableError();
      }
      await usageTracker?.beforeCall(messages, tools, maxTokens);
      const startedAt = Date.now();
      let data;
      try {
        data = await callProvider(entry, messages, tools, fetchImpl, maxTokens, reasoning, responseFormat ? { response_format: responseFormat } : {}, {
          timeoutMs: Math.max(1, Math.min(timeoutMs, remainingMs)),
          imageInput,
          signal,
        });
      } catch (error) {
        if (confirmedUsage(error.usage)) await usageTracker?.record(error.usage);
        await usageTracker?.release();
        attempts += 1;
        let stageError = error;
        const code = /^[a-z0-9_.-]{1,60}$/i.test(String(stageError?.code ?? "")) ? stageError.code : "provider-error";
        writeInferenceLog("warn", "inference_stage_failed", {
          requestId,
          stage: entry.provider,
          status: Number.isInteger(stageError?.status) ? stageError.status : null,
          code,
          retryable: Boolean(stageError?.retryable),
          attempt: attempt + 1,
          elapsedMs: Date.now() - startedAt,
          providerStatus: Number.isInteger(stageError?.status) ? stageError.status : null,
          providerCode: stageError?.providerError?.code ?? null,
          providerMessage: stageError?.providerError?.message ?? null,
        });
        if (stageError?.code === "client-aborted" || signal?.aborted) throw new InferenceUnavailableError();

        const delayMs = stageError.retryDelayMs ?? (stageError.status === 429 ? 350 : 150);
        const canRetry = Boolean(stageError?.retryable)
          && !(modelConfig.chain.length > 1 && stageError.quotaExceeded)
          && attempt < maxRetries
          && deadlineAt - Date.now() > Math.max(1_000, delayMs)
          && delayMs <= 2_000;
        if (canRetry) {
          writeInferenceLog("info", "inference_stage_retry", { requestId, stage: entry.provider, code, status: stageError.status ?? null, attempt: attempt + 1, delayMs });
          await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, Math.max(0, deadlineAt - Date.now()))));
          continue;
        }
        break;
      }
      await usageTracker?.record(successUsage(data, messages, tools, { requestId, stage: entry.provider }));
      return { data, internalStage: entry.provider };
    }
  }

  writeInferenceLog("error", "inference_all_stages_failed", { requestId, attempts });
  throw new InferenceUnavailableError();
}

// Replies and documents stream instead of waiting for one big response.
// A non-streamed call has to finish the whole body inside a single timeout;
// a stream only fails when the provider goes quiet for idleTimeoutMs, so a
// reply that is still being written is never cut off for being long.
// onDelta receives visible text as it arrives. Returns the same { data }
// shape as callModelWithFallback, including any tool calls.
// Recover only finalized native usage, never an estimate or a running snapshot.
async function recoverStreamUsage(entry, generationId, usage, fetchImpl, { signal, deadlineAt } = {}) {
  if (entry.provider !== "paid" || !generationId || [usage?.prompt_tokens, usage?.completion_tokens].every(Number.isSafeInteger)) return usage;
  // Generation metadata can become visible after the stream has ended. A
  // single immediate lookup can return 404 or a still-running snapshot.
  // Retry that lookup, not inference; use only finalized native token counts.
  const recoveryDeadline = Math.min(Date.now() + 5_000, deadlineAt ?? Infinity);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (signal?.aborted || Date.now() >= recoveryDeadline) break;
    try {
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(1_500, recoveryDeadline - Date.now())));
      const response = await fetchImpl(`${config.providerBaseUrls.paid}/generation?id=${encodeURIComponent(generationId)}`, {
        headers: requestHeaders(entry, config.providerKeys[entry.provider]), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (response.ok) {
        const { data } = await response.json();
        if ((data?.finish_reason || data?.native_finish_reason || data?.cancelled === true)
          && [data?.native_tokens_prompt, data?.native_tokens_completion].every((n) => Number.isSafeInteger(n) && n >= 0)) {
          return { prompt_tokens: data.native_tokens_prompt, completion_tokens: data.native_tokens_completion };
        }
      } else {
        void response.body?.cancel?.().catch(() => {});
        if (![404, 429].includes(response.status) && response.status < 500) break;
      }
    } catch { /* A transient lookup failure can recover within the same budget. */ }
    if (attempt < 5 && !signal?.aborted) {
      const delay = Math.min(250 * 2 ** attempt, recoveryDeadline - Date.now());
      if (delay <= 0) break;
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, delay);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }
  return usage;
}

async function streamOnce(entry, messages, tools, {
  fetchImpl, maxTokens, reasoning, responseFormat, idleTimeoutMs, firstOutputTimeoutMs = idleTimeoutMs, deadlineAt, imageInput, signal, onDelta, onReasoning,
}) {
  const apiKey = config.providerKeys[entry.provider];
  const endpoint = chatCompletionsUrl(entry.provider);
  if (!apiKey || !endpoint) throw new ProviderStageError("missing-credential");
  const body = requestBody(entry, messages, tools, maxTokens, reasoning, { stream: true, stream_options: { include_usage: true }, ...(responseFormat ? { response_format: responseFormat } : {}) });
  const startedAt = Date.now();
  const controller = new AbortController();
  let stopReason = null;
  let reader = null;
  // Cancel the read as well as the request, so a body that ignores the
  // abort still ends.
  const stop = (reason) => { stopReason ??= reason; controller.abort(); void reader?.cancel().catch(() => {}); };
  const overallTimer = setTimeout(() => stop("provider-timeout"), Math.max(1, deadlineAt - Date.now()));
  let idleTimer = setTimeout(() => stop("provider-stalled"), idleTimeoutMs);
  // A shorter wait for the first text or tool call. Empty chunks do not count.
  const firstOutputTimer = firstOutputTimeoutMs < idleTimeoutMs ? setTimeout(() => stop("provider-stalled"), firstOutputTimeoutMs) : null;
  const onClientAbort = () => stop("client-aborted");
  if (signal?.aborted) stop("client-aborted");
  signal?.addEventListener("abort", onClientAbort, { once: true });
  const state = { content: "", firstTokenMs: null, firstOutputMs: null, firstReasoningMs: null, delivered: 0 };
  const outputArrived = () => {
    if (state.firstOutputMs !== null) return;
    state.firstOutputMs = Date.now() - startedAt;
    clearTimeout(firstOutputTimer);
  };
  let finishReason = null;
  let generationId = null;
  let usage = {};
  let inferenceStarted = false;
  const toolCalls = [];
  try {
    inferenceStarted = true;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: requestHeaders(entry, apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      inferenceStarted = false;
      const status = response.status;
      const providerError = status >= 400 && status < 500 ? await rejectionSummary(response) : null;
      if (!providerError) void response.body?.cancel?.().catch(() => {});
      throw Object.assign(new ProviderStageError("provider-http-error", { status, retryable: status === 408 || status === 429 || status >= 500 }), { quotaExceeded: isProviderQuota(null, status), providerError });
    }
    if (response.headers.get("content-type")?.includes("application/json")) {
      const data = await response.json();
      const quotaExceeded = isProviderQuota(data?.error);
      if (quotaExceeded) inferenceStarted = false;
      throw Object.assign(new ProviderStageError(quotaExceeded ? "provider-quota" : "provider-invalid-stream", { retryable: true }), { quotaExceeded, providerError: providerErrorSummary(data?.error) });
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (stopReason) break;
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        // Keep-alives are not progress.
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        if (chunk.id) generationId = chunk.id;
        if (chunk.error) {
          const status = Number.isInteger(chunk.error.code) ? chunk.error.code : null;
          const quotaExceeded = isProviderQuota(chunk.error, status);
          // A quota rejection before any output never began billable inference.
          // Do not turn it into an unknown-usage hold that stops the chain.
          if (quotaExceeded && !state.content && !toolCalls.length) inferenceStarted = false;
          throw Object.assign(new ProviderStageError("provider-stream-error", { status, retryable: true }), { quotaExceeded, providerError: providerErrorSummary(chunk.error) });
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => stop("provider-stalled"), idleTimeoutMs);
        const choice = chunk.choices?.[0];
        // Streamed thinking (delta.reasoning_details) shows the model is
        // working: it ends the first-output wait, but it is never part of the
        // reply or counted as output. Readable thinking (text and summary
        // details) goes to onReasoning; encrypted details are never shown.
        if (Array.isArray(choice?.delta?.reasoning_details) && choice.delta.reasoning_details.length) {
          state.firstReasoningMs ??= Date.now() - startedAt;
          clearTimeout(firstOutputTimer);
          for (const detail of choice.delta.reasoning_details) {
            const text = detail?.type === "reasoning.text" ? detail.text : detail?.type === "reasoning.summary" ? detail.summary : null;
            if (typeof text === "string" && text) onReasoning?.(text);
          }
        }
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta) {
          outputArrived();
          state.firstTokenMs ??= Date.now() - startedAt;
          state.content += delta;
          if (onDelta) state.delivered += onDelta(delta, state.content) ? delta.length : 0;
        }
        for (const call of choice?.delta?.tool_calls ?? []) {
          outputArrived();
          const index = Number.isInteger(call.index) ? call.index : toolCalls.length;
          toolCalls[index] ??= { id: call.id, type: "function", function: { name: "", arguments: "" } };
          if (call.id) toolCalls[index].id = call.id;
          if (call.function?.name) toolCalls[index].function.name += call.function.name;
          if (call.function?.arguments) toolCalls[index].function.arguments += call.function.arguments;
          if (typeof call.extra_content?.google?.thought_signature === "string") toolCalls[index].extra_content = { google: { thought_signature: call.extra_content.google.thought_signature } };
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) usage = chunk.usage;
      }
      if (done) break;
    }
    if (stopReason) throw new ProviderStageError(stopReason, { retryable: stopReason === "provider-stalled" });
    if (!finishReason) throw new ProviderStageError("provider-stream-incomplete", { retryable: true });
  } catch (error) {
    const stageError = error instanceof ProviderStageError ? error
      : new ProviderStageError(stopReason ?? "provider-network-error", { retryable: stopReason !== "client-aborted" });
    if (stopReason) stageError.code = stopReason;
    // A stall before any output is released, not charged, so its usage
    // lookup would only delay the retry.
    const stalledBeforeOutput = stopReason === "provider-stalled" && !state.content && !toolCalls.length;
    if (!stalledBeforeOutput) usage = await recoverStreamUsage(entry, generationId, usage, fetchImpl, { signal, deadlineAt });
    Object.assign(stageError, { usage, inferenceStarted, elapsedMs: Date.now() - startedAt, firstTokenMs: state.firstTokenMs,
      receivedChars: state.content.length, receivedToolCalls: toolCalls.length, delivered: state.delivered > 0 });
    throw stageError;
  } finally {
    clearTimeout(overallTimer);
    clearTimeout(idleTimer);
    clearTimeout(firstOutputTimer);
    signal?.removeEventListener("abort", onClientAbort);
  }
  usage = await recoverStreamUsage(entry, generationId, usage, fetchImpl, { signal, deadlineAt });
  const message = { role: "assistant", content: state.content };
  const calls = toolCalls.filter((call) => call?.function?.name);
  if (calls.length) message.tool_calls = calls;
  const data = { choices: [{ message, finish_reason: finishReason }], usage };
  if (!hasUsableResponse(data)) throw Object.assign(new ProviderStageError("provider-empty-response", { retryable: true }), { delivered: state.delivered > 0, usage, inferenceStarted: true });
  return { data, elapsedMs: Date.now() - startedAt, firstTokenMs: state.firstTokenMs, firstOutputMs: state.firstOutputMs, firstReasoningMs: state.firstReasoningMs };
}

// A stall, a transient 5xx, or a provider error event in the stream, before
// any text or tool call reached us, is safe to try again: the user has seen
// nothing, and the try is not charged.
const START_RETRY_DELAYS_MS = [500, 1_000];
const SINGLE_ROUTE_START_RETRIES = 2;

function failedBeforeOutput(error) {
  if (error?.delivered || error?.receivedChars || error?.receivedToolCalls) return false;
  if (error?.code === "provider-stalled") return true;
  const transientStatus = error?.status >= 500 || error?.status === 408;
  if (error?.code === "provider-stream-error") return !error.quotaExceeded && (error.status == null || transientStatus);
  return error?.code === "provider-http-error" && transientStatus;
}

function pause(ms, signal) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

// Walk explicitly configured routes; providers never choose an unlisted fallback.
export async function callModelStreaming(modelKey, messages, tools, {
  fetchImpl = fetch, maxTokens = 2_048, reasoning = null, responseFormat,
  idleTimeoutMs = 25_000, firstOutputTimeoutMs = idleTimeoutMs, overallTimeoutMs = 120_000,
  deadlineAt = Date.now() + overallTimeoutMs, maxRetries = 1, startRetryDelaysMs = START_RETRY_DELAYS_MS,
  imageInput = false, signal, onDelta, onReset, onReasoning, onRetry, requestId = "unknown", usageTracker,
} = {}) {
  const chain = getModelConfig(modelKey).chain;
  const requestStartedAt = Date.now();
  let stageCode = "provider-error";
  let attempts = 0;
  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index];
    const lastRoute = index + 1 === chain.length;
    // A tier with one route gets two more tries when it fails before any
    // output. A chain with fallback routes keeps walking its routes instead.
    const startRetries = chain.length === 1 ? Math.max(maxRetries, SINGLE_ROUTE_START_RETRIES) : maxRetries;
    for (let attempt = 0; attempt <= startRetries; attempt += 1) {
      if (signal?.aborted || deadlineAt <= Date.now()) throw new InferenceUnavailableError();
      // Only the last possible try waits the full idle time for its first output.
      const waitForFirstOutputMs = (lastRoute && attempt === startRetries) ? idleTimeoutMs : firstOutputTimeoutMs;
      await usageTracker?.beforeCall(messages, tools, maxTokens);
      attempts += 1;
      let result;
      try {
        result = await streamOnce(entry, messages, tools, { fetchImpl, maxTokens, reasoning, responseFormat, idleTimeoutMs,
          firstOutputTimeoutMs: waitForFirstOutputMs, deadlineAt, imageInput, signal, onDelta, onReasoning });
      } catch (error) {
        const code = /^[a-z0-9_.-]{1,60}$/i.test(String(error?.code ?? "")) ? error.code : "provider-error";
        stageCode = code;
        writeInferenceLog("warn", "inference_stream_failed", { requestId, stage: entry.provider, code, status: error?.status ?? null, attempt: attempt + 1,
          elapsedMs: error?.elapsedMs ?? null, receivedChars: error?.receivedChars ?? 0, providerStatus: Number.isInteger(error?.status) ? error.status : null,
          providerCode: error?.providerError?.code ?? null, providerMessage: error?.providerError?.message ?? null });
        if (failedBeforeOutput(error)) {
          await usageTracker?.release();
          if (signal?.aborted || deadlineAt <= Date.now()) throw new InferenceUnavailableError();
          const delayMs = startRetryDelaysMs[Math.min(attempt, startRetryDelaysMs.length - 1)] ?? 0;
          const nextWaitMs = (lastRoute && attempt + 1 === startRetries) ? idleTimeoutMs : firstOutputTimeoutMs;
          if (attempt < startRetries && deadlineAt - Date.now() > delayMs + nextWaitMs) {
            writeInferenceLog("info", "inference_retry", { requestId, stage: entry.provider, attempt: attempts, reason: code,
              status: error?.status ?? null, elapsedMs: error?.elapsedMs ?? null, delayMs });
            onRetry?.({ attempt: attempt + 2, maxAttempts: startRetries + 1, reason: code });
            await pause(delayMs, signal);
            continue;
          }
          if (!lastRoute) break;
          writeInferenceLog("error", "inference_exhausted", { requestId, attempts, reason: code, totalElapsedMs: Date.now() - requestStartedAt });
          throw Object.assign(new InferenceUnavailableError(), { stageCode: code, exhausted: true });
        }
        if (confirmedUsage(error.usage)) await usageTracker?.record(error.usage);
        await usageTracker?.release();
        if (code === "client-aborted" || signal?.aborted || deadlineAt <= Date.now()) throw new InferenceUnavailableError();
        // A second model must replace a partial answer, never append to it.
        if (error?.delivered) {
          if (!onReset || index + 1 === chain.length) throw Object.assign(new InferenceUnavailableError(), { stageCode: code });
          await onReset();
          break;
        }
        const canRetry = attempt < maxRetries && error?.retryable && !(chain.length > 1 && error.quotaExceeded) && deadlineAt - Date.now() > 20_000;
        if (canRetry) {
          writeInferenceLog("info", "inference_stream_retry", { requestId, stage: entry.provider, code, attempt: attempt + 1 });
          continue;
        }
        break;
      }
      // Accounting failures stop the request rather than silently trying
      // another model. Missing token counts are not one: see successUsage.
      await usageTracker?.record(successUsage(result.data, messages, tools, { requestId, stage: entry.provider }));
      writeInferenceLog("info", "inference_stream_completed", { requestId, stage: entry.provider, attempt: attempt + 1, attempts,
        elapsedMs: result.elapsedMs, firstTokenMs: result.firstTokenMs, firstOutputMs: result.firstOutputMs, firstReasoningMs: result.firstReasoningMs,
        completionTokens: result.data.usage?.completion_tokens ?? null, finishReason: result.data.choices[0].finish_reason });
      return { data: result.data, internalStage: entry.provider };
    }
  }
  throw Object.assign(new InferenceUnavailableError(), { stageCode });
}
