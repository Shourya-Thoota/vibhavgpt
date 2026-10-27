// First import: removes inherited credentials and sets placeholders before any application code reads them.
import { blockOutbound, databaseSpy } from "./synthetic-environment.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { apiErrorDiagnostics, logApiError } from "../src/security/error-log.js";

// Every value below is synthetic. The point is that nothing a request or an
// error carries can reach the server log, whatever shape it arrives in.
const SECRETS = [
  "sk-live-SYNTHETIC-KEY-1",
  "Bearer SYNTHETIC-TOKEN-2",
  "session=SYNTHETIC-COOKIE-3",
  "hunter2-SYNTHETIC-PASSWORD",
  "my private diary entry SYNTHETIC",
  "postgres://user:SYNTHETIC-DB-PASSWORD@db.invalid/app",
  "person@example.invalid",
  "203.0.113.77",
];

const capture = (run) => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  return Promise.resolve().then(run).then(() => lines).finally(() => { console.error = original; });
};
const assertNoSecrets = (text) => { for (const secret of SECRETS) assert.equal(text.includes(secret), false, `log leaked ${secret}`); };

function hostileError() {
  const error = new Error(`insert failed for ${SECRETS[6]} using ${SECRETS[5]} with ${SECRETS[4]}`);
  error.name = `Error ${SECRETS[3]}`;
  error.code = `${SECRETS[0]} (not an identifier)`;
  error.status = 500;
  error.constraint = SECRETS[1];
  error.body = `{"password":"${SECRETS[3]}","message":"${SECRETS[4]}"`;
  error.headers = { authorization: SECRETS[1], cookie: SECRETS[2], "x-forwarded-for": SECRETS[7] };
  error.request = { url: `/api/account?token=${SECRETS[0]}`, body: { note: SECRETS[4] } };
  error.detail = `Key (email)=(${SECRETS[6]}) already exists.`;
  error.cause = Object.assign(new Error(SECRETS[5]), { code: SECRETS[0], response: { data: { echoed: SECRETS[4] }, headers: { "set-cookie": SECRETS[2] } } });
  error.errors = [new Error(SECRETS[3]), { message: SECRETS[1] }];
  error.stack = `Error: ${SECRETS[4]}\n    at secret (${SECRETS[5]}:1:1)`;
  return error;
}

const hostileRequest = () => ({
  method: "POST",
  originalUrl: `/api/account/${SECRETS[0]}/delete?email=${SECRETS[6]}&token=${SECRETS[1]}#${SECRETS[2]}`,
  headers: { authorization: SECRETS[1], cookie: SECRETS[2], "x-forwarded-for": SECRETS[7] },
  body: { password: SECRETS[3], message: SECRETS[4] },
  chatRequestId: SECRETS[4],
});

test("diagnostics keep only known values and drop secrets, content, headers, bodies and nested data", () => {
  const record = apiErrorDiagnostics(hostileError(), hostileRequest());
  assertNoSecrets(JSON.stringify(record));
  assert.deepEqual(record, {
    event: "api_error", method: "POST", area: "account", requestId: null,
    errorType: "Error", code: "unclassified", type: null, status: 500, sqlState: null,
  });
});

test("diagnostics list exactly the allowlisted keys, so a new field cannot slip in", () => {
  assert.deepEqual(Object.keys(apiErrorDiagnostics(new Error("x"), {})), ["event", "method", "area", "requestId", "errorType", "code", "type", "status", "sqlState"]);
  assert.deepEqual(apiErrorDiagnostics(undefined, undefined), {
    event: "api_error", method: null, area: null, requestId: null, errorType: "Error", code: "unclassified", type: null, status: null, sqlState: null,
  });
});

test("useful diagnostics survive when they are known values: type, code, status, SQL state, request id, route area", () => {
  const error = Object.assign(new TypeError("boom"), { code: "23505", status: 409, constraint: "users_email_key", type: "entity.parse.failed" });
  const requestId = "eb239dbf-c645-4b41-bc8e-c0094150c300";
  assert.deepEqual(apiErrorDiagnostics(error, { method: "PATCH", originalUrl: "/api/chat/abc?x=1", chatRequestId: requestId }), {
    event: "api_error", method: "PATCH", area: "chat", requestId,
    errorType: "TypeError", code: "23505", type: "entity.parse.failed", status: 409, sqlState: "23505",
  });
  assert.equal(apiErrorDiagnostics(Object.assign(new Error("x"), { code: "ECONNREFUSED" }), {}).code, "ECONNREFUSED");
});

test("only a known /api/<area> name is kept: no query, fragment, id, unknown area or non-api path", () => {
  const area = (originalUrl) => apiErrorDiagnostics(new Error("x"), { originalUrl }).area;
  assert.equal(area("/api/connect/partner/subscription?id=1"), "connect");
  assert.equal(area("/api/chat"), "chat");
  assert.equal(area("/api/chat#frag"), "chat");
  assert.equal(area("/api/not-a-listed-area/x"), "other");
  assert.equal(area(`/api/${"a".repeat(31)}/x`), null);
  assert.equal(area("/api/we ird/x"), null);
  assert.equal(area("/somewhere/else"), null);
  assert.equal(area(undefined), null);
  assert.equal(apiErrorDiagnostics(new Error("x"), { method: "TRACE secret" }).method, null);
});

test("logApiError writes one JSON line and nothing else", async () => {
  const lines = await capture(() => logApiError(hostileError(), hostileRequest()));
  assert.equal(lines.length, 1);
  assertNoSecrets(lines[0]);
  assert.equal(JSON.parse(lines[0]).event, "api_error");
});

test("server.js no longer logs a raw error object", () => {
  const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /console\.(error|warn|log)\([^)]*\berror\s*\)/);
  assert.match(source, /logApiError\(error, _req\)/);
});

test("the real handler logs a malformed-JSON failure without echoing the body, headers or cookies", async (t) => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  // Only this exact local origin is reachable, and the database pool throws and counts any call.
  const outbound = blockOutbound(`http://127.0.0.1:${server.address().port}`);
  const database = await databaseSpy(t);
  try {
    const { port } = server.address();
    const body = `{"password":"${SECRETS[3]}","message":"${SECRETS[4]}",`;
    let response, responseText;
    const lines = await capture(async () => {
      response = await fetch(`http://127.0.0.1:${port}/api/voice/live/session/abc/end?token=${SECRETS[0]}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: SECRETS[1], cookie: SECRETS[2], "x-forwarded-for": SECRETS[7] },
        body,
      });
      responseText = await response.text();
    });
    // The response is unchanged by this work: a client error answers the sender.
    assert.equal(response.status, 400);
    assert.ok(JSON.parse(responseText).error);
    assert.equal(lines.length, 1, `expected one log line, got: ${lines.join(" | ")}`);
    assertNoSecrets(lines[0]);
    const record = JSON.parse(lines[0]);
    assert.equal(record.event, "api_error");
    assert.equal(record.area, "voice");
    assert.equal(record.method, "POST");
    assert.equal(record.status, 400);
    assert.equal(record.type, "entity.parse.failed");
    assert.deepEqual(outbound.blocked, [], "no request to any other destination was attempted");
    assert.equal(database.total(), 0, "the parser rejects before any database work");
  } finally {
    outbound.restore();
    await new Promise((resolve) => server.close(resolve));
  }
});
