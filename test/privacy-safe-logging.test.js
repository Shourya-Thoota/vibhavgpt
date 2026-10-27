// First import: removes inherited credentials and sets placeholders before any application code reads them.
import { blockOutbound, databaseSpy } from "./synthetic-environment.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { config } = await import("../src/config.js");
const { apiErrorDiagnostics, errorSummary, logFailure } = await import("../src/security/error-log.js");
const { stripeWebhookHandler } = await import("../src/billing/router.js");
const { extractAndSaveFacts } = await import("../src/memory/service.js");
const { checkModeration } = await import("../src/chat/moderation.js");
const { sendOtpEmail } = await import("../src/email/service.js");
const { RECONCILE_INTERVAL_MS, startLiveUsageReconciliationJob, stopLiveUsageReconciliationJob } = await import("../src/voice/live-usage.js");

// Every sentinel is synthetic. Each test puts them everywhere an error or request can carry text
// (message, name, code, cause, nested response, body, headers, an email address, user content)
// and checks that none reaches the log. The values are not shaped like real keys.
const SENTINELS = [
  "SENTINEL_MESSAGE_TEXT", "SENTINEL_PROVIDER_REPLY", "SENTINEL_USER_CONTENT", "SENTINEL_HEADER_VALUE",
  "SENTINEL_COOKIE_VALUE", "SENTINEL_BODY_VALUE", "SENTINEL_PARAM_NAME", "SENTINEL_REQUEST_ID", "SENTINEL_CAUSE_TEXT",
  "sentinel-person@example.invalid", "sentinel-sender@example.invalid", "SENTINEL_CODE_LOOKALIKE", "SentinelNameLookalike",
];
// Lowercase and identifier-shaped on purpose: text a pattern check would let through.
const PRIVATE = "private_diary_text";
const assertClean = (text) => { for (const sentinel of [...SENTINELS, PRIVATE]) assert.equal(text.includes(sentinel), false, `a log line contained ${sentinel}: ${text}`); };

// Nothing leaves the machine and the database is never reached. Any outbound request throws at once
// (the code under test is given injected fakes instead), and any database call throws and is counted.
// `answer` lets one expected query be answered with synthetic rows; it is counted too.
async function sandbox(t, options) {
  const outbound = blockOutbound();
  t.after(() => outbound.restore());
  const database = await databaseSpy(t, options);
  return {
    expectNoActivity(expectedDatabaseCalls = 0) {
      assert.deepEqual(outbound.blocked, [], "no outbound request was attempted");
      assert.equal(database.total(), expectedDatabaseCalls, `database calls: ${JSON.stringify(database.calls)}`);
    },
  };
}

async function captured(run) {
  const lines = [];
  const originals = { error: console.error, warn: console.warn, log: console.log };
  const take = (...args) => lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  console.error = take; console.warn = take; console.log = take;
  try { await run(); } finally { Object.assign(console, originals); }
  return lines;
}

function hostile(overrides = {}) {
  return Object.assign(new Error(`failed for ${SENTINELS[9]}: ${SENTINELS[0]} ${SENTINELS[2]}`), {
    name: SENTINELS[12], code: SENTINELS[11], type: SENTINELS[5], status: 400, statusCode: 400,
    constraint: SENTINELS[1], detail: SENTINELS[9], body: SENTINELS[5],
    headers: { authorization: SENTINELS[3], cookie: SENTINELS[4] },
    cause: Object.assign(new Error(SENTINELS[8]), { code: SENTINELS[11], response: { data: SENTINELS[1] } }),
    response: { data: { error: { message: SENTINELS[1], param: SENTINELS[6] } } }, errors: [new Error(SENTINELS[0])],
    stack: `Error: ${SENTINELS[0]}\n    at ${SENTINELS[2]} (file.js:1:1)`, ...overrides,
  });
}

test("a name, code or type that merely looks like an identifier is not logged; only known values are", () => {
  assert.deepEqual(errorSummary(hostile()), { errorType: "Error", code: "unclassified", type: "other", status: 400, sqlState: null });
  assert.deepEqual(errorSummary(Object.assign(new TypeError("x"), { code: "ECONNREFUSED" })), { errorType: "TypeError", code: "ECONNREFUSED", type: null, status: null, sqlState: null });
  assert.deepEqual(errorSummary(Object.assign(new Error("x"), { name: "DatabaseError", code: "23505" })), { errorType: "DatabaseError", code: "23505", type: null, status: null, sqlState: "23505" });
  assert.equal(errorSummary(Object.assign(new Error("x"), { code: "ZZZZZ" })).sqlState, null, "a five-character code is not a SQL state unless it is a listed one");
  assert.equal(errorSummary(Object.assign(new Error("x"), { code: PRIVATE, name: PRIVATE, type: PRIVATE })).code, "unclassified");
  assert.equal(errorSummary(Object.assign(new Error("x"), { name: PRIVATE })).errorType, "Error");
  assert.equal(errorSummary(Object.assign(new Error("x"), { type: "entity.parse.failed" })).type, "entity.parse.failed");
  assert.equal(errorSummary({ statusCode: 404 }).status, 404);
  assert.equal(errorSummary({ status: 99 }).status, null);
  assert.equal(errorSummary({ status: "500" }).status, null);
  assert.deepEqual(Object.keys(errorSummary(null)), ["errorType", "code", "type", "status", "sqlState"]);
});

test("the API diagnostics list exact keys, a fixed set of areas, and only server-made request ids", () => {
  const request = { method: "POST", originalUrl: `/api/${SENTINELS[6].toLowerCase()}/${SENTINELS[0]}?token=${SENTINELS[3]}#${SENTINELS[4]}`, chatRequestId: SENTINELS[7] };
  const record = apiErrorDiagnostics(hostile(), request);
  assertClean(JSON.stringify(record));
  assert.deepEqual(Object.keys(record), ["event", "method", "area", "requestId", "errorType", "code", "type", "status", "sqlState"]);
  assert.equal(record.area, null, "a segment that is not even area-shaped is dropped");
  assert.equal(apiErrorDiagnostics(new Error("x"), { originalUrl: `/api/sentinel-area-lookalike/${SENTINELS[0]}` }).area, "other", "an unlisted area, however identifier-like, is reported as other");
  assert.equal(apiErrorDiagnostics(new Error("x"), { originalUrl: `/api/${PRIVATE.replaceAll("_", "-")}/x`, chatRequestId: PRIVATE }).area, "other");
  assert.equal(record.requestId, null, "an identifier-shaped value that is not a server-made UUID is dropped");
  const requestId = "eb239dbf-c645-4b41-bc8e-c0094150c300";
  assert.deepEqual(
    [apiErrorDiagnostics(new Error("x"), { method: "GET", originalUrl: "/api/chat/abc?x=1", chatRequestId: requestId }).area,
      apiErrorDiagnostics(new Error("x"), { originalUrl: "/api/native-auth/callback" }).area,
      apiErrorDiagnostics(new Error("x"), { originalUrl: "/api/voice" }).area,
      apiErrorDiagnostics(new Error("x"), { originalUrl: "/somewhere/else" }).area,
      apiErrorDiagnostics(new Error("x"), { originalUrl: undefined }).area],
    ["chat", "native-auth", "voice", null, null],
  );
  assert.equal(apiErrorDiagnostics(new Error("x"), { chatRequestId: requestId }).requestId, requestId);
  assert.equal(apiErrorDiagnostics(new Error("x"), { method: `POST ${SENTINELS[0]}` }).method, null);
});

test("logFailure reads only its two-field schema: unknown keys and values are dropped, never copied", async () => {
  const lines = await captured(() => {
    // Lowercase identifier-shaped text in an arbitrary key, an arbitrary value, and in both allowed fields.
    logFailure("sample_failure", hostile(), { [PRIVATE]: PRIVATE, note: PRIVATE, count: 3, retried: true, nested: { [PRIVATE]: PRIVATE }, stage: PRIVATE, kind: PRIVATE });
    // Known values are kept, and the unknown key beside them is not.
    logFailure("sample_failure", new Error("x"), { stage: "verify", kind: "email-verification", [PRIVATE]: true, attempt: 2 });
    logFailure("sample_failure", new Error("x"), { stage: "apply", kind: "two-factor" });
    logFailure("sample_failure", new Error("x"), { kind: "sign-in" });
    // Nothing usable at all.
    logFailure("sample_failure", new Error("x"), null);
    logFailure("sample_failure", new Error("x"), PRIVATE);
    logFailure("sample_failure", new Error("x"), [PRIVATE]);
    logFailure(`bad label ${PRIVATE}`, hostile());
  });
  assert.equal(lines.length, 8);
  assertClean(lines.join("\n"));
  const [first, second, third, fourth, fifth, sixth, seventh, unlabelled] = lines.map((line) => JSON.parse(line));
  const summary = { errorType: "Error", code: "unclassified", type: null, status: null, sqlState: null };
  assert.deepEqual(first, { event: "sample_failure", kind: "other", errorType: "Error", code: "unclassified", type: "other", status: 400, sqlState: null }, "an unknown stage is dropped and an unknown kind is reported as other");
  assert.deepEqual(second, { event: "sample_failure", stage: "verify", kind: "email-verification", ...summary });
  assert.deepEqual(third, { event: "sample_failure", stage: "apply", kind: "two-factor", ...summary });
  assert.deepEqual(fourth, { event: "sample_failure", kind: "sign-in", ...summary });
  for (const record of [fifth, sixth, seventh]) assert.deepEqual(record, { event: "sample_failure", ...summary }, "no extras");
  assert.equal(unlabelled.event, "unlabelled_failure");
});

test("extra fields cannot overwrite the event or the diagnostic fields, whatever they are called", async () => {
  const inherited = JSON.parse(`{"__proto__": {"stage": "verify"}, "kind": "${PRIVATE}"}`);
  const lines = await captured(() => {
    logFailure("sample_failure", Object.assign(new Error("x"), { code: "ECONNREFUSED", status: 503 }), {
      event: "forged_event", errorType: "Forged", code: "forged_code", type: "forged_type", status: 599, sqlState: "99999", stage: "apply",
    });
    logFailure("sample_failure", new Error("x"), inherited);
    logFailure("sample_failure", new Error("x"), { get stage() { return "verify"; }, constructor: { stage: "apply" }, toString: PRIVATE });
  });
  assertClean(lines.join("\n"));
  const [forged, withInherited, accessor] = lines.map((line) => JSON.parse(line));
  assert.deepEqual(forged, { event: "sample_failure", stage: "apply", errorType: "Error", code: "ECONNREFUSED", type: null, status: 503, sqlState: null }, "the event and every diagnostic field come from the label and the error");
  assert.equal(Object.hasOwn(withInherited, "__proto__"), false);
  assert.deepEqual(withInherited, { event: "sample_failure", kind: "other", errorType: "Error", code: "unclassified", type: null, status: null, sqlState: null });
  assert.equal(accessor.stage, "verify", "an own accessor that returns an allowed value is still just an allowed value");
  assert.equal(Object.hasOwn(accessor, "constructor"), false);
  assert.equal(Object.hasOwn(accessor, "toString"), false);
});

test("a failed billing webhook logs its stage and a known error class, never the payload, signature or error text", async (t) => {
  const box = await sandbox(t);
  const saved = { secret: config.stripeWebhookSecret, key: config.stripeSecretKey };
  config.stripeWebhookSecret = "webhook-secret-sentinel-not-real"; config.stripeSecretKey = "stripe-key-sentinel-not-real";
  const handler = stripeWebhookHandler[1];
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  try {
    const lines = await captured(() => handler({ body: Buffer.from(JSON.stringify({ note: SENTINELS[5], customer: SENTINELS[9], diary: PRIVATE })), headers: { "stripe-signature": `t=1,v1=${SENTINELS[3]}` } }, res));
    assert.equal(res.code, 400, "the response is unchanged");
    assert.deepEqual(res.body, { error: "Webhook could not be verified." });
    assert.equal(lines.length, 1);
    assertClean(lines[0]);
    const record = JSON.parse(lines[0]);
    assert.equal(record.event, "billing_webhook_failed");
    assert.equal(record.stage, "verify");
    assert.deepEqual(Object.keys(record).sort(), ["code", "errorType", "event", "sqlState", "stage", "status", "type"]);
  } finally { Object.assign(config, { stripeWebhookSecret: saved.secret, stripeSecretKey: saved.key }); }
  box.expectNoActivity();
});

test("a failed memory extraction logs the failure class, not the error text or the person's message", async (t) => {
  const box = await sandbox(t);
  const saved = { key: config.providerKeys.primaryFree, url: config.providerBaseUrls.primaryFree, model: config.memoryExtractionModel, approved: config.lumenPrimaryApproved };
  config.providerKeys.primaryFree = "memory-key-sentinel"; config.providerBaseUrls.primaryFree = "https://primary.test/v1"; config.memoryExtractionModel = "fixture/memory"; config.lumenPrimaryApproved = true;
  try {
    let result;
    const lines = await captured(async () => {
      result = await extractAndSaveFacts("user-1", `remember ${SENTINELS[2]} and ${SENTINELS[9]} and ${PRIVATE}`, [{ content: SENTINELS[2] }], {
        fetchImpl: async () => { throw hostile({ message: `provider echoed ${SENTINELS[2]} ${SENTINELS[9]} ${PRIVATE}` }); },
      });
    });
    assert.deepEqual(result, [], "chat still continues with no facts");
    assert.equal(lines.length, 1);
    assertClean(lines[0]);
    assert.equal(JSON.parse(lines[0]).event, "memory_fact_extraction_unavailable");
  } finally {
    config.providerKeys.primaryFree = saved.key; config.providerBaseUrls.primaryFree = saved.url; config.memoryExtractionModel = saved.model; config.lumenPrimaryApproved = saved.approved;
  }
  box.expectNoActivity();
});

test("a failed content classifier logs the failure class and the message is still allowed through the local guard", async (t) => {
  const box = await sandbox(t);
  const saved = { url: config.moderationApiUrl, model: config.moderationModel, key: config.moderationApiKey, approved: config.moderationDataPolicyApproved };
  config.moderationApiUrl = "https://moderation.test/v1/chat"; config.moderationModel = "fixture/moderation"; config.moderationApiKey = "moderation-key-sentinel"; config.moderationDataPolicyApproved = true;
  try {
    let result;
    const lines = await captured(async () => {
      result = await checkModeration(`a harmless note ${SENTINELS[2]} ${PRIVATE}`, { fetchImpl: async () => { throw hostile({ message: `fetch failed for ${SENTINELS[2]} ${PRIVATE}` }); } });
    });
    assert.deepEqual(result, { flagged: false, category: "" });
    assert.equal(lines.length, 1);
    assertClean(lines[0]);
    assert.equal(JSON.parse(lines[0]).event, "content_classifier_unavailable");
  } finally {
    Object.assign(config, { moderationApiUrl: saved.url, moderationModel: saved.model, moderationApiKey: saved.key, moderationDataPolicyApproved: saved.approved });
  }
  box.expectNoActivity();
});

test("a failed OTP email logs the HTTP status and kind of code, not the provider's text, the sender or the recipient", async (t) => {
  // The one expected query is the greeting's name lookup, answered here with no rows; it must happen once per email.
  const box = await sandbox(t, { answer: async () => ({ rows: [] }) });
  const saved = { key: config.resendApiKey, from: config.emailFrom, fetch: globalThis.fetch };
  config.resendApiKey = "email-key-sentinel"; config.emailFrom = SENTINELS[10];
  // The only destination the email code can reach is this fake; it is never forwarded anywhere.
  const requested = [];
  globalThis.fetch = async (url) => { requested.push(String(url)); return { ok: false, status: 422, json: async () => ({ message: `${SENTINELS[1]} rejected ${SENTINELS[9]} ${PRIVATE}` }) }; };
  try {
    let failure;
    const lines = await captured(async () => {
      await sendOtpEmail({ email: SENTINELS[9], otp: "123456", type: "sign-in" }).catch((error) => { failure = error; });
    });
    assert.equal(failure?.message, "We couldn't send your code. Please try again.", "the thrown message is unchanged");
    assert.equal(lines.length, 1);
    assertClean(lines[0]);
    assert.deepEqual(JSON.parse(lines[0]), { event: "otp_email_delivery_failed", kind: "sign-in", errorType: "Error", code: "unclassified", type: null, status: 422, sqlState: null });
    const odd = await captured(async () => { await sendOtpEmail({ email: SENTINELS[9], otp: "123456", type: PRIVATE }).catch(() => {}); });
    assertClean(odd[0]);
    assert.equal(JSON.parse(odd[0]).kind, "other", "an unknown kind of code is reported as other");
    assert.deepEqual(requested, ["https://api.resend.com/emails", "https://api.resend.com/emails"], "only the two expected requests, both to the fake");
  } finally { Object.assign(config, { resendApiKey: saved.key, emailFrom: saved.from }); globalThis.fetch = saved.fetch; }
  box.expectNoActivity(2);
});

test("a failed voice-usage reconciliation run logs a known code and nothing from the error", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const box = await sandbox(t);
  let runs = 0;
  // A synthetic failure injected in place of the real reconciliation, so no database is involved.
  const reconcile = async () => { runs += 1; throw hostile({ name: "Error", code: "ECONNREFUSED", message: `connect failed: ${SENTINELS[0]} ${PRIVATE} ${SENTINELS[9]}` }); };
  let lines;
  try {
    lines = await captured(async () => {
      startLiveUsageReconciliationJob({ reconcile });
      t.mock.timers.tick(RECONCILE_INTERVAL_MS);
      await new Promise((resolve) => setImmediate(resolve));
    });
  } finally { stopLiveUsageReconciliationJob(); t.mock.timers.reset(); }
  assert.equal(runs, 1, "the job ran the injected reconciliation exactly once");
  assert.equal(lines.length, 1);
  assertClean(lines[0]);
  assert.deepEqual(JSON.parse(lines[0]), { event: "voice_usage_reconciliation_failed", errorType: "Error", code: "ECONNREFUSED", type: "other", status: 400, sqlState: null });
  box.expectNoActivity();
});

test("a Stripe-shaped error is reduced to its class, code and status", () => {
  const stripe = Object.assign(new Error(`No such subscription: ${SENTINELS[9]} ${SENTINELS[0]} ${PRIVATE}`), {
    name: "StripeInvalidRequestError", code: "resource_missing", statusCode: 404, raw: { message: SENTINELS[1], param: SENTINELS[6] }, requestId: SENTINELS[7],
  });
  assert.deepEqual(errorSummary(stripe), { errorType: "StripeInvalidRequestError", code: "resource_missing", type: null, status: 404, sqlState: null });
});

// The text between a call's parentheses, found by matching them (strings and escapes skipped), so a
// semicolon or a bracket inside a log message cannot hide a call from the check.
function callArguments(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      for (index += 1; index < source.length && source[index] !== char; index += 1) if (source[index] === "\\") index += 1;
    } else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return source.slice(openIndex + 1, index);
  }
  throw new Error("unbalanced call");
}

test("the argument scanner sees a call whose log text contains a semicolon", () => {
  const source = 'console.warn("Fact extraction was unavailable; chat will continue.", { reason: error.message });';
  assert.equal(callArguments(source, source.indexOf("(")), '"Fact extraction was unavailable; chat will continue.", { reason: error.message }');
});

test("no log call in the reported files passes an error's message, stack, cause or object", () => {
  const files = ["src/billing/router.js", "src/memory/service.js", "src/email/service.js", "src/voice/live-usage.js", "src/billing/service.js", "src/chat/moderation.js", "src/voice/live-comet.js", "src/server.js"];
  for (const path of files) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    // Every direct console.error/warn call must be a fixed string, or the structured start-up and auth records.
    for (const match of source.matchAll(/console\.(?:error|warn)\(/g)) {
      const argument = callArguments(source, match.index + match[0].length - 1).trim();
      const fixedString = /^"[^"$]*"$/.test(argument);
      const structuredRecord = /^JSON\.stringify\(\{/.test(argument);
      assert.ok(fixedString || structuredRecord, `${path}: console call is not a fixed string or structured record: ${argument.slice(0, 80)}`);
      assert.doesNotMatch(argument, /\.message|\.stack|\.cause|\berror\)|,\s*error\b/, `${path}: console call carries error data: ${argument.slice(0, 80)}`);
    }
    // Every logFailure call names a fixed label written as a string literal.
    for (const match of source.matchAll(/logFailure\(([^)]*)/g)) assert.match(match[1], /^"[a-z][a-z0-9_]{2,60}"\s*,/, `${path}: logFailure label is not a literal`);
    assert.doesNotMatch(source, /logFailure\([^)]*\.(message|stack|cause)\b/, `${path}: logFailure is given error text`);
  }
});
