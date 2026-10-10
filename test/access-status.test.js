import assert from "node:assert/strict";
import test from "node:test";
import { accessError, accessStatus, accessPayload } from "../frontend/src/access-status.js";
import { responseError } from "../frontend/src/api.js";

test("all access reasons produce distinct truthful messages and actions", () => {
  for (const [reason, action] of Object.entries({ plan: "plans", quota: "usage", credits: "credits", service: "retry", network: "retry", permission: "permission", "entitlement-sync": "restore", storage: "storage", restricted: "support" })) {
    const status = accessStatus({ reason, feature: "Live Comet" });
    assert.equal(status.action, action);
    if (reason !== "service") assert.doesNotMatch(status.message, /temporarily unavailable/);
    if (reason !== "credits") assert.doesNotMatch(status.message, /Flex Credits/);
  }
  assert.equal(accessStatus({ status: 429, message: "ambiguous" }), null);
  assert.equal(accessStatus({ name: "NotAllowedError" }).reason, "permission");
});

test("Free and Plus restrictions preserve required plan, while valid Pro is not falsely restricted", () => {
  for (const requiredPlan of ["Plus or Pro", "Pro"]) {
    const error = accessError("plan", { feature: "Paid feature", requiredPlan });
    assert.equal(error.status, 403);
    assert.equal(responseError(accessPayload(error), 403).access.requiredPlan, requiredPlan);
  }
  assert.equal(accessStatus({ tier: "pro" }), null);
  assert.equal(accessStatus({ tier: "free" }), null); // Tier alone cannot establish why a request failed.
});

test("quota reset, feature detail, and credits survive JSON and SSE payloads", () => {
  const error = accessError("quota", { feature: "Live Comet", resetAt: "2026-10-01T00:00:00Z", publicMessage: "You've used your Live Comet allowance for this month." });
  const restored = responseError(JSON.parse(JSON.stringify(accessPayload(error))), 429);
  assert.equal(restored.message, error.message);
  assert.equal(restored.access.resetAt, "2026-10-01T00:00:00.000Z");
  assert.equal(restored.access.action, "usage");
  assert.equal(responseError(accessPayload(accessError("credits")), 402).access.reason, "credits");
});

test("stale entitlement is a restore action, never an upgrade or service outage", () => {
  const error = responseError({ code: "entitlement-sync", reason: "entitlement-sync" }, 503);
  assert.equal(error.access.action, "restore");
  assert.doesNotMatch(error.message, /current plan|temporarily unavailable/);
});

test("rolling limit timing and pending holds survive the API and SSE access payload", () => {
  const error = accessError("quota", { feature: "Vesper", window: "rolling", pending: 34894, used: 51576, limit: 80000, requestTooLarge: true, resetAt: "2026-10-04T22:00:00Z" });
  const { access } = responseError(JSON.parse(JSON.stringify(accessPayload(error))), 429);
  assert.equal(access.window, "rolling");
  assert.equal(access.pending, 34894);
  assert.equal(access.requestTooLarge, true);
  assert.equal(access.resetAt, "2026-10-04T22:00:00.000Z");
  assert.equal(access.used, 51576);
  assert.equal(access.limit, 80000);
  assert.equal(access.percentage, 64);
});
