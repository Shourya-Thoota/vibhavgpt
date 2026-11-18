import { and, eq } from "drizzle-orm";
import {
  modelEndpoints,
  modelFamilies,
  modelPricingSnapshots,
  modelVersions,
} from "../db/schema.js";
import { calculateConsumptionScore } from "./consumption.js";

/**
 * Idempotent registry import/update with a dry-run diff.
 *
 * What it can and cannot do:
 * - It only ever writes PENDING records: candidate versions, candidate or disabled
 *   endpoints, privacy reviews with privacyApproved false. Any desired record that is
 *   not pending is rejected, so this tool cannot approve or activate anything.
 * - On an existing row it updates evidence and descriptive fields only. It never
 *   rewrites an endpoint's privacy review or state, or a version's lifecycle state, so
 *   an approval recorded by the owner survives every later run.
 * - A pricing snapshot is immutable once recorded. A changed price needs a new
 *   pricingVersionId; a difference on an existing id is reported as a conflict and the
 *   apply is refused.
 * - It never reads or stores credentials: desired data is scanned and rejected if it
 *   looks like one.
 */

export class RegistrySyncError extends Error {
  constructor(message, code = "registry_sync_error", details = {}) {
    super(message);
    this.name = "RegistrySyncError";
    this.code = code;
    this.details = details;
  }
}

const SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /:\/\/[^/\s:@]+:[^/\s@]+@/,
  /[?&](?:key|token|secret|password|api_key)=/i,
];

export function assertNoSecrets(value) {
  const text = JSON.stringify(value);
  for (const shape of SECRET_SHAPES) {
    if (shape.test(text)) throw new RegistrySyncError("Desired registry data looks like it contains a credential.", "credential_detected");
  }
}

export function assertDesiredIsPending(desired) {
  for (const item of desired) {
    if (item.version.lifecycleState !== "candidate") {
      throw new RegistrySyncError(`${item.family.slug}: versions are only ever written as candidate.`, "not_pending", { slug: item.family.slug });
    }
    for (const endpoint of item.endpoints) {
      const where = `${item.family.slug} ${endpoint.providerName}/${endpoint.transportType}`;
      if (endpoint.privacyReview?.privacyApproved !== false || endpoint.privacyReview?.revoked) {
        throw new RegistrySyncError(`${where}: a privacy approval cannot be written by the sync.`, "approval_not_allowed", { where });
      }
      if (!["candidate", "disabled"].includes(endpoint.endpointState)) {
        throw new RegistrySyncError(`${where}: endpoints are only ever written as candidate or disabled.`, "not_pending", { where });
      }
      if (endpoint.privacyReview.reviewedBy || endpoint.privacyReview.auditRef) {
        throw new RegistrySyncError(`${where}: reviewer identities and audit references come only from the owner's evidence.`, "reviewer_not_allowed", { where });
      }
    }
  }
}

// jsonb does not preserve key order, so values are compared canonically.
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  // JSON drops undefined-valued keys, so they are not part of the value.
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => [key, canonical(value[key])]));
  return value ?? null;
};
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const diff = (current, wanted, fields) => {
  const changes = {};
  for (const field of fields) if (!same(current?.[field], wanted?.[field])) changes[field] = { from: current?.[field] ?? null, to: wanted?.[field] ?? null };
  return changes;
};
const OWNED_METADATA_KEYS = ["evidence", "pricingEvidence", "ownerEvidenceRequired", "approvalStatus", "transportIsolation"];
const ownedMetadata = (metadata) => Object.fromEntries(OWNED_METADATA_KEYS.filter((key) => metadata?.[key] !== undefined).map((key) => [key, metadata[key]]));

const PRICE_FIELDS = ["currency", "billingUnit", "inputPriceMicrosPerM", "outputPriceMicrosPerM", "cachedReadPriceMicrosPerM", "reasoningIncludedInOutput", "pricingConfidence", "provenance"];

export async function readCurrentRegistry(executor) {
  const [families, versions, endpoints, pricing] = await Promise.all([
    executor.select().from(modelFamilies),
    executor.select().from(modelVersions),
    executor.select().from(modelEndpoints),
    executor.select().from(modelPricingSnapshots),
  ]);
  return { families, versions, endpoints, pricing };
}

/**
 * Pure: the exact set of changes needed to reach the desired state.
 */
export function planRegistrySync(desired, current = { families: [], versions: [], endpoints: [], pricing: [] }) {
  assertNoSecrets(desired);
  assertDesiredIsPending(desired);
  const operations = [];
  const conflicts = [];
  const preserved = [];

  for (const item of desired) {
    const familyRow = current.families.find((row) => row.slug === item.family.slug);
    const familyChanges = diff(familyRow, item.family, ["displayName", "familyGroup", "description", "sortOrder"]);
    operations.push({ op: !familyRow ? "create" : Object.keys(familyChanges).length ? "update" : "noop", kind: "family", key: item.family.slug, changes: familyRow ? familyChanges : item.family });

    const versionRow = familyRow ? current.versions.find((row) => row.familyId === familyRow.id && row.versionTag === item.version.versionTag) : null;
    const wantedMetadata = ownedMetadata(item.version.metadata);
    const versionChanges = versionRow
      ? { ...diff(versionRow, item.version, ["aliases", "capabilitiesDocumented", "planEligibility"]), ...(same(ownedMetadata(versionRow.metadata), wantedMetadata) ? {} : { metadata: { from: "evidence (previous)", to: "evidence (updated)" } }) }
      : null;
    const versionKey = `${item.family.slug}@${item.version.versionTag}`;
    operations.push({ op: !versionRow ? "create" : Object.keys(versionChanges).length ? "update" : "noop", kind: "version", key: versionKey, changes: versionRow ? versionChanges : { lifecycleState: "candidate", planEligibility: item.version.planEligibility } });
    if (versionRow && versionRow.lifecycleState !== "candidate") preserved.push({ kind: "version", key: versionKey, kept: `lifecycleState=${versionRow.lifecycleState}` });

    for (const endpoint of item.endpoints) {
      const endpointRow = versionRow
        ? current.endpoints.find((row) => row.versionId === versionRow.id && row.providerName === endpoint.providerName && row.transportType === endpoint.transportType)
        : null;
      const endpointKey = `${versionKey}#${endpoint.providerName}/${endpoint.transportType}`;
      const endpointChanges = endpointRow ? diff(endpointRow, endpoint, ["adapterType", "endpointUrl", "capabilitiesVerified", "sortPriority"]) : null;
      operations.push({ op: !endpointRow ? "create" : Object.keys(endpointChanges).length ? "update" : "noop", kind: "endpoint", key: endpointKey, changes: endpointRow ? endpointChanges : { endpointState: endpoint.endpointState, privacyApproved: false, endpointUrl: endpoint.endpointUrl } });
      if (endpointRow && (endpointRow.privacyReview?.privacyApproved === true || endpointRow.endpointState !== endpoint.endpointState)) {
        preserved.push({ kind: "endpoint", key: endpointKey, kept: `endpointState=${endpointRow.endpointState}, privacyApproved=${Boolean(endpointRow.privacyReview?.privacyApproved)}` });
      }

      for (const snapshot of endpoint.pricingSnapshots ?? []) {
        const priceRow = endpointRow ? current.pricing.find((row) => row.endpointId === endpointRow.id && row.pricingVersionId === snapshot.pricingVersionId) : null;
        const priceKey = `${endpointKey}$${snapshot.pricingVersionId}`;
        if (!priceRow) {
          operations.push({ op: "create", kind: "pricing", key: priceKey, changes: { inputPriceMicrosPerM: snapshot.inputPriceMicrosPerM, outputPriceMicrosPerM: snapshot.outputPriceMicrosPerM, cachedReadPriceMicrosPerM: snapshot.cachedReadPriceMicrosPerM, pricingConfidence: snapshot.pricingConfidence } });
          continue;
        }
        const priceChanges = diff(priceRow, snapshot, PRICE_FIELDS);
        if (Object.keys(priceChanges).length) {
          conflicts.push({ kind: "pricing", key: priceKey, reason: "A recorded price is immutable. Use a new pricingVersionId to change it.", changes: priceChanges });
          operations.push({ op: "conflict", kind: "pricing", key: priceKey, changes: priceChanges });
        } else {
          operations.push({ op: "noop", kind: "pricing", key: priceKey, changes: {} });
        }
      }
    }
  }

  const count = (op) => operations.filter((operation) => operation.op === op).length;
  return {
    operations,
    conflicts,
    preserved,
    summary: { create: count("create"), update: count("update"), noop: count("noop"), conflict: count("conflict") },
  };
}

export function formatRegistryPlan(plan) {
  const lines = [`Registry sync plan: ${plan.summary.create} create, ${plan.summary.update} update, ${plan.summary.noop} unchanged, ${plan.summary.conflict} conflict`];
  for (const operation of plan.operations.filter((op) => op.op !== "noop")) {
    lines.push(`  ${operation.op.toUpperCase().padEnd(8)} ${operation.kind.padEnd(8)} ${operation.key}`);
    for (const [field, change] of Object.entries(operation.changes ?? {})) {
      const rendered = change && typeof change === "object" && "to" in change ? `${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}` : JSON.stringify(change);
      lines.push(`             ${field}: ${rendered.length > 140 ? `${rendered.slice(0, 137)}...` : rendered}`);
    }
  }
  for (const kept of plan.preserved) lines.push(`  KEPT     ${kept.kind.padEnd(8)} ${kept.key} (${kept.kept}; not touched by the sync)`);
  if (plan.conflicts.length) lines.push("  Apply is refused while conflicts exist.");
  return lines.join("\n");
}

/**
 * Applies a plan in one transaction. Refuses on conflicts. Re-plans against the rows it
 * reads inside the transaction, so a concurrent change cannot make it write stale data.
 */
export async function applyRegistrySync(desired, executor) {
  return executor.transaction(async (tx) => {
    const current = await readCurrentRegistry(tx);
    const plan = planRegistrySync(desired, current);
    if (plan.conflicts.length) throw new RegistrySyncError("Registry sync refused: conflicts exist.", "conflicts", { conflicts: plan.conflicts });

    for (const item of desired) {
      let [family] = await tx.select().from(modelFamilies).where(eq(modelFamilies.slug, item.family.slug));
      if (!family) {
        [family] = await tx.insert(modelFamilies).values({ ...item.family }).returning();
      } else {
        await tx.update(modelFamilies).set({ displayName: item.family.displayName, familyGroup: item.family.familyGroup, description: item.family.description, sortOrder: item.family.sortOrder, updatedAt: new Date() }).where(eq(modelFamilies.id, family.id));
      }

      let [version] = await tx.select().from(modelVersions).where(and(eq(modelVersions.familyId, family.id), eq(modelVersions.versionTag, item.version.versionTag)));
      const wantedMetadata = ownedMetadata(item.version.metadata);
      if (!version) {
        [version] = await tx.insert(modelVersions).values({
          familyId: family.id, versionTag: item.version.versionTag, aliases: item.version.aliases, capabilitiesDocumented: item.version.capabilitiesDocumented,
          planEligibility: item.version.planEligibility, lifecycleState: "candidate", metadata: wantedMetadata,
        }).returning();
      } else {
        // Keep everything the sync does not own (for example the lifecycle audit trail).
        await tx.update(modelVersions).set({
          aliases: item.version.aliases, capabilitiesDocumented: item.version.capabilitiesDocumented, planEligibility: item.version.planEligibility,
          metadata: { ...(version.metadata ?? {}), ...wantedMetadata }, updatedAt: new Date(),
        }).where(eq(modelVersions.id, version.id));
      }

      for (const endpoint of item.endpoints) {
        let [row] = await tx.select().from(modelEndpoints).where(and(eq(modelEndpoints.versionId, version.id), eq(modelEndpoints.providerName, endpoint.providerName), eq(modelEndpoints.transportType, endpoint.transportType)));
        if (!row) {
          [row] = await tx.insert(modelEndpoints).values({
            versionId: version.id, providerName: endpoint.providerName, transportType: endpoint.transportType, adapterType: endpoint.adapterType,
            endpointUrl: endpoint.endpointUrl, capabilitiesVerified: endpoint.capabilitiesVerified, privacyReview: endpoint.privacyReview,
            endpointState: endpoint.endpointState, sortPriority: endpoint.sortPriority,
          }).returning();
        } else {
          // privacyReview and endpointState are deliberately not in this update.
          await tx.update(modelEndpoints).set({ adapterType: endpoint.adapterType, endpointUrl: endpoint.endpointUrl, capabilitiesVerified: endpoint.capabilitiesVerified, sortPriority: endpoint.sortPriority, updatedAt: new Date() }).where(eq(modelEndpoints.id, row.id));
        }

        for (const snapshot of endpoint.pricingSnapshots ?? []) {
          const [existing] = await tx.select().from(modelPricingSnapshots).where(and(eq(modelPricingSnapshots.endpointId, row.id), eq(modelPricingSnapshots.pricingVersionId, snapshot.pricingVersionId)));
          if (existing) continue;
          const { calculatedMu, consumptionCategory } = calculateConsumptionScore(snapshot.inputPriceMicrosPerM, snapshot.outputPriceMicrosPerM);
          await tx.insert(modelPricingSnapshots).values({
            endpointId: row.id, pricingVersionId: snapshot.pricingVersionId, effectiveFrom: new Date(snapshot.effectiveFrom), currency: snapshot.currency,
            billingUnit: snapshot.billingUnit, inputPriceMicrosPerM: snapshot.inputPriceMicrosPerM, outputPriceMicrosPerM: snapshot.outputPriceMicrosPerM,
            cachedReadPriceMicrosPerM: snapshot.cachedReadPriceMicrosPerM, reasoningIncludedInOutput: snapshot.reasoningIncludedInOutput,
            calculatedMu, consumptionCategory, pricingConfidence: snapshot.pricingConfidence, provenance: snapshot.provenance,
          });
        }
      }
    }
    return plan;
  });
}
