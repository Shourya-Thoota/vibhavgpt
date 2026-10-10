import test from "node:test";
import assert from "node:assert/strict";
import { COMPARISON_GROUPS, compactTokens, monthlyEquivalent, yearlySaving } from "../frontend/src/plan-comparison.js";
import { PRODUCT_KNOWLEDGE } from "../frontend/src/product-knowledge.js";

const row = (label) => COMPARISON_GROUPS.flatMap((group) => group.rows).find((entry) => entry.label === label);
const plan = (id) => PRODUCT_KNOWLEDGE.plans.find((entry) => entry.id === id);
const features = (id) => plan(id).features.join(" ");

test("token rows come from the enforced quotas", () => {
  assert.deepEqual(row("Lumen and Nova").values, ["1M", "8M", "12M"]);
  assert.deepEqual(row("Study").values, ["500K", "4M", "6M"]);
  assert.deepEqual(row("Nebula").values, [null, "1.5M", "3M"]);
  assert.deepEqual(row("Vesper").values, [null, "300K", "800K"]);
  assert.equal(compactTokens(0), null);
});

test("generation and upload rows agree with the plan features", () => {
  const [, plusImages, proImages] = row("Image generations").values;
  assert.match(features("plus"), new RegExp(`${plusImages.split(" ")[0]} image`));
  assert.match(features("pro"), new RegExp(`${proImages.split(" ")[0]} image generations`));
  assert.match(features("plus"), new RegExp(`${row("Document generations").values[1].split(" ")[0]} document`));
  assert.match(features("pro"), /unlimited document generations/i);
  const [freeDocs, plusDocs, proDocs] = row("Document uploads").values;
  const [, plusImg, proImg] = row("Image uploads").values;
  assert.match(features("free"), new RegExp(`${freeDocs} maximum document`));
  assert.match(features("plus"), new RegExp(`${plusDocs} document and ${plusImg} image uploads`));
  assert.match(features("pro"), new RegExp(`${proDocs} document and ${proImg} image uploads`));
});

test("yearly price helpers", () => {
  assert.equal(monthlyEquivalent("$49.99"), "$4.17");
  assert.equal(yearlySaving("$4.99", "$49.99"), 17);
  assert.equal(yearlySaving("$12.99", "$129.99"), 17);
  assert.equal(yearlySaving("$0", "$0"), null);
});
