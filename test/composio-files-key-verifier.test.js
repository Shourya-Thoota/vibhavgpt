import test from "node:test";
import assert from "node:assert/strict";
import { verifyFilesKey } from "../scripts/verify-composio-files-key.js";

const KEY = "proj_CANARY_7c1d9e04b2a85f36";
const ACCOUNT = "ca_CANARY_account_id";
const reply = (status, body) => async () => ({ status, ok: status < 300, json: async () => body });
const route = (table) => async (url, init) => {
  const path = url.replace(/^https?:\/\/[^/]+\/api\/v3\.1/, "");
  const key = Object.keys(table).find((k) => path.startsWith(k));
  const [status, body] = table[key] ?? [599, null];
  return { status, ok: status < 300, json: async () => body, method: init.method };
};
const clean = (out) => { assert.ok(!out.includes(KEY) && !out.includes(ACCOUNT) && !out.includes("ca_secret") && !out.includes("a@b.c"), "no key, id or address is printed"); };

test("an accepted key with no account named is ACCEPTED but the project stays UNVERIFIED, never READY", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push([url, init.method, init.headers["x-api-key"]]); return { status: 200, ok: true, json: async () => ({ items: [{ id: "ca_secret_one", email: "a@b.c" }, { id: "ca_secret_two" }] }) }; };
  const out = (await verifyFilesKey({ apiKey: KEY, fetchImpl })).join("\n");
  assert.match(out, /credential \(file route\): ACCEPTED/);
  assert.match(out, /project: UNVERIFIED[^\n]*2 Google Drive connection/);
  assert.match(out, /verdict: NOT CONFIRMED/);
  assert.doesNotMatch(out, /READY \(/);
  clean(out);
  assert.ok(seen.every(([, method, key]) => method === "GET" && key === KEY), "only GETs, with the key in the header");
});

test("a named connected account found in the key's project is a MATCH and the verdict is READY", async () => {
  const out = (await verifyFilesKey({ apiKey: KEY, accountId: ACCOUNT, fetchImpl: route({ "/files/list": [200, { items: [] }], "/connected_accounts/": [200, { id: ACCOUNT, user_id: "u" }] }) })).join("\n");
  assert.match(out, /project \(named connected account\): MATCH/);
  assert.match(out, /verdict: READY/);
  clean(out);
});

test("a named connected account that the key's project does not hold is NO MATCH and not ready", async () => {
  const out = (await verifyFilesKey({ apiKey: KEY, accountId: ACCOUNT, fetchImpl: route({ "/files/list": [200, { items: [] }], "/connected_accounts/": [404, { error: { message: `no ${ACCOUNT}` } }] }) })).join("\n");
  assert.match(out, /NO MATCH/);
  assert.match(out, /verdict: NOT CONFIRMED/);
  assert.doesNotMatch(out, /verdict: READY/);
  clean(out);
});

test("an unrecognised connection-list shape is UNVERIFIED, not zero connections and not ready", async () => {
  const out = (await verifyFilesKey({ apiKey: KEY, fetchImpl: route({ "/files/list": [200, {}], "/connected_accounts": [200, { something: "else" }] }) })).join("\n");
  assert.match(out, /project: UNVERIFIED \(connection list had an unrecognised shape\)/);
  assert.doesNotMatch(out, /\b0 Google Drive/);
  assert.doesNotMatch(out, /verdict: READY/);
});

test("a rejected key says so, with the status word and no body", async () => {
  const out = (await verifyFilesKey({ apiKey: KEY, fetchImpl: reply(401, { error: { message: `Invalid API key ${KEY}` } }) })).join("\n");
  assert.match(out, /REJECTED \(401/);
  assert.match(out, /verdict: NOT READY/);
  assert.ok(!out.includes("Invalid API key"));
  clean(out);
});

test("a network failure and a missing key are reported without throwing", async () => {
  const down = (await verifyFilesKey({ apiKey: KEY, fetchImpl: async () => { throw new Error(`boom ${KEY}`); } })).join("\n");
  assert.match(down, /UNREACHABLE/);
  assert.match(down, /verdict: NOT READY/);
  clean(down);
  assert.deepEqual(await verifyFilesKey({ apiKey: "" }), ["files key: not set (the gateway key would be used)"]);
});
