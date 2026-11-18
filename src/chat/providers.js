import { config, TECTON_MODEL } from "../config.js";
import { redactSensitive } from "../../frontend/src/sentry-scrub.js";
import { isTelemetryStatus, readBoundedBody, requestTextOf, upstreamFailureRecord } from "./upstream-telemetry.js";
import { replyTokenEstimate, requestTokenEstimate } from "./context-window.js";
import { stripThoughts } from "./thought-filter.js";
import { reasoningParameter } from "./reasoning-effort.js";
import { recordShadowCostEvent } from "../usage/shadow-ledger.js";
import { findSeedModelByKey } from "../models/seed-catalog.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { lumenGatewayPolicyState } from "./lumen-gateway-guard.js";
import { routeAllowed } from "./route-inventory.js";
import { marketplaceCandidate, marketplaceListing } from "../models/marketplace.js";
import { thirdPartyModel } from "../../frontend/src/model-marketplace.js";
import { noteUpstreamStatus } from "./capacity-context.js";

export const resolveProviderTarget = (entry) => {
  if (entry?.transport === "router" || entry?.provider === "paid") {
    const base = config.providerBaseUrls.paid?.trim?.();
    const apiKey = config.providerKeys.paid?.trim?.();
    if (!base || !apiKey) {
      return { base: undefined, apiKey: undefined };
    }
    return { base, apiKey };
  }

  // An entry may name another stage's connection to reuse (its base URL and credential) while keeping its own request behaviour:
  // the GPT-6 marketplace models use Study's direct connection (connection: "study") but are not Study (provider: "direct").
  const stage = entry?.connection ?? entry?.provider;
  const stageBase = config.providerBaseUrls[stage];
  const stageApiKey = config.providerKeys[stage];
  const base = typeof stageBase === "string" ? stageBase.trim() : stageBase;
  const apiKey = typeof stageApiKey === "string" ? stageApiKey.trim() : stageApiKey;
  return { base, apiKey };
};

// Each stage's endpoint is its configured base URL plus the standard
// chat-completions path, or /responses for endpoints using the Responses API;
// an unconfigured stage is skipped like a missing key.
export const providerEndpointUrl = (entry) => {
  const { base } = resolveProviderTarget(entry);
  if (!base) return undefined;
  if (entry?.api === "responses") {
    return `${base}/responses`;
  }
  return `${base}/chat/completions`;
};

const chatCompletionsUrl = (stage) => providerEndpointUrl({ provider: stage });

export const providerApiKey = (entry) => {
  const { apiKey } = resolveProviderTarget(entry);
  return apiKey;
};

export class InferenceUnavailableError extends Error {
  constructor() {
    super("VibhavGPT is temporarily unavailable. Please try again shortly.");
    this.code = "inference-unavailable";
    this.status = 503;
  }
}

/** The tier was requested with tools, but every usable stage has supportsTools: false. */
export class ToolsUnsupportedError extends Error {
  constructor(modelKey) {
    const label = { lumen: "Lumen", vesper: "Vulcan", zenith: "Zenith", tecton: "Tecton" }[modelKey] || "This model";
    // Which models can run connector actions depends on the plan, so the message names none (it once named Nova, now retired).
    super(`${label} can't run connector actions. Choose another model in the model picker to use the selected connector.`);
    this.code = "tools-unsupported";
    this.modelKey = modelKey;
    this.status = 409;
  }
}

export function toolCapableEntries(chain, tools) {
  if (!tools?.length) return chain;
  return chain.filter((entry) => entry.supportsTools !== false);
}

function writeInferenceLog(level, event, fields) {
  console[level](JSON.stringify({ event, ...fields }));
}

// The environment variable that holds the credential a chain entry sends (resolveProviderTarget): a name only, never its value.
const CREDENTIAL_VARIABLES = Object.freeze({
  primaryFree: "INFERENCE_PRIMARY_API_KEY", gatewayFree: "INFERENCE_GATEWAY_API_KEY", secondaryFree: "INFERENCE_SECONDARY_API_KEY",
  reserveFree: "INFERENCE_RESERVE_API_KEY", paid: "INFERENCE_ROUTER_API_KEY", study: "INFERENCE_DIRECT_API_KEY", direct: "INFERENCE_DIRECT_API_KEY",
  google: "GEMINI_API_KEY",
});
export function credentialVariable(entry) {
  if (entry?.transport === "router" || entry?.provider === "paid") return CREDENTIAL_VARIABLES.paid;
  return CREDENTIAL_VARIABLES[entry?.connection ?? entry?.provider] ?? null;
}
// A 401 or 403 from a provider is its verdict on the credential this server sent (the router answers "User not found." for a key it
// does not recognise), not an outage and not this request's fault: every route on that credential fails the same way until the key is
// replaced. Logged once per failure, distinctly, so it is never read as a capacity problem. Not retried; nothing is charged.
export function isCredentialRejection(error) {
  return error?.code === "provider-http-error" && (error?.status === 401 || error?.status === 403);
}
function noteCredentialRejection(error, entry, { requestId, modelKey }) {
  if (!isCredentialRejection(error)) return;
  writeInferenceLog("error", "inference_credential_rejected", {
    requestId, modelKey: modelKey ?? null, stage: entry?.provider ?? null, transport: entry?.transport ?? null, status: error.status,
    credential: credentialVariable(entry), providerMessage: error?.providerError?.message ?? null,
  });
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
async function failedResponseDetail(response, requestBody = null) {
  const status = response.status;
  if (!isTelemetryStatus(status)) {
    const providerError = status >= 400 && status < 500 ? await rejectionSummary(response) : null;
    if (!providerError) void response.body?.cancel?.().catch(() => { });
    return { providerError, upstream: null };
  }
  const bodyText = await readBoundedBody(response);
  return {
    // As before: a 4xx (here a 429) has its short summary; a 5xx body is not used as the stage's error.
    providerError: status < 500 ? summaryFromText(bodyText) : null,
    upstream: upstreamFailureRecord({ status, headers: response.headers, bodyText, requestText: requestTextOf(requestBody) }),
  };
}

async function rejectionSummary(response) {
  return summaryFromText(await readBoundedBody(response));
}

function summaryFromText(text) {
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
// Engines with a small context window: the reply's room is what is left after the request. Tecton's engine holds 32,768 tokens (its one
// host's published context length); the shared input budget (context-window.js, 24,000 estimated tokens) already fits under it.
const CONTEXT_WINDOW_TOKENS = { "allam-2-7b": 4_096, [TECTON_MODEL]: 32_768 };
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

/* Data-policy gates for Lumen's stages. Each stage's provider receives the
   whole conversation, so it is used only after its training and retention
   terms have been reviewed, and only for the model that was reviewed: a
   fallback's approval names that model (CHAT_LUMEN_<STAGE>_APPROVED_MODEL),
   and changing the configured model revokes it. A model the provider picks
   for itself (auto, auto:free, openrouter/free) can never be approved, since its terms cannot
   be known in advance. An unapproved stage is skipped without a request; with
   none approved, Lumen fails closed as unavailable. */
const LUMEN_STAGES = {
  primaryFree: { modelKey: "lumen", approval: () => ({ approved: config.lumenPrimaryApproved, model: config.lumenApprovals.primaryModel, pinRequired: false }) },
  gatewayFree: { modelKey: "lumenFallback1", approval: () => ({ ...config.lumenApprovals.gateway, pinRequired: true }) },
  secondaryFree: { modelKey: "lumenFallback2", approval: () => ({ ...config.lumenApprovals.secondary, pinRequired: true }) },
  reserveFree: { modelKey: "lumenFallback3", approval: () => ({ ...config.lumenApprovals.reserve, pinRequired: true }) },
};
const PROVIDER_SELECTED_MODEL = /^(?:auto(?:$|[:/-])|openrouter\/free(?:$|[:/-]))/i;

export function lumenStageApproval(stage) {
  const definition = LUMEN_STAGES[stage];
  const model = definition && config.chatModels[definition.modelKey];
  if (!model) return { approved: false, reason: "not-configured" };
  if (PROVIDER_SELECTED_MODEL.test(model)) return { approved: false, reason: "provider-selected-model" };
  const { approved, model: pinned, pinRequired } = definition.approval();
  if (!approved) return { approved: false, reason: "not-approved" };
  if (!pinned) return pinRequired ? { approved: false, reason: "model-not-pinned" } : { approved: true, reason: "approved-unpinned" };
  if (pinned !== model) return { approved: false, reason: "pinned-model-mismatch" };
  // The gateway also needs the live policy check (lumen-gateway-guard.js): until it has verified this model on this provider, and
  // within the last two hours, the stage is closed. Nothing is sent while the policy is unverified.
  if (stage === "gatewayFree" && config.lumenChatRoute !== "staged") {
    const policy = lumenGatewayPolicyState({ model, provider: config.lumenGatewayProvider });
    if (!policy.verified) return { approved: false, reason: `policy-${policy.reason}` };
  }
  return { approved: true, reason: "approved" };
}

// Lumen chat runs on the gateway alone (owner decision, Slice 4): one free endpoint on the router, pinned to one provider, no
// fallbacks of any kind. The primary stage still runs search intent, memory extraction and moderation (primaryProviderApproved).
export const LUMEN_CHAT_STAGE = "gatewayFree";
const lumenRoute = (provider, key, extra = {}) => ({
  provider,
  get model() { return config.chatModels[key]; },
  approved: () => lumenStageApproval(provider).approved,
  ...extra,
});
const lumenGatewayRoute = () => ({
  provider: "gatewayFree",
  transport: "router",
  get model() { return config.chatModels.lumenFallback1; },
  approved: () => lumenStageApproval("gatewayFree").approved,
  // Lumen stays as it was: no tools (memory is saved by extraction, as before) and no reasoning parameter.
  supportsTools: false,
  supportsReasoning: false,
  // No data_collection flag: "deny" would exclude this provider's retaining endpoint. Training protection is the single pinned
  // provider, no fallbacks, and the live guard requiring training: false for it.
  get providerRouting() { return { order: [config.lumenGatewayProvider], allow_fallbacks: false }; },
  // The provider asks for a per-user id; it gets a keyed hash of the account id, never the id or email (see inferenceUserHash).
  sendsUserHash: true,
});

// Lumen on paid zero-retention hosts (CHAT_LUMEN_ROUTE=paid-zdr; owner-gated, off by default). The same Gemma instruct model, pinned to
// the configured hosts in order, no fallbacks, and no data_collection flag: the guard has already required, from each host's live
// policy, training: false and no retention. On the router's paid path, so its cost is recovered and recorded like any paid route.
// Closed until the guard has verified it (strict gate); Lumen still never moves to another tier.
const lumenPaidZdrRoute = () => ({
  provider: "paid",
  transport: "router",
  get model() { return config.lumenPaidZdrModel; },
  approved: () => config.lumenPaidZdrProviders.length > 0 && routeAllowed("lumen"),
  supportsTools: false,
  supportsReasoning: false,
  get providerRouting() { return { order: [...config.lumenPaidZdrProviders], only: [...config.lumenPaidZdrProviders], allow_fallbacks: false }; },
});

// The account a chat request is for, set once per request by the chat route, so the gateway can send its pseudonymous user hash.
const inferenceUser = new AsyncLocalStorage();
export function runWithInferenceUser(userId, fn) {
  return inferenceUser.run({ userId: userId ? String(userId) : null }, fn);
}
// Stable per account, not reversible without the server secret, and different from any id used anywhere else.
export function inferenceUserHash(userId = inferenceUser.getStore()?.userId) {
  if (!userId || !config.authSecret) return null;
  return `u_${createHmac("sha256", config.authSecret).update(`lumen-gateway-user:${userId}`).digest("hex").slice(0, 32)}`;
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
    configured: Boolean((stage === LUMEN_CHAT_STAGE && config.lumenChatRoute !== "staged" ? (resolveProviderTarget({ transport: "router" }).apiKey && resolveProviderTarget({ transport: "router" }).base) : (config.providerKeys[stage] && config.providerBaseUrls[stage])) && config.chatModels[LUMEN_STAGES[stage].modelKey]),
    ...lumenStageApproval(stage),
  }));
}

// The route Lumen chat actually uses now (CHAT_LUMEN_ROUTE), and whether it can serve: configured, and approved by its own guard. For
// the boot log, so "lumenAvailable" describes the active route rather than one stage of another route. Names and yes/no only.
export function lumenActiveRouteState() {
  const route = config.lumenChatRoute;
  if (route === "paid-zdr") {
    const target = resolveProviderTarget({ transport: "router" });
    const configured = Boolean(target.apiKey && target.base && config.lumenPaidZdrModel && config.lumenPaidZdrProviders.length);
    const approved = configured && routeAllowed("lumen");
    return { route, configured, approved, reason: !configured ? "not-configured" : approved ? "verified" : "policy-unverified" };
  }
  const stages = lumenPolicySummary();
  const serving = route === "staged" ? stages : stages.filter((stage) => stage.stage === LUMEN_CHAT_STAGE);
  const ready = serving.find((stage) => stage.configured && stage.approved);
  const first = serving[0] ?? { configured: false, reason: "not-configured" };
  return { route, configured: serving.some((stage) => stage.configured), approved: Boolean(ready), reason: ready ? ready.reason : first.configured ? first.reason : "not-configured" };
}

export const MODEL_CONFIGS = {
  lumen: {
    displayName: "VibhavGPT Lumen", supportsVision: false,
    get chain() {
      if (config.lumenChatRoute === "paid-zdr") return [lumenPaidZdrRoute()];
      if (config.lumenChatRoute !== "staged") return [lumenGatewayRoute()];
      // The previous four-stage chain, only when the owner sets CHAT_LUMEN_ROUTE=staged.
      return [
        lumenRoute("primaryFree", "lumen", { supportsTools: false }),
        lumenRoute("gatewayFree", "lumenFallback1"),
        lumenRoute("secondaryFree", "lumenFallback2"),
        lumenRoute("reserveFree", "lumenFallback3"),
      ];
    }
  },
  nova: {
    displayName: "VibhavGPT Nova", supportsVision: true, chain: [{
      provider: "paid", get model() { return config.chatModels.nova; },
      get providerRouting() { return privateRoute(config.routeProviders.nova); },
      // The route-policy guard (route-inventory.js) closes it only on evidence that none of its hosts may receive text.
      approved: () => config.routeProviders.nova.length > 0 && routeAllowed("nova"),
    }]
  },
  study: { displayName: "VibhavGPT Study", supportsVision: true, chain: [{ provider: "study", get model() { return config.chatModels.study; }, approved: () => routeAllowed("study") }] },
  nebula: {
    displayName: "VibhavGPT Nebula", supportsVision: true, chain: [{
      provider: "paid", get model() { return config.chatModels.nebula; },
      get providerRouting() { return privateRoute(config.routeProviders.nebula); },
      approved: () => config.nebulaDataPolicyVerified && config.routeProviders.nebula.length > 0 && routeAllowed("nebula"),
    }]
  },
  vesper: {
    displayName: "VibhavGPT Vulcan",
    supportsVision: true,
    get chain() {
      const transport = (config.vesperTransport || "router").trim().toLowerCase();
      if (transport === "direct") {
        return [{
          provider: "direct",
          transport: "direct",
          get model() { return config.chatModels.vesperDirect?.trim() || undefined; },
          api: "responses",
          store: false,
          approved: () => config.vesperDataPolicyVerified === true && routeAllowed("vesper"),
        }];
      }
      if (transport === "router") {
        return [{
          provider: "paid",
          transport: "router",
          get model() { return config.chatModels.vesper; },
          providerRouting: { allow_fallbacks: false, data_collection: "deny" },
          approved: () => routeAllowed("vesper"),
        }];
      }
      return [{
        provider: "invalid",
        get model() { return undefined; },
        approved: () => false,
      }];
    },
  },
};

// Zenith (Slice 7): the flagship house tier, Max only. Pinned to its configured hosts in order, no fallbacks, and closed until the route
// guard has verified, live, that every pinned host neither trains on nor retains prompts (route-inventory.js: strict).
MODEL_CONFIGS.zenith = {
  displayName: "VibhavGPT Zenith",
  supportsVision: true,
  chain: [{
    provider: "paid",
    transport: "router",
    get model() { return config.chatModels.zenith; },
    get providerRouting() { return { order: [...config.zenithProviders], only: [...config.zenithProviders], allow_fallbacks: false, data_collection: "deny" }; },
    approved: () => config.zenithProviders.length > 0 && routeAllowed("zenith"),
  }],
};

// Tecton (Build): VibhavGPT's coding model for prototypes, Pro and Max. One engine on one host (config.js TECTON_MODEL / TECTON_PROVIDERS),
// pinned with no fallbacks and no data collection, and closed until the route guard has verified the host's policy live. The engine does not
// take tools, so its requests never carry tools or tool_choice (supportsTools: false strips them); a turn that needs a connector is refused.
MODEL_CONFIGS.tecton = {
  displayName: "VibhavGPT Tecton",
  supportsVision: false,
  chain: [{
    provider: "paid",
    transport: "router",
    supportsTools: false,
    get model() { return config.chatModels.tecton; },
    get providerRouting() { return { order: [...config.tectonProviders], only: [...config.tectonProviders], allow_fallbacks: false, data_collection: "deny" }; },
    approved: () => config.tectonProviders.length > 0 && routeAllowed("tecton"),
  }],
};

// A third-party model (Slice 7), shown under its maker's name. On the router: the same pinned, no-fallback, zero-retention route as
// Zenith. On the maker's own API (GPT-6): exactly Vulcan's direct entry, Responses API with store: false. Either way it can be used only
// while it is listed (src/models/marketplace.js), and there is one route, never a fallback to another host or tier.
function marketplaceModelConfig(key) {
  const entry = thirdPartyModel(key);
  const candidate = marketplaceCandidate(key);
  if (!entry || !candidate) return null;
  const approved = () => config.modelMarketplaceEnabled !== false && marketplaceListing(entry.id).listed;
  const route = candidate.transport === "direct"
    // Study's own direct connection (config.providerKeys.study / providerBaseUrls.study): the same key and base URL Study mode's
    // gpt-6-luna uses, never the router's. provider stays "direct", so none of Study's request behaviour (its reasoning setting and
    // token field, keyed on provider "study") applies, and the model key stays the marketplace model's, so none of Study's prompts,
    // effort or billing (keyed on the "study" model key) applies either.
    // Google's Gemini 4 routes name their own connection ("google") and the chat API; OpenAI's keep Study's connection and Responses.
    ? candidate.connection === "google"
      ? { provider: "direct", connection: "google", transport: "direct", model: candidate.model, api: "chat", approved }
      : { provider: "direct", connection: "study", transport: "direct", model: candidate.model, api: "responses", store: false, approved }
    : {
      provider: "paid",
      transport: "router",
      model: candidate.model,
      providerRouting: { order: [...candidate.hosts], only: [...candidate.hosts], allow_fallbacks: false, data_collection: "deny" },
      approved,
    };
  return { id: entry.id, displayName: entry.name, supportsVision: Boolean(entry.vision), thirdParty: true, chain: [route] };
}

// The byline over a generated image, in the same "VibhavGPT <name>" form as
// the chat models above. It is a label only: not a model key, so nothing
// routes on it and the model picker never offers it.
export const IMAGE_DISPLAY_NAME = "VibhavGPT Prism";

export function getModelConfig(modelKey) {
  if (modelKey === "spark") modelKey = "lumen";
  if (MODEL_CONFIGS[modelKey]) return MODEL_CONFIGS[modelKey];
  const marketplace = marketplaceModelConfig(modelKey);
  if (marketplace) return marketplace;

  const seedModel = findSeedModelByKey(modelKey);
  if (seedModel) {
    const supportsVision = Boolean(seedModel.capabilities?.vision);
    const supportsTools = Boolean(seedModel.capabilities?.tools);
    const supportsReasoning = Boolean(seedModel.capabilities?.reasoning);
    return {
      id: seedModel.id,
      displayName: seedModel.modelName,
      supportsVision,
      supportsTools,
      supportsReasoning,
      chain: [
        {
          provider: "paid",
          transport: "router",
          supportsVision,
          supportsTools,
          supportsReasoning,
          get model() {
            return config.chatModels[seedModel.id] || seedModel.routerModelId || seedModel.id;
          },
          providerRouting: { allow_fallbacks: false, data_collection: "deny" },
          approved: () => Boolean(config.providerKeys.paid && config.providerBaseUrls.paid),
        },
      ],
    };
  }

  return MODEL_CONFIGS.lumen;
}

export function formatResponsesInput(messages) {
  const items = [];
  for (const message of messages) {
    if (message.type === "reasoning" || message.type === "function_call" || message.type === "function_call_output") {
      items.push(message);
      continue;
    }
    if (message.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
      });
      continue;
    }
    if (message.tool_calls?.length) {
      if (Array.isArray(message.reasoning_items) && message.reasoning_items.length) {
        for (const item of message.reasoning_items) {
          items.push(item);
        }
      }
      if (message.content) {
        items.push({ role: "assistant", content: message.content });
      }
      for (const call of message.tool_calls) {
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.function?.name || call.name,
          arguments: typeof call.function?.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function?.arguments ?? {}),
        });
      }
      continue;
    }
    if (Array.isArray(message.reasoning_items) && message.reasoning_items.length) {
      for (const item of message.reasoning_items) {
        items.push(item);
      }
    }
    if (Array.isArray(message.content)) {
      const parts = message.content.map((part) => {
        if (part.type === "text" || part.type === "input_text") {
          return { type: "input_text", text: part.text || "" };
        }
        if (part.type === "image_url" || part.type === "input_image") {
          const url = part.image_url?.url || part.image_url;
          return { type: "input_image", image_url: url };
        }
        return part;
      });
      items.push({ role: message.role, content: parts });
      continue;
    }
    items.push({ role: message.role, content: message.content ?? "" });
  }
  return items;
}

export function formatResponsesTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((tool) => {
    if (tool.type === "function" && tool.function) {
      return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {}),
      };
    }
    return tool;
  });
}

export function formatResponsesTextFormat(rawFormat) {
  if (!rawFormat || typeof rawFormat !== "object") return undefined;
  if (rawFormat.type === "json_schema") {
    const { type, json_schema, ...topRest } = rawFormat;
    if (json_schema && typeof json_schema === "object") {
      const { name, strict, schema, ...schemaRest } = json_schema;
      return {
        type: "json_schema",
        ...(name !== undefined ? { name } : {}),
        ...(strict !== undefined ? { strict } : {}),
        ...(schema !== undefined ? { schema } : {}),
        ...schemaRest,
        ...topRest,
      };
    }
    return {
      type: "json_schema",
      ...topRest,
    };
  }
  return { ...rawFormat };
}

function checkRoute(entry) {
  if (!entry.model || (entry.approved && !entry.approved())) throw new ProviderStageError("route-not-configured");
}

function requestBody(entry, messages, tools, maxTokens, reasoning, extraBody = {}) {
  checkRoute(entry);
  if (entry.api === "responses") {
    const input = formatResponsesInput(messages);
    const { response_format, responseFormat, include, text, ...restExtra } = extraBody;
    const rawFormat = response_format ?? responseFormat;
    const body = {
      model: entry.model,
      input,
      store: false,
      include: Array.from(new Set([...(Array.isArray(include) ? include : include ? [include] : []), "reasoning.encrypted_content"])),
      ...restExtra,
    };
    if (text || rawFormat) {
      body.text = {
        ...(text && typeof text === "object" ? text : {}),
        ...(rawFormat ? { format: formatResponsesTextFormat(rawFormat) } : {}),
      };
    }
    if (maxTokens) body.max_output_tokens = maxTokens;
    if (tools?.length && entry.supportsTools !== false) {
      body.tools = formatResponsesTools(tools);
      body.tool_choice = "auto";
    }
    const parameter = reasoningParameter(entry.model, reasoning);
    if (parameter) body.reasoning = parameter;
    return body;
  }
  const compatibleMessages = messages.map((message) => {
    const { reasoning_items, ...cleanMessage } = message;
    if (entry.supportsTools === false && cleanMessage.role === "tool") return { role: "system", content: `Trusted server tool result: ${cleanMessage.content}` };
    if (!cleanMessage.tool_calls) return cleanMessage;
    if (entry.supportsTools === false) return { role: "assistant", content: cleanMessage.content || `Requested tools: ${cleanMessage.tool_calls.map((call) => call.function?.name).join(", ")}` };
    return {
      ...cleanMessage, tool_calls: cleanMessage.tool_calls.map((call) => {
        const { extra_content, ...standard } = call;
        const isGoogleModel = Boolean(
          entry.model && (
            entry.model.startsWith("google/") ||
            entry.model.startsWith("gemini-") ||
            entry.model.startsWith("models/gemini-") ||
            /^gemini\b/i.test(entry.model) ||
            entry.protocol === "google"
          )
        );
        return isGoogleModel ? call : standard;
      })
    };
  });
  const { responseFormat, ...restExtra } = extraBody;
  const body = { model: entry.model, messages: compatibleMessages, ...restExtra };
  if (responseFormat && !body.response_format) {
    body.response_format = responseFormat;
  }
  if (entry.provider === "study") {
    body.max_completion_tokens = maxTokens;
    body.reasoning_effort = "none";
    body.store = false;
  } else {
    body.max_tokens = outputTokenCeiling(entry.model, compatibleMessages, entry.supportsTools === false ? undefined : tools, maxTokens);
    if (entry.providerRouting) body.provider = entry.providerRouting;
    if (entry.sendsUserHash) { const user = inferenceUserHash(); if (user) body.user = user; }
    // The paid tiers always send a reasoning setting the model accepts (see
    // reasoning-effort.js); Normal is a real level, never left to the model.
    // Thinking is billed whether or not it is returned, so it is returned. It
    // is not shown: the stream relays only that the model is thinking (see
    // reasoningDisplay). Internal steps that pass reasoning: false hide it
    // entirely. Other routes send no reasoning parameter.
    if (entry.provider === "paid" && entry.supportsReasoning !== false) {
      const parameter = reasoningParameter(entry.model, reasoning);
      if (parameter) body.reasoning = parameter;
    }
    // Gemini 4 on Google's own endpoint: the validated thinking level, exactly as chosen in the composer, as reasoning_effort (which
    // Google maps to thinking_level). Nothing else is sent, and an unlisted level never reaches here (resolveMarketplaceThinking).
    if (entry.connection === "google" && reasoning && typeof reasoning === "object" && reasoning.exact && reasoning.effort) body.reasoning_effort = reasoning.effort;
  }
  if (tools?.length && entry.supportsTools !== false) { body.tools = tools; body.tool_choice = "auto"; }
  return body;
}

function requestHeaders(entry, apiKey) {
  return {
    Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json",
    ...(entry.provider === "gatewayFree" && entry.transport !== "router" ? { "X-Free-Fallback": "false" } : {})
  };
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
  const hasRefusal = typeof message?.refusal === "string" && message.refusal.trim().length > 0;
  return hasText || hasTools || hasRefusal;
}

function isProviderQuota(error, status) {
  if ([402, 429].includes(status) || [402, 429].includes(Number(error?.code))) return true;
  const detail = typeof error === "string" ? error : [error?.code, error?.type, error?.status, error?.message].filter(Boolean).join(" ");
  return /quota|rate[ _-]?limit|resource[ _-]?exhausted|insufficient[ _-]?(?:credits|balance)|credits[ _-]?(?:exhausted|depleted)/i.test(detail);
}

export function normalizeResponsesApiResponse(data) {
  if (!data || typeof data !== "object") return data;
  if (Array.isArray(data.choices)) return data;

  if (data.status === "failed" || data.error) {
    data.error = data.error || { code: data.failed_details?.code || "response_failed", message: data.failed_details?.message || "Response failed" };
    return data;
  }

  let text = "";
  let refusal = "";
  const toolCalls = [];
  const reasoningItems = [];
  for (const item of data.output ?? []) {
    if (item.type === "reasoning") {
      reasoningItems.push(item);
    } else if (item.type === "message") {
      if (typeof item.content === "string") {
        text += item.content;
      } else if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === "output_text" || part.type === "text") {
            text += part.text || "";
          } else if (part.type === "refusal") {
            refusal += part.refusal || "";
          }
        }
      }
      if (item.refusal) {
        refusal += item.refusal;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      });
    }
  }

  let finishReason = toolCalls.length ? "tool_calls" : "stop";
  if (data.status === "incomplete") {
    const reason = data.incomplete_details?.reason;
    finishReason = reason === "max_output_tokens" ? "length" : reason === "content_filter" ? "content_filter" : "incomplete";
  } else if (refusal && !text && !toolCalls.length) {
    finishReason = "refusal";
  }

  const resUsage = data.usage;
  const usage = resUsage ? {
    prompt_tokens: resUsage.input_tokens ?? resUsage.prompt_tokens ?? 0,
    completion_tokens: resUsage.output_tokens ?? resUsage.completion_tokens ?? 0,
    prompt_tokens_details: {
      cached_tokens: resUsage.input_tokens_details?.cached_tokens ?? resUsage.prompt_tokens_details?.cached_tokens ?? 0,
      cache_write_tokens: resUsage.input_tokens_details?.cache_write_tokens ?? 0,
    },
    completion_tokens_details: {
      reasoning_tokens: resUsage.output_tokens_details?.reasoning_tokens ?? resUsage.completion_tokens_details?.reasoning_tokens ?? 0,
    },
  } : undefined;

  return {
    id: data.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: data.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || (refusal ? refusal : null),
          ...(refusal ? { refusal } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          ...(reasoningItems.length ? { reasoning_items: reasoningItems } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  };
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
  const apiKey = providerApiKey(entry);
  const endpoint = providerEndpointUrl(entry);
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
    const { providerError, upstream } = await failedResponseDetail(response, body);
    throw Object.assign(new ProviderStageError("provider-http-error", {
      status,
      retryable: status === 408 || status === 425 || status === 429 || status >= 500,
      retryDelayMs,
    }), { quotaExceeded: isProviderQuota(null, status), providerError, upstream });
  }

  let data;
  try {
    data = await response.json();
    if (entry.api === "responses") {
      data = normalizeResponsesApiResponse(data);
    }
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
  if (!primaryProviderApproved() || !routeAllowed("search-intent")) throw new ProviderStageError("route-not-configured");
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
  if (data?.usage) {
    void recordShadowCostEvent({
      requestId,
      operation: "search_intent",
      modelKey: config.searchIntentModel || "primaryFree",
      provider: "primaryFree",
      usage: data.usage,
    }).catch(() => { });
  }
  return { data, internalStage: "primaryFree" };
}

// The image prompt rewriter (generation/image-handoff.js): the same
// lightweight model and gate as the search-intent step, plain text out.
export async function callImagePromptModel(
  messages,
  { fetchImpl = fetch, maxTokens = 420, timeoutMs = 8_000, signal, requestId = "unknown" } = {},
) {
  if (!primaryProviderApproved() || !routeAllowed("search-intent")) throw new ProviderStageError("route-not-configured");
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
  if (data?.usage) {
    void recordShadowCostEvent({
      requestId,
      operation: "image_prompt_rewrite",
      modelKey: config.searchIntentModel || "primaryFree",
      provider: "primaryFree",
      usage: data.usage,
    }).catch(() => { });
  }
  return { data, internalStage: "primaryFree" };
}

function isEntryUsable(entry) {
  if (!entry?.model) return false;
  if (entry.approved && !entry.approved()) return false;
  const key = providerApiKey(entry);
  if (!key || typeof key !== "string" || !key.trim()) return false;
  const endpoint = providerEndpointUrl(entry);
  if (!endpoint || typeof endpoint !== "string" || !endpoint.trim()) return false;
  return true;
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
    requireToolRoute = false,
  } = {},
) {
  const modelConfig = getModelConfig(modelKey);
  let attempts = 0;
  const rawChain = modelConfig.chain;
  const usable = rawChain.filter(isEntryUsable);
  const chain = requireToolRoute ? toolCapableEntries(usable, tools) : usable;
  if (requireToolRoute && tools?.length && usable.length > 0 && chain.length === 0) {
    throw new ToolsUnsupportedError(modelKey);
  }
  if (chain.length === 0) {
    writeInferenceLog("error", "inference_all_stages_failed", { requestId, attempts: 0 });
    throw new InferenceUnavailableError();
  }

  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index];
    const isLastRoute = index === chain.length - 1;

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
        if (confirmedUsage(error.usage)) await usageTracker?.record(error.usage, { entry, attemptNumber: attempts + 1 });
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
          // On a 429 or 5xx: the rate-limit headers and the host's error, sanitized (upstream-telemetry.js).
          upstream: stageError?.upstream ?? null,
        });
        noteUpstreamStatus(stageError?.status);
        noteCredentialRejection(stageError, entry, { requestId, modelKey });
        if (stageError?.code === "client-aborted" || signal?.aborted) throw new InferenceUnavailableError();

        const delayMs = stageError.retryDelayMs ?? (stageError.status === 429 ? 350 : 150);
        const isRateLimit = stageError.status === 429 || stageError.code === "provider-quota" || Boolean(stageError.quotaExceeded);
        const isNotConfigured = stageError.code === "route-not-configured" || stageError.code === "missing-credential";

        const canRetry = Boolean(stageError?.retryable)
          && !(chain.length > 1 && isRateLimit)
          && !isNotConfigured
          && attempt < maxRetries
          && deadlineAt - Date.now() > Math.max(1_000, delayMs)
          && delayMs <= 2_000;
        if (canRetry) {
          writeInferenceLog("info", "inference_stage_retry", { requestId, stage: entry.provider, code, status: stageError.status ?? null, attempt: attempt + 1, delayMs });
          await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, Math.max(0, deadlineAt - Date.now()))));
          continue;
        }

        if (!isLastRoute) {
          const nextCandidate = chain[index + 1];
          if (nextCandidate && !isNotConfigured) {
            writeInferenceLog("info", "inference_internal_fallback", {
              requestId,
              modelKey,
              fromStage: entry.provider,
              toStage: nextCandidate.provider,
              reason: code,
              status: stageError.status ?? null,
            });
          }
          break;
        }
        break;
      }
      await usageTracker?.record(successUsage(data, messages, tools, { requestId, stage: entry.provider }), { entry, attemptNumber: attempts + 1 });
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
async function recoverStreamUsage(entry, generationId, usage, fetchImpl, { signal, deadlineAt, requireCost = false } = {}) {
  const hasTokens = [usage?.prompt_tokens, usage?.completion_tokens].every(Number.isSafeInteger);
  const hasCost = Number.isFinite(usage?.cost) && usage.cost >= 0;
  if (entry.provider !== "paid" || !generationId || (hasTokens && (!requireCost || hasCost))) return usage;
  // Generation metadata can become visible after the stream has ended. A
  // single immediate lookup can return 404 or a still-running snapshot.
  // Retry that lookup, not inference; use only finalized native token counts.
  const recoveryDeadline = Math.min(Date.now() + 5_000, deadlineAt ?? Infinity);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (signal?.aborted || Date.now() >= recoveryDeadline) break;
    try {
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(1_500, recoveryDeadline - Date.now())));
      const response = await fetchImpl(`${config.providerBaseUrls.paid}/generation?id=${encodeURIComponent(generationId)}`, {
        headers: requestHeaders(entry, providerApiKey(entry)), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (response.ok) {
        const { data } = await response.json();
        if ((data?.finish_reason || data?.native_finish_reason || data?.cancelled === true)
          && [data?.native_tokens_prompt, data?.native_tokens_completion].every((n) => Number.isSafeInteger(n) && n >= 0)) {
          const reportedCost = Number(data.total_cost);
          return {
            prompt_tokens: data.native_tokens_prompt,
            completion_tokens: data.native_tokens_completion,
            ...(requireCost && Number.isFinite(reportedCost) && reportedCost >= 0 ? { cost: reportedCost } : {}),
          };
        }
      } else {
        void response.body?.cancel?.().catch(() => { });
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

/** Assemble one streamed tool-call delta into the calls collected so far. */
export function applyStreamToolCallDelta(toolCalls, call) {
  const index = Number.isInteger(call?.index) ? call.index : toolCalls.length;
  toolCalls[index] ??= { id: call?.id, type: "function", function: { name: "", arguments: "" } };
  if (call?.id) toolCalls[index].id = call.id;
  if (call?.function?.name) toolCalls[index].function.name += call.function.name;
  if (call?.function?.arguments) toolCalls[index].function.arguments += call.function.arguments;
  if (typeof call?.extra_content?.google?.thought_signature === "string") {
    toolCalls[index].extra_content = { google: { thought_signature: call.extra_content.google.thought_signature } };
  }
  return toolCalls;
}

// What a streamed reasoning field is, by the contract of the wire format that
// carries it. Nothing here is shown to a customer unless it is a summary the
// route is explicitly marked to display.
//
//   raw      the model's own chain of thought: chat `delta.reasoning`,
//            `delta.reasoning_content`, `reasoning_details` of type
//            `reasoning.text`, and Responses `response.reasoning_text.delta`.
//            It can restate instructions and talk itself through tool choices,
//            so it is never relayed.
//   opaque   `reasoning_details` of type `reasoning.encrypted`: continuity data
//            for the provider, never text.
//   summary  `reasoning.summary` and Responses `response.reasoning_summary_text`.
//            These are provider-composed summaries, but only when the request
//            asked for one. No request in this app asks (reasoningParameter
//            never sets `summary`), so a route shows summary text only after
//            someone verifies it and sets `displayableReasoningSummary: true`
//            on its entry. None is set today: every route is status-only.
const SUMMARY_FIELDS = new Set(["chat.reasoning_details.summary", "responses.reasoning_summary_text"]);

// "show": relay the text. "activity": relay only that the model is thinking.
export function reasoningDisplay(entry, field) {
  return SUMMARY_FIELDS.has(field) && entry?.displayableReasoningSummary === true ? "show" : "activity";
}

async function streamOnce(entry, messages, tools, {
  fetchImpl, maxTokens, reasoning, responseFormat, idleTimeoutMs, firstOutputTimeoutMs = idleTimeoutMs, deadlineAt, imageInput, signal, onDelta, onReasoning, onThinking,
  requireCost = false, collectUsageAfterAbort = false,
}) {
  // Thinking text never leaves here as a side effect of arriving: it is either
  // a verified summary (onReasoning) or a bare "the model is thinking" signal
  // (onThinking). Both still end the first-output wait.
  const relayReasoning = (field, text) => {
    if (reasoningDisplay(entry, field) === "show" && typeof text === "string" && text) onReasoning?.(text);
    else onThinking?.();
  };
  const apiKey = providerApiKey(entry);
  const endpoint = providerEndpointUrl(entry);
  if (!apiKey || !endpoint) throw new ProviderStageError("missing-credential");
  const streamExtra = entry.api === "responses" ? { stream: true } : { stream: true, stream_options: { include_usage: true } };
  const body = requestBody(entry, messages, tools, maxTokens, reasoning, { ...streamExtra, ...(responseFormat ? { response_format: responseFormat } : {}) });
  const startedAt = Date.now();
  const controller = new AbortController();
  let stopReason = null;
  let reader = null;
  // Cancel the read as well as the request, so a body that ignores the
  // abort still ends.
  const stop = (reason) => { stopReason ??= reason; controller.abort(); void reader?.cancel().catch(() => { }); };
  const overallTimer = setTimeout(() => stop("provider-timeout"), Math.max(1, deadlineAt - Date.now()));
  let idleTimer = setTimeout(() => stop("provider-stalled"), idleTimeoutMs);
  // A shorter wait for the first text or tool call. Empty chunks do not count.
  const firstOutputTimer = firstOutputTimeoutMs < idleTimeoutMs ? setTimeout(() => stop("provider-stalled"), firstOutputTimeoutMs) : null;
  const onClientAbort = () => stop("client-aborted");
  if (signal?.aborted) stop("client-aborted");
  signal?.addEventListener("abort", onClientAbort, { once: true });
  const state = { content: "", firstTokenMs: null, firstOutputMs: null, firstReasoningMs: null, delivered: 0, refusal: "" };
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
  const toolCallsByOutputIndex = new Map();
  const toolCallsById = new Map();
  const reasoningItemsMap = new Map();
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
      const { providerError, upstream } = await failedResponseDetail(response, body);
      throw Object.assign(new ProviderStageError("provider-http-error", { status, retryable: status === 408 || status === 429 || status >= 500, retryDelayMs: status === 429 ? retryAfterMs(response.headers.get("retry-after")) : null }), { quotaExceeded: isProviderQuota(null, status), providerError, upstream });
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
    for (; ;) {
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
          // An error inside a stream (the router relays a host's 429 or 5xx this way after the headers were sent).
          const upstream = isTelemetryStatus(status) ? upstreamFailureRecord({ status, headers: response.headers, bodyText: JSON.stringify({ error: chunk.error }), requestText: requestTextOf(body) }) : null;
          throw Object.assign(new ProviderStageError("provider-stream-error", { status, retryable: true }), { quotaExceeded, providerError: providerErrorSummary(chunk.error), upstream });
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => stop("provider-stalled"), idleTimeoutMs);
        if (typeof chunk.type === "string") {
          if (chunk.type === "response.output_text.delta" || chunk.type === "response.text.delta") {
            const delta = typeof chunk.delta === "string" ? chunk.delta : "";
            if (delta) {
              outputArrived();
              state.firstTokenMs ??= Date.now() - startedAt;
              state.content += delta;
              if (onDelta) state.delivered += onDelta(delta, state.content) ? delta.length : 0;
            }
          } else if (chunk.type === "response.reasoning_summary_text.delta" || chunk.type === "response.reasoning_text.delta") {
            const text = typeof chunk.delta === "string" ? chunk.delta : "";
            if (text) {
              state.firstReasoningMs ??= Date.now() - startedAt;
              clearTimeout(firstOutputTimer);
              relayReasoning(chunk.type === "response.reasoning_summary_text.delta" ? "responses.reasoning_summary_text" : "responses.reasoning_text", text);
            }
          } else if (chunk.type === "response.output_item.added" && chunk.item?.type === "reasoning") {
            const id = chunk.item.call_id || chunk.item.id || (Number.isInteger(chunk.output_index) ? `idx_${chunk.output_index}` : `r_${reasoningItemsMap.size}`);
            reasoningItemsMap.set(id, { ...chunk.item });
          } else if (chunk.type === "response.output_item.done" && chunk.item?.type === "reasoning") {
            const id = chunk.item.call_id || chunk.item.id || (Number.isInteger(chunk.output_index) ? `idx_${chunk.output_index}` : `r_${reasoningItemsMap.size}`);
            const existing = reasoningItemsMap.get(id);
            reasoningItemsMap.set(id, { ...existing, ...chunk.item });
          } else if (chunk.type === "response.output_item.added" && chunk.item?.type === "function_call") {
            outputArrived();
            const id = chunk.item.call_id || chunk.item.id;
            const call = { id, type: "function", function: { name: chunk.item.name || "", arguments: chunk.item.arguments || "" } };
            if (Number.isInteger(chunk.output_index)) toolCallsByOutputIndex.set(chunk.output_index, call);
            if (id) toolCallsById.set(id, call);
            toolCalls.push(call);
          } else if (chunk.type === "response.function_call_arguments.delta") {
            outputArrived();
            const call = (chunk.call_id && toolCallsById.get(chunk.call_id))
              || (chunk.item_id && toolCallsById.get(chunk.item_id))
              || (Number.isInteger(chunk.output_index) && toolCallsByOutputIndex.get(chunk.output_index))
              || toolCalls[toolCalls.length - 1];
            if (call) {
              call.function.arguments += (typeof chunk.delta === "string" ? chunk.delta : "");
            }
          } else if (chunk.type === "response.output_item.done" && chunk.item?.type === "function_call") {
            outputArrived();
            const call = (chunk.item.call_id && toolCallsById.get(chunk.item.call_id))
              || (chunk.item.id && toolCallsById.get(chunk.item.id))
              || (Number.isInteger(chunk.output_index) && toolCallsByOutputIndex.get(chunk.output_index));
            if (call && chunk.item.arguments) {
              call.function.arguments = chunk.item.arguments;
            }
          } else if (chunk.type === "response.refusal.delta") {
            const delta = typeof chunk.delta === "string" ? chunk.delta : "";
            if (delta) {
              outputArrived();
              state.firstTokenMs ??= Date.now() - startedAt;
              state.refusal += delta;
            }
          } else if (chunk.type === "response.failed" || chunk.type === "error") {
            const err = chunk.response?.error || chunk.error || { message: "Stream response failed" };
            const status = Number.isInteger(err.code) ? err.code : null;
            const quotaExceeded = isProviderQuota(err, status);
            if (quotaExceeded && !state.content && !toolCalls.length) inferenceStarted = false;
            const resUsage = chunk.response?.usage || chunk.usage;
            if (resUsage) {
              usage = {
                prompt_tokens: resUsage.input_tokens ?? resUsage.prompt_tokens ?? 0,
                completion_tokens: resUsage.output_tokens ?? resUsage.completion_tokens ?? 0,
                prompt_tokens_details: {
                  cached_tokens: resUsage.input_tokens_details?.cached_tokens ?? resUsage.prompt_tokens_details?.cached_tokens ?? 0,
                  cache_write_tokens: resUsage.input_tokens_details?.cache_write_tokens ?? 0,
                },
                completion_tokens_details: {
                  reasoning_tokens: resUsage.output_tokens_details?.reasoning_tokens ?? resUsage.completion_tokens_details?.reasoning_tokens ?? 0,
                },
              };
            }
            throw Object.assign(new ProviderStageError("provider-stream-error", { status, retryable: true }), {
              quotaExceeded,
              providerError: providerErrorSummary(err),
            });
          } else if (chunk.type === "response.incomplete") {
            const reason = chunk.response?.incomplete_details?.reason;
            finishReason = reason === "max_output_tokens" ? "length" : reason === "content_filter" ? "content_filter" : "incomplete";
            const resUsage = chunk.response?.usage || chunk.usage;
            if (resUsage) {
              usage = {
                prompt_tokens: resUsage.input_tokens ?? resUsage.prompt_tokens ?? 0,
                completion_tokens: resUsage.output_tokens ?? resUsage.completion_tokens ?? 0,
                prompt_tokens_details: {
                  cached_tokens: resUsage.input_tokens_details?.cached_tokens ?? resUsage.prompt_tokens_details?.cached_tokens ?? 0,
                  cache_write_tokens: resUsage.input_tokens_details?.cache_write_tokens ?? 0,
                },
                completion_tokens_details: {
                  reasoning_tokens: resUsage.output_tokens_details?.reasoning_tokens ?? resUsage.completion_tokens_details?.reasoning_tokens ?? 0,
                },
              };
            }
          } else if (chunk.type === "response.completed" || chunk.type === "response.done") {
            const status = chunk.response?.status;
            if (status === "incomplete") {
              const reason = chunk.response?.incomplete_details?.reason;
              finishReason = reason === "max_output_tokens" ? "length" : reason === "content_filter" ? "content_filter" : "incomplete";
            } else if (status === "failed") {
              const err = chunk.response?.error || chunk.error || { message: "Stream response failed" };
              const resUsage = chunk.response?.usage || chunk.usage;
              if (resUsage) {
                usage = {
                  prompt_tokens: resUsage.input_tokens ?? resUsage.prompt_tokens ?? 0,
                  completion_tokens: resUsage.output_tokens ?? resUsage.completion_tokens ?? 0,
                  prompt_tokens_details: {
                    cached_tokens: resUsage.input_tokens_details?.cached_tokens ?? resUsage.prompt_tokens_details?.cached_tokens ?? 0,
                    cache_write_tokens: resUsage.input_tokens_details?.cache_write_tokens ?? 0,
                  },
                  completion_tokens_details: {
                    reasoning_tokens: resUsage.output_tokens_details?.reasoning_tokens ?? resUsage.completion_tokens_details?.reasoning_tokens ?? 0,
                  },
                };
              }
              throw Object.assign(new ProviderStageError("provider-stream-error", { retryable: true }), {
                providerError: providerErrorSummary(err),
              });
            } else {
              finishReason = toolCalls.length ? "tool_calls" : (state.refusal && !state.content ? "refusal" : "stop");
            }
            if (Array.isArray(chunk.response?.output)) {
              for (const item of chunk.response.output) {
                if (item?.type === "reasoning") {
                  const id = item.id || (Number.isInteger(item.output_index) ? `idx_${item.output_index}` : `r_${reasoningItemsMap.size}`);
                  const existing = reasoningItemsMap.get(id);
                  reasoningItemsMap.set(id, { ...existing, ...item });
                }
              }
            }
            const resUsage = chunk.response?.usage || chunk.usage;
            if (resUsage) {
              usage = {
                prompt_tokens: resUsage.input_tokens ?? resUsage.prompt_tokens ?? 0,
                completion_tokens: resUsage.output_tokens ?? resUsage.completion_tokens ?? 0,
                prompt_tokens_details: {
                  cached_tokens: resUsage.input_tokens_details?.cached_tokens ?? resUsage.prompt_tokens_details?.cached_tokens ?? 0,
                  cache_write_tokens: resUsage.input_tokens_details?.cache_write_tokens ?? 0,
                },
                completion_tokens_details: {
                  reasoning_tokens: resUsage.output_tokens_details?.reasoning_tokens ?? resUsage.completion_tokens_details?.reasoning_tokens ?? 0,
                },
              };
            }
          }
        }
        const choice = chunk.choices?.[0];
        // Streamed thinking (delta.reasoning_details or delta.reasoning) shows the model is
        // working: it ends the first-output wait, but it is never part of the
        // reply or counted as output. Readable thinking (text and summary
        // details) goes to onReasoning; encrypted details are never shown.
        const reasoningDelta = (typeof choice?.delta?.reasoning === "string" && choice.delta.reasoning)
          || (typeof choice?.delta?.reasoning_content === "string" && choice.delta.reasoning_content);
        // A chunk can carry the same thinking twice: as the plain `reasoning`
        // string and again inside `reasoning_details`. Neither raw form is
        // relayed (see reasoningDisplay), so it cannot be shown twice. Only a
        // `reasoning.summary` detail on a route marked as displayable is text.
        const details = Array.isArray(choice?.delta?.reasoning_details) ? choice.delta.reasoning_details : [];
        if (reasoningDelta || details.length) {
          state.firstReasoningMs ??= Date.now() - startedAt;
          clearTimeout(firstOutputTimer);
        }
        const summaries = details
          .filter((detail) => detail?.type === "reasoning.summary" && typeof detail.summary === "string" && detail.summary)
          .map((detail) => detail.summary);
        if (summaries.length && reasoningDisplay(entry, "chat.reasoning_details.summary") === "show") {
          for (const text of summaries) relayReasoning("chat.reasoning_details.summary", text);
        } else if (reasoningDelta || details.length) {
          // One signal per chunk, whatever it carried (raw text, encrypted data,
          // or a summary on a route that is not verified for display).
          onThinking?.();
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
          applyStreamToolCallDelta(toolCalls, call);
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
    // After a client disconnect the request's own signal is already aborted, so
    // an opted-in caller looks the final usage up under a short independent
    // limit. The upstream stream is already cancelled; nothing keeps generating.
    const lateCollection = collectUsageAfterAbort && stopReason === "client-aborted";
    if (!stalledBeforeOutput) {
      usage = lateCollection
        ? await recoverStreamUsage(entry, generationId, usage, fetchImpl, { deadlineAt: Math.min(deadlineAt, Date.now() + LATE_USAGE_COLLECTION_MS), requireCost })
        : await recoverStreamUsage(entry, generationId, usage, fetchImpl, { signal, deadlineAt, requireCost });
    }
    Object.assign(stageError, {
      usage, inferenceStarted, elapsedMs: Date.now() - startedAt, firstTokenMs: state.firstTokenMs,
      receivedChars: state.content.length, receivedToolCalls: toolCalls.length, delivered: state.delivered > 0
    });
    throw stageError;
  } finally {
    clearTimeout(overallTimer);
    clearTimeout(idleTimer);
    clearTimeout(firstOutputTimer);
    signal?.removeEventListener("abort", onClientAbort);
  }
  usage = await recoverStreamUsage(entry, generationId, usage, fetchImpl, { signal, deadlineAt, requireCost });
  const message = { role: "assistant", content: state.content || (state.refusal ? state.refusal : "") };
  if (state.refusal) message.refusal = state.refusal;
  const calls = toolCalls.filter((call) => call?.function?.name);
  if (calls.length) message.tool_calls = calls;
  const reasoningItems = Array.from(reasoningItemsMap.values());
  if (reasoningItems.length) message.reasoning_items = reasoningItems;
  const data = { choices: [{ message, finish_reason: finishReason }], usage };
  if (!hasUsableResponse(data)) throw Object.assign(new ProviderStageError("provider-empty-response", { retryable: true }), { delivered: state.delivered > 0, usage, inferenceStarted: true });
  return { data, elapsedMs: Date.now() - startedAt, firstTokenMs: state.firstTokenMs, firstOutputMs: state.firstOutputMs, firstReasoningMs: state.firstReasoningMs };
}

// A stall, a transient 5xx, or a provider error event in the stream, before
// any text or tool call reached us, is safe to try again: the user has seen
// nothing, and the try is not charged.
const LATE_USAGE_COLLECTION_MS = 3_000;
const START_RETRY_DELAYS_MS = [500, 1_000];
// An upstream 429 inside a reply: the host's Retry-After is honoured up to this long, with jitter so replies waiting on the same host
// do not retry in step. A host that asks for longer is not retried inside the reply: the person is told the tier is in high demand.
export const RATE_LIMIT_MAX_WAIT_MS = 4_000;
const equalJitter = (ms, random = Math.random) => (ms > 0 ? Math.round(ms / 2 + random() * (ms / 2)) : 0);
const SINGLE_ROUTE_START_RETRIES = 2;

function failedBeforeOutput(error) {
  if (error?.delivered || error?.receivedChars || error?.receivedToolCalls) return false;
  if (error?.code === "provider-stalled" || error?.code === "provider-empty-response") return true;
  if (error?.code === "missing-credential" || error?.code === "route-not-configured" || error?.code === "route-unavailable") return true;
  if (error?.code === "provider-quota" || Boolean(error?.quotaExceeded)) return true;
  const status = error?.status;
  const transientStatus = status >= 500 || status === 408 || status === 429;
  if (error?.code === "provider-stream-error") return error.status == null || transientStatus;
  if (error?.code === "provider-http-error") return transientStatus;
  if (error?.code === "provider-network-error" || error?.code === "provider-timeout" || error?.code === "provider-stream-incomplete") return true;
  return false;
}

function retryAfterMs(value) {
  if (value == null || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
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
  imageInput = false, signal, onDelta, onReset, onReasoning, onThinking, onRetry, requestId = "unknown", usageTracker,
  requireToolRoute = false,
} = {}) {
  const modelConfig = getModelConfig(modelKey);
  const rawChain = modelConfig.chain;
  const usable = rawChain.filter(isEntryUsable);
  const chain = requireToolRoute ? toolCapableEntries(usable, tools) : usable;
  if (requireToolRoute && tools?.length && usable.length > 0 && chain.length === 0) {
    throw new ToolsUnsupportedError(modelKey);
  }
  if (chain.length === 0) {
    writeInferenceLog("error", "inference_exhausted", { requestId, attempts: 0, reason: "route-not-configured", totalElapsedMs: 0 });
    throw Object.assign(new InferenceUnavailableError(), { stageCode: "route-not-configured", exhausted: true });
  }

  const requestStartedAt = Date.now();
  let stageCode = "provider-error";
  let attempts = 0;

  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index];
    const isLastRoute = index === chain.length - 1;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (signal?.aborted || deadlineAt <= Date.now()) throw new InferenceUnavailableError();
      const isLastPossibleTry = isLastRoute && attempt === maxRetries;
      const waitForFirstOutputMs = isLastPossibleTry ? idleTimeoutMs : firstOutputTimeoutMs;
      await usageTracker?.beforeCall(messages, tools, maxTokens);
      attempts += 1;
      let result;
      try {
        result = await streamOnce(entry, messages, tools, {
          fetchImpl, maxTokens, reasoning, responseFormat, idleTimeoutMs,
          firstOutputTimeoutMs: waitForFirstOutputMs, deadlineAt, imageInput, signal, onDelta, onReasoning, onThinking
        });
      } catch (error) {
        const code = /^[a-z0-9_.-]{1,60}$/i.test(String(error?.code ?? "")) ? error.code : "provider-error";
        stageCode = code;
        writeInferenceLog("warn", "inference_stream_failed", {
          requestId, stage: entry.provider, code, status: error?.status ?? null, attempt: attempt + 1,
          elapsedMs: error?.elapsedMs ?? null, receivedChars: error?.receivedChars ?? 0, providerStatus: Number.isInteger(error?.status) ? error.status : null,
          providerCode: error?.providerError?.code ?? null, providerMessage: error?.providerError?.message ?? null,
          upstream: error?.upstream ?? null,
        });
        noteUpstreamStatus(error?.status);
        noteCredentialRejection(error, entry, { requestId, modelKey });

        if (error?.delivered || (error?.receivedChars > 0 && error?.delivered !== false)) {
          if (confirmedUsage(error.usage)) await usageTracker?.record(error.usage, { entry, attemptNumber: attempts });
          await usageTracker?.release();
          if (typeof onReset === "function" && !isLastRoute) {
            const nextCandidate = chain[index + 1];
            if (nextCandidate) {
              writeInferenceLog("info", "inference_internal_fallback", {
                requestId,
                modelKey,
                fromStage: entry.provider,
                toStage: nextCandidate.provider,
                reason: "stream-reset-fallback",
                status: error?.status ?? null,
              });
              await onReset();
              break;
            }
          }
          writeInferenceLog("warn", "inference_midstream_failure_no_fallback", { requestId, stage: entry.provider, code, receivedChars: error?.receivedChars ?? 0 });
          throw Object.assign(new InferenceUnavailableError(), { stageCode: code, status: error?.status ?? 503 });
        }

        if (failedBeforeOutput(error)) {
          await usageTracker?.release();
          if (signal?.aborted || deadlineAt <= Date.now()) throw new InferenceUnavailableError();
          let delayMs = startRetryDelaysMs[Math.min(attempt, startRetryDelaysMs.length - 1)] ?? 0;
          const nextWaitMs = isLastPossibleTry ? idleTimeoutMs : firstOutputTimeoutMs;
          const isRateLimit = error?.status === 429 || error?.code === "provider-quota" || Boolean(error?.quotaExceeded);
          const isNotConfigured = error?.code === "route-not-configured" || error?.code === "missing-credential";
          // A 429: wait what the host asked (up to RATE_LIMIT_MAX_WAIT_MS), jittered. Asked for longer: no retry inside this reply.
          const hostWaitMs = isRateLimit && Number.isFinite(error?.retryDelayMs) ? error.retryDelayMs : null;
          const waitTooLong = hostWaitMs !== null && hostWaitMs > RATE_LIMIT_MAX_WAIT_MS;
          if (isRateLimit && !waitTooLong) delayMs = equalJitter(Math.max(delayMs, hostWaitMs ?? 0));

          const canRetry = attempt < maxRetries
            && Boolean(error?.retryable)
            && !(chain.length > 1 && isRateLimit)
            && !isNotConfigured
            && !waitTooLong
            && deadlineAt - Date.now() > delayMs + nextWaitMs;

          if (canRetry) {
            writeInferenceLog("info", "inference_retry", {
              requestId, stage: entry.provider, attempt: attempts, reason: code,
              status: error?.status ?? null, elapsedMs: error?.elapsedMs ?? null, delayMs
            });
            onRetry?.({ attempt: attempt + 2, maxAttempts: maxRetries + 1, reason: code, ...(isRateLimit ? { rateLimited: true } : {}) });
            await pause(delayMs, signal);
            continue;
          }

          if (!isLastRoute) {
            const nextCandidate = chain[index + 1];
            if (nextCandidate && !isNotConfigured) {
              writeInferenceLog("info", "inference_internal_fallback", {
                requestId,
                modelKey,
                fromStage: entry.provider,
                toStage: nextCandidate.provider,
                reason: code,
                status: error?.status ?? null,
              });
            }
            break;
          }

          writeInferenceLog("error", "inference_exhausted", { requestId, attempts, reason: code, totalElapsedMs: Date.now() - requestStartedAt, rateLimited: isRateLimit, hostWaitMs });
          throw Object.assign(new InferenceUnavailableError(), { stageCode: code, exhausted: true, rateLimited: isRateLimit });
        }

        if (confirmedUsage(error.usage)) await usageTracker?.record(error.usage, { entry, attemptNumber: attempts });
        await usageTracker?.release();
        if (code === "client-aborted" || signal?.aborted || deadlineAt <= Date.now()) throw new InferenceUnavailableError();

        if (!isLastRoute) break;
        break;
      }

      await usageTracker?.record(successUsage(result.data, messages, tools, { requestId, stage: entry.provider }), { entry, attemptNumber: attempts });
      writeInferenceLog("info", "inference_stream_completed", {
        requestId, stage: entry.provider, attempt: attempt + 1, attempts,
        elapsedMs: result.elapsedMs, firstTokenMs: result.firstTokenMs, firstOutputMs: result.firstOutputMs, firstReasoningMs: result.firstReasoningMs,
        completionTokens: result.data.usage?.completion_tokens ?? null, finishReason: result.data.choices[0].finish_reason
      });
      return { data: result.data, internalStage: entry.provider };
    }
  }

  throw Object.assign(new InferenceUnavailableError(), { stageCode });
}


/* Single-attempt, endpoint-pinned calls for allowance-enforced requests.
   The coordinator pins one registry endpoint per call and forbids retry loops
   and fallback between routes, so these never walk the chain: they call the
   one stage the pinned endpoint names, once, and report what is known about
   billable usage. Whether another attempt is allowed is decided above this
   layer, and only where zero billable usage is established. */

// The chain stage a registry endpoint pins: the same provider stage, and the
// same transport when the stage declares one. No match means no dispatch.
export function chainEntryForEndpoint(modelKey, endpoint) {
  const chain = getModelConfig(modelKey).chain;
  const matches = chain.filter((entry) => entry.provider === endpoint?.providerName
    && (!entry.transport || entry.transport === endpoint?.transportType));
  return matches.length === 1 ? matches[0] : null;
}

// Whether a failure proves no upstream inference happened. A rejection before
// inference (credentials, HTTP refusal, quota) does; a timeout, stall or abort
// after the request started does not, so its usage stays unknown.
export function failureShowsZeroUsage(error) {
  if (confirmedUsage(error?.usage)) return false;
  return error?.inferenceStarted !== true;
}

export function reportedCostFor(entry) {
  return entry?.provider === "paid";
}

function requirePinnedEntry(modelKey, endpoint) {
  const entry = chainEntryForEndpoint(modelKey, endpoint);
  if (!entry || (typeof entry.approved === "function" && !entry.approved())) {
    throw Object.assign(new ProviderStageError("route-unavailable"), { inferenceStarted: false });
  }
  return entry;
}

export async function callPinnedEndpoint(modelKey, endpoint, messages, tools, {
  fetchImpl = fetch, maxTokens = 2_048, reasoning = null, responseFormat, timeoutMs = 60_000, imageInput = false, signal, requireToolRoute = false,
} = {}) {
  const entry = requirePinnedEntry(modelKey, endpoint);
  if (requireToolRoute && tools?.length && entry.supportsTools === false) throw new ToolsUnsupportedError(modelKey);
  const data = await callProvider(entry, messages, tools, fetchImpl, maxTokens, reasoning, responseFormat ? { response_format: responseFormat } : {}, { timeoutMs, imageInput, signal });
  return { data, internalStage: entry.provider, reportsCost: reportedCostFor(entry) };
}

export async function streamPinnedEndpoint(modelKey, endpoint, messages, tools, {
  fetchImpl = fetch, maxTokens = 2_048, reasoning = null, responseFormat, idleTimeoutMs = 25_000, firstOutputTimeoutMs = idleTimeoutMs,
  overallTimeoutMs = 120_000, deadlineAt = Date.now() + overallTimeoutMs, imageInput = false, signal, onDelta, onReasoning, onThinking, requireToolRoute = false,
} = {}) {
  const entry = requirePinnedEntry(modelKey, endpoint);
  if (requireToolRoute && tools?.length && entry.supportsTools === false) throw new ToolsUnsupportedError(modelKey);
  const requireCost = reportedCostFor(entry);
  const result = await streamOnce(entry, messages, tools, {
    fetchImpl, maxTokens, reasoning, responseFormat, idleTimeoutMs, firstOutputTimeoutMs, deadlineAt, imageInput, signal, onDelta, onReasoning, onThinking,
    requireCost, collectUsageAfterAbort: true,
  });
  return { data: result.data, internalStage: entry.provider, reportsCost: requireCost };
}
