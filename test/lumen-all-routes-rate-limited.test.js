import test, { beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// The production shape of the Lumen failure reported as e95d6c11-b326-4992-8424-7c792e5e6a73: two stages are approved (primary, gateway) and
// the other two are configured but not approved, and both approved stages answer HTTP 429 at the same moment, one with a per-organisation
// tokens-per-minute limit and one with a site-wide "free capacity is full" limit. This pins what the code does in that situation, through the
// real chat routes: it stops after exactly one chat request per approved stage (a 429 is not retried while another stage can answer, and the
// provider's "retry after 30 seconds" is not waited out), it never touches an unapproved or paid route, the person gets the same generic
// message whatever the provider said, nothing the provider said or the person typed reaches the logs, and nothing is charged.
//
// What this test does NOT claim: it does not add capacity. With both approved stages limited there is nothing left to try, and that is the
// correct, bounded outcome. More availability needs a third stage the owner has approved, which is a data-policy decision, not a code change.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db: drizzle(client), pool: { query: (sql, params) => client.query(sql, params) } },
});
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => (req.authSession ? next() : res.status(401).json({ error: "Sign in is required." })),
    loadOptionalSession: (_req, _res, next) => next(),
  },
});

const { config } = await import("../src/config.js");

const STAGES = ["primaryFree", "gatewayFree", "secondaryFree", "reserveFree"];
const MODEL_KEYS = { primaryFree: "lumen", gatewayFree: "lumenFallback1", secondaryFree: "lumenFallback2", reserveFree: "lumenFallback3" };
const host = (name) => `https://${name.toLowerCase()}.fixture.test/v1`;
const CANARY_PROMPT = "CANARY-PROMPT-7731 explain photosynthesis";
const CANARY_ORG = "org_CANARYORG9921";
const USER_ID = "rate-limit-user";

// Bodies shaped like the two real ones: wording and codes, with an organisation id the logs must not repeat.
const PRIMARY_429 = { error: { message: `Rate limit reached for model \`fixture-primaryFree\` in organization ${CANARY_ORG} service tier \`on_demand\` on tokens per minute (TPM): Limit 8000, Used 4732, Requested 5200. Please try again in 4.2s.`, type: "tokens", code: "rate_limit_exceeded" } };
const GATEWAY_429 = { error: { code: "free_global_rate_limited", message: "Free models share a limited site-wide capacity and it is currently full — this is not your personal quota. Retry after 30 seconds, or add credits to use the paid models." } };

beforeEach(() => {
  for (const stage of STAGES) {
    config.providerKeys[stage] = "fixture-key";
    config.providerBaseUrls[stage] = host(stage);
    config.chatModels[MODEL_KEYS[stage]] = `fixture-${stage}`;
  }
  config.lumenPrimaryApproved = true;
  config.lumenApprovals.primaryModel = undefined;
  config.lumenApprovals.gateway = { approved: true, model: "fixture-gatewayFree" };
  config.lumenApprovals.secondary = { approved: false, model: undefined };
  config.lumenApprovals.reserve = { approved: false, model: undefined };
  // Routes a Lumen request must never reach: the paid router and the direct account.
  config.providerKeys.paid = "fixture-paid-key";
  config.providerBaseUrls.paid = host("paid");
  config.providerKeys.direct = "fixture-direct-key";
  config.providerBaseUrls.direct = host("direct");
  // Moderation runs on the approved primary provider, as it does in production; search intent and memory stay local.
  config.moderationApiKey = "";
  config.moderationDataPolicyApproved = false;
  config.moderationApiUrl = `${host("primaryFree")}/chat/completions`;
  config.moderationModel = "fixture/moderation";
  config.memoryExtractionModel = "fixture/memory";
  config.searchIntentModel = "fixture/search";
});

function captureLogs(t) {
  const lines = [];
  const originals = { info: console.info, warn: console.warn, error: console.error, log: console.log };
  for (const level of Object.keys(originals)) console[level] = (...args) => { lines.push(args.map(String).join(" ")); };
  t.after(() => Object.assign(console, originals));
  const events = () => lines.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  return { lines, byEvent: (name) => events().filter((event) => event.event === name) };
}

async function rows(sql, params = []) { return (await client.query(sql, params)).rows; }
async function snapshot() {
  return {
    usage: (await rows("SELECT count(*)::int AS n FROM usage_events WHERE user_id = $1", [USER_ID]))[0].n,
    billable: (await rows("SELECT count(*)::int AS n FROM usage_events WHERE user_id = $1 AND (coalesce(input_tokens,0) > 0 OR coalesce(output_tokens,0) > 0)", [USER_ID]))[0].n,
    reserved: (await rows("SELECT coalesce(sum(reserved_tokens),0)::int AS n FROM usage_events WHERE user_id = $1", [USER_ID]))[0].n,
    credits: (await rows("SELECT count(*)::int AS n FROM credit_ledger WHERE user_id = $1", [USER_ID]))[0].n,
  };
}

async function startChat(t, fetchImpl) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).startsWith("http://127.0.0.1") ? realFetch(url, init) : fetchImpl(String(url), init));
  const { default: express } = await import("express");
  const { chatRouter } = await import("../src/chat/router.js");
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [USER_ID]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: USER_ID } }; next(); });
  app.use("/api/chat", chatRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => { globalThis.fetch = realFetch; return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

// Runs one Lumen request through the real route, with both approved stages answering 429, and reports everything observable.
async function limitedRequest(t, { stream }) {
  const logs = captureLogs(t);
  const contacted = [];
  const base = await startChat(t, async (url, init) => {
    contacted.push({ url, model: JSON.parse(init.body).model });
    if (url.startsWith(host("primaryFree"))) return Response.json(PRIMARY_429, { status: 429, headers: { "retry-after": "5" } });
    if (url.startsWith(host("gatewayFree"))) return Response.json(GATEWAY_429, { status: 429, headers: { "retry-after": "30" } });
    throw new Error(`Unexpected outbound request: ${new URL(url).host}`);
  });
  const before = await snapshot();
  const startedAt = Date.now();
  const response = await fetch(`${base}/api/chat${stream ? "/stream" : ""}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "lumen", message: CANARY_PROMPT }),
  });
  const text = await response.text();
  const elapsedMs = Date.now() - startedAt;
  const after = await snapshot();
  // The streaming route answers 200 and reports the failure as an "error" event; the plain route answers with the failure status.
  let failure;
  if (stream) {
    // A block may start with its event id (id: N) before the event line (src/chat/live-replies.js).
    const block = text.split("\n\n").find((part) => /^event: error$/m.test(part));
    failure = block ? JSON.parse(block.split("\n").find((line) => line.startsWith("data: ")).slice(6)) : null;
  } else {
    failure = { ...JSON.parse(text), status: response.status };
  }
  return { text, failure, contacted, logs, elapsedMs, before, after };
}

function assertBoundedAndPrivate({ text, failure, contacted, logs, elapsedMs, before, after }, names) {
  // What the person gets: a generic refusal that is the same whatever the providers said.
  assert.ok(failure, "the failure was reported to the person");
  assert.equal(failure.status, 503);
  assert.equal(failure.code, "inference-unavailable");
  assert.doesNotMatch(text, /rate.?limit|capacity|quota|tokens|TPM|gateway|bazaar|gpt-oss|fixture|organi[sz]ation|credits|paid/i, "no provider wording reaches the person");
  assert.ok(!text.includes(CANARY_ORG));

  // Bounded: one chat request per approved stage, in order, and the provider's retry-after is not waited out. The moderation classifier is a
  // separate call that runs first, and only on the approved primary provider (it draws on that provider's shared budget, which matters when
  // that budget is the thing running out). It is not a chat attempt, and nothing is ever sent to an unapproved or paid route.
  const moderation = contacted.filter((call) => call.model === "fixture/moderation");
  const chat = contacted.filter((call) => call.model !== "fixture/moderation");
  assert.deepEqual(chat, [
    { url: `${host("primaryFree")}/chat/completions`, model: "fixture-primaryFree" },
    { url: `${host("gatewayFree")}/chat/completions`, model: "fixture-gatewayFree" },
  ]);
  assert.ok(moderation.length <= 1 && moderation.every((call) => call.url.startsWith(host("primaryFree"))), "moderation goes only to the approved primary provider");
  assert.ok(elapsedMs < 5_000, `answered in ${elapsedMs} ms, not after a provider wait of 5 to 30 s`);

  // What the log says: both failures, the one hand-off, then exhaustion after exactly two attempts.
  assert.deepEqual(logs.byEvent(names.failed).map((e) => [e.stage, e.status]), [["primaryFree", 429], ["gatewayFree", 429]]);
  assert.deepEqual(logs.byEvent("inference_internal_fallback").map((e) => [e.fromStage, e.toStage, e.status]), [["primaryFree", "gatewayFree", 429]]);
  const exhausted = logs.byEvent(names.exhausted);
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0].attempts, 2);

  // Privacy of the log: neither what the person typed, nor a key, nor the provider's organisation id.
  const everything = logs.lines.join("\n");
  assert.ok(!everything.includes("CANARY-PROMPT-7731"), "the prompt is not logged");
  assert.ok(!everything.includes("fixture-key") && !everything.includes("fixture-paid-key") && !everything.includes("fixture-direct-key"), "no key is logged");
  assert.ok(!everything.includes(CANARY_ORG), "the provider's organisation id is not logged");

  // Accounting: a request that produced no answer is not charged, holds nothing, and spends no credit.
  assert.equal(after.billable, before.billable, "no billable usage was recorded");
  assert.equal(after.reserved, 0, "no reservation is left outstanding");
  assert.equal(after.credits, before.credits, "no credit ledger entry was written");
}

test("streaming route, both approved stages 429: two chat requests, no wait, nothing unapproved or paid, nothing charged", async (t) => {
  assertBoundedAndPrivate(await limitedRequest(t, { stream: true }), { failed: "inference_stream_failed", exhausted: "inference_exhausted" });
});

test("plain route, both approved stages 429: the same bounds, privacy and accounting", async (t) => {
  assertBoundedAndPrivate(await limitedRequest(t, { stream: false }), { failed: "inference_stage_failed", exhausted: "inference_all_stages_failed" });
});

test("a person whose request failed this way can use the same allowance afterwards", async (t) => {
  let phase = "limited";
  const contacted = [];
  const base = await startChat(t, async (url) => {
    contacted.push(url);
    if (phase === "limited") {
      return url.startsWith(host("primaryFree"))
        ? Response.json(PRIMARY_429, { status: 429 })
        : Response.json(GATEWAY_429, { status: 429 });
    }
    return Response.json({ choices: [{ message: { content: "Plants turn light into sugar." }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 6 } });
  });
  const ask = () => fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "lumen", message: "Explain photosynthesis." }) });

  const first = await ask();
  assert.equal(first.status, 503);
  const afterFailure = await snapshot();
  assert.equal(afterFailure.billable, 0, "the failed attempt cost nothing, so there is nothing to reconcile");

  phase = "recovered";
  const second = await ask();
  assert.equal(second.status, 200, "the next request is admitted and answered once capacity returns");
  assert.equal(contacted.filter((url) => url.startsWith(host("secondaryFree")) || url.startsWith(host("reserveFree")) || url.startsWith(host("paid")) || url.startsWith(host("direct"))).length, 0);
});
