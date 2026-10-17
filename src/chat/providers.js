import { config } from "../config.js";

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
  ...extra,
});
export const MODEL_CONFIGS = {
  lumen: { displayName: "VibhavGPT Lumen", supportsVision: false, chain: [
    lumenRoute("primaryFree", "lumen", { approved: () => config.lumenPrimaryApproved, supportsTools: false }),
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
    provider: "paid", get model() { return config.chatModels.nebula; }, defaultReasoning: false,
    get providerRouting() { return privateRoute(config.routeProviders.nebula); },
    approved: () => config.nebulaDataPolicyVerified && config.routeProviders.nebula.length > 0,
  }] },
  vesper: { displayName: "VibhavGPT Vesper", supportsVision: true, chain: [{
    provider: "paid", get model() { return config.chatModels.vesper; },
    providerRouting: { allow_fallbacks: false, data_collection: "deny" },
  }] },
};

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
    body.max_tokens = maxTokens;
    if (entry.providerRouting) body.provider = entry.providerRouting;
    if (entry.provider === "paid" && (reasoning === false || (reasoning == null && entry.defaultReasoning === false))) body.reasoning = { enabled: false, exclude: true };
    else if (entry.provider === "paid" && reasoning) body.reasoning = { effort: reasoning, exclude: true };
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
  const trimmed = content.trim();
  if (!trimmed.startsWith("<think>")) return trimmed;
  const closing = trimmed.indexOf("</think>");
  // An unfinished reasoning block is not a user-facing answer. Treat it as
  // unusable so the fallback chain can provide a proper final response.
  return closing === -1 ? "" : trimmed.slice(closing + "</think>".length).trim();
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
    void response.body?.cancel?.().catch(() => {});
    throw Object.assign(new ProviderStageError("provider-http-error", {
      status,
      retryable: status === 408 || status === 425 || status === 429 || status >= 500,
      retryDelayMs,
    }), { quotaExceeded: isProviderQuota(null, status) });
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
        if ((error.usage && Object.keys(error.usage).length) || error.inferenceStarted) await usageTracker?.record(error.usage);
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
      await usageTracker?.record(data.usage);
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
  fetchImpl, maxTokens, reasoning, responseFormat, idleTimeoutMs, deadlineAt, imageInput, signal, onDelta,
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
  const onClientAbort = () => stop("client-aborted");
  if (signal?.aborted) stop("client-aborted");
  signal?.addEventListener("abort", onClientAbort, { once: true });
  const state = { content: "", firstTokenMs: null, delivered: 0 };
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
      void response.body?.cancel?.().catch(() => {});
      const status = response.status;
      throw Object.assign(new ProviderStageError("provider-http-error", { status, retryable: status === 408 || status === 429 || status >= 500 }), { quotaExceeded: isProviderQuota(null, status) });
    }
    if (response.headers.get("content-type")?.includes("application/json")) {
      const data = await response.json();
      const quotaExceeded = isProviderQuota(data?.error);
      if (quotaExceeded) inferenceStarted = false;
      throw Object.assign(new ProviderStageError(quotaExceeded ? "provider-quota" : "provider-invalid-stream", { retryable: true }), { quotaExceeded });
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
          throw Object.assign(new ProviderStageError("provider-stream-error", { status, retryable: true }), { quotaExceeded });
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => stop("provider-stalled"), idleTimeoutMs);
        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta) {
          state.firstTokenMs ??= Date.now() - startedAt;
          state.content += delta;
          if (onDelta) state.delivered += onDelta(delta, state.content) ? delta.length : 0;
        }
        for (const call of choice?.delta?.tool_calls ?? []) {
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
    usage = await recoverStreamUsage(entry, generationId, usage, fetchImpl, { signal, deadlineAt });
    Object.assign(stageError, { usage, inferenceStarted, elapsedMs: Date.now() - startedAt, firstTokenMs: state.firstTokenMs, receivedChars: state.content.length, delivered: state.delivered > 0 });
    throw stageError;
  } finally {
    clearTimeout(overallTimer);
    clearTimeout(idleTimer);
    signal?.removeEventListener("abort", onClientAbort);
  }
  usage = await recoverStreamUsage(entry, generationId, usage, fetchImpl, { signal, deadlineAt });
  const message = { role: "assistant", content: state.content };
  const calls = toolCalls.filter((call) => call?.function?.name);
  if (calls.length) message.tool_calls = calls;
  const data = { choices: [{ message, finish_reason: finishReason }], usage };
  if (!hasUsableResponse(data)) throw Object.assign(new ProviderStageError("provider-empty-response", { retryable: true }), { delivered: state.delivered > 0, usage, inferenceStarted: true });
  return { data, elapsedMs: Date.now() - startedAt, firstTokenMs: state.firstTokenMs };
}

// Walk explicitly configured routes; providers never choose an unlisted fallback.
export async function callModelStreaming(modelKey, messages, tools, {
  fetchImpl = fetch, maxTokens = 2_048, reasoning = null, responseFormat,
  idleTimeoutMs = 25_000, overallTimeoutMs = 120_000,
  deadlineAt = Date.now() + overallTimeoutMs, maxRetries = 1,
  imageInput = false, signal, onDelta, onReset, requestId = "unknown", usageTracker,
} = {}) {
  const chain = getModelConfig(modelKey).chain;
  let stageCode = "provider-error";
  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index];
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (signal?.aborted || deadlineAt <= Date.now()) throw new InferenceUnavailableError();
      await usageTracker?.beforeCall(messages, tools, maxTokens);
      let result;
      try {
        result = await streamOnce(entry, messages, tools, { fetchImpl, maxTokens, reasoning, responseFormat, idleTimeoutMs, deadlineAt, imageInput, signal, onDelta });
      } catch (error) {
        const code = /^[a-z0-9_.-]{1,60}$/i.test(String(error?.code ?? "")) ? error.code : "provider-error";
        stageCode = code;
        writeInferenceLog("warn", "inference_stream_failed", { requestId, stage: entry.provider, code, status: error?.status ?? null, attempt: attempt + 1,
          elapsedMs: error?.elapsedMs ?? null, receivedChars: error?.receivedChars ?? 0 });
        if ((error.usage && Object.keys(error.usage).length) || error.inferenceStarted) await usageTracker?.record(error.usage);
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
      // Accounting failures stop the request rather than silently trying another model.
      await usageTracker?.record(result.data.usage);
      writeInferenceLog("info", "inference_stream_completed", { requestId, stage: entry.provider, attempt: attempt + 1,
        elapsedMs: result.elapsedMs, firstTokenMs: result.firstTokenMs,
        completionTokens: result.data.usage?.completion_tokens ?? null, finishReason: result.data.choices[0].finish_reason });
      return { data: result.data, internalStage: entry.provider };
    }
  }
  throw Object.assign(new InferenceUnavailableError(), { stageCode });
}
