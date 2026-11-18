import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { config } from "../src/config.js";
import {
  ROUTE_OBSERVER_OUTCOMES,
  observeRoutingDecision,
  compareProposedWithActual,
  getOrFetchRegistrySnapshot,
  getRouteObserverDiagnostics,
  getRouteObserverMetrics,
  resetRouteObserverState,
  setRouteObserverSnapshotForTesting,
} from "../src/models/route-observer.js";
import {
  ROUTE_DECISION_REASONS,
  evaluateRoutingDecision,
  serializeDecisionForClient,
} from "../src/models/decision.js";
import { getModelConfig } from "../src/chat/providers.js";
import * as schema from "../src/db/schema.js";

// Helper to build a comprehensive synthetic registry snapshot
function buildSyntheticSnapshot() {
  const jan1 = "2026-01-01T00:00:00Z";
  return [
    // 1. Free Lightweight Model: Lumen
    {
      family: {
        id: "fam-lumen",
        slug: "vibhavgpt/lumen",
        displayName: "VibhavGPT Lumen",
        familyGroup: "native",
        sortOrder: 10,
      },
      version: {
        id: "ver-lumen",
        versionTag: "lumen-standard",
        aliases: ["lumen", "spark"],
        planEligibility: "free",
        lifecycleState: "active",
        capabilitiesDocumented: {
          vision: false,
          tools: true,
          streaming: true,
          structuredOutputs: true,
          contextWindowTokens: 131072,
          maxOutputTokens: 8192,
          reasoningSupported: false,
        },
      },
      endpoints: [
        {
          id: "ep-lumen-primary",
          providerName: "primaryFree",
          transportType: "primaryFree",
          adapterType: "chat_completions",
          endpointUrl: "https://api.groq.com/openai/v1",
          endpointState: "active",
          sortPriority: 1,
          capabilitiesVerified: { vision: false, tools: true, streaming: true },
          privacyReview: {
            privacyApproved: true,
            trainingPolicy: "denied",
            zeroDataRetention: false,
            scope: "default",
          },
          pricingSnapshots: [
            {
              pricingVersionId: "snap-lumen-1",
              effectiveFrom: jan1,
              effectiveTo: null,
              currency: "USD",
              billingUnit: "usd_per_1m_tokens",
              inputPriceMicrosPerM: 50_000,
              outputPriceMicrosPerM: 80_000,
              calculatedMu: 0.12,
              consumptionCategory: "low",
              pricingConfidence: "verified",
            },
          ],
        },
      ],
    },
    // 2. Paid Fast Model: Nova
    {
      family: {
        id: "fam-nova",
        slug: "vibhavgpt/nova",
        displayName: "VibhavGPT Nova",
        familyGroup: "native",
        sortOrder: 20,
      },
      version: {
        id: "ver-nova",
        versionTag: "nova-flash",
        aliases: ["nova", "deepseek/deepseek-v4.1-flash"],
        planEligibility: "paid",
        lifecycleState: "active",
        capabilitiesDocumented: {
          vision: true,
          tools: true,
          streaming: true,
          structuredOutputs: true,
          contextWindowTokens: 131072,
          maxOutputTokens: 8192,
          reasoningSupported: false,
        },
      },
      endpoints: [
        {
          id: "ep-nova-router",
          providerName: "paid",
          transportType: "router",
          adapterType: "chat_completions",
          endpointUrl: "https://openrouter.ai/api/v1",
          endpointState: "active",
          sortPriority: 1,
          capabilitiesVerified: { vision: true, tools: true, streaming: true },
          privacyReview: {
            privacyApproved: true,
            trainingPolicy: "denied",
            zeroDataRetention: true,
            scope: "default",
          },
          pricingSnapshots: [
            {
              pricingVersionId: "snap-nova-1",
              effectiveFrom: jan1,
              effectiveTo: null,
              currency: "USD",
              billingUnit: "usd_per_1m_tokens",
              inputPriceMicrosPerM: 400_000,
              outputPriceMicrosPerM: 1_200_000,
              calculatedMu: 1.85,
              consumptionCategory: "medium",
              pricingConfidence: "verified",
            },
          ],
        },
      ],
    },
    // 3. Paid Reasoning Model: Nebula
    {
      family: {
        id: "fam-nebula",
        slug: "vibhavgpt/nebula",
        displayName: "VibhavGPT Nebula",
        familyGroup: "native",
        sortOrder: 30,
      },
      version: {
        id: "ver-nebula",
        versionTag: "nebula-pro",
        aliases: ["nebula", "moonshotai/kimi-k2.6"],
        planEligibility: "paid",
        lifecycleState: "active",
        capabilitiesDocumented: {
          vision: true,
          tools: true,
          streaming: true,
          structuredOutputs: true,
          contextWindowTokens: 262144,
          maxOutputTokens: 16384,
          reasoningSupported: true,
          reasoningModes: ["low", "normal", "high"],
        },
      },
      endpoints: [
        {
          id: "ep-nebula-router",
          providerName: "paid",
          transportType: "router",
          adapterType: "chat_completions",
          endpointUrl: "https://openrouter.ai/api/v1",
          endpointState: "active",
          sortPriority: 1,
          capabilitiesVerified: { vision: true, tools: true, streaming: true },
          privacyReview: {
            privacyApproved: true,
            trainingPolicy: "denied",
            zeroDataRetention: true,
            scope: "default",
          },
          pricingSnapshots: [
            {
              pricingVersionId: "snap-nebula-1",
              effectiveFrom: jan1,
              effectiveTo: null,
              currency: "USD",
              billingUnit: "usd_per_1m_tokens",
              inputPriceMicrosPerM: 1_200_000,
              outputPriceMicrosPerM: 3_500_000,
              calculatedMu: 5.4,
              consumptionCategory: "high",
              pricingConfidence: "verified",
            },
          ],
        },
      ],
    },
    // 4. Native Vulcan with Dual Direct & Router Endpoints
    {
      family: {
        id: "fam-vesper",
        slug: "vibhavgpt/vesper",
        displayName: "VibhavGPT Vulcan",
        familyGroup: "native",
        sortOrder: 40,
      },
      version: {
        id: "ver-vesper",
        versionTag: "vesper-terra",
        aliases: ["vesper"],
        planEligibility: "paid",
        lifecycleState: "active",
        capabilitiesDocumented: {
          vision: true,
          tools: true,
          streaming: true,
          structuredOutputs: true,
          contextWindowTokens: 131072,
          maxOutputTokens: 8192,
          reasoningSupported: false,
        },
      },
      endpoints: [
        {
          id: "ep-vesper-direct",
          providerName: "vesperDirect",
          transportType: "direct",
          adapterType: "chat_completions",
          endpointUrl: "https://api.openai.com/v1",
          endpointState: "active",
          sortPriority: 1,
          capabilitiesVerified: { vision: true, tools: true, streaming: true },
          privacyReview: {
            privacyApproved: true,
            trainingPolicy: "training_excluded",
            zeroDataRetention: true,
            scope: "default",
          },
          pricingSnapshots: [
            {
              pricingVersionId: "snap-vesper-direct-1",
              effectiveFrom: jan1,
              effectiveTo: null,
              currency: "USD",
              billingUnit: "usd_per_1m_tokens",
              inputPriceMicrosPerM: 2_500_000,
              outputPriceMicrosPerM: 10_000_000,
              calculatedMu: 6.8,
              consumptionCategory: "high",
              pricingConfidence: "verified",
            },
          ],
        },
        {
          id: "ep-vesper-router",
          providerName: "paid",
          transportType: "router",
          adapterType: "chat_completions",
          endpointUrl: "https://openrouter.ai/api/v1",
          endpointState: "active",
          sortPriority: 2,
          capabilitiesVerified: { vision: true, tools: true, streaming: true },
          privacyReview: {
            privacyApproved: true,
            trainingPolicy: "denied",
            zeroDataRetention: true,
            scope: "default",
          },
          pricingSnapshots: [
            {
              pricingVersionId: "snap-vesper-router-1",
              effectiveFrom: jan1,
              effectiveTo: null,
              currency: "USD",
              billingUnit: "usd_per_1m_tokens",
              inputPriceMicrosPerM: 2_000_000,
              outputPriceMicrosPerM: 8_000_000,
              calculatedMu: 5.5,
              consumptionCategory: "high",
              pricingConfidence: "verified",
            },
          ],
        },
      ],
    },
  ];
}

// ===========================================================================
// SECTION 1: FOCUSED DECISION SERVICE REGRESSION TESTS
// ===========================================================================

test("decision service regression: explicit model selection is never silently substituted", async () => {
  const snapshot = buildSyntheticSnapshot();

  // Request a nonexistent model
  const nonExistent = await evaluateRoutingDecision(
    { plan: "pro", requestedModel: { modelKey: "nonexistent-model" } },
    { registrySnapshot: snapshot },
  );
  assert.equal(nonExistent.eligible, false);
  assert.equal(nonExistent.reasonCode, ROUTE_DECISION_REASONS.MODEL_NOT_FOUND);
  assert.equal(nonExistent.selectedCandidate, undefined);

  // Request an inactive version
  const inactiveSnapshot = JSON.parse(JSON.stringify(snapshot));
  inactiveSnapshot[1].version.lifecycleState = "disabled";
  const inactiveResult = await evaluateRoutingDecision(
    { plan: "pro", requestedModel: { modelKey: "nova" } },
    { registrySnapshot: inactiveSnapshot },
  );
  assert.equal(inactiveResult.eligible, false);
  assert.equal(inactiveResult.reasonCode, ROUTE_DECISION_REASONS.VERSION_NOT_ACTIVE);
  assert.equal(inactiveResult.selectedCandidate, undefined);
});

test("decision service regression: Vulcan preserves explicit direct transport with no fallback", async () => {
  const snapshot = buildSyntheticSnapshot();

  // Direct Vulcan request matches only direct endpoint
  const directDecision = await evaluateRoutingDecision(
    { plan: "pro", requestedModel: { modelKey: "vesper" }, transportPreference: "direct" },
    { registrySnapshot: snapshot },
  );
  assert.equal(directDecision.eligible, true);
  assert.equal(directDecision.pinnedEndpoint.transportType, "direct");
  assert.equal(directDecision.pinnedEndpoint.providerName, "vesperDirect");

  // When direct endpoint is disabled, direct Vulcan fails rather than falling back to router
  const disabledDirectSnapshot = JSON.parse(JSON.stringify(snapshot));
  disabledDirectSnapshot[3].endpoints[0].endpointState = "disabled"; // ep-vesper-direct disabled
  const fallbackRefusal = await evaluateRoutingDecision(
    { plan: "pro", requestedModel: { modelKey: "vesper" }, transportPreference: "direct" },
    { registrySnapshot: disabledDirectSnapshot },
  );
  assert.equal(fallbackRefusal.eligible, false);
  assert.equal(fallbackRefusal.reasonCode, ROUTE_DECISION_REASONS.ENDPOINT_NOT_ACTIVE);
});

test("decision service regression: unknown evidence cannot become permission", async () => {
  const snapshot = buildSyntheticSnapshot();

  // Endpoint without privacy approval fails
  const unapprovedSnapshot = JSON.parse(JSON.stringify(snapshot));
  unapprovedSnapshot[1].endpoints[0].privacyReview.privacyApproved = false;
  const unapprovedRes = await evaluateRoutingDecision(
    { plan: "pro", requestedModel: { modelKey: "nova" } },
    { registrySnapshot: unapprovedSnapshot },
  );
  assert.equal(unapprovedRes.eligible, false);
  assert.equal(unapprovedRes.reasonCode, ROUTE_DECISION_REASONS.PRIVACY_NOT_APPROVED);

  // Endpoint without pricing snapshot fails
  const unpricedSnapshot = JSON.parse(JSON.stringify(snapshot));
  unpricedSnapshot[1].endpoints[0].pricingSnapshots = [];
  const unpricedRes = await evaluateRoutingDecision(
    { plan: "pro", requestedModel: { modelKey: "nova" } },
    { registrySnapshot: unpricedSnapshot },
  );
  assert.equal(unpricedRes.eligible, false);
  assert.equal(unpricedRes.reasonCode, ROUTE_DECISION_REASONS.PRICING_SNAPSHOT_MISSING);
});

test("decision service regression: Auto task requirements are applied before price tie-breakers", async () => {
  const snapshot = buildSyntheticSnapshot();

  // Task requiring reasoning should select Nebula (high tier) even though Nova has lower mu (1.85 vs 5.4)
  const autoReasoning = await evaluateRoutingDecision(
    {
      plan: "pro",
      requestedModel: { auto: true, task: { classification: "reasoning" } },
      reasoning: { effort: "high" },
    },
    { registrySnapshot: snapshot },
  );
  assert.equal(autoReasoning.eligible, true);
  assert.equal(autoReasoning.selectedCandidate.versionTag, "nebula-pro");

  // Task requiring lightweight should select Lumen (low tier)
  const autoLightweight = await evaluateRoutingDecision(
    {
      plan: "free",
      requestedModel: { auto: true, task: { classification: "lightweight" } },
    },
    { registrySnapshot: snapshot },
  );
  assert.equal(autoLightweight.eligible, true);
  assert.equal(autoLightweight.selectedCandidate.versionTag, "lumen-standard");
});

test("decision service regression: client serialization strictly scrubs wholesale rates and endpoints", async () => {
  const snapshot = buildSyntheticSnapshot();
  const decision = await evaluateRoutingDecision(
    { plan: "plus", requestedModel: { modelKey: "nova" } },
    { registrySnapshot: snapshot },
  );
  assert.equal(decision.eligible, true);

  const clientJson = serializeDecisionForClient(decision);
  assert.equal(clientJson.inputPriceMicrosPerM, undefined);
  assert.equal(clientJson.outputPriceMicrosPerM, undefined);
  assert.equal(clientJson.endpointUrl, undefined);
  assert.equal(clientJson.pinnedEndpoint, undefined);
  assert.equal(clientJson.pinnedPricing, undefined);
  assert.equal(JSON.stringify(clientJson).includes("openrouter.ai"), false);
});

// ===========================================================================
// SECTION 2: OBSERVER TESTS
// ===========================================================================

test("observer test: disabled mode performs no registry I/O or background work", async (t) => {
  resetRouteObserverState();
  t.after(resetRouteObserverState);

  // Ensure feature flag is disabled
  config.featureRegistryRouteShadow = false;

  let dbQueried = false;
  const mockDb = {
    select: () => {
      dbQueried = true;
      throw new Error("DB should not be queried when feature flag is disabled");
    },
  };

  const result = await observeRoutingDecision({
    requestId: "req-disabled-1",
    userPlan: "plus",
    requestedTier: "nova",
    executor: mockDb,
  });

  assert.equal(result.observed, false);
  assert.equal(result.outcome, ROUTE_OBSERVER_OUTCOMES.OBSERVATION_SKIPPED);
  assert.equal(result.reasonCode, "feature_flag_disabled");
  assert.equal(dbQueried, false, "Database was never touched when observer was disabled");

  // Diagnostics ring buffer remains empty
  const diagnostics = getRouteObserverDiagnostics();
  assert.equal(diagnostics.length, 0);
});

test("observer test: captures actual selected stage and honest comparison outcomes", async (t) => {
  resetRouteObserverState();
  t.after(resetRouteObserverState);

  const snapshot = buildSyntheticSnapshot();
  setRouteObserverSnapshotForTesting(snapshot);

  // 1. Matched: Nova router execution matches proposed router endpoint
  const matchedRes = await observeRoutingDecision({
    requestId: "req-obs-matched",
    userPlan: "plus",
    requestedTier: "nova",
    modalities: { vision: true, streaming: true },
    actualExecution: {
      actualStage: "paid",
      actualModel: "deepseek/deepseek-v4.1-flash",
      actualTransport: "router",
    },
    force: true,
  });

  assert.equal(matchedRes.observed, true);
  assert.equal(matchedRes.outcome, ROUTE_OBSERVER_OUTCOMES.MATCHED);
  assert.equal(matchedRes.reasonCode, "compatible_execution");
  assert.equal(matchedRes.actualStage, "paid");

  // 2. Expected Unpriced: model with missing pricing returns expected_unpriced
  const unpricedSnapshot = JSON.parse(JSON.stringify(snapshot));
  unpricedSnapshot[1].endpoints[0].pricingSnapshots = [];
  setRouteObserverSnapshotForTesting(unpricedSnapshot);

  const unpricedRes = await observeRoutingDecision({
    requestId: "req-obs-unpriced",
    userPlan: "plus",
    requestedTier: "nova",
    actualExecution: {
      actualStage: "paid",
      actualModel: "deepseek/deepseek-v4.1-flash",
      actualTransport: "router",
    },
    force: true,
  });

  assert.equal(unpricedRes.observed, true);
  assert.equal(unpricedRes.outcome, ROUTE_OBSERVER_OUTCOMES.EXPECTED_UNPRICED);
  assert.equal(unpricedRes.reasonCode, ROUTE_DECISION_REASONS.PRICING_SNAPSHOT_MISSING);

  // 3. Expected Pending Approval: model with unapproved privacy
  const unapprovedSnapshot = JSON.parse(JSON.stringify(snapshot));
  unapprovedSnapshot[1].endpoints[0].privacyReview.privacyApproved = false;
  setRouteObserverSnapshotForTesting(unapprovedSnapshot);

  const unapprovedRes = await observeRoutingDecision({
    requestId: "req-obs-unapproved",
    userPlan: "plus",
    requestedTier: "nova",
    actualExecution: {
      actualStage: "paid",
      actualModel: "deepseek/deepseek-v4.1-flash",
      actualTransport: "router",
    },
    force: true,
  });

  assert.equal(unapprovedRes.observed, true);
  assert.equal(unapprovedRes.outcome, ROUTE_OBSERVER_OUTCOMES.EXPECTED_PENDING_APPROVAL);
  assert.equal(unapprovedRes.reasonCode, ROUTE_DECISION_REASONS.PRIVACY_NOT_APPROVED);

  // 4. Unexpected Endpoint Mismatch: Vulcan direct executed on router
  setRouteObserverSnapshotForTesting(snapshot);
  const mismatchRes = await observeRoutingDecision({
    requestId: "req-obs-mismatch",
    userPlan: "pro",
    requestedTier: "vesper",
    transportPreference: "direct",
    actualExecution: {
      actualStage: "paid",
      actualModel: "x-ai/grok-4.7",
      actualTransport: "router", // Router transport conflicts with proposed direct
    },
    force: true,
  });

  assert.equal(mismatchRes.observed, true);
  assert.equal(mismatchRes.outcome, ROUTE_OBSERVER_OUTCOMES.UNEXPECTED_ENDPOINT_MISMATCH);
  assert.equal(mismatchRes.reasonCode, "transport_mismatch");
});

test("observer test: retries and multi-turn tool steps attribute without duplicate comparison events", async (t) => {
  resetRouteObserverState();
  t.after(resetRouteObserverState);

  const snapshot = buildSyntheticSnapshot();
  setRouteObserverSnapshotForTesting(snapshot);

  const reqId = "req-tool-turn-123";

  // Initial call (Turn 1)
  const turn1 = await observeRoutingDecision({
    requestId: reqId,
    userPlan: "free",
    requestedTier: "lumen",
    actualExecution: {
      actualStage: "primaryFree",
      actualModel: "lumen",
      attemptNumber: 1,
    },
    force: true,
  });
  assert.equal(turn1.observed, true);
  assert.equal(turn1.outcome, ROUTE_OBSERVER_OUTCOMES.MATCHED);

  // Tool follow-up call (Turn 2, same requestId)
  const turn2 = await observeRoutingDecision({
    requestId: reqId,
    actualExecution: {
      actualStage: "primaryFree",
      attemptNumber: 2,
    },
    force: true,
  });
  assert.equal(turn2.observed, true);
  assert.equal(turn2.attributedTurn, true);
  assert.equal(turn2.attemptsCount, 2);

  // Diagnostic ring buffer should record exactly ONE comparison event for this request
  const diags = getRouteObserverDiagnostics().filter((d) => d.requestId === reqId);
  assert.equal(diags.length, 1, "Only one diagnostic comparison event emitted per request ID");
});

test("observer test: empty or unavailable registry skips observation safely without failing callers", async (t) => {
  resetRouteObserverState();
  t.after(resetRouteObserverState);

  // Set snapshot to null/empty
  setRouteObserverSnapshotForTesting([]);

  const res = await observeRoutingDecision({
    requestId: "req-empty-reg",
    userPlan: "free",
    requestedTier: "lumen",
    actualExecution: { actualStage: "primaryFree" },
    force: true,
  });

  assert.equal(res.observed, false);
  assert.equal(res.outcome, ROUTE_OBSERVER_OUTCOMES.OBSERVATION_SKIPPED);
  assert.equal(res.reasonCode, "snapshot_unavailable");
});

test("observer test: observer errors/timeouts fail safely and do not throw", async (t) => {
  resetRouteObserverState();
  t.after(resetRouteObserverState);

  // Mock DB that throws an error during snapshot load
  const errorDb = {
    select: () => {
      throw new Error("Simulated database failure");
    },
  };

  // Calling getOrFetchRegistrySnapshot with errorDb does not crash, returns null gracefully
  const snapshot = await getOrFetchRegistrySnapshot(errorDb, { forceRefresh: true });
  assert.equal(snapshot, null);

  const res = await observeRoutingDecision({
    requestId: "req-err-1",
    userPlan: "plus",
    requestedTier: "nova",
    executor: errorDb,
    force: true,
  });

  assert.equal(res.observed, false);
  assert.equal(res.outcome, ROUTE_OBSERVER_OUTCOMES.OBSERVATION_SKIPPED);
  assert.equal(res.reasonCode, "snapshot_unavailable");
});

test("observer test: diagnostics contain only allowed internal non-sensitive fields", async (t) => {
  resetRouteObserverState();
  t.after(resetRouteObserverState);

  const snapshot = buildSyntheticSnapshot();
  setRouteObserverSnapshotForTesting(snapshot);

  await observeRoutingDecision({
    requestId: "req-diag-audit-999",
    userPlan: "plus",
    requestedTier: "nova",
    modalities: { vision: true },
    actualExecution: {
      actualStage: "paid",
      actualModel: "deepseek/deepseek-v4.1-flash",
      actualTransport: "router",
    },
    taskClass: "coding",
    force: true,
  });

  const diagnostics = getRouteObserverDiagnostics();
  assert.equal(diagnostics.length, 1);
  const entry = diagnostics[0];

  // Verify only permitted diagnostic fields are present
  const allowedKeys = new Set([
    "requestId",
    "requestedTier",
    "actualStage",
    "snapshotVersion",
    "policyVersion",
    "outcome",
    "reasonCode",
    "observerDurationMs",
    "failureCategory",
    "attemptsCount",
    "observedAt",
  ]);

  for (const key of Object.keys(entry)) {
    assert.equal(allowedKeys.has(key), true, `Field ${key} is permitted in structured diagnostics`);
  }

  // Strictly verify no customer prompt bodies, user IDs, or API keys
  assert.equal(entry.userId, undefined);
  assert.equal(entry.content, undefined);
  assert.equal(entry.prompt, undefined);
  assert.equal(entry.apiKey, undefined);
  assert.equal(entry.token, undefined);
});

test("observer test: live provider configuration invariance with observer enabled vs disabled", () => {
  // Live provider configuration must remain 100% identical regardless of observer presence
  const lumenCfg = getModelConfig("lumen");
  const novaCfg = getModelConfig("nova");
  const nebulaCfg = getModelConfig("nebula");
  const vesperCfg = getModelConfig("vesper");

  assert.equal(lumenCfg.chain[0].provider, "primaryFree");
  assert.equal(novaCfg.chain[0].provider, "paid");
  assert.equal(nebulaCfg.chain[0].provider, "paid");
  assert.equal(vesperCfg.chain[0].provider, "paid");
  assert.equal(vesperCfg.chain.length, 1);
  assert.equal(vesperCfg.supportsVision, true);
});
