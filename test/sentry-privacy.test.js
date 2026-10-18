import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as Sentry from "@sentry/node";
import { SENTRY_DATA_COLLECTION, redactSensitive, scrubBreadcrumb, scrubEvent, stripQuery } from "../frontend/src/sentry-scrub.js";
import { reportChatReplyFailure, reportServerError } from "../src/sentry.js";
import { sentryOptions } from "../src/instrument.js";

// Error monitoring receives diagnostics only. These run the real Sentry SDK
// with a placeholder DSN and a beforeSend that records each event and drops
// it, so nothing is ever sent.
const sent = [];
Sentry.init({
  dsn: "https://public@example.invalid/1",
  defaultIntegrations: false,
  beforeSend: (event) => { sent.push(scrubEvent(event)); return null; },
});
const settle = () => Sentry.flush(500);
const requestId = "eb239dbf-c645-4b41-bc8e-c0094150c300";

test("collection is locked down: no bodies, cookies, query strings or user identity", () => {
  assert.deepEqual(SENTRY_DATA_COLLECTION, {
    userInfo: false,
    cookies: false,
    httpBodies: [],
    urlQueryParams: false,
    httpHeaders: { request: { allow: ["user-agent", "content-type"] }, response: false },
  });
  const options = sentryOptions({ SENTRY_DSN: "https://public@example.invalid/2", NODE_ENV: "production", RAILWAY_GIT_COMMIT_SHA: "abc123" });
  assert.equal(options.environment, "production");
  assert.equal(options.release, "abc123");
  assert.equal(options.dataCollection, SENTRY_DATA_COLLECTION);
  assert.equal(options.beforeSend, scrubEvent);
  assert.equal(options.beforeBreadcrumb, scrubBreadcrumb);
  assert.equal(sentryOptions({}).release, undefined);
});

test("beforeSend strips request bodies, cookies, query strings, headers and the user", () => {
  const event = scrubEvent({
    request: {
      method: "POST",
      url: "https://api.vibhavgpt.com/api/chat/stream?draft=secret#frag",
      query_string: "draft=secret",
      data: { message: "Summarize my medical notes" },
      cookies: { "session_token": "abc" },
      headers: { "user-agent": "Mozilla/5.0", "content-type": "application/json", cookie: "session=abc", authorization: "Bearer xyz", "x-forwarded-for": "203.0.113.9" },
      env: { REMOTE_ADDR: "203.0.113.9" },
    },
    user: { id: "user-1", email: "a@b.com", ip_address: "203.0.113.9" },
  });
  assert.deepEqual(event.request, {
    method: "POST",
    url: "https://api.vibhavgpt.com/api/chat/stream",
    headers: { "user-agent": "Mozilla/5.0", "content-type": "application/json" },
  });
  assert.equal(event.user, undefined);
  assert.doesNotMatch(JSON.stringify(event), /medical|secret|session|xyz|203\.0\.113/);
});

test("emails and keys are scrubbed to [email] and [redacted]; reference and trace ids are kept", () => {
  assert.equal(redactSensitive("Failed for someone@example.com"), "Failed for [email]");
  assert.equal(redactSensitive("bad key sk-or-v1-abcdef1234567890 and token_abcdefgh"), "bad key [redacted] and [redacted]");
  assert.equal(redactSensitive("Authorization: Bearer abcdefghijklmnop"), "Authorization: [redacted]");
  assert.equal(redactSensitive(`blob ${"A".repeat(40)}`), "blob [redacted]");
  assert.equal(redactSensitive(`request ${requestId}`), `request ${requestId}`);
  const event = scrubEvent({
    message: "Signup failed for someone@example.com",
    exception: { values: [{ type: "Error", value: "upstream rejected key sk-live-abcdefghijkl" }] },
    extra: { note: "contact someone@example.com", nested: { key: "rk_test_abcdefgh" } },
    tags: { requestId },
    contexts: { trace: { trace_id: "0123456789abcdef0123456789abcdef", span_id: "0123456789abcdef" }, app: { note: "someone@example.com" } },
  });
  assert.equal(event.message, "Signup failed for [email]");
  assert.equal(event.exception.values[0].value, "upstream rejected key [redacted]");
  assert.deepEqual(event.extra, { note: "contact [email]", nested: { key: "[redacted]" } });
  assert.equal(event.tags.requestId, requestId);
  assert.equal(event.contexts.trace.trace_id, "0123456789abcdef0123456789abcdef", "trace links survive");
  assert.equal(event.contexts.app.note, "[email]");
});

test("breadcrumbs never carry bodies, console arguments or query strings", () => {
  const fetchCrumb = scrubBreadcrumb({ category: "fetch", data: { method: "POST", url: "/api/chat/stream?draft=hello", status_code: 500, body: "{\"message\":\"my prompt\"}", request_body: "my prompt" } });
  assert.deepEqual(fetchCrumb.data, { method: "POST", url: "/api/chat/stream", status_code: 500 });
  const consoleCrumb = scrubBreadcrumb({ category: "console", message: "failed https://api.example.test/search?q=private+question for a@b.com", data: { arguments: ["my prompt"], logger: "console" } });
  assert.equal(consoleCrumb.message, "failed https://api.example.test/search for [email]");
  assert.deepEqual(consoleCrumb.data, { logger: "console" });
  const nav = scrubBreadcrumb({ category: "navigation", data: { from: "/app?x=1", to: "/app/chat/abc?y=2" } });
  assert.deepEqual(nav.data, { from: "/app", to: "/app/chat/abc" });
  assert.equal(stripQuery("/a/b#c"), "/a/b");
});

test("4xx errors are not reported; 5xx errors are, tagged with the reference id", async () => {
  sent.length = 0;
  for (const status of [400, 401, 403, 404, 409, 413, 429]) {
    assert.equal(reportServerError(Object.assign(new Error("client error"), { status }), { status, requestId }), false);
  }
  await settle();
  assert.equal(sent.length, 0, "no client error reached Sentry");
  assert.equal(reportServerError(Object.assign(new Error("db down"), { code: "ECONNREFUSED" }), { status: 500, requestId, route: "/api/chat" }), true);
  await settle();
  assert.equal(sent.length, 1);
  assert.deepEqual({ requestId: sent[0].tags.requestId, route: sent[0].tags.route, status: sent[0].tags.status, code: sent[0].tags.code }, { requestId, route: "/api/chat", status: "500", code: "ECONNREFUSED" });
});

test("a chat failure report carries the reference id and code, never the message text", async () => {
  sent.length = 0;
  const error = Object.assign(new Error("Failed while answering: here is my private prompt about my diagnosis"), { code: "inference-unavailable", status: 503, stageCode: "provider-stream-error" });
  reportChatReplyFailure(error, { requestId, phase: "thinking" });
  await settle();
  assert.equal(sent.length, 1);
  const [event] = sent;
  assert.deepEqual({ requestId: event.tags.requestId, phase: event.tags.phase, code: event.tags.code, status: event.tags.status, stageCode: event.tags.stageCode },
    { requestId, phase: "thinking", code: "inference-unavailable", status: "503", stageCode: "provider-stream-error" });
  assert.equal(event.exception.values[0].value, "Chat reply failed: inference-unavailable");
  assert.doesNotMatch(JSON.stringify(event), /private prompt|diagnosis/);
  assert.ok(event.exception.values[0].stacktrace?.frames?.length > 0, "where it failed is kept");
});

test("the app wires monitoring in once, early, and only for real faults", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const pkg = JSON.parse(read("../package.json"));
  assert.equal(pkg.scripts.start, "node scripts/migrate-database.js && node --import ./src/instrument.js src/server.js");
  const instrument = read("../src/instrument.js");
  assert.match(instrument, /if \(process\.env\.SENTRY_DSN\) Sentry\.init\(sentryOptions\(\)\);/);
  const sentryModule = read("../src/sentry.js");
  assert.doesNotMatch(sentryModule, /Sentry\.init/, "src/sentry.js only re-exports");
  const server = read("../src/server.js");
  assert.match(server, /if \(config\.sentryDsn && reportServerError\(error, \{ status, requestId: _req\.chatRequestId \?\? null, route: _req\.baseUrl \|\| null \}\)\) \{/);
  assert.equal(server.match(/Sentry\.captureException/g), null, "the server reports only through reportServerError");
  const generation = read("../src/generation/router.js");
  assert.doesNotMatch(generation, /captureException/, "no duplicate report before next(error)");
  const chat = read("../src/chat/router.js");
  assert.equal(chat.match(/reportChatReplyFailure\(error, \{ requestId, phase \}\)/g)?.length, 3);
  assert.match(chat, /if \(error instanceof InferenceUnavailableError && !abortController\.signal\.aborted\) reportChatReplyFailure/);
  const frontend = read("../frontend/src/sentry.js");
  assert.match(frontend, /if \(dsn\) Sentry\.init\(sentryOptions\(dsn, import\.meta\.env\.MODE\)\);/);
  assert.match(frontend, /dataCollection: SENTRY_DATA_COLLECTION,\s*beforeSend: scrubEvent,\s*beforeSendTransaction: scrubEvent,\s*beforeBreadcrumb: scrubBreadcrumb,/);
  assert.doesNotMatch(frontend, /replayIntegration|Replay/, "no session replay");
});
