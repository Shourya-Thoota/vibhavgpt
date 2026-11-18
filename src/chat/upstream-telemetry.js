/**
 * What an upstream model route said when it refused or failed a request (HTTP 429 or 5xx), made safe to log. It feeds capacity
 * decisions (rate limiting and queueing): which limit was hit, how long to wait, and whose limit it was (the router's, the host's).
 *
 * Logged: every x-ratelimit-* header and retry-after (from the response, and from the router's error metadata when it relays the
 * host's), the error code, one short redacted line of the message, the host the router named, and a short redacted excerpt of the
 * host's raw error. Never logged: the request or any part of a user's text (long quoted runs are removed, as a provider can quote the
 * request back), keys or tokens, emails, or the pseudonymous user hash sent on some routes.
 */
import { redactSensitive } from "../../frontend/src/sentry-scrub.js";

const MAX_BODY_BYTES = 2_048;
const MAX_HEADER_VALUE = 80;
const MAX_RAW = 300;
const MAX_HEADERS = 24;

export const RATE_LIMIT_HEADER = /^(x-ratelimit-[a-z0-9-]+|retry-after)$/i;

// Text from a provider, cleaned for logs: control characters, quoted runs, keys, emails and user hashes removed, then truncated.
export function scrubUpstreamText(text, max = MAX_RAW) {
  if (typeof text !== "string" || !text) return null;
  const cleaned = redactSensitive(text.replace(/[\u0000-\u001f\u007f]+/g, " "))
    .replace(/(["'`])[^"'`]{24,}\1/g, "[quoted]")
    .replace(/\bu_[0-9a-f]{16,}\b/gi, "[user]")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function headerValue(value) {
  return scrubUpstreamText(String(value ?? ""), MAX_HEADER_VALUE);
}

// Every rate-limit header in a Headers object (or a plain object of headers), names lowercased.
export function rateLimitHeaders(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === "function" ? [...headers.entries()] : Object.entries(headers);
  for (const [name, value] of entries) {
    if (Object.keys(out).length >= MAX_HEADERS) break;
    if (RATE_LIMIT_HEADER.test(String(name))) out[String(name).toLowerCase()] = headerValue(value);
  }
  return out;
}

// The error inside a provider's body: { error: {...} }, [{ error }], or plain text.
export function upstreamErrorDetail(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  let error = null;
  try {
    const parsed = JSON.parse(text);
    const candidate = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error;
    error = typeof candidate === "string" ? { message: candidate } : candidate && typeof candidate === "object" ? candidate : null;
  } catch {
    return { code: null, message: scrubUpstreamText(text, 160), host: null, raw: null, hostRateLimit: {} };
  }
  if (!error) return null;
  const metadata = error.metadata && typeof error.metadata === "object" ? error.metadata : {};
  const raw = typeof metadata.raw === "string" ? metadata.raw : metadata.raw ? JSON.stringify(metadata.raw) : null;
  return {
    code: typeof error.code === "string" || Number.isInteger(error.code) ? String(error.code).slice(0, 40) : null,
    message: scrubUpstreamText(typeof error.message === "string" ? error.message : "", 160),
    // The host the router sent the request to (server-side log only; never shown to anyone).
    host: typeof metadata.provider_name === "string" ? metadata.provider_name.slice(0, 60) : null,
    raw: scrubUpstreamText(raw),
    // A router relays the host's own rate-limit headers here when the host set them.
    hostRateLimit: rateLimitHeaders(metadata.headers && typeof metadata.headers === "object" ? metadata.headers : null),
  };
}

// Reads at most MAX_BODY_BYTES of a response body, so a large or endless body never holds the request.
export async function readBoundedBody(response) {
  let text = "";
  try {
    const reader = response?.body?.getReader();
    if (!reader) return "";
    const decoder = new TextDecoder();
    while (text.length < MAX_BODY_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    void reader.cancel().catch(() => {});
  } catch { /* The status and headers are still recorded. */ }
  return text.slice(0, MAX_BODY_BYTES);
}

// The text a request carried (its messages), flattened, to check what a provider sends back against it.
export function requestTextOf(body) {
  const parts = [];
  const visit = (value) => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") ["content", "text", "input"].forEach((key) => visit(value[key]));
  };
  visit(body?.messages ?? body?.input ?? null);
  return parts.join("\n").replace(/\s+/g, " ");
}

// A provider can echo part of the request back without quotes. Any 20-character stretch of a field that also occurs in the request
// withholds that field entirely.
const ECHO_WINDOW = 20;
function echoesRequest(text, requestText) {
  if (!text || !requestText || requestText.length < ECHO_WINDOW) return false;
  const flat = text.replace(/\s+/g, " ");
  for (let i = 0; i + ECHO_WINDOW <= flat.length; i += 4) {
    if (requestText.includes(flat.slice(i, i + ECHO_WINDOW))) return true;
  }
  return false;
}

export const isTelemetryStatus = (status) => status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);

/** The record for one failed response: { status, rateLimit, error }. `bodyText` is optional (already read elsewhere). */
export function upstreamFailureRecord({ status, headers, bodyText = "", requestText = "" }) {
  const error = upstreamErrorDetail(bodyText);
  if (error && requestText) {
    for (const key of ["message", "raw"]) if (echoesRequest(error[key], requestText)) error[key] = "[withheld: echoes the request]";
  }
  return { status, rateLimit: rateLimitHeaders(headers), error };
}

/** Logs one failed response from a route that has no inference log of its own (moderation, extraction, images, the classifier). */
export async function logUpstreamFailure({ route, model = null, response, requestId = null, requestBody = null, log = console }) {
  if (!response || !isTelemetryStatus(response.status)) return null;
  const record = upstreamFailureRecord({ status: response.status, headers: response.headers, bodyText: await readBoundedBody(response), requestText: requestTextOf(requestBody) });
  log.warn(JSON.stringify({ event: "upstream_http_error", route, model, requestId, ...record }));
  return record;
}
