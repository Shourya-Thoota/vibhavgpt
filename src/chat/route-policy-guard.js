/**
 * The live data-policy guard for every model route that goes through the router (Slice 4 built it for Lumen; PR 3 makes it the one
 * guard for all routes). For a route it reads, live, the router's own published data:
 *   - the documented Endpoints API: which hosts serve the model, and at what price;
 *   - the data embedded in the model's public providers page: each host's data policy (training, retention, publishing). The policy is
 *     in no documented API, so anything missing or unparseable counts as unverified.
 * and decides whether the route has somewhere safe to send a request.
 *
 * How a route chooses its host decides what "safe" needs:
 *   - "pinned": the route names its hosts (Lumen's single pin; Nova's and Nebula's allow-lists). Safe while at least one named host
 *     serves the model with training false and no publishing (and is free, where the route must be free).
 *   - "deny": the router is told data_collection: deny and picks the host itself (Vulcan). Safe while at least one host has training
 *     false and does not retain prompts, which is what deny allows.
 *   - "unpinned": the router picks any host, with no deny flag (image generation, the auto classifier). The account's own setting then
 *     decides which hosts are eligible: for paid models the account excludes hosts that train (checked on the dashboard), so one
 *     non-training host is enough; for free models it does not, so every host must be non-training.
 *
 * Cadence: once at boot, then hourly; a result older than two hours counts as unverified. Two public GETs per route per hour; nothing
 * about any user is sent. What a route does with the result (closed until verified, or closed only on evidence) is decided by its gate
 * in route-inventory.js.
 */

export const GUARD_INTERVAL_MS = 60 * 60 * 1000;
export const GUARD_MAX_AGE_MS = 2 * GUARD_INTERVAL_MS;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGE_BYTES = 6_000_000;

const states = new Map();
let timer = null;

const emptyState = () => ({ status: "unverified", reason: "not-checked", model: null, hosts: null, checkedAt: 0, evidence: null, allowedHosts: [], positiveEvidence: false });
// The reasons that are evidence about a host's policy (as opposed to "could not tell": not found, unparseable, not serving, fetch failed).
const POSITIVE_HOST_REASONS = new Set(["training-not-false", "publishes-prompts", "retains-prompts", "endpoint-not-free", "retention-not-zero", "retention-over-limit"]);
const hostsKey = (hosts) => (Array.isArray(hosts) ? hosts.join("|") : "*");

export function routePolicyState(route, { model, hosts = null, now = Date.now() } = {}) {
  const state = states.get(route) ?? emptyState();
  const base = { status: state.status, reason: state.reason, allowedHosts: state.allowedHosts, checkedAt: state.checkedAt, positiveEvidence: Boolean(state.positiveEvidence) };
  if (state.status !== "verified") return { ...base, verified: false };
  if (state.model !== model || state.hosts !== hostsKey(hosts)) return { ...base, verified: false, reason: "unverified-config" };
  if (now - state.checkedAt > GUARD_MAX_AGE_MS) return { ...base, verified: false, reason: "stale" };
  return { ...base, verified: true, reason: "verified", evidence: state.evidence };
}

// The JSON object that starts at `start` (a "{"), read with string awareness. Null when it does not close.
function objectAt(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === "\"") inString = false;
    } else if (ch === "\"") inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Every data policy the page gives for this model variant on this host. The page embeds endpoint records as (escaped) JSON; a record
 * begins at its "model_variant_slug" and runs to the next one. Only records naming this exact variant and this exact host count.
 */
export function policiesFromProvidersPage(html, { model, provider }) {
  const text = String(html ?? "").replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  const marker = `"model_variant_slug":${JSON.stringify(model)}`;
  const records = [];
  let at = text.indexOf(marker);
  while (at >= 0) {
    const next = text.indexOf("\"model_variant_slug\":", at + marker.length);
    records.push(text.slice(at, next < 0 ? undefined : next));
    at = next < 0 ? -1 : text.indexOf(marker, next);
  }
  const policies = [];
  const providerNameAt = /"provider_name":"((?:[^"\\]|\\.)*)"/g;
  for (const whole of records) {
    // A record is the host's only when the record itself is that host's: its own provider_name is the first one in it. Merely
    // mentioning the host is not enough: the page's last record runs to the end of the page and takes in a page-wide list of providers,
    // which made another host's record (and its retention policy) count as this host's. Within the host's own record, only what comes
    // before any other provider's name is read, so a neighbouring host's policy can never be attributed to this one. Every own copy
    // must still pass; a host with no own record is still "policy-not-found".
    providerNameAt.lastIndex = 0;
    const names = [...whole.matchAll(providerNameAt)];
    if (!names.length || names[0][1] !== provider) continue;
    const foreign = names.find((match) => match[1] !== provider);
    const record = foreign ? whole.slice(0, foreign.index) : whole;
    for (const key of ["\"data_policy\":", "\"dataPolicy\":"]) {
      let i = record.indexOf(key);
      while (i >= 0) {
        const raw = objectAt(record, i + key.length);
        if (raw) {
          try { policies.push(JSON.parse(raw)); } catch { policies.push({ unparseable: true }); }
        }
        i = record.indexOf(key, i + key.length);
      }
    }
  }
  return policies;
}

const isZero = (value) => value === 0 || value === "0" || value === "0.0" || value === undefined || value === null;
const isFree = (pricing = {}) => isZero(pricing.prompt) && isZero(pricing.completion) && isZero(pricing.request) && isZero(pricing.image) && pricing.prompt !== undefined && pricing.completion !== undefined;

// A configured host name matches an endpoint by its display name ("Google AI Studio") or its slug ("google-ai-studio", "host/fp8").
export function hostMatches(configured, endpoint) {
  const want = String(configured ?? "").trim().toLowerCase();
  if (!want) return false;
  const name = String(endpoint?.provider_name ?? "").toLowerCase();
  const tag = String(endpoint?.tag ?? "").toLowerCase();
  if (want === name || want === tag) return true;
  const [wantSlug, wantQuant] = want.split("/");
  const [tagSlug, tagQuant] = tag.split("/");
  return Boolean(tagSlug) && wantSlug === tagSlug && (!wantQuant || wantQuant === tagQuant);
}

/** One host's verdict: { host, ok, reason, evidence }. */
function evaluateHost(endpoint, { model, providersHtml, requireFree, requireNoRetention, requireZeroRetention, maxRetentionDays = null }) {
  const pricing = endpoint.pricing ?? {};
  const endpointEvidence = { provider_name: endpoint.provider_name, model_id: endpoint.model_id, pricing, context_length: endpoint.context_length, max_completion_tokens: endpoint.max_completion_tokens, status: endpoint.status, supported_parameters: Array.isArray(endpoint.supported_parameters) ? endpoint.supported_parameters : [] };
  const verdict = (ok, reason, extra = {}) => ({ host: endpoint.provider_name, ok, reason, evidence: { endpoint: endpointEvidence, ...extra } });
  if (requireFree && !isFree(pricing)) return verdict(false, "endpoint-not-free");
  const policies = policiesFromProvidersPage(providersHtml, { model, provider: endpoint.provider_name });
  if (!policies.length) return verdict(false, "policy-not-found");
  if (policies.some((p) => p.unparseable)) return verdict(false, "policy-unparseable");
  // Every copy on the page must agree; one copy saying training (or no clear "false") rules the host out.
  if (policies.some((p) => p.training !== false)) return verdict(false, "training-not-false", { dataPolicy: policies.find((p) => p.training !== false) });
  if (policies.some((p) => p.canPublish === true)) return verdict(false, "publishes-prompts", { dataPolicy: policies.find((p) => p.canPublish === true) });
  if (requireNoRetention && policies.some((p) => p.retainsPrompts === true)) return verdict(false, "retains-prompts", { dataPolicy: policies.find((p) => p.retainsPrompts === true) });
  // Zero retention (Lumen's paid-zdr route): every copy must state that prompts are not retained, and none may keep them for safety.
  if (requireZeroRetention && policies.some((p) => p.retainsPrompts !== false || p.safetyRetention === true)) {
    return verdict(false, "retention-not-zero", { dataPolicy: policies.find((p) => p.retainsPrompts !== false || p.safetyRetention === true) });
  }
  // A retention ceiling (Aura, owner-approved 2026-11-15): a host that keeps prompts must say for how long in every copy, and no longer
  // than the ceiling the privacy policy discloses. Unstated or longer retention rules the host out.
  if (Number.isFinite(maxRetentionDays)) {
    const over = policies.find((p) => (p.retainsPrompts !== false || p.safetyRetention === true) && !(Number(p.retentionDays) > 0 && Number(p.retentionDays) <= maxRetentionDays));
    if (over) return verdict(false, "retention-over-limit", { dataPolicy: over, maxRetentionDays });
  }
  const { training, trainingOpenRouter, retainsPrompts, retentionDays, canPublish, safetyRetention, requiresUserIDs } = policies[0];
  return verdict(true, "verified", { dataPolicy: { training, trainingOpenRouter, retainsPrompts, retentionDays, canPublish, safetyRetention, requiresUserIDs }, policyCopies: policies.length });
}

/**
 * Pure decision for a route from the two fetched documents.
 * `mode`: "pinned" (with `hosts`), "deny", or "unpinned" (with `accountExcludesTraining`). Returns
 * { ok, reason, allowedHosts, hosts: [{ host, ok, reason }], evidence } where evidence is the first allowed host's (or, when none is
 * allowed, the first examined host's).
 */
export function evaluateRoutePolicy({ endpointsJson, providersHtml, model, mode = "pinned", hosts = null, requireFree = false, requireZeroRetention = false, maxRetentionDays = null, accountExcludesTraining = false }) {
  const endpoints = endpointsJson?.data?.endpoints;
  if (!Array.isArray(endpoints)) return { ok: false, reason: "endpoints-unreadable", allowedHosts: [], hosts: [], evidence: { endpointsJson: summarize(endpointsJson) } };
  const servingModel = endpoints.filter((e) => e && (e.model_id === model || !e.model_id));
  let candidates = servingModel;
  if (mode === "pinned") {
    candidates = servingModel.filter((e) => (hosts ?? []).some((configured) => hostMatches(configured, e)));
    if (!candidates.length) return { ok: false, reason: "provider-not-serving", allowedHosts: [], hosts: [], evidence: { providers: servingModel.map((e) => e.provider_name) } };
  } else if (!candidates.length) {
    return { ok: false, reason: "no-endpoints", allowedHosts: [], hosts: [], evidence: { providers: [] } };
  }
  const verdicts = candidates.map((endpoint) => evaluateHost(endpoint, { model, providersHtml, requireFree, requireNoRetention: mode === "deny", requireZeroRetention, maxRetentionDays }));
  // What the model accepts (text, image, ...), from the same document: the marketplace's capability check reads it with the host's own.
  const inputModalities = Array.isArray(endpointsJson?.data?.architecture?.input_modalities) ? endpointsJson.data.architecture.input_modalities : [];
  for (const verdict of verdicts) verdict.evidence.inputModalities = inputModalities;
  const allowed = verdicts.filter((v) => v.ok);
  const summary = verdicts.map(({ host, ok, reason }) => ({ host, ok, reason }));
  // An unpinned free model can land on any host, and the account does not exclude training hosts for free models: every host must pass.
  const everyHostMustPass = mode === "unpinned" && !accountExcludesTraining;
  const ok = everyHostMustPass ? allowed.length === verdicts.length : allowed.length > 0;
  if (ok) return { ok: true, reason: "verified", allowedHosts: allowed.map((v) => v.host), hosts: summary, evidence: allowed[0].evidence, positiveEvidence: false };
  const failing = verdicts.find((v) => !v.ok);
  const reason = verdicts.length === 1 || everyHostMustPass ? failing.reason : "no-compliant-host";
  // Positive evidence: the route failed because of what host policies say, not because something could not be read. With every host
  // required, one host with a policy finding is enough; otherwise every examined host must have one.
  const positiveEvidence = everyHostMustPass
    ? verdicts.some((v) => !v.ok && POSITIVE_HOST_REASONS.has(v.reason))
    : verdicts.every((v) => POSITIVE_HOST_REASONS.has(v.reason));
  return { ok: false, reason, allowedHosts: allowed.map((v) => v.host), hosts: summary, evidence: failing.evidence, positiveEvidence };
}

function summarize(value) {
  try { return JSON.stringify(value).slice(0, 400); } catch { return null; }
}

async function fetchWithTimeout(fetchImpl, url, accept) {
  const response = await fetchImpl(url, { headers: { Accept: accept }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  return response;
}

/**
 * Fetches both documents for one route and records the result. Never throws: a failure is a recorded reason.
 * Logs one line per check (`event`, default "route_policy") with the decision, the reason, the hosts examined and the policy seen.
 */
export async function verifyRoutePolicy({
  route, model, mode = "pinned", hosts = null, requireFree = false, requireZeroRetention = false, maxRetentionDays = null, accountExcludesTraining = false, event = "route_policy",
  fetchImpl = fetch, apiBase = "https://openrouter.ai/api/v1", siteBase = "https://openrouter.ai", log = console, now = () => Date.now(),
} = {}) {
  let result;
  if (!model || (mode === "pinned" && !(hosts ?? []).length)) {
    result = { ok: false, reason: "not-configured", allowedHosts: [], hosts: [], evidence: null };
  } else {
    try {
      const [endpointsResponse, pageResponse] = await Promise.all([
        fetchWithTimeout(fetchImpl, `${apiBase}/models/${model}/endpoints`, "application/json"),
        fetchWithTimeout(fetchImpl, `${siteBase}/${model}/providers`, "text/html"),
      ]);
      const endpointsJson = await endpointsResponse.json();
      const providersHtml = (await pageResponse.text()).slice(0, MAX_PAGE_BYTES);
      result = evaluateRoutePolicy({ endpointsJson, providersHtml, model, mode, hosts, requireFree, requireZeroRetention, maxRetentionDays, accountExcludesTraining });
    } catch (error) {
      result = { ok: false, reason: "policy-fetch-failed", allowedHosts: [], hosts: [], evidence: { error: String(error?.message ?? error).slice(0, 200) } };
    }
  }
  states.set(route, { status: result.ok ? "verified" : "failed", reason: result.reason, model, hosts: hostsKey(hosts), checkedAt: now(), evidence: result.evidence, allowedHosts: result.allowedHosts, positiveEvidence: Boolean(result.positiveEvidence) });
  const line = event === "lumen_gateway_policy"
    ? { event, approved: result.ok, reason: result.reason, provider: (hosts ?? [])[0] ?? null, evidence: result.evidence }
    : { event, route, approved: result.ok, reason: result.reason, positiveEvidence: Boolean(result.positiveEvidence), model, mode, allowedHosts: result.allowedHosts, hosts: result.hosts, evidence: result.evidence };
  (result.ok ? log.info : log.warn).call(log, JSON.stringify(line));
  return result;
}

/** Boot: check every given route once, then hourly. Returns the first results, keyed by route. */
export async function startRouteGuards(routes, options = {}) {
  const run = () => Promise.all(routes.map((route) => verifyRoutePolicy({ ...options, ...route })));
  const results = await run();
  if (timer) clearInterval(timer);
  timer = setInterval(() => { void run(); }, GUARD_INTERVAL_MS);
  timer.unref?.();
  return Object.fromEntries(routes.map((route, i) => [route.route, results[i]]));
}

export function stopRouteGuards() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** For tests only. */
export function resetRoutePolicyStateForTests(route = null, next = null) {
  if (route === null) states.clear();
  else if (next) states.set(route, next);
  else states.delete(route);
}
