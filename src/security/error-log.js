// What the server writes to its log when something fails. An error object can
// carry anything: a message built from the request body, the raw body itself,
// headers, a database row, an email address, a memory, a provider response. So
// nothing is copied from one. Every field below is chosen from a closed list
// of known values (anything else becomes the fixed word "other"), and no field
// is ever taken from an error's message, stack, cause or nested data. The full
// error still reaches error monitoring, which scrubs it separately (sentry.js).
//
// Matching a pattern is not enough to be safe: a value shaped like an
// identifier can still be someone's text. So names, codes, request types and
// route areas are looked up in the lists here, not validated by shape.
const OTHER = "other";
const listed = (values) => new Set(values);

// Class names of errors this server meets: JavaScript's own, Node's network
// and timeout errors, the HTTP body parser, the database drivers and Stripe.
const ERROR_NAMES = listed([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError",
  "AbortError", "TimeoutError", "DOMException",
  "BadRequestError", "PayloadTooLargeError", "UnsupportedMediaTypeError", "RequestHeaderFieldsTooLargeError", "ForbiddenError", "NotFoundError",
  "DatabaseError", "DrizzleQueryError", "DrizzleError",
  "StripeError", "StripeCardError", "StripeInvalidRequestError", "StripeAPIError", "StripeAuthenticationError", "StripeConnectionError",
  "StripePermissionError", "StripeRateLimitError", "StripeSignatureVerificationError", "StripeIdempotencyError",
]);
// Node system codes, PostgreSQL error classes and states, Stripe and provider codes that matter for diagnosis.
const ERROR_CODES = listed([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH", "ABORT_ERR",
  "ERR_INVALID_URL", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
  "23502", "23503", "23505", "23514", "22001", "22003", "22P02", "40001", "40P01", "42P01", "42703", "42501", "53300", "53200", "57014", "57P01", "08000", "08001", "08003", "08004", "08006", "08P01", "28P01", "3D000", "25P02", "55P03",
  "resource_missing", "rate_limit", "api_connection_error", "api_error", "authentication_error", "invalid_request_error", "idempotency_error",
  "rate_limit_exceeded", "insufficient_quota", "invalid_api_key", "model_not_found", "server_error", "context_length_exceeded", "invalid_value", "unsupported_value",
]);
const SQL_STATES = listed([...ERROR_CODES].filter((code) => /^[0-9][0-9A-Z]{4}$/.test(code)));
// What the HTTP body parser calls each failure.
const REQUEST_TYPES = listed([
  "entity.parse.failed", "entity.too.large", "entity.verify.failed", "request.aborted", "request.size.invalid", "stream.encoding.set",
  "encoding.unsupported", "charset.unsupported", "parameters.too.many", "querystring.parse.rangeError",
]);
// The /api/<area> that failed, by its fixed name. Anything not listed, including every
// id and every unknown path, is reported as "other".
const API_AREAS = listed([
  "account", "auth", "billing", "chat", "connect", "generation", "health", "me", "memory", "native-auth",
  "profile", "search", "security", "uploads", "usage", "voice", "webhooks",
]);
const METHODS = listed(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
// Request ids are made by this server (a random UUID), never taken from a request.
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// A caller's own fixed label, written as a literal at the call site. It names the
// event and is never built from data; this only rejects an unusable one.
const LABEL = /^[a-z][a-z0-9_]{2,60}$/;

const known = (set, value, fallback = OTHER) => (typeof value === "string" && set.has(value) ? value : fallback);
const httpStatus = (value) => (Number.isInteger(value) && value >= 100 && value <= 599 ? value : null);

// The fields the log is allowed to carry for one error. No message, stack, cause or nested data.
export function errorSummary(error) {
  const rawCode = typeof error?.code === "number" ? String(error.code) : error?.code;
  return {
    errorType: known(ERROR_NAMES, error?.name, "Error"),
    code: known(ERROR_CODES, rawCode, "unclassified"),
    type: typeof error?.type === "string" ? known(REQUEST_TYPES, error.type) : null,
    status: httpStatus(error?.status ?? error?.statusCode),
    sqlState: known(SQL_STATES, rawCode, null),
  };
}

// Used by the API error handler for an error no route handled.
export function apiErrorDiagnostics(error, req = {}) {
  const pathname = String(req.originalUrl ?? "").split(/[?#]/)[0];
  const area = pathname.match(/^\/api\/([a-z0-9-]{1,30})(?=\/|$)/i)?.[1];
  return {
    event: "api_error",
    method: known(METHODS, req.method, null),
    area: area === undefined ? null : known(API_AREAS, area.toLowerCase()),
    requestId: typeof req.chatRequestId === "string" && REQUEST_ID.test(req.chatRequestId) ? req.chatRequestId : null,
    ...errorSummary(error),
  };
}

export function logApiError(error, req) {
  console.error(JSON.stringify(apiErrorDiagnostics(error, req)));
}

// The only extra fields a caller can add to a failure line, and the only values each can have.
// Anything else is dropped (an unknown key) or, for a field that always appears, reported as
// "other". Add a field here, with its closed list, when a caller genuinely needs one.
const OTP_KINDS = ["sign-in", "email-verification", "forget-password", "change-email", "two-factor"];
const EXTRA_FIELDS = {
  // Where a webhook failed: checking its signature, or applying the verified event.
  stage: { values: new Set(["verify", "apply"]), otherwise: undefined },
  // Which kind of one-time code an email was for.
  kind: { values: new Set([...OTP_KINDS, OTHER]), otherwise: OTHER },
};

// A failure somewhere other than a request handler (a webhook, a background job, a provider call).
// `event` is the caller's fixed label, written as a literal at the call site. `fields` is read
// only through EXTRA_FIELDS above; a key it does not name, a value outside the list, and any
// attempt to set `event` or a diagnostic field are all ignored.
export function logFailure(event, error, fields = {}, level = "error") {
  const extra = {};
  for (const [name, { values, otherwise }] of Object.entries(EXTRA_FIELDS)) {
    if (!fields || !Object.hasOwn(fields, name)) continue;
    const value = typeof fields[name] === "string" && values.has(fields[name]) ? fields[name] : otherwise;
    if (value !== undefined) extra[name] = value;
  }
  const line = JSON.stringify({ event: LABEL.test(String(event)) ? event : "unlabelled_failure", ...extra, ...errorSummary(error) });
  if (level === "warn") console.warn(line);
  else console.error(line);
}
