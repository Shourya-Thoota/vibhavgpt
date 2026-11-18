import test from "node:test";
import assert from "node:assert/strict";
import { COMPARISON_GROUPS, compactTokens, monthlyEquivalent, yearlySaving } from "../frontend/src/plan-comparison.js";
import { PRODUCT_KNOWLEDGE } from "../frontend/src/product-knowledge.js";

const row = (label) => COMPARISON_GROUPS.flatMap((group) => group.rows).find((entry) => entry.label === label);
const plan = (id) => PRODUCT_KNOWLEDGE.plans.find((entry) => entry.id === id);
const features = (id) => plan(id).features.join(" ");

test("token rows come from the enforced quotas", () => {
  assert.deepEqual(row("Lumen").values, ["Up to 15 AI requests in any 24 hours and $0.25 each UTC calendar month, shared", "8M", "12M", "Included"]);
  assert.deepEqual(row("Study").values, ["Shares the Free allowance above", "4M", "6M", "Included"]);
  assert.deepEqual(row("Vulcan").values, [null, null, "800K", "Included"]);
  assert.deepEqual(row("Zenith").values, [null, null, null, "Included"]);
  // Nova and Nebula were retired on 2026-11-14 and have no row.
  assert.equal(row("Nebula"), undefined);
  assert.equal(row("Lumen and Nova"), undefined);
  assert.equal(compactTokens(0), null);
});

test("generation and upload rows agree with the plan features", () => {
  const [, plusImages, proImages, maxImages] = row("Image generations").values;
  assert.match(features("plus"), new RegExp(`${plusImages.split(" ")[0]} image`));
  assert.match(features("pro"), new RegExp(`${proImages.split(" ")[0]} image generations`));
  assert.match(features("max"), new RegExp(`${maxImages.split(" ")[0]} image generations`));
  assert.match(features("plus"), new RegExp(`${row("Document generations").values[1].split(" ")[0]} document`));
  assert.match(features("pro"), /unlimited document generations/i);
  assert.match(features("max"), /unlimited document generations/i);
  const [freeDocs, plusDocs, proDocs, maxDocs] = row("Document uploads").values;
  const [, plusImg, proImg, maxImg] = row("Image uploads").values;
  assert.match(features("free"), new RegExp(`${freeDocs} maximum document`));
  assert.match(features("plus"), new RegExp(`${plusDocs} document and ${plusImg} image uploads`));
  assert.match(features("pro"), new RegExp(`${proDocs} document and ${proImg} image uploads`));
  assert.match(features("max"), new RegExp(`${maxDocs} document and ${maxImg} image uploads`));
});

test("the Max column is never blank and states configured launch allowances", () => {
  for (const entry of COMPARISON_GROUPS.flatMap((group) => group.rows)) {
    assert.equal(entry.values.length, 4, entry.label);
    assert.notEqual(entry.values[3], null, `${entry.label} has a Max value`);
    assert.notEqual(entry.values[3], undefined, `${entry.label} has a Max value`);
  }
  assert.equal(row("Document generations").values[3], "Unlimited");
  assert.equal(row("Document uploads").values[3], "80 MB");
  assert.equal(row("Image uploads").values[3], "20 MB");
  assert.equal(row("Image generations").values[3], "1,500 per month");
});

test("yearly price helpers", () => {
  assert.equal(monthlyEquivalent("$49.99"), "$4.17");
  assert.equal(monthlyEquivalent("$500"), "$41.67");
  assert.equal(yearlySaving("$4.99", "$49.99"), 17);
  assert.equal(yearlySaving("$12.99", "$129.99"), 17);
  assert.equal(yearlySaving("$50", "$500"), 17);
  // Max since 2026-11-15: $499.90 a year against 12 x $49.99 ($599.88) saves 16.7%, shown as about 17%; about $41.66 a month.
  assert.equal(yearlySaving("$49.99", "$499.90"), 17);
  assert.equal(monthlyEquivalent("$499.90"), "$41.66");
  assert.equal(yearlySaving("$0", "$0"), null);
});
