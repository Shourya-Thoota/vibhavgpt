// Slice 7, the model marketplace: Zenith (Max only), third-party models listed only after the live privacy guard, the capability check
// and a known live price, and billed per turn at the provider's cost plus 10% in credits, itemized in the ledger.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";

import { CREDIT_MICROS } from "../frontend/src/credits-policy.js";
import {
  HOUSE_MODELS, HOUSE_INTELLIGENCE, INTELLIGENCE_LEVELS, THIRD_PARTY_MODELS, THIRD_PARTY_PROVIDERS, planIncludesHouseModel, planIncludesThirdPartyModel,
} from "../frontend/src/model-marketplace.js";
import {
  DIRECT_MARKETPLACE_CANDIDATES, LONG_DOCUMENT_MIN_TOKENS, MARKETPLACE_CANDIDATES, ROUTER_MARKETPLACE_CANDIDATES, buildPickerLineup, capabilityCheck, listedMarketplaceModels, marketplaceListing,
  marketplaceRoute, rawCostForTurn, rawCostMicrosFromPrice, resetMarketplacePricesForTests, settlementPrice, thirdPartyCharge,
} from "../src/models/marketplace.js";
import { calculateUnifiedLedgerDeductionMicros } from "../src/models/pricing-engine.js";
import { GUARD_MAX_AGE_MS, resetRoutePolicyStateForTests } from "../src/chat/route-policy-guard.js";
import { resolveExecutableModelKey } from "../src/chat/model-keys.js";
import { assertModelPlanAccess, estimateTurnReservationHoldMicros, finalizeUsage, MODEL_TOKEN_PRICES } from "../src/usage/service.js";
import { getModelConfig } from "../src/chat/providers.js";
import { routeInventory } from "../src/chat/route-inventory.js";
import { config } from "../src/config.js";
import { buildIdentitySystemPrompt } from "../src/chat/prompts.js";
import { marketplaceCharges, usageEvents } from "../src/db/schema.js";

const PLANS = ["free", "plus", "pro", "max"];

// A verified guard result for one third-party route, shaped as the guard records it (route-policy-guard.js).
function verify(id, { pricing = { prompt: "0.0000012", completion: "0.000004", input_cache_read: "0.00000024" }, inputModalities = ["image", "text"], supported = ["tools", "tool_choice", "reasoning"], context = 202_752, checkedAt = Date.now(), status = "verified" } = {}) {
  const candidate = MARKETPLACE_CANDIDATES.find((c) => c.id === id);
  resetRoutePolicyStateForTests(marketplaceRoute(id), {
    status, reason: status === "verified" ? "verified" : "retains-prompts", model: candidate.model, hosts: candidate.hosts.join("|"), checkedAt,
    evidence: { endpoint: { provider_name: candidate.hosts[0], pricing, context_length: context, supported_parameters: supported }, inputModalities, dataPolicy: { training: false, retainsPrompts: false } },
    allowedHosts: status === "verified" ? [...candidate.hosts] : [], positiveEvidence: status !== "verified",
  });
}
const clearGuards = () => { resetRoutePolicyStateForTests(); resetMarketplacePricesForTests(); };

// ---- The cost plus 10% math --------------------------------------------------------------------------------------------------------

test("third-party charge: the provider's cost plus 10%, in integer micro-dollars rounded up, then credits at the one credit unit", () => {
  // A worked turn: 2,000 input and 800 output tokens at $1.20 / $4.00 per million.
  const price = { inputUsdPerToken: 0.0000012, outputUsdPerToken: 0.000004, cacheReadUsdPerToken: 0.00000024 };
  const raw = rawCostMicrosFromPrice(price, { inputTokens: 2000, outputTokens: 800 });
  assert.equal(raw, 5600, "2,000 x $1.20/M + 800 x $4.00/M = $0.0056");
  assert.deepEqual(thirdPartyCharge(raw), { rawCostMicros: 5600, upchargeMicros: 560, chargedMicros: 6160, credits: 0.1232 });
  assert.equal(CREDIT_MICROS, 50_000, "one credit is $0.05");
  // The rounding rule is the ledger's own: never a fraction of a micro-dollar, always up. 1 micro-dollar costs 2; 333 costs 367.
  assert.deepEqual(thirdPartyCharge(1), { rawCostMicros: 1, upchargeMicros: 1, chargedMicros: 2, credits: 2 / CREDIT_MICROS });
  assert.equal(thirdPartyCharge(333).chargedMicros, 367);
  assert.equal(thirdPartyCharge(0).chargedMicros, 0);
  // It is exactly the ledger's debit for that cost, so the 10% is applied once, never twice.
  for (const cost of [0, 1, 9, 10, 99, 100, 333, 5600, 123_457, 1_000_000]) {
    const charge = thirdPartyCharge(cost);
    assert.equal(charge.chargedMicros, calculateUnifiedLedgerDeductionMicros(cost), `${cost}`);
    assert.equal(charge.upchargeMicros, charge.chargedMicros - cost);
    assert.ok(charge.upchargeMicros >= cost * 0.1 && charge.upchargeMicros < cost * 0.1 + 1, `${cost}: the upcharge is 10%, rounded up by under one micro-dollar`);
    assert.equal(charge.credits, charge.chargedMicros / CREDIT_MICROS);
  }
});

test("a turn's cost is what the provider reported when it reports one, otherwise the live price times the counted tokens", () => {
  const price = { inputUsdPerToken: 0.00000015, outputUsdPerToken: 0.0000005, cacheReadUsdPerToken: 0.00000003 };
  assert.deepEqual(rawCostForTurn({ reportedCostUsd: 0.0123, price, tokens: { inputTokens: 1, outputTokens: 1 } }), { rawCostMicros: 12_300, source: "provider-reported" });
  assert.deepEqual(rawCostForTurn({ price, tokens: { inputTokens: 10_000, outputTokens: 2_000, cachedInputTokens: 4_000 } }), { rawCostMicros: Math.round((6000 * 0.00000015 + 4000 * 0.00000003 + 2000 * 0.0000005) * 1e6), source: "live-price" });
  assert.equal(rawCostForTurn({ tokens: { inputTokens: 10 } }), null, "no reported cost and no price: unknown, never guessed");
});

// ---- Listing: guard, capability, price ------------------------------------------------------------------------------------------------

test("a third-party model is listed only while its guard is verified, it passes the capability check, and its live price is known", (t) => {
  t.after(clearGuards);
  clearGuards();
  for (const model of THIRD_PARTY_MODELS) assert.equal(marketplaceListing(model.id).listed, false, `${model.id}: unverified (or unattested) means not listed`);
  assert.deepEqual(listedMarketplaceModels(), []);

  verify("glm-5.3");
  assert.equal(marketplaceListing("glm-5.3").listed, true);
  assert.deepEqual(marketplaceListing("glm-5.3").price, { inputUsdPerToken: 0.0000012, outputUsdPerToken: 0.000004, cacheReadUsdPerToken: 0.00000024, cacheWriteUsdPerToken: 0.0000012 }, "no published write price: writes at the input rate");

  // The guard found the host keeps prompts: blocked.
  verify("glm-5.3", { status: "failed" });
  assert.equal(marketplaceListing("glm-5.3").listed, false);
  // A verified result that has aged past the guard's window: blocked until re-verified.
  verify("glm-5.3", { checkedAt: Date.now() - GUARD_MAX_AGE_MS - 1 });
  assert.equal(marketplaceListing("glm-5.3").listed, false);
  assert.match(marketplaceListing("glm-5.3").reason, /stale/);
  // Unknown price: not listed, never guessed.
  verify("glm-5.3", { pricing: { prompt: "0.0000012" } });
  assert.deepEqual(marketplaceListing("glm-5.3"), { listed: false, reason: "price-unknown" });
  verify("glm-5.3", { pricing: { prompt: "abc", completion: "0.000004" } });
  assert.equal(marketplaceListing("glm-5.3").listed, false);
  // Capability: no tools on the pinned host, or too short a context, and it is not listed. GLM 5.3 alone may go without vision (the
  // owner's one approved waiver): it is listed, reported as waived, and says "Text only".
  verify("glm-5.3", { inputModalities: ["text"] });
  assert.equal(marketplaceListing("glm-5.3").listed, true);
  assert.deepEqual(marketplaceListing("glm-5.3").capability.waived, ["vision"]);
  verify("glm-5.3", { supported: ["reasoning"] });
  assert.equal(marketplaceListing("glm-5.3").reason, "capability-tools");
  verify("glm-5.3", { context: LONG_DOCUMENT_MIN_TOKENS - 1 });
  assert.equal(marketplaceListing("glm-5.3").reason, "capability-long-documents");
});

test("the capability check needs vision, tool calling and long-document reading together", () => {
  assert.deepEqual(capabilityCheck({ inputModalities: ["text", "image"], hostParameters: ["tools"], contextLength: 1_048_576 }).missing, []);
  assert.deepEqual(capabilityCheck({ inputModalities: ["text"], hostParameters: [], contextLength: 1000 }).missing, ["vision", "tools", "long-documents"]);
  assert.equal(LONG_DOCUMENT_MIN_TOKENS, 128_000);
});

test("an unlisted third-party model cannot run: the guard blocks unverified providers at execution, not just in the picker", (t) => {
  t.after(clearGuards);
  clearGuards();
  const blocked = resolveExecutableModelKey("glm-5.3");
  assert.equal(blocked.available, false);
  assert.equal(blocked.code, "model_unavailable");
  assert.equal(getModelConfig("glm-5.3").chain[0].approved(), false);
  verify("glm-5.3");
  assert.deepEqual(resolveExecutableModelKey("glm-5.3"), { available: true, modelKey: "glm-5.3", thirdParty: true });
  assert.equal(getModelConfig("glm-5.3").chain[0].approved(), true);
});

// ---- Entitlements ----------------------------------------------------------------------------------------------------------------------

test("entitlement matrix: Zenith is Max only; each third-party model is open from its plan floor up", () => {
  // Nova and Nebula were retired on 2026-11-14: no plan includes them.
  const expected = { lumen: [1, 1, 1, 1], nova: [0, 0, 0, 0], nebula: [0, 0, 0, 0], vesper: [0, 0, 1, 1], zenith: [0, 0, 0, 1] };
  for (const [model, row] of Object.entries(expected)) {
    assert.deepEqual(PLANS.map((plan) => Number(planIncludesHouseModel(plan, model))), row, `${model}: the picker's plan gate`);
  }
  for (const plan of PLANS) {
    if (plan === "max") assert.doesNotThrow(() => assertModelPlanAccess(plan, "zenith"));
    else assert.throws(() => assertModelPlanAccess(plan, "zenith"), (error) => error.reason === "plan" && /Max/.test(JSON.stringify(error)), `${plan}: Zenith refused, and the plan named is Max`);
    for (const model of THIRD_PARTY_MODELS) {
      if (planIncludesThirdPartyModel(plan, model.id)) assert.doesNotThrow(() => assertModelPlanAccess(plan, model.id), `${plan}: ${model.id} is open (metered)`);
      else assert.throws(() => assertModelPlanAccess(plan, model.id), (error) => error.reason === "plan", `${plan}: ${model.id} is below its floor`);
    }
  }
  const floors = { "glm-5.3": [0, 1, 1, 1], "glm-5.3-flash": [0, 1, 1, 1], "gpt-6-luna": [0, 1, 1, 1], "gpt-6.1-terra": [0, 0, 1, 1], "gpt-6.2-sol": [0, 0, 0, 1], "gpt-6.2-astra": [0, 0, 0, 1] };
  for (const [model, row] of Object.entries(floors)) assert.deepEqual(PLANS.map((plan) => Number(planIncludesThirdPartyModel(plan, model))), row, model);
});

test("Zenith bills as a house model at a rate set above Vulcan's", () => {
  assert.ok(MODEL_TOKEN_PRICES.zenith.input > MODEL_TOKEN_PRICES.vesper.input);
  assert.ok(MODEL_TOKEN_PRICES.zenith.output > MODEL_TOKEN_PRICES.vesper.output);
  assert.deepEqual(MODEL_TOKEN_PRICES.zenith, { input: 1.5, output: 7.5, cacheRead: 0.075 });
  // Vulcan's own rate is unchanged.
  assert.deepEqual(MODEL_TOKEN_PRICES.vesper, { input: 1.0, output: 5.0, cacheRead: 0.05 });
});

// ---- The lineup the picker shows --------------------------------------------------------------------------------------------------------

test("the picker lineup: house models first with intelligence labels and no Recommended badge; then each provider's listed models under its name", (t) => {
  t.after(clearGuards);
  clearGuards();
  const empty = buildPickerLineup({ plan: "free" });
  assert.deepEqual(empty.house.map((m) => m.id), ["lumen", "vesper", "zenith"]);
  assert.ok(empty.house.every((m) => INTELLIGENCE_LEVELS.includes(m.intelligence)));
  assert.doesNotMatch(JSON.stringify(empty), /recommended/i, "no model is badged Recommended");
  assert.deepEqual(empty.providers, [], "nothing verified: no provider group");
  assert.deepEqual(empty.house.map((m) => m.allowed), [true, false, false], "Free: Lumen");
  assert.equal(buildPickerLineup({ plan: "max" }).house.find((m) => m.id === "zenith").allowed, true);

  for (const model of ROUTER_MARKETPLACE_CANDIDATES) verify(model.id, { context: 1_048_576 });
  const full = buildPickerLineup({ plan: "plus" });
  assert.deepEqual(full.providers.map((p) => p.name), ["GLM"], "the router models' provider; GPT-6 lists only with its direct terms attested");
  assert.deepEqual(full.providers[0].models.map((m) => [m.name, m.intelligenceLabel, m.providerLabel, m.allowed]), [
    ["GLM 5.3", "Smart", "GLM", true], ["GLM 5.3 Flash", "Balanced", "GLM", true],
  ]);
  assert.equal(full.providers[0].showHeader, true);
  assert.equal(buildPickerLineup({ plan: "free" }).providers[0].models.every((m) => m.allowed === false && m.lockedCopy === "Available with Plus, Pro, or Max."), true, "GLM is Plus and up: shown locked on Free");
  assert.equal("billingNote" in full, false, "no billing line travels with the picker");
  assert.ok(THIRD_PARTY_PROVIDERS.some((p) => p.name === "GPT-6"));
  // What reaches the browser names no engine, route or price.
  const wire = JSON.stringify(full);
  assert.doesNotMatch(wire, /mistral|z-ai\/|openrouter|pricing|UsdPerToken|price/i);
  assert.equal(buildPickerLineup({ plan: "pro", marketplaceEnabled: false }).providers.length, 0, "MODEL_MARKETPLACE=off hides them all");
});

test("the intelligence scale is one ordered scale and the house ladder climbs it, Zenith at the top", () => {
  const ranks = HOUSE_MODELS.map((m) => INTELLIGENCE_LEVELS.indexOf(HOUSE_INTELLIGENCE[m.id]));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal(HOUSE_INTELLIGENCE.zenith, "best");
  for (const model of THIRD_PARTY_MODELS) assert.ok(INTELLIGENCE_LEVELS.includes(model.intelligence));
});

// ---- Routes and privacy ----------------------------------------------------------------------------------------------------------------

test("Zenith and every third-party model run on pinned, no-fallback, zero-retention routes held strictly by the guard; Vulcan is unchanged", () => {
  const router = "https://openrouter.ai/api/v1";
  const cfg = { ...config, providerBaseUrls: { ...config.providerBaseUrls, paid: router }, chatModels: { ...config.chatModels, vesper: config.chatModels.vesper || "vendor/vesper-test" }, vesperTransport: "router" };
  const routes = Object.fromEntries(routeInventory(cfg).map((r) => [r.route, r]));
  for (const name of ["zenith", ...ROUTER_MARKETPLACE_CANDIDATES.map((c) => marketplaceRoute(c.id))]) {
    const route = routes[name];
    assert.ok(route, `${name} is in the inventory`);
    assert.equal(route.mode, "pinned");
    assert.equal(route.requireZeroRetention, true);
    assert.equal(route.gate, "strict", `${name}: closed until verified`);
    assert.equal(route.verifiable, true);
  }
  assert.deepEqual(routes.zenith.hosts, config.zenithProviders);
  // GPT-6 runs on the maker's own API, like Vulcan and Study: never on the router (where every OpenAI endpoint retains prompts), never
  // guard-decided, and never a route_policy line.
  for (const candidate of DIRECT_MARKETPLACE_CANDIDATES) {
    const route = routes[marketplaceRoute(candidate.id)];
    assert.ok(route, `${candidate.id} is in the inventory`);
    assert.equal(route.mode, "direct");
    assert.notEqual(route.host, "openrouter.ai");
    const entry = getModelConfig(candidate.id).chain[0];
    const shape = candidate.connection === "google" ? ["direct", "direct", "chat", undefined] : ["direct", "direct", "responses", false];
    assert.deepEqual([entry.provider, entry.transport, entry.api, entry.store], shape, candidate.id);
    assert.equal(entry.providerRouting, undefined);
  }
  for (const key of ["zenith", "glm-5.3"]) {
    const routing = getModelConfig(key).chain[0].providerRouting;
    assert.equal(routing.allow_fallbacks, false, key);
    assert.equal(routing.data_collection, "deny", key);
    assert.deepEqual(routing.only, routing.order, `${key}: only its pinned hosts`);
  }
  // Vulcan's strict flags are exactly as they were.
  const vesper = getModelConfig("vesper").chain[0];
  if (vesper.providerRouting) assert.deepEqual(vesper.providerRouting, { allow_fallbacks: false, data_collection: "deny" });
  assert.equal(routes.vesper.mode, "deny", "Vulcan: data_collection deny, guarded as before");
  assert.equal(routes.vesper.requireZeroRetention, undefined, "and its route definition is untouched");
});

test("Vulcan traffic still never reaches background memory extraction; third-party chats are held the same way (fail closed)", async () => {
  const { vesperModelKeys, safeNonVesperConversationModelKeys, safeNonVesperAssistantModelKeys } = await import("../src/chat/model-keys.js");
  assert.ok(vesperModelKeys().includes("vesper"));
  for (const safe of [safeNonVesperConversationModelKeys(), safeNonVesperAssistantModelKeys()]) {
    assert.equal(safe.includes("vesper"), false, "Vulcan is never on a safe list");
    // A key not on the safe lists is treated like Vulcan (hasHistoricalVesperUse fails closed): no memory extraction, no image hand-off.
    for (const model of THIRD_PARTY_MODELS) assert.equal(safe.includes(model.id), false, `${model.id} is held like Vulcan`);
    assert.ok(safe.includes("zenith"), "Zenith is a house tier, handled like Nova and Nebula");
  }
});

test("a third-party chat is protected from its first turn: no background memory extraction even before the conversation has an id", async () => {
  const router = (await readFile(new URL("../src/chat/router.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(router, /let protectedChat = normalizeModelKey\(modelKey\) === "vesper" \|\| isThirdPartyModel\(modelKey\);/);
  // The one background-extraction call is behind that flag, and the flag is set before the conversation id is.
  const flagAt = router.indexOf("let protectedChat =");
  const idAt = router.indexOf("conversationId = req.chatUserMessage.conversationId;");
  const extractAt = router.indexOf("extractAndSaveFacts(userId, content");
  assert.ok(flagAt > 0 && idAt > flagAt && extractAt > idAt, "flag first, then the new conversation's id, then extraction");
  assert.match(router.slice(extractAt - 200, extractAt), /if \(memoryTarget && shouldUpdateMemory && !protectedChat\) \{/);
  assert.equal((router.match(/extractAndSaveFacts\(/g) ?? []).length, 1, "no other extraction call");
});

test("a third-party model says truthfully what it is, and does not speak for the house models", () => {
  const prompt = buildIdentitySystemPrompt("glm-5.3");
  assert.match(prompt, /^You are GLM 5\.3, a model made by Z\.AI/);
  assert.match(prompt, /You are not one of VibhavGPT's own models/);
  assert.doesNotMatch(prompt.split("\n")[0], /Never name any AI company/);
  assert.match(buildIdentitySystemPrompt("zenith"), /^You are VibhavGPT Zenith, the flagship/);
  assert.doesNotMatch(buildIdentitySystemPrompt("zenith"), /mistral/i, "Zenith's engine is never in its prompt");
});

// ---- Settlement and the ledger ----------------------------------------------------------------------------------------------------

async function createDatabase(t) {
  const client = new PGlite();
  t.after(() => client.close());
  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  return drizzle(client);
}

test("a settled third-party turn records the provider's cost on the usage row and itemizes model, cost, upcharge and credits in the ledger", async (t) => {
  t.after(clearGuards);
  verify("glm-5.3", { pricing: { prompt: "0.00000015", completion: "0.0000005" }, context: 1_048_576 });
  const db = await createDatabase(t);
  const [event] = await db.insert(usageEvents).values({ userId: "u1", model: "glm-5.3", reservedTokens: 5000 }).returning({ id: usageEvents.id });

  // The router reported what the provider charged: that is the cost.
  const settled = await finalizeUsage(event.id, { prompt_tokens: 40_000, completion_tokens: 2_000, cost: 0.007 }, db, "glm-5.3", { userId: "u1" });
  assert.deepEqual(settled, { rawCostMicros: 7000, upchargeMicros: 700, chargedMicros: 7700, credits: 0.154, costSource: "provider-reported" });
  const [row] = await db.select().from(usageEvents).where(eq(usageEvents.id, event.id));
  assert.equal(row.costMicros, 7000, "the usage row holds the raw cost; the credits engine debits it once at cost plus 10%");
  assert.equal(calculateUnifiedLedgerDeductionMicros(row.costMicros), 7700);
  const [charge] = await db.select().from(marketplaceCharges).where(eq(marketplaceCharges.usageEventId, event.id));
  assert.deepEqual(
    { model: charge.model, provider: charge.provider, raw: charge.rawCostMicros, upcharge: charge.upchargeMicros, charged: charge.chargedMicros, credits: charge.credits, source: charge.costSource, inTok: charge.inputTokens, outTok: charge.outputTokens },
    { model: "glm-5.3", provider: "GLM", raw: 7000, upcharge: 700, charged: 7700, credits: "0.154", source: "provider-reported", inTok: 40_000, outTok: 2_000 },
  );

  // Settling the same call again adds no second ledger row.
  await finalizeUsage(event.id, { prompt_tokens: 40_000, completion_tokens: 2_000, cost: 0.007 }, db, "glm-5.3", { userId: "u1" });
  assert.equal((await db.select().from(marketplaceCharges)).length, 1);

  // No reported cost: the live price times the tokens.
  const [second] = await db.insert(usageEvents).values({ userId: "u1", model: "glm-5.3", reservedTokens: 5000 }).returning({ id: usageEvents.id });
  const priced = await finalizeUsage(second.id, { prompt_tokens: 10_000, completion_tokens: 1_000 }, db, "glm-5.3", { userId: "u1" });
  assert.equal(priced.costSource, "live-price");
  assert.equal(priced.rawCostMicros, Math.round((10_000 * 0.00000015 + 1_000 * 0.0000005) * 1e6));
});

test("a third-party hold is priced at the live price with the same markup, and an unpriced settlement is never free", async (t) => {
  t.after(clearGuards);
  verify("glm-5.3");
  const hold = estimateTurnReservationHoldMicros("glm-5.3", 0, { estimatedInputTokens: 1000, maxOutputTokens: 1000 });
  assert.equal(hold, calculateUnifiedLedgerDeductionMicros(Math.round(1512 * 1.2 + 1000 * 4)));
  assert.ok(settlementPrice("glm-5.3"));

  clearGuards();
  // Nothing verified in this process and no reported cost: the row keeps its hold rather than settling at zero.
  const db = await createDatabase(t);
  const [event] = await db.insert(usageEvents).values({ userId: "u2", model: "glm-5.3", reservedTokens: 5000 }).returning({ id: usageEvents.id });
  assert.equal(await finalizeUsage(event.id, { prompt_tokens: 10, completion_tokens: 10 }, db, "glm-5.3", { userId: "u2" }), null);
  const [row] = await db.select().from(usageEvents).where(eq(usageEvents.id, event.id));
  assert.equal(row.costMicros, 0);
  assert.equal(row.reservedTokens, 5000, "still held, so it still counts against the balance");
});
