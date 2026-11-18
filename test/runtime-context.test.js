import test from "node:test";
import assert from "node:assert/strict";
import {
  buildUserIdentityProfile,
  buildTemporalSpatialLocalization,
  buildSubscriptionStateContext,
  buildPlatformKnowledgeGraph,
  shouldTriggerPeriodicMemoryUpdate,
  assembleStandardizedPlatformPayload,
} from "../src/chat/runtime-context.js";

test("Runtime Context: User Identity Profile with privacy-safe anonymized ID", () => {
  const profile = buildUserIdentityProfile({
    user: { id: "user_12345678-abcd-ef01-2345-6789abcdef01", name: "Alice Wonderland", email: "alice@example.com" },
    userProfile: { displayName: "Alice", handle: "alice_w", responseStyle: "concise", customInstructions: "Prefer TypeScript." },
    userId: "user_12345678-abcd-ef01-2345-6789abcdef01",
  });

  assert.equal(profile.accountName, "Alice");
  assert.equal(profile.handle, "alice_w");
  assert.ok(profile.anonymizedId.startsWith("anon_"));
  // Raw database ID must NOT be present in anonymized identifier
  assert.equal(profile.anonymizedId.includes("user_12345678"), false);
  assert.equal(profile.preferences.responseStyle, "concise");
  assert.equal(profile.preferences.customInstructions, "Prefer TypeScript.");
});

test("Runtime Context: Temporal & Spatial Localization metrics", () => {
  const fixedDate = new Date("2026-11-01T15:30:00Z");
  const mockReq = {
    headers: {
      "x-timezone": "America/New_York",
      "x-timezone-offset": "-300", // UTC-5
      "x-geo-country": "US",
      "x-geo-region": "NY",
      "x-geo-city": "New York",
    },
  };

  const loc = buildTemporalSpatialLocalization({ req: mockReq, now: fixedDate });
  assert.equal(loc.exactLocalDate, "2026-11-01");
  assert.equal(loc.timezone, "America/New_York");
  assert.equal(loc.activeTimezoneOffset, "UTC-05:00");
  assert.equal(loc.geographicMarkers.country, "US");
  assert.equal(loc.geographicMarkers.region, "NY");
  assert.equal(loc.geographicMarkers.city, "New York");
});

test("Runtime Context: Subscription State & Capability Scopes", () => {
  const freeScope = buildSubscriptionStateContext({ tier: "free", creditsActive: false });
  assert.equal(freeScope.billingTier, "free");
  assert.equal(freeScope.mtabDollars, 0.25);
  assert.ok(freeScope.capabilityScope.includes("Includes Lumen and Study"), "Nova was retired on 2026-11-14");
  assert.ok(freeScope.capabilityScope.includes("2 image generations per week"));
  assert.ok(freeScope.capabilityScope.includes("15 prompts/24h"));
  assert.ok(!freeScope.capabilityScope.includes("Image Mode is disabled"));

  const plusScope = buildSubscriptionStateContext({ tier: "plus", creditsActive: false });
  assert.equal(plusScope.billingTier, "plus");
  assert.equal(plusScope.mtabDollars, 3.00);
  assert.equal(plusScope.maxAllowedMu, 7.00);
  assert.ok(plusScope.capabilityScope.includes("mu <= 7.00"));
  assert.ok(plusScope.capabilityScope.includes("100 images/month"));
  assert.ok(plusScope.capabilityScope.includes("40 high-compute prompts"));

  const proScope = buildSubscriptionStateContext({ tier: "pro", creditsActive: false });
  assert.equal(proScope.billingTier, "pro");
  assert.equal(proScope.mtabDollars, 9.00);
  assert.ok(proScope.capabilityScope.includes("400 images/month"));
  assert.ok(proScope.capabilityScope.includes("120 high-compute prompts"));

  const maxScope = buildSubscriptionStateContext({ tier: "max", creditsActive: false });
  assert.equal(maxScope.billingTier, "max");
  assert.equal(maxScope.mtabDollars, 40.00);
  assert.ok(maxScope.capabilityScope.includes("1,500 images/month"));
  assert.ok(maxScope.capabilityScope.includes("400 Extra-High prompts"));
});

test("Runtime Context: Subscription State & Capability Scopes with active AI credits", () => {
  const freeScope = buildSubscriptionStateContext({ tier: "free", creditsActive: true });
  assert.ok(freeScope.capabilityScope.includes("Includes Lumen and Study"), "Nova was retired on 2026-11-14");
  assert.ok(freeScope.capabilityScope.includes("2 image generations per week"));
  assert.ok(freeScope.capabilityScope.includes("AI-credit policy"));
  assert.ok(!freeScope.capabilityScope.includes("Green Dot"));
  assert.ok(!freeScope.capabilityScope.includes("15 prompts"));
  assert.ok(!freeScope.capabilityScope.includes("Image Mode is disabled"));

  const plusScope = buildSubscriptionStateContext({ tier: "plus", creditsActive: true });
  assert.ok(plusScope.capabilityScope.includes("AI credits"));
  assert.ok(plusScope.capabilityScope.includes("100 images/month"));
  assert.ok(!plusScope.capabilityScope.includes("Red Dot"));
  assert.ok(!plusScope.capabilityScope.includes("40 high-compute prompts"));

  const proScope = buildSubscriptionStateContext({ tier: "pro", creditsActive: true });
  assert.ok(proScope.capabilityScope.includes("AI credits"));
  assert.ok(proScope.capabilityScope.includes("400 images/month"));
  assert.ok(!proScope.capabilityScope.includes("Red Dot"));
  assert.ok(!proScope.capabilityScope.includes("120 high-compute prompts"));

  const maxScope = buildSubscriptionStateContext({ tier: "max", creditsActive: true });
  assert.ok(maxScope.capabilityScope.includes("AI credits"));
  assert.ok(maxScope.capabilityScope.includes("1,500 images/month"));
  assert.ok(!maxScope.capabilityScope.includes("400 Extra-High prompts"));
});

test("Runtime Context: Periodic memory update triggers on milestones and session boundaries", () => {
  // Should NOT trigger on routine arbitrary turn 1 or turn 3
  assert.equal(
    shouldTriggerPeriodicMemoryUpdate({ turnCount: 1, userMessage: "Hello assistant." }),
    false
  );
  assert.equal(
    shouldTriggerPeriodicMemoryUpdate({ turnCount: 3, userMessage: "What is quantum computing?" }),
    false
  );

  // Milestone: Every 5 turns
  assert.equal(
    shouldTriggerPeriodicMemoryUpdate({ turnCount: 5, userMessage: "Okay got it." }),
    true
  );
  assert.equal(
    shouldTriggerPeriodicMemoryUpdate({ turnCount: 10, userMessage: "Thanks." }),
    true
  );

  // Milestone: High contextual density (>800 characters)
  const longPrompt = "a".repeat(850);
  assert.equal(
    shouldTriggerPeriodicMemoryUpdate({ turnCount: 2, userMessage: longPrompt }),
    true
  );

  // Explicit memory request
  assert.equal(
    shouldTriggerPeriodicMemoryUpdate({ turnCount: 2, userMessage: "Please remember that I prefer dark mode." }),
    true
  );

  // Session boundary
  assert.equal(
    shouldTriggerPeriodicMemoryUpdate({ turnCount: 2, userMessage: "Bye", isSessionBoundary: true }),
    true
  );
});

test("Runtime Context: Standardized Platform Runtime Payload assembly", () => {
  const payload = assembleStandardizedPlatformPayload({
    user: { id: "test-user-id", name: "David" },
    userProfile: { displayName: "David", handle: "david_dev", responseStyle: "detailed" },
    userId: "test-user-id",
    tier: "plus",
    req: { headers: { "x-timezone": "UTC" } },
    now: new Date("2026-11-01T20:00:00Z"),
    facts: [{ content: "User works as a software architect." }],
    memoryEnabled: true,
  });

  assert.ok(payload.includes("<PlatformRuntimePayload>"));
  assert.ok(payload.includes("Account Name: David"));
  assert.ok(payload.includes("@david_dev"));
  assert.ok(payload.includes("Active Billing Tier: PLUS"));
  assert.ok(payload.includes("Monthly Token Allowance Budget (MTAB): $3.00"));
  assert.ok(payload.includes("User works as a software architect."));
  assert.ok(payload.includes("VibhavGPT Baseline Architecture & Ecosystem Grounding"));
  assert.ok(payload.includes("</PlatformRuntimePayload>"));
});


test("each plan's scope names exactly the models that plan includes, and never a retired one", async () => {
  const { buildSubscriptionStateContext, planModelsSentence } = await import("../src/chat/runtime-context.js");
  assert.equal(planModelsSentence("free"), "Models on this plan: Lumen. Also included: Study.");
  assert.equal(planModelsSentence("plus"), "Models on this plan: Lumen, GLM 5.3, GLM 5.3 Flash, GPT-6 Luna, Gemini 4 Hydrogen. Also included: Study.");
  assert.equal(planModelsSentence("pro"), "Models on this plan: Lumen, Vulcan, GLM 5.3, GLM 5.3 Flash, GPT-6 Luna, GPT-6.1 Terra, Gemini 4 Hydrogen, Gemini 4 Argon. Also included: Study and Build (VibhavGPT Tecton).");
  assert.equal(planModelsSentence("max"), "Models on this plan: Lumen, Vulcan, Zenith, GLM 5.3, GLM 5.3 Flash, GPT-6 Luna, GPT-6.1 Terra, GPT-6.2 Sol, GPT-6.2 Astra, Gemini 4 Hydrogen, Gemini 4 Argon, Gemini 4 Carbon. Also included: Study and Build (VibhavGPT Tecton).");
  for (const tier of ["free", "plus", "pro", "max"]) {
    for (const creditsActive of [true, false]) {
      const scope = buildSubscriptionStateContext({ tier, creditsActive }).capabilityScope;
      assert.doesNotMatch(scope, /\b(Nova|Nebula|GPT-6 Sol)\b/, `${tier}: no retired model`);
      assert.ok(scope.endsWith(planModelsSentence(tier)), `${tier}: names its models`);
    }
  }
});
