process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";

import test from "node:test";
import assert from "node:assert/strict";

const { buildSeedRegistrySnapshot, serializeModelForCatalog } = await import("../src/models/catalog-service.js");
const { isFreeIncludedFamily } = await import("../src/models/free-included.js");
const { NATIVE_FAMILY_ARCHITECTURES } = await import("../src/models/inventory.js");

// Free includes Lumen. (It also included Nova until Nova and Nebula were retired on 2026-11-14; a retired tier is included in no plan
// and is not in the customer-facing seed registry.) This suite was nova-free-registry-gate.test.js; it keeps the same checks on Lumen.

const seed = () => buildSeedRegistrySnapshot({ customerFacingOnly: true });
const bySlug = (snapshot, slug) => {
  const item = snapshot.find((entry) => entry.family.slug === slug);
  assert.ok(item, `seed registry has ${slug}`);
  return item;
};
const selectability = (item, plan) => serializeModelForCatalog(item, plan).selectability;

// The database-backed registry names a tier "vibhavgpt/<tier>" and stores the upstream model id as the version tag; rows written
// before the Free launch can still say plan_eligibility = 'paid'. The included-with-Free exception must fire on that exact shape.
function dbShapedLumen(planEligibility = "paid") {
  const base = bySlug(seed(), "lumen");
  return {
    ...base,
    family: { ...base.family, slug: NATIVE_FAMILY_ARCHITECTURES.lumen.slug },
    version: { ...base.version, versionTag: "upstream/example-model-id", planEligibility },
  };
}

test("Free includes Lumen in both registry slug shapes, and nothing else; the retired tiers are not included", () => {
  for (const slug of ["lumen", "vibhavgpt/lumen", " VibhavGPT/Lumen "]) assert.equal(isFreeIncludedFamily({ slug }), true, slug);
  for (const slug of ["nova", "vibhavgpt/nova", "nebula", "vibhavgpt/nebula", "vesper", "zenith", "study", "vibhavgpt/vesper", "vibhavgpt/study", "someone/lumen-fork", ""]) {
    assert.equal(isFreeIncludedFamily({ slug }), false, slug);
  }
  assert.equal(isFreeIncludedFamily(null), false);
  assert.equal(isFreeIncludedFamily(undefined), false);
});

test("the inventory's own slugs are recognised, so the two cannot drift apart", () => {
  assert.equal(isFreeIncludedFamily({ slug: NATIVE_FAMILY_ARCHITECTURES.lumen.slug }), true);
  assert.equal(isFreeIncludedFamily({ slug: NATIVE_FAMILY_ARCHITECTURES.nova.slug }), false, "Nova is retired");
  assert.equal(isFreeIncludedFamily({ slug: NATIVE_FAMILY_ARCHITECTURES.nebula.slug }), false);
});

test("the customer-facing seed registry holds no retired tier", () => {
  const slugs = seed().map((entry) => entry.family.slug);
  assert.ok(slugs.includes("lumen") && slugs.includes("vesper"), slugs.join(", "));
  assert.equal(slugs.some((slug) => /nova|nebula/.test(slug)), false, slugs.join(", "));
});

test("database-shaped Lumen with a stale 'paid' row is selectable on Free", () => {
  const free = selectability(dbShapedLumen("paid"), "free");
  assert.deepEqual(free, { selectable: true, locked: false, lockReason: null, lockType: null });
});

test("database-shaped Lumen is also selectable when stored as 'free'", () => {
  assert.equal(selectability(dbShapedLumen("free"), "free").selectable, true);
});

test("seed-fallback Lumen is selectable on Free", () => {
  assert.equal(selectability(bySlug(seed(), "lumen"), "free").selectable, true);
});

test("Lumen stays selectable on every paid plan", () => {
  for (const plan of ["plus", "pro", "max"]) assert.equal(selectability(dbShapedLumen("paid"), plan).selectable, true, plan);
});

test("Vulcan stays locked on Free and Plus, and opens on Pro", () => {
  const vesper = bySlug(seed(), "vesper");
  assert.equal(selectability(vesper, "free").selectable, false);
  assert.equal(selectability(vesper, "plus").selectable, false);
  assert.equal(selectability(vesper, "pro").selectable, true);
});

test("a stale paid row for a non-included family is still locked on Free (the exception is not a loophole)", () => {
  const vesper = bySlug(seed(), "vesper");
  const disguised = { ...vesper, family: { ...vesper.family, slug: "vibhavgpt/vesper" }, version: { ...vesper.version, versionTag: "lumen-ish", planEligibility: "paid" } };
  assert.equal(selectability(disguised, "free").selectable, false);
});
