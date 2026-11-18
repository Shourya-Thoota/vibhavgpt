// The route-policy guard attributes a data policy to a host only from that host's own record on the providers page. Before, any record
// that merely mentioned the host counted: the page's last record (AtlasCloud's, for z-ai/glm-5.3-flash) runs to the end of the page and
// takes in a page-wide provider list naming Z.AI, so AtlasCloud's "retains prompts" policy was read as Z.AI's and the route failed. This is
// a tightening of attribution, not of the rule: every own copy must still say no training and no retention, a host with no own record is
// still unverified, and a host whose own record retains is still refused. A synthetic page in the real page's shape.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRoutePolicy, policiesFromProvidersPage } from "../src/chat/route-policy-guard.js";

const MODEL = "z-ai/glm-5.3-flash";
const policy = (retainsPrompts, terms) => ({ training: false, trainingOpenRouter: false, retainsPrompts, canPublish: false, safetyRetention: false, termsOfServiceURL: terms });
const record = (provider, dataPolicy, tail = "") => `"model_variant_slug":${JSON.stringify(MODEL)},"provider_name":${JSON.stringify(provider)},"provider_info":{"name":${JSON.stringify(provider)},"dataPolicy":${JSON.stringify(dataPolicy)}},"data_policy":${JSON.stringify(dataPolicy)}${tail}`;
// The page escapes its embedded JSON, as the real one does.
const page = (...records) => `<script>self.__next_f.push([1,"${records.join(",").replace(/"/g, "\\\"")}"])</script>`;
// The last record's tail: a page-wide list of every provider, Z.AI included, after AtlasCloud's own data.
const directory = `,"providers":[{"provider_name":"Darkbloom"},{"provider_name":"Z.AI"},{"provider_name":"Fireworks"}]`;
const endpoints = (...names) => ({ data: { endpoints: names.map((name) => ({ provider_name: name, tag: name.toLowerCase(), model_id: MODEL, pricing: { prompt: "0.00000015", completion: "0.0000005" }, context_length: 1_048_576, supported_parameters: ["tools"] })), architecture: { input_modalities: ["text", "image"] } } });

const LIVE_SHAPE = page(
  record("Z.AI", policy(false, "https://chat.z.ai/terms")),
  record("Z.AI", policy(false, "https://chat.z.ai/terms")),
  record("AtlasCloud", policy(true, null), directory),
);

test("a host's policy comes only from its own records: the last record's provider list no longer lends another host's policy", () => {
  const zai = policiesFromProvidersPage(LIVE_SHAPE, { model: MODEL, provider: "Z.AI" });
  assert.ok(zai.length >= 2, "Z.AI's own copies are read");
  assert.ok(zai.every((p) => p.retainsPrompts === false), "and only Z.AI's own: none of AtlasCloud's retaining copies");
  assert.ok(policiesFromProvidersPage(LIVE_SHAPE, { model: MODEL, provider: "AtlasCloud" }).every((p) => p.retainsPrompts === true));
});

test("the route pinned to Z.AI verifies on Z.AI's own zero-retention policy", () => {
  const verdict = evaluateRoutePolicy({ endpointsJson: endpoints("Z.AI", "AtlasCloud"), providersHtml: LIVE_SHAPE, model: MODEL, mode: "pinned", hosts: ["Z.AI"], requireZeroRetention: true });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, "verified");
});

test("the rule is unchanged: a host whose own record retains prompts is still refused, and one with no record is still unverified", () => {
  const atlas = evaluateRoutePolicy({ endpointsJson: endpoints("AtlasCloud"), providersHtml: LIVE_SHAPE, model: MODEL, mode: "pinned", hosts: ["AtlasCloud"], requireZeroRetention: true });
  assert.deepEqual([atlas.ok, atlas.reason], [false, "retention-not-zero"]);

  const zaiRetains = page(record("Z.AI", policy(false, "t")), record("Z.AI", policy(true, "t")));
  const refused = evaluateRoutePolicy({ endpointsJson: endpoints("Z.AI"), providersHtml: zaiRetains, model: MODEL, mode: "pinned", hosts: ["Z.AI"], requireZeroRetention: true });
  assert.deepEqual([refused.ok, refused.reason], [false, "retention-not-zero"], "every own copy must still pass");

  const trains = page(record("Z.AI", { ...policy(false, "t"), training: true }));
  assert.equal(evaluateRoutePolicy({ endpointsJson: endpoints("Z.AI"), providersHtml: trains, model: MODEL, mode: "pinned", hosts: ["Z.AI"], requireZeroRetention: true }).reason, "training-not-false");

  const onlyMentioned = page(record("AtlasCloud", policy(false, null), directory));
  const none = evaluateRoutePolicy({ endpointsJson: endpoints("Z.AI"), providersHtml: onlyMentioned, model: MODEL, mode: "pinned", hosts: ["Z.AI"], requireZeroRetention: true });
  assert.deepEqual([none.ok, none.reason === "policy-not-found" || /not-found|no-compliant/.test(none.reason)], [false, true], "mentioned but no own record: not verified");
});

test("inside a host's own record, a policy that follows another provider's name is not read as the host's", () => {
  const ownThenNeighbour = page(record("Z.AI", policy(false, "t"), `,"provider_name":"Darkbloom","data_policy":${JSON.stringify(policy(true, null))}`));
  const read = policiesFromProvidersPage(ownThenNeighbour, { model: MODEL, provider: "Z.AI" });
  assert.ok(read.length >= 1 && read.every((p) => p.retainsPrompts === false));
});
