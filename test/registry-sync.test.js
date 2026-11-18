process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";

const schema = await import("../src/db/schema.js");
const { buildDesiredNativeRegistry, OWNER_EVIDENCE_REQUIRED, SOURCE_RETRIEVED_AT } = await import("../src/models/native-registry-evidence.js");
const { applyRegistrySync, assertDesiredIsPending, assertNoSecrets, formatRegistryPlan, planRegistrySync, readCurrentRegistry, RegistrySyncError } = await import("../src/models/registry-sync.js");
const { evaluateRoutingDecision, loadRegistrySnapshot } = await import("../src/models/decision.js");
const { VERIFIED_PRODUCTION_OBSERVATION } = await import("../src/models/inventory.js");

async function createDatabase(t) {
  const client = new PGlite();
  t.after(() => client.close());
  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  return { client, db: drizzle(client) };
}
const counts = async (db) => {
  const current = await readCurrentRegistry(db);
  return { families: current.families.length, versions: current.versions.length, endpoints: current.endpoints.length, pricing: current.pricing.length };
};
const find = (desired, tier) => desired.find((item) => item.family.slug === `vibhavgpt/${tier}`);
const priceOf = (desired, tier, key) => find(desired, tier).endpoints.find((e) => `${e.providerName}|${e.transportType}` === key).pricingSnapshots[0];

test("the offline plan is a pure dry run that creates only pending records", () => {
  const desired = buildDesiredNativeRegistry();
  const plan = planRegistrySync(desired);
  assert.equal(plan.summary.conflict, 0);
  assert.equal(plan.summary.update + plan.summary.noop, 0);
  assert.ok(plan.summary.create > 0);
  assert.match(formatRegistryPlan(plan), /Registry sync plan: \d+ create/);
  for (const item of desired) {
    assert.equal(item.version.lifecycleState, "candidate");
    assert.equal(item.version.metadata.approvalStatus, "pending_owner_evidence");
    for (const endpoint of item.endpoints) {
      assert.equal(endpoint.privacyReview.privacyApproved, false);
      assert.equal(endpoint.privacyReview.reviewedBy, null, "no reviewer identity is invented");
      assert.equal(endpoint.privacyReview.auditRef, null);
      assert.equal(endpoint.privacyReview.trainingPolicy, "unknown", "a public statement is not a recorded training policy");
      assert.ok(["candidate", "disabled"].includes(endpoint.endpointState));
    }
  }
});

test("researched prices match their sources and carry URL, retrieval date and limits", () => {
  const desired = buildDesiredNativeRegistry();
  assert.equal(SOURCE_RETRIEVED_AT, "2026-10-31");
  const expected = [
    ["nova", "paid|router", 174_000, 586_000, 18_000],
    ["nebula", "paid|router", 682_500, 3_500_000, 150_000],
    ["study", "study|direct", 100_000, 500_000, 10_000],
    ["vesper", "direct|direct", 1_000_000, 5_000_000, 50_000],
  ];
  for (const [tier, key, input, output, cached] of expected) {
    const price = priceOf(desired, tier, key);
    assert.deepEqual([price.inputPriceMicrosPerM, price.outputPriceMicrosPerM, price.cachedReadPriceMicrosPerM], [input, output, cached], tier);
    assert.match(price.provenance, /https:\/\//, `${tier} records a source URL`);
    assert.match(price.provenance, /retrieved 2026-10-31/, `${tier} records a retrieval date`);
    assert.match(price.provenance, /limitations:/, `${tier} records its limits`);
    assert.notEqual(price.pricingConfidence, "unverified");
  }
  assert.match(priceOf(desired, "study", "study|direct").provenance, /context up to 272000 tokens/);
  assert.match(priceOf(desired, "vesper", "direct|direct").provenance, /context up to 272000 tokens/);
  assert.equal(priceOf(desired, "nova", "paid|router").pricingConfidence, "verified_ceiling", "router prices are a reservation ceiling, not what is charged");
  // Lumen's customer rate is zero by owner policy and is labelled as such, not as vendor pricing.
  const lumen = priceOf(desired, "lumen", "primaryFree|primaryFree");
  assert.deepEqual([lumen.inputPriceMicrosPerM, lumen.outputPriceMicrosPerM], [0, 0]);
  assert.equal(lumen.pricingConfidence, "owner_policy");
});

test("only evidenced stages are priced; unapproved and unreadable stages stay unpriced and disabled or pending", () => {
  const desired = buildDesiredNativeRegistry();
  const lumen = find(desired, "lumen");
  const byStage = Object.fromEntries(lumen.endpoints.map((endpoint) => [endpoint.providerName, endpoint]));
  assert.equal(byStage.primaryFree.pricingSnapshots.length, 1);
  assert.equal(byStage.gatewayFree.pricingSnapshots.length, 0, "no readable price source for the gateway stage");
  assert.equal(byStage.secondaryFree.endpointState, "disabled");
  assert.equal(byStage.reserveFree.endpointState, "disabled");
  const vesper = find(desired, "vesper");
  const router = vesper.endpoints.find((endpoint) => endpoint.transportType === "router");
  assert.equal(router.pricingSnapshots.length, 0, "the alternate router route is never priced or enabled");
});

test("model ids and endpoint hosts equal the observed server configuration (no invented pins)", () => {
  const desired = buildDesiredNativeRegistry();
  const models = VERIFIED_PRODUCTION_OBSERVATION.models;
  assert.equal(find(desired, "lumen").version.versionTag, models.lumenPrimary);
  assert.equal(find(desired, "nova").version.versionTag, models.nova);
  assert.equal(find(desired, "study").version.versionTag, models.study);
  assert.equal(find(desired, "nebula").version.versionTag, models.nebula);
  assert.equal(find(desired, "vesper").version.versionTag, models.vesperDirect);
  assert.equal(find(desired, "nova").endpoints[0].endpointUrl, VERIFIED_PRODUCTION_OBSERVATION.endpoints.novaRouter);
  assert.equal(find(desired, "study").endpoints[0].endpointUrl, VERIFIED_PRODUCTION_OBSERVATION.endpoints.studyDirect);
});

test("the owner checklist names exact settings, tiers and locations, and nothing else", () => {
  assert.ok(OWNER_EVIDENCE_REQUIRED.length <= 6);
  for (const item of OWNER_EVIDENCE_REQUIRED) {
    assert.ok(item.tiers.length > 0 && item.fact && item.where && item.why, item.id);
  }
  const tiers = new Set(OWNER_EVIDENCE_REQUIRED.flatMap((item) => item.tiers));
  assert.deepEqual([...tiers].sort(), ["lumen", "nebula", "nova", "study", "vesper"]);
});

test("applying is idempotent, writes pending records only, and never makes a tier eligible", async (t) => {
  const { db } = await createDatabase(t);
  const desired = buildDesiredNativeRegistry();
  const first = await applyRegistrySync(desired, db);
  const afterFirst = await counts(db);
  assert.equal(first.summary.create, 24);
  assert.deepEqual(afterFirst, { families: 5, versions: 5, endpoints: 9, pricing: 5 });

  const second = planRegistrySync(desired, await readCurrentRegistry(db));
  assert.deepEqual(second.summary, { create: 0, update: 0, noop: 24, conflict: 0 }, "a second run changes nothing");
  await applyRegistrySync(desired, db);
  assert.deepEqual(await counts(db), afterFirst);

  const snapshot = await loadRegistrySnapshot(db);
  for (const tier of ["lumen", "nova", "study", "nebula", "vesper"]) {
    const decision = await evaluateRoutingDecision({ plan: "pro", requestedModel: { modelKey: tier } }, { registrySnapshot: snapshot, evaluatedAt: "2026-10-31T12:00:00Z" });
    assert.equal(decision.eligible, false, `${tier} stays ineligible until the owner's evidence is recorded`);
    assert.equal(decision.reasonCode, "version_not_active");
  }
  const endpoints = await db.select().from(schema.modelEndpoints);
  assert.ok(endpoints.every((row) => row.privacyReview.privacyApproved === false));
});

test("an owner's approval and lifecycle state survive every later sync", async (t) => {
  const { db } = await createDatabase(t);
  const desired = buildDesiredNativeRegistry();
  await applyRegistrySync(desired, db);

  // What the owner's own evidence later records (test stand-in; the sync never does this).
  const [version] = await db.select().from(schema.modelVersions).where(eq(schema.modelVersions.versionTag, "gpt-6-luna"));
  const [endpoint] = await db.select().from(schema.modelEndpoints).where(eq(schema.modelEndpoints.versionId, version.id));
  await db.update(schema.modelEndpoints).set({ endpointState: "active", privacyReview: { privacyApproved: true, auditRef: "owner-evidence-1", reviewedBy: "owner", reviewedAt: "2026-11-02T00:00:00.000Z", expiresAt: "2027-11-02T00:00:00.000Z", scope: "default", trainingPolicy: "denied" } }).where(eq(schema.modelEndpoints.id, endpoint.id));
  await db.update(schema.modelVersions).set({ lifecycleState: "active", metadata: { ...version.metadata, auditTrail: [{ from: "reviewed", to: "active", actor: "owner" }] } }).where(eq(schema.modelVersions.id, version.id));

  const plan = planRegistrySync(desired, await readCurrentRegistry(db));
  assert.equal(plan.conflicts.length, 0);
  assert.ok(plan.preserved.some((item) => item.kind === "endpoint" && /privacyApproved=true/.test(item.kept)));
  assert.ok(plan.preserved.some((item) => item.kind === "version" && /lifecycleState=active/.test(item.kept)));
  await applyRegistrySync(desired, db);

  const [after] = await db.select().from(schema.modelEndpoints).where(eq(schema.modelEndpoints.id, endpoint.id));
  assert.equal(after.endpointState, "active");
  assert.equal(after.privacyReview.privacyApproved, true);
  assert.equal(after.privacyReview.auditRef, "owner-evidence-1");
  const [afterVersion] = await db.select().from(schema.modelVersions).where(eq(schema.modelVersions.id, version.id));
  assert.equal(afterVersion.lifecycleState, "active");
  assert.deepEqual(afterVersion.metadata.auditTrail, [{ from: "reviewed", to: "active", actor: "owner" }], "the lifecycle audit trail is kept");

  // One complete eligible path: with the owner's approval recorded, Study resolves to its
  // verified pinned price, while every other tier stays pending.
  const snapshot = await loadRegistrySnapshot(db);
  const study = await evaluateRoutingDecision({ plan: "pro", requestedModel: { modelKey: "study" } }, { registrySnapshot: snapshot, evaluatedAt: "2026-11-03T00:00:00Z" });
  assert.equal(study.eligible, true);
  assert.deepEqual([study.pinnedPricing.inputPriceMicrosPerM, study.pinnedPricing.outputPriceMicrosPerM, study.pinnedPricing.cachedReadPriceMicrosPerM], [100_000, 500_000, 10_000]);
  const nova = await evaluateRoutingDecision({ plan: "pro", requestedModel: { modelKey: "nova" } }, { registrySnapshot: snapshot, evaluatedAt: "2026-11-03T00:00:00Z" });
  assert.equal(nova.eligible, false);
});

test("a recorded price is immutable: a different value is a conflict and the apply is refused without writing", async (t) => {
  const { db } = await createDatabase(t);
  const desired = buildDesiredNativeRegistry();
  await applyRegistrySync(desired, db);
  await db.update(schema.modelPricingSnapshots).set({ outputPriceMicrosPerM: 999_999 }).where(sql`pricing_version_id = 'native_2026_10_31_study'`);
  const plan = planRegistrySync(desired, await readCurrentRegistry(db));
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.summary.conflict, 1);
  await assert.rejects(applyRegistrySync(desired, db), (error) => error instanceof RegistrySyncError && error.code === "conflicts");
  const [row] = await db.select().from(schema.modelPricingSnapshots).where(sql`pricing_version_id = 'native_2026_10_31_study'`);
  assert.equal(row.outputPriceMicrosPerM, 999_999, "nothing was overwritten");
});

test("the sync cannot approve, activate, name a reviewer, or carry a credential", () => {
  const base = () => buildDesiredNativeRegistry();
  const mutate = (change) => { const desired = base(); change(desired); return desired; };
  assert.throws(() => planRegistrySync(mutate((d) => { d[1].endpoints[0].privacyReview.privacyApproved = true; })), (e) => e.code === "approval_not_allowed");
  assert.throws(() => planRegistrySync(mutate((d) => { d[1].endpoints[0].endpointState = "active"; })), (e) => e.code === "not_pending");
  assert.throws(() => planRegistrySync(mutate((d) => { d[1].version.lifecycleState = "active"; })), (e) => e.code === "not_pending");
  assert.throws(() => planRegistrySync(mutate((d) => { d[1].endpoints[0].privacyReview.reviewedBy = "someone"; })), (e) => e.code === "reviewer_not_allowed");
  assert.throws(() => planRegistrySync(mutate((d) => { d[1].endpoints[0].privacyReview.auditRef = "ref-1"; })), (e) => e.code === "reviewer_not_allowed");
  for (const secret of ["sk-" + "a".repeat(30), "Bearer " + "b".repeat(30), "https://user:pass@host.example/v1", "https://x.example/v1?api_key=abc", "AIza" + "c".repeat(30)]) {
    assert.throws(() => assertNoSecrets({ endpointUrl: secret }), (e) => e.code === "credential_detected", secret.slice(0, 12));
  }
  assert.doesNotThrow(() => assertNoSecrets(base()));
  assert.doesNotThrow(() => assertDesiredIsPending(base()));
});

test("the shipped evidence contains no credentials and no provider names beyond internal registry fields", async () => {
  const text = JSON.stringify(buildDesiredNativeRegistry());
  assert.doesNotThrow(() => assertNoSecrets(JSON.parse(text)));
  const source = await readFile(new URL("../scripts/registry-sync.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /console\.(log|error)\([^)]*DATABASE_URL/, "the database URL is never printed");
  assert.match(source, /--confirm=write-pending-records/, "writing needs an explicit confirmation");
});
