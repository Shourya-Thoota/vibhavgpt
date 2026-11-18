// Part E: proof that a marketplace turn costs exactly the provider's cost x 1.10 in credits, for every shipped model, on each rate (input,
// output, cache read, and GPT-6's long-context rates), and that taking the billing line out of the model picker changed nothing in
// billing. The expected numbers are computed independently here, in exact integer arithmetic (BigInt pico-dollars), never by calling
// the code under test; then the settled row goes through the same debit the credits engine applies.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";

import { CREDIT_MICROS } from "../frontend/src/credits-policy.js";
import { THIRD_PARTY_BILLING_NOTE, THIRD_PARTY_MODELS } from "../frontend/src/model-marketplace.js";
import { creditsPricingFootnote } from "../frontend/src/credits-copy.js";
import { productKnowledgeFor } from "../frontend/src/product-knowledge.js";
import { MARKETPLACE_CANDIDATES, marketplaceRoute, resetMarketplacePricesForTests, resetMarketplaceReferencesForTests, setMarketplaceReferenceForTests, thirdPartyCharge } from "../src/models/marketplace.js";
import { calculateUnifiedLedgerDeductionMicros } from "../src/models/pricing-engine.js";
import { resetRoutePolicyStateForTests } from "../src/chat/route-policy-guard.js";
import { finalizeUsage } from "../src/usage/service.js";
import { creditSpendByWindow } from "../src/usage/credits.js";
import { marketplaceCharges, usageEvents } from "../src/db/schema.js";
import { config } from "../src/config.js";

// The live per-token prices read on 2026-11-13 (production boot evidence for GLM; the maker's own endpoint for GPT-6), as strings.
const LIVE = {
  "glm-5.3": { prompt: "0.0000014", completion: "0.0000044", input_cache_read: "0.00000026" },
  "glm-5.3-flash": { prompt: "0.00000015", completion: "0.0000005", input_cache_read: "0.00000003" },
  "gpt-6-luna": { prompt: "0.00000005", completion: "0.00000025", input_cache_read: "0.000000005", overrides: [{ min_prompt_tokens: 272000, prompt: "0.0000001", completion: "0.000000375", input_cache_read: "0.00000001" }] },
  "gpt-6.1-terra": { prompt: "0.0000005", completion: "0.0000025", input_cache_read: "0.000000025", overrides: [{ min_prompt_tokens: 272000, prompt: "0.000001", completion: "0.00000375", input_cache_read: "0.00000005" }] },
  // GPT-6.2 Sol at OpenAI's standard tier (the row billed: the reference reads tag "openai", not the Flex row).
  // GPT-6.2 Sol and Astra at OpenAI's standard row, as the router published them on 2026-11-17 (and OpenAI's model pages state), with
  // their prompt-cache write rates (1.25x input; doubled above 272K prompt tokens).
  "gpt-6.2-sol": { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000001", input_cache_write: "0.0000025", overrides: [{ min_prompt_tokens: 272000, prompt: "0.000004", completion: "0.000015", input_cache_read: "0.0000002", input_cache_write: "0.000005" }] },
  "gpt-6.2-astra": { prompt: "0.000008", completion: "0.00004", input_cache_read: "0.0000004", input_cache_write: "0.00001", overrides: [{ min_prompt_tokens: 272000, prompt: "0.000016", completion: "0.00006", input_cache_read: "0.0000008", input_cache_write: "0.00002" }] },
  // Gemini 4 at Google AI Studio's standard tier (tag "google-ai-studio", read 2026-11-16; Carbon and Argon at their introductory rate).
  "gemini-4-hydrogen": { prompt: "0.0000015", completion: "0.0000075", input_cache_read: "0.000000075" },
  "gemini-4-argon": { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000001" },
  "gemini-4-carbon": { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000001" },
};
assert.deepEqual(Object.keys(LIVE), THIRD_PARTY_MODELS.map((m) => m.id), "every shipped model is proven");

// "0.0000012" USD -> 1_200_000 pico-dollars, exactly.
const pico = (usd) => { const [whole, frac = ""] = usd.split("."); return BigInt(whole) * 10n ** 12n + BigInt((frac + "0".repeat(12)).slice(0, 12)); };
function expected(pricing, { inputTokens = 0, outputTokens = 0, cachedInputTokens = 0, cacheWriteInputTokens = 0 }) {
  const tier = [...(pricing.overrides ?? [])].sort((a, b) => b.min_prompt_tokens - a.min_prompt_tokens).find((o) => inputTokens >= o.min_prompt_tokens);
  const rates = tier ?? pricing;
  const cached = BigInt(Math.min(inputTokens, cachedInputTokens));
  // Prompt-cache writes at the host's write rate (input rate where none is published); never more than the input left after reads.
  const written = BigInt(Math.min(inputTokens - Math.min(inputTokens, cachedInputTokens), cacheWriteInputTokens));
  const uncached = BigInt(inputTokens) - cached - written;
  const totalPico = uncached * pico(rates.prompt) + cached * pico(rates.input_cache_read) + written * pico(rates.input_cache_write ?? rates.prompt) + BigInt(outputTokens) * pico(rates.completion);
  const raw = (totalPico + 500_000n) / 1_000_000n; // micro-dollars, rounded half up
  const charged = (raw * 11n + 9n) / 10n; // x 1.10, rounded up to a whole micro-dollar
  return { raw: Number(raw), charged: Number(charged), upcharge: Number(charged - raw), credits: Number(charged) / CREDIT_MICROS };
}

const CASES = {
  "input only": { inputTokens: 12_345, outputTokens: 0 },
  "output only": { inputTokens: 0, outputTokens: 6_789 },
  "cache read only": { inputTokens: 40_000, cachedInputTokens: 40_000, outputTokens: 0 },
  mixed: { inputTokens: 98_765, cachedInputTokens: 31_337, outputTokens: 4_321 },
  // Prompt-cache writes (Responses usage input_tokens_details.cache_write_tokens), billed at the write rate (2026-11-17).
  "cache writes": { inputTokens: 50_000, cachedInputTokens: 10_000, cacheWriteInputTokens: 30_000, outputTokens: 1_000 },
};
const LONG_CONTEXT = { inputTokens: 300_001, cachedInputTokens: 100_000, cacheWriteInputTokens: 50_000, outputTokens: 2_222 };

async function database(t) {
  const client = new PGlite();
  t.after(() => client.close());
  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  return drizzle(client);
}
function listEverything() {
  for (const candidate of MARKETPLACE_CANDIDATES) {
    const evidence = { endpoint: { provider_name: candidate.transport === "direct" ? "OpenAI" : candidate.hosts[0], pricing: LIVE[candidate.id], context_length: 1_048_576, supported_parameters: ["tools"] }, inputModalities: ["image", "text"] };
    if (candidate.transport === "direct") setMarketplaceReferenceForTests(candidate.id, { ok: true, reason: "read", checkedAt: Date.now(), evidence });
    else resetRoutePolicyStateForTests(marketplaceRoute(candidate.id), { status: "verified", reason: "verified", model: candidate.model, hosts: candidate.hosts.join("|"), checkedAt: Date.now(), evidence: { ...evidence, dataPolicy: { training: false, retainsPrompts: false } }, allowedHosts: [...candidate.hosts], positiveEvidence: false });
  }
}
const usageFor = ({ inputTokens = 0, outputTokens = 0, cachedInputTokens = 0, cacheWriteInputTokens = 0 }) => ({ prompt_tokens: inputTokens, completion_tokens: outputTokens, prompt_tokens_details: { cached_tokens: cachedInputTokens, cache_write_tokens: cacheWriteInputTokens } });

test("every shipped model, every rate: a settled turn's charge is exactly the provider's cost x 1.10, and its credits are that over one credit", async (t) => {
  const before = config.vesperDataPolicyVerified;
  config.vesperDataPolicyVerified = true;
  // Gemini 4's own attestation and key (placeholder: no request is sent here).
  const geminiBefore = [config.geminiDataPolicyVerified, config.providerKeys.google];
  config.geminiDataPolicyVerified = true;
  config.providerKeys.google = "placeholder-gemini-key";
  t.after(() => { config.vesperDataPolicyVerified = before; [config.geminiDataPolicyVerified, config.providerKeys.google] = geminiBefore; resetRoutePolicyStateForTests(); resetMarketplacePricesForTests(); resetMarketplaceReferencesForTests(); });
  listEverything();
  const db = await database(t);
  const proven = [];
  for (const model of THIRD_PARTY_MODELS) {
    const cases = { ...CASES, ...(LIVE[model.id].overrides ? { "long context (from 272K prompt tokens)": LONG_CONTEXT } : {}) };
    for (const [name, tokens] of Object.entries(cases)) {
      const want = expected(LIVE[model.id], tokens);
      assert.ok(want.raw > 0, `${model.id} ${name}: a real cost`);
      const [event] = await db.insert(usageEvents).values({ userId: "proof", model: model.id, reservedTokens: 1000 }).returning({ id: usageEvents.id });
      const settled = await finalizeUsage(event.id, usageFor(tokens), db, model.id, { userId: "proof" });
      const label = `${model.id}, ${name}`;
      assert.deepEqual(settled, { rawCostMicros: want.raw, upchargeMicros: want.upcharge, chargedMicros: want.charged, credits: want.credits, costSource: "live-price" }, label);
      // The usage row holds the provider's cost; what the credits engine debits for it is the same x 1.10, applied once.
      const [row] = await db.select().from(usageEvents).where(eq(usageEvents.id, event.id));
      assert.equal(row.costMicros, want.raw, label);
      // One window covering the turn, in the credits schedule's own shape (credits-policy.js windowIndexAt).
      const schedule = { startMs: 0, endMs: 8.64e15, windows: [{ startMs: 0, endMs: 8.64e15 }] };
      const [spent] = creditSpendByWindow([{ ...row, createdAt: new Date() }], schedule, { debitMicros: calculateUnifiedLedgerDeductionMicros, holdMicros: () => 0 });
      assert.equal(spent, want.charged, `${label}: the debit`);
      const [charge] = await db.select().from(marketplaceCharges).where(eq(marketplaceCharges.usageEventId, event.id));
      assert.deepEqual([charge.rawCostMicros, charge.upchargeMicros, charge.chargedMicros, Number(charge.credits)], [want.raw, want.upcharge, want.charged, want.credits], `${label}: the ledger line`);
      proven.push(label);
    }
  }
  assert.equal(proven.length, 2 * 5 + 4 * 6 + 3 * 5, "49 settlements proven: GLM 5 cases each, GPT-6 6 (with long context), Gemini 4 5 each");
});

test("a cost the router reports is used as is, then x 1.10 the same way", () => {
  for (const [usd, raw, charged] of [[0.0123, 12_300, 13_530], [0.000001, 1, 2], [0.0000333, 33, 37], [1.5, 1_500_000, 1_650_000]]) {
    const turn = thirdPartyCharge(Math.round(usd * 1e6));
    assert.deepEqual([turn.rawCostMicros, turn.chargedMicros, turn.credits], [raw, charged, charged / CREDIT_MICROS], `${usd}`);
  }
});

test("the credits engine's one debit is the ledger's x 1.10, and nothing else marks a marketplace turn up", async () => {
  const service = (await readFile(new URL("../src/usage/service.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  // Every debit goes through ledgerDebitMicros, which applies the 1.10 markup to every model except Tecton, a house model charged at its
  // own configured rate (owner decision, 2026-11-15). No marketplace model is exempt.
  assert.match(service, /debitMicros: \(rawCostMicros, event\) => ledgerDebitMicros\(event\?\.model, rawCostMicros\),/);
  assert.match(service, /totalCommittedMicros \+= ledgerDebitMicros\(ev\.model, ev\.costMicros\);/);
  assert.match(service, /const UNMARKED_HOUSE_MODELS = new Set\(\["tecton"\]\);/);
  const { ledgerDebitMicros } = await import("../src/usage/service.js");
  const { THIRD_PARTY_MODELS } = await import("../frontend/src/model-marketplace.js");
  for (const model of THIRD_PARTY_MODELS) assert.equal(ledgerDebitMicros(model.id, 1_000), 1_100, `${model.id}: cost plus 10%`);
  // The usage row carries the raw cost, never the marked-up one, so the markup cannot be applied twice.
  assert.match(service, /costMicros: charge\.rawCostMicros,/);
  for (let raw = 0; raw <= 2_000; raw += 1) assert.equal(calculateUnifiedLedgerDeductionMicros(raw), Math.ceil((raw * 11) / 10), `${raw}`);
});

test("taking the billing line out of the picker changed nothing in billing; the disclosure stays on Pricing and in the Terms", async () => {
  // Billing never read the picker's line: the settlement, the ledger and the credits engine do not import it.
  for (const file of ["src/models/marketplace.js", "src/usage/service.js", "src/usage/credits.js", "src/models/pricing-engine.js"]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /THIRD_PARTY_BILLING_NOTE|billingNote/, file);
  }
  // The worked example from the marketplace's launch, unchanged to the micro-dollar.
  assert.deepEqual(thirdPartyCharge(5600), { rawCostMicros: 5600, upchargeMicros: 560, chargedMicros: 6160, credits: 0.1232 });
  // The disclosure, word for word, where people read about prices and terms; not under the picker.
  assert.equal(THIRD_PARTY_BILLING_NOTE, "Third-party models are billed per turn at the provider's cost plus 10%, in credits.");
  const app = await readFile(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /className="compare__footnote">[^\n]*THIRD_PARTY_BILLING_NOTE/, "Pricing");
  for (const mode of ["rollover", "reset"]) assert.ok(creditsPricingFootnote(mode).includes(THIRD_PARTY_BILLING_NOTE), `Pricing (credits, ${mode})`);
  assert.ok(productKnowledgeFor(null).terms.some(([title, body]) => title === "Third-party models" && body.includes(THIRD_PARTY_BILLING_NOTE)), "Terms");
  assert.doesNotMatch(app, /model-list__note|model-sheet__note/, "no billing line under the picker");
});
