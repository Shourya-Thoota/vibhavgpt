// Tecton's price (owner decision, 2026-11-15): a VibhavGPT house model at $0.80 input / $1.20 output per 1M tokens, charged at exactly that
// rate. The ledger's 1.10 markup, which other house models and marketplace models (cost plus 10%) get, is not added on top of it.
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real-at-least-32-chars";
const { MODEL_TOKEN_PRICES, ledgerDebitMicros, estimateTurnReservationHoldMicros, actualApiCostUsd } = await import("../src/usage/service.js");
const { creditSpendByWindow } = await import("../src/usage/credits.js");
const { thirdPartyCharge } = await import("../src/models/marketplace.js");
const { calculateUnifiedLedgerDeductionMicros } = await import("../src/models/pricing-engine.js");

test("Tecton's configured rate is $0.80 / $1.20 per 1M tokens, not its engine's price", () => {
  assert.deepEqual({ input: MODEL_TOKEN_PRICES.tecton.input, output: MODEL_TOKEN_PRICES.tecton.output }, { input: 0.80, output: 1.20 });
});

test("a settled Tecton turn is debited at exactly its rate; other house models keep the 1.10 markup", () => {
  // 1M input + 1M output tokens.
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
  const tectonRaw = Math.round(actualApiCostUsd("tecton", usage) * 1_000_000);
  assert.equal(tectonRaw, 2_000_000, "$0.80 + $1.20");
  assert.equal(ledgerDebitMicros("tecton", tectonRaw), 2_000_000, "debited at $2.00, no markup");
  const lumenRaw = Math.round(actualApiCostUsd("lumen", usage) * 1_000_000);
  assert.equal(ledgerDebitMicros("lumen", lumenRaw), calculateUnifiedLedgerDeductionMicros(lumenRaw), "Lumen unchanged");
  assert.equal(ledgerDebitMicros("lumen", 1_000_000), 1_100_000);
  assert.equal(ledgerDebitMicros("vesper", 1_000_000), 1_100_000, "Vulcan unchanged");
});

test("the hold before a Tecton turn uses the same unmarked rate", () => {
  const held = estimateTurnReservationHoldMicros("tecton", 0, { estimatedInputTokens: 1_000_000 - 512, maxOutputTokens: 1_000_000 });
  assert.equal(held, 2_000_000);
  // Zenith is held from the same rate table, with the markup.
  const heldZenith = estimateTurnReservationHoldMicros("zenith", 0, { estimatedInputTokens: 1_000_000 - 512, maxOutputTokens: 1_000_000 });
  assert.equal(heldZenith, calculateUnifiedLedgerDeductionMicros(Math.round(1_000_000 * MODEL_TOKEN_PRICES.zenith.input + 1_000_000 * MODEL_TOKEN_PRICES.zenith.output)));
});

test("credits spent: a Tecton row counts its rate once; a marketplace row still counts cost plus 10%", () => {
  const startMs = Date.parse("2026-11-01T00:00:00Z"), endMs = Date.parse("2026-12-01T00:00:00Z");
  const schedule = { startMs, endMs, windows: [{ startMs, endMs }] };
  const accounting = { debitMicros: (raw, event) => ledgerDebitMicros(event?.model, raw), holdMicros: () => 0 };
  const at = new Date("2026-11-10T00:00:00Z");
  const spend = (model) => creditSpendByWindow([{ model, costMicros: 1_000_000, reservedTokens: 0, createdAt: at }], schedule, accounting);
  const total = (windows) => (Array.isArray(windows) ? windows.reduce((a, b) => a + Number(b || 0), 0) : Object.values(windows).reduce((a, b) => a + Number(b || 0), 0));
  assert.equal(total(spend("tecton")), 1_000_000);
  assert.equal(total(spend("glm-5.3-flash")), 1_100_000, "marketplace: cost plus 10%");
  assert.equal(thirdPartyCharge(1_000_000).chargedMicros, 1_100_000, "the marketplace charge is unchanged");
});
