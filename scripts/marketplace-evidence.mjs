// Records the live evidence behind the model marketplace (Slice 7): for every candidate, the router's published capability data, the
// route-policy guard's verdict on the host it would be pinned to (the Lumen paid-zdr standard: training false, no publishing, zero
// retention), and the live price that host charges. Public GETs only; nothing about any user is sent, and no key is needed.
//
//   node scripts/marketplace-evidence.mjs [outFile]    (default docs/models/marketplace-evidence.json)
import fs from "node:fs";
import path from "node:path";
import { evaluateRoutePolicy, hostMatches } from "../src/chat/route-policy-guard.js";
import { CAPABILITY_WAIVERS, DIRECT_MARKETPLACE_CANDIDATES, ROUTER_MARKETPLACE_CANDIDATES, ZENITH_CANDIDATES, VESPER_MIGRATION_CANDIDATES, capabilityCheck } from "../src/models/marketplace.js";

// Models the owner asked for that are not in the lineup because they fail the guard live; recorded so the reason stays checkable.
const OMITTED = [];
// Retired from the lineup (replaced by GLM 5.3); recorded for the record of what changed.
const RETIRED = [
  { id: "glm-5v-turbo", provider: "GLM", model: "z-ai/glm-5v-turbo", hosts: ["Z.AI"], note: "replaced by GLM 5.3 (owner decision)" },
  { id: "glm-5.3-flashx", provider: "GLM", model: "z-ai/glm-5.3-flashx", hosts: ["Z.AI"], note: "replaced by GLM 5.3 Flash (owner decision)" },
];

const out = path.resolve(process.argv[2] ?? "docs/models/marketplace-evidence.json");
const api = "https://openrouter.ai/api/v1";
const site = "https://openrouter.ai";
const getJson = async (url) => { const r = await fetch(url, { headers: { Accept: "application/json" } }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); };
const getText = async (url) => { const r = await fetch(url, { headers: { Accept: "text/html" } }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.text(); };

const catalog = (await getJson(`${api}/models`)).data;
async function evidenceFor({ id = null, model, hosts }) {
  const listing = catalog.find((m) => m.id === model) ?? null;
  const [endpointsJson, providersHtml] = await Promise.all([getJson(`${api}/models/${model}/endpoints`), getText(`${site}/${model}/providers`)]);
  const guard = evaluateRoutePolicy({ endpointsJson, providersHtml, model, mode: "pinned", hosts, requireZeroRetention: true });
  const endpoint = (endpointsJson?.data?.endpoints ?? []).find((e) => hosts.some((h) => hostMatches(h, e))) ?? null;
  const capability = capabilityCheck({ inputModalities: listing?.architecture?.input_modalities ?? [], hostParameters: endpoint?.supported_parameters ?? [], contextLength: endpoint?.context_length ?? 0, waive: CAPABILITY_WAIVERS[id] ?? [] });
  return {
    model, hosts,
    listedName: listing?.name ?? null,
    inputModalities: listing?.architecture?.input_modalities ?? [],
    host: endpoint ? { name: endpoint.provider_name, tag: endpoint.tag, contextLength: endpoint.context_length, maxCompletionTokens: endpoint.max_completion_tokens, tools: (endpoint.supported_parameters ?? []).includes("tools"), toolChoice: (endpoint.supported_parameters ?? []).includes("tool_choice"), pricing: { inputUsdPerToken: endpoint.pricing?.prompt ?? null, outputUsdPerToken: endpoint.pricing?.completion ?? null, cacheReadUsdPerToken: endpoint.pricing?.input_cache_read ?? null } } : null,
    capability,
    guard: { ok: guard.ok, reason: guard.reason, allowedHosts: guard.allowedHosts, dataPolicy: guard.evidence?.dataPolicy ?? null, hostsExamined: guard.hosts },
  };
}

const record = { checkedAt: new Date().toISOString(), standard: "pinned host; training false; no publishing; zero retention (Lumen paid-zdr)", zenith: [], vesperMigration: [], marketplace: [] };
for (const candidate of ZENITH_CANDIDATES) record.zenith.push(await evidenceFor(candidate));
// Vesper's own standard is data_collection: deny (no retention); a candidate that fails zero retention also fails that.
for (const candidate of VESPER_MIGRATION_CANDIDATES) record.vesperMigration.push(await evidenceFor(candidate));
for (const candidate of ROUTER_MARKETPLACE_CANDIDATES) record.marketplace.push({ id: candidate.id, provider: candidate.provider, transport: "router", ...(await evidenceFor(candidate)) });
// GPT-6 on the maker's own API (the documented manual-verification pattern Vesper and Study use). Recorded: the maker's own endpoint
// (price and capabilities, what the live reference read uses), and the guard's verdict on the router path, which is why it is not used.
record.marketplaceDirect = [];
for (const candidate of DIRECT_MARKETPLACE_CANDIDATES) {
  const { guard, ...routerPath } = await evidenceFor({ model: candidate.reference.model, hosts: [candidate.reference.host] });
  record.marketplaceDirect.push({ id: candidate.id, provider: candidate.provider, transport: "direct", directModel: candidate.model, privacy: "documented terms (docs/security/route-data-policy.json)", ...routerPath, routerPathGuard: guard });
}
record.omitted = [];
for (const candidate of OMITTED) record.omitted.push({ id: candidate.id, provider: candidate.provider, note: candidate.note, ...(await evidenceFor(candidate)) });
record.retired = [];
for (const candidate of RETIRED) record.retired.push({ id: candidate.id, provider: candidate.provider, note: candidate.note, ...(await evidenceFor(candidate)) });
fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
for (const row of record.marketplaceDirect) {
  console.log(`${row.model.padEnd(24)} direct; router path guard=${row.routerPathGuard.ok ? "pass" : `FAIL(${row.routerPathGuard.reason})`} capability=${row.capability.ok ? "pass" : `FAIL(${row.capability.missing.join(",")})`} in=${row.host?.pricing.inputUsdPerToken} out=${row.host?.pricing.outputUsdPerToken} ctx=${row.host?.contextLength}`);
}
for (const row of [...record.zenith, ...record.vesperMigration, ...record.marketplace, ...record.omitted]) {
  console.log(`${row.model.padEnd(24)} guard=${row.guard.ok ? "pass" : `FAIL(${row.guard.reason})`} capability=${row.capability.ok ? "pass" : `FAIL(${row.capability.missing.join(",")})`} in=${row.host?.pricing.inputUsdPerToken} out=${row.host?.pricing.outputUsdPerToken} ctx=${row.host?.contextLength}`);
}
console.log(`wrote ${path.relative(process.cwd(), out)}`);
