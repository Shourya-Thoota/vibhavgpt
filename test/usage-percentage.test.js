import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { usagePercentage, overallTokenPercentage, combinedTokenUsage } from "../frontend/src/usage-percentage.js";

test("usage percentages round to whole numbers and stay within progress bar bounds", () => {
  assert.equal(usagePercentage(123905, 12000000), 1);
  assert.equal(usagePercentage(0, 100000), 0);
  assert.equal(usagePercentage(150000, 100000), 100);
  assert.equal(usagePercentage(-5, 100), 0);
  assert.equal(usagePercentage(10, 0), 0);
  assert.equal(usagePercentage(10, Infinity), 0);
});

test("overall percentage divides all model usage by total monthly allowances", () => {
  const usage = { tokensThisPeriod: 999999, limits: { lumen: { monthly: 1000000 }, study: { monthly: 500000 }, nebula: { monthly: 0 } }, tokenBreakdown: { lumen: { total: 100000 }, study: { total: 50000 }, nebula: { total: 900000 } } };
  assert.equal(overallTokenPercentage(usage, ["lumen", "study", "nebula"]), 70);
  assert.equal(overallTokenPercentage(null, ["lumen"]), 0);
});

test("token dashboard uses percentages and omits raw input/output and reserved counts", async () => {
  const source = await readFile(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /used=\{combined\.monthly\.used\} limit=\{combined\.monthly\.limit\} label="of monthly token allowances used" percentageOnly/);
  assert.match(source, /used=\{combined\.rolling\.used\} limit=\{combined\.rolling\.limit\} label="of 5-hour token allowances used" percentageOnly/);
  assert.doesNotMatch(source, /Tokens by model|Includes pending usage:|overallPercentage/);
  assert.match(source, /Monthly caps reset on the first day at 00:00 UTC\. The 5-hour window rolls continuously/);
  assert.doesNotMatch(source, /monthly\.input\.toLocaleString|monthly\.output\.toLocaleString|reserved\.toLocaleString/);
});

test("pending holds count in both the model percentages and the overall summary", async () => {
  const { modelTokenUsage } = await import("../frontend/src/usage-percentage.js");
  const usage = { limits: { vesper: { monthly: 800000, rolling: 80000 } }, tokenBreakdown: { vesper: { total: 16682 } }, rollingTokenBreakdown: { vesper: { total: 16682 } }, reservedTokenBreakdown: { vesper: 34894 }, rollingReservedTokenBreakdown: { vesper: 34894 } };
  const counted = modelTokenUsage(usage, "vesper");
  assert.equal(counted.rolling, 51576);
  assert.equal(usagePercentage(counted.rolling, 80000), 64);
  assert.equal(overallTokenPercentage(usage, ["vesper"]), 6);
});

test("combined monthly and rolling totals include each window's pending holds exactly once", () => {
  const usage = {
    limits: { lumen: { monthly: 1000, rolling: 100 }, nova: { monthly: 3000, rolling: 300 }, nebula: { monthly: 0, rolling: 0 } },
    tokenBreakdown: { lumen: { total: 100 }, nova: { total: 400 }, nebula: { total: 100 } },
    rollingTokenBreakdown: { lumen: { total: 10 }, nova: { total: 40 }, nebula: { total: 5 } },
    reservedTokenBreakdown: { lumen: 100, nova: 200 },
    rollingReservedTokenBreakdown: { lumen: 20, nova: 30 },
  };
  const combined = combinedTokenUsage(usage);
  assert.deepEqual(combined, { monthly: { used: 900, limit: 4000 }, rolling: { used: 105, limit: 400 } });
  assert.equal(usagePercentage(combined.monthly.used, combined.monthly.limit), 23);
  assert.equal(usagePercentage(combined.rolling.used, combined.rolling.limit), 26);
  assert.deepEqual(combinedTokenUsage(null), { monthly: { used: 0, limit: 0 }, rolling: { used: 0, limit: 0 } });
});
