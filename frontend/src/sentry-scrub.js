// Privacy rules for error monitoring, shared by the server and the app.
// Sentry receives diagnostics only: never request or response bodies (a
// chat prompt, a conversation, an upload), cookies, query strings, or who
// the user is. Text that does reach it (error messages, breadcrumbs) has
// emails and anything key- or token-like replaced.

// Collect nothing that could carry user content or identity. An empty
// httpBodies list turns body collection off (the SDK expects a list).
export const SENTRY_DATA_COLLECTION = Object.freeze({
  userInfo: false,
  cookies: false,
  httpBodies: [],
  urlQueryParams: false,
  httpHeaders: { request: { allow: ["user-agent", "content-type"] }, response: false },
});

const ALLOWED_HEADERS = new Set(["user-agent", "content-type"]);
const MAX_DEPTH = 6;
// Request reference ids are UUIDs; they are what an event is looked up by.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function redactSensitive(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .replace(/\b(?:sk|pk|rk|key|token)[-_][A-Za-z0-9_-]{6,}/gi, "[redacted]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[redacted]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, (match) => (UUID.test(match) ? match : "[redacted]"));
}

// A URL without its query string or fragment.
export function stripQuery(url) {
  if (typeof url !== "string") return url;
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

function redactDeep(value, depth = 0) {
  if (typeof value === "string") return redactSensitive(value);
  if (!value || typeof value !== "object" || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, depth + 1);
  return out;
}

function scrubRequest(request) {
  if (!request || typeof request !== "object") return request;
  const clean = {};
  if (typeof request.method === "string") clean.method = request.method;
  if (typeof request.url === "string") clean.url = stripQuery(request.url);
  if (request.headers && typeof request.headers === "object") {
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => ALLOWED_HEADERS.has(name.toLowerCase())));
    if (Object.keys(headers).length) clean.headers = headers;
  }
  // Never kept: data (the body), cookies, query_string, env.
  return clean;
}

const BODY_KEYS = new Set(["body", "request_body", "response_body", "data", "input", "arguments"]);

export function scrubBreadcrumb(breadcrumb) {
  if (!breadcrumb || typeof breadcrumb !== "object") return breadcrumb;
  const clean = { ...breadcrumb };
  if (typeof clean.message === "string") clean.message = redactSensitive(stripQueryInText(clean.message));
  if (clean.data && typeof clean.data === "object") {
    const data = {};
    for (const [key, value] of Object.entries(clean.data)) {
      if (BODY_KEYS.has(key)) continue;
      if ((key === "url" || key === "from" || key === "to") && typeof value === "string") data[key] = stripQuery(value);
      else data[key] = redactDeep(value);
    }
    clean.data = data;
  }
  return clean;
}

// URLs written inside free text (for example a logged message).
function stripQueryInText(text) {
  return text.replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, "$1");
}

export function scrubEvent(event) {
  if (!event || typeof event !== "object") return event;
  const clean = { ...event };
  if (clean.request) clean.request = scrubRequest(clean.request);
  delete clean.user;
  if (typeof clean.message === "string") clean.message = redactSensitive(clean.message);
  if (clean.logentry) clean.logentry = redactDeep(clean.logentry);
  if (clean.exception?.values) {
    clean.exception = { ...clean.exception, values: clean.exception.values.map((value) => ({ ...value, value: redactSensitive(value.value) })) };
  }
  if (Array.isArray(clean.breadcrumbs)) clean.breadcrumbs = clean.breadcrumbs.map(scrubBreadcrumb).filter(Boolean);
  else if (Array.isArray(clean.breadcrumbs?.values)) clean.breadcrumbs = { ...clean.breadcrumbs, values: clean.breadcrumbs.values.map(scrubBreadcrumb).filter(Boolean) };
  if (clean.extra) clean.extra = redactDeep(clean.extra);
  if (clean.tags) clean.tags = redactDeep(clean.tags);
  // Sentry's own trace ids link an error to its trace; everything else in
  // the contexts is redacted like any other text.
  if (clean.contexts) {
    const { trace, ...rest } = clean.contexts;
    clean.contexts = { ...redactDeep(rest), ...(trace ? { trace } : {}) };
  }
  return clean;
}
