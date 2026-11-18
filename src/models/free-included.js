/**
 * Native tiers that every Free account may select and use, within the existing
 * Free token allowance and rate limits (see frontend/src/token-quotas.js and
 * usage/service.js). This is the single source of truth for the "included with
 * Free" exception used by the customer catalog, the routing decision engine and
 * the registry eligibility check.
 *
 * It is keyed on the registry family slug, which every family record carries.
 * Earlier checks looked at `family.architectureKey` / `familyArchitectureKey`
 * (fields nothing ever sets) or at `versionTag === "nova"` (the version tag is
 * the upstream model id, never "nova"), so the exception could not fire and a
 * stored `plan_eligibility = 'paid'` row locked Nova out of Free.
 */
// Two registries describe the same native tiers with different slugs: the
// database-backed inventory uses "vibhavgpt/<tier>", while the built-in seed
// snapshot (the catalog's fallback when the database registry is empty) uses
// the bare tier id. Third-party families are always "<vendor>/<model>", so a
// bare "nova" or "lumen" can only be ours.
// Nova was included with Free until it was retired on 2026-11-14; a retired tier is included in no plan.
export const FREE_INCLUDED_FAMILY_SLUGS = Object.freeze(["vibhavgpt/lumen", "lumen"]);

export function isFreeIncludedFamily(family) {
  const slug = String(family?.slug ?? "").trim().toLowerCase();
  return FREE_INCLUDED_FAMILY_SLUGS.includes(slug);
}
