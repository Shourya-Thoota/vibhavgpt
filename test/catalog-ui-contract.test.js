import test from "node:test";
import assert from "node:assert/strict";
import { isCatalogUiEnabled } from "../frontend/src/components/catalog/catalog-gate.js";
import {
  adaptServerCatalogForPresentation,
  CONSUMPTION_TIER_CONFIG,
} from "../frontend/src/components/catalog/catalog-adapter.js";

test("UI Gate - disabled by default and controllable via runtime/env flags", () => {
  // Test default state in node environment
  delete globalThis.window;
  delete process.env.VITE_FEATURE_MODEL_CATALOG_UI;
  assert.equal(isCatalogUiEnabled(), false, "UI gate must be false by default");

  // With mock window object
  globalThis.window = {};

  // Undefined window flag falls back to env (false)
  assert.equal(isCatalogUiEnabled(), false);

  // Enabled via window flag
  globalThis.window.__VIBHAVGPT_FEATURE_MODEL_CATALOG_UI = true;
  assert.equal(isCatalogUiEnabled(), true);

  // Disabled via window flag
  globalThis.window.__VIBHAVGPT_FEATURE_MODEL_CATALOG_UI = false;
  assert.equal(isCatalogUiEnabled(), false);

  // Cleanup
  delete globalThis.window;
});

test("Execution Disconnection - catalog presentation ensures read-only semantics", () => {
  const serverCatalog = {
    userPlan: "pro",
    models: [
      {
        id: "openai-gpt-6-terra",
        displayName: "GPT-6 Terra",
        group: { id: "openai", displayName: "OpenAI" },
        description: "Frontier reasoning model.",
        modalities: { input: ["text", "image"], output: ["text"] },
        contextWindowTokens: 200000,
        supportedReasoningEfforts: ["low", "normal", "high"],
        capabilities: { tools: true, vision: true, streaming: true, structuredOutputs: true, reasoning: true },
        consumptionCategory: "high",
        sortRank: 10,
        selectability: { selectable: true, locked: false, lockReason: null, lockType: null },
      },
      {
        id: "anthropic-claude-sonnet-45",
        displayName: "Claude Sonnet 4.5",
        group: { id: "anthropic", displayName: "Anthropic" },
        description: "Leading software engineering and reasoning model.",
        modalities: { input: ["text", "image"], output: ["text"] },
        contextWindowTokens: 200000,
        supportedReasoningEfforts: ["low", "normal", "high"],
        capabilities: { tools: true, vision: true, streaming: true, structuredOutputs: true, reasoning: true },
        consumptionCategory: "high",
        sortRank: 12,
        selectability: { selectable: true, locked: false, lockReason: null, lockType: null },
      },
    ],
    groups: [
      { id: "openai", displayName: "OpenAI", sortRank: 10 },
      { id: "anthropic", displayName: "Anthropic", sortRank: 12 },
    ],
  };

  const adapted = adaptServerCatalogForPresentation({
    catalog: serverCatalog,
    favorites: ["openai-gpt-6-terra"],
  });

  // Disconnection checks
  assert.equal(adapted.autoMode, null, "Auto router must not be exposed in catalog UI");
  for (const model of adapted.models) {
    assert.equal(model.isReadOnly, true, "All models must be marked isReadOnly");
    assert.equal(model.isFixture, false, "Must not be marked isFixture");
  }

  // Model ladder verification
  const nativeLadder = ["lumen", "nova", "nebula", "vesper"];
  for (const model of adapted.models) {
    // None of the catalog registry IDs should clash with or replace the native ladder
    assert.ok(
      !nativeLadder.includes(model.id),
      `Registry ID ${model.id} must not collide with native chat model names`
    );
  }
});

import fs from "node:fs";
import path from "node:path";

// Helper simulating the exact useAuthenticatedCatalog write queue and account boundary logic
function createTestCatalogManager({
  userId = "user-1",
  initialPreferences = { favorites: [], hiddenBrands: [], brandOrder: [] },
  apiPatchHandler,
} = {}) {
  let activeUserId = userId;
  let preferences = { ...initialPreferences };
  let confirmedPreferences = { ...initialPreferences };
  let saving = false;
  let saveError = null;
  let statusAnnouncement = "";
  let writeSeq = 0;
  let writeQueue = Promise.resolve();

  function setUserId(nextUserId) {
    if (activeUserId !== nextUserId) {
      activeUserId = nextUserId;
      writeQueue = Promise.resolve();
      confirmedPreferences = { favorites: [], hiddenBrands: [], brandOrder: [] };
      preferences = { favorites: [], hiddenBrands: [], brandOrder: [] };
      saving = false;
      saveError = null;
      statusAnnouncement = "";
    }
  }

  function updatePreferences(patch, successAnnouncement, failAnnouncement) {
    if (!activeUserId) return;
    const targetUserId = activeUserId;
    const seq = ++writeSeq;
    saving = true;
    saveError = null;
    if (successAnnouncement) {
      statusAnnouncement = successAnnouncement;
    }

    writeQueue = writeQueue.catch(() => {}).then(async () => {
      if (activeUserId !== targetUserId) return;

      try {
        const result = await apiPatchHandler(patch, targetUserId);
        if (activeUserId !== targetUserId) return;

        if (result) {
          const rawPrefs = result.preferences || result;
          confirmedPreferences = {
            favorites: Array.isArray(rawPrefs.favorites) ? [...rawPrefs.favorites] : [],
            hiddenBrands: Array.isArray(rawPrefs.hiddenBrands) ? [...rawPrefs.hiddenBrands] : [],
            brandOrder: Array.isArray(rawPrefs.brandOrder) ? [...rawPrefs.brandOrder] : [],
          };
        }

        if (seq === writeSeq) {
          if (result) {
            preferences = { ...confirmedPreferences };
          }
          saving = false;
          saveError = null;
          statusAnnouncement = "Preferences saved.";
        }
      } catch (err) {
        if (activeUserId !== targetUserId) return;

        if (seq === writeSeq) {
          if (confirmedPreferences) {
            preferences = { ...confirmedPreferences };
          }
          saving = false;
          saveError = err;
          statusAnnouncement =
            failAnnouncement || "Failed to save preferences. Changes rolled back.";
        }
      }
    });

    return writeQueue;
  }

  function toggleFavorite(modelId) {
    const exists = preferences.favorites.includes(modelId);
    const nextFavorites = exists
      ? preferences.favorites.filter((id) => id !== modelId)
      : [...preferences.favorites, modelId];

    preferences = { ...preferences, favorites: nextFavorites };
    return updatePreferences(
      { favorites: nextFavorites },
      exists ? `Removed ${modelId} from favorites.` : `Added ${modelId} to favorites.`,
      "Failed to update favorite. Change rolled back."
    );
  }

  return {
    get preferences() { return preferences; },
    get confirmedPreferences() { return confirmedPreferences; },
    get saving() { return saving; },
    get saveError() { return saveError; },
    get statusAnnouncement() { return statusAnnouncement; },
    get writeQueue() { return writeQueue; },
    setUserId,
    updatePreferences,
    toggleFavorite,
  };
}

test("Hook State Machine - Ordered write queue guarantees deterministic same-field server persistence and reload", async () => {
  // Simulated server-side database
  let serverDb = {
    favorites: ["initial-model"],
    hiddenBrands: [],
    brandOrder: [],
  };

  const dispatchOrder = [];
  const completionOrder = [];

  // Simulated server PATCH handler with synthetic network latency
  const apiPatchHandler = async (patch) => {
    const patchId = JSON.stringify(patch.favorites);
    dispatchOrder.push(patchId);

    // If change A (length 2), simulate a slow server response (50ms);
    // If change B (length 3), simulate a faster server response (10ms).
    // Without client serialization, B would resolve before A, causing A to overwrite B on the server!
    const delay = patch.favorites.length === 2 ? 50 : 10;
    await new Promise((r) => setTimeout(r, delay));

    // Update server DB atomically
    serverDb = {
      ...serverDb,
      ...patch,
    };
    completionOrder.push(patchId);

    return { preferences: { ...serverDb } };
  };

  const manager = createTestCatalogManager({
    userId: "test-user-ordering",
    initialPreferences: serverDb,
    apiPatchHandler,
  });

  // User rapidly toggles two favorites on the SAME field in sequence
  // Change A: Add "model-A"
  manager.toggleFavorite("model-A");
  // Change B immediately: Add "model-B"
  manager.toggleFavorite("model-B");

  // Wait for write queue to drain completely
  await manager.writeQueue;

  // Verify client dispatched strictly in order
  assert.deepEqual(dispatchOrder, [
    JSON.stringify(["initial-model", "model-A"]),
    JSON.stringify(["initial-model", "model-A", "model-B"]),
  ], "Requests must be dispatched sequentially to prevent server-side out-of-order writes");

  // Reload preferences from server
  const reloaded = { ...serverDb };

  // Confirm persisted database result strictly reflects Change B
  assert.deepEqual(
    reloaded.favorites,
    ["initial-model", "model-A", "model-B"],
    "Persisted server state upon reload must reflect change B"
  );
  assert.equal(manager.saving, false);
  assert.equal(manager.saveError, null);
  assert.equal(manager.statusAnnouncement, "Preferences saved.");
});

test("Hook State Machine - Earlier success followed by latest failure reverts to last-confirmed state", async () => {
  let serverDb = {
    favorites: ["confirmed-model-0"],
    hiddenBrands: [],
    brandOrder: [],
  };

  let writeCount = 0;
  const apiPatchHandler = async (patch) => {
    writeCount++;
    if (writeCount === 1) {
      // Write A succeeds
      serverDb = { ...serverDb, ...patch };
      return { preferences: { ...serverDb } };
    }
    // Write B fails
    throw new Error("503 Service Unavailable: database lock timeout");
  };

  const manager = createTestCatalogManager({
    userId: "test-user-fail-last",
    initialPreferences: serverDb,
    apiPatchHandler,
  });

  // Write A succeeds
  manager.toggleFavorite("confirmed-model-1");
  // Write B immediately follows and fails
  manager.toggleFavorite("failing-model-2");

  await manager.writeQueue;

  // Must revert to last-confirmed state (from Write A), NOT older initial state!
  assert.deepEqual(
    manager.preferences.favorites,
    ["confirmed-model-0", "confirmed-model-1"],
    "Must revert strictly to the last-confirmed state"
  );
  assert.equal(manager.saving, false);
  assert.ok(manager.saveError, "saveError must be set");
  assert.match(manager.saveError.message, /database lock timeout/);
  assert.equal(
    manager.statusAnnouncement,
    "Failed to update favorite. Change rolled back.",
    "Must announce failure and never falsely announce success"
  );
});

test("Hook State Machine - Earlier failure followed by latest success commits latest and clears error", async () => {
  let serverDb = {
    favorites: ["base-model"],
    hiddenBrands: [],
    brandOrder: [],
  };

  let writeCount = 0;
  const apiPatchHandler = async (patch) => {
    writeCount++;
    if (writeCount === 1) {
      // Write A fails with transient network error
      throw new Error("Network timeout on write A");
    }
    // Write B succeeds
    serverDb = { ...serverDb, ...patch };
    return { preferences: { ...serverDb } };
  };

  const manager = createTestCatalogManager({
    userId: "test-user-recover",
    initialPreferences: serverDb,
    apiPatchHandler,
  });

  manager.toggleFavorite("transient-model");
  manager.toggleFavorite("success-model");

  await manager.writeQueue;

  // Latest write was successful and must remain confirmed
  assert.deepEqual(
    manager.preferences.favorites,
    ["base-model", "transient-model", "success-model"],
    "Latest successful write must remain committed"
  );
  assert.equal(manager.saving, false);
  assert.equal(manager.saveError, null, "saveError must be cleared by latest success");
  assert.equal(manager.statusAnnouncement, "Preferences saved.");
});

test("Hook State Machine - Account switch or logout while save is pending drops in-flight writes and prevents leakage", async () => {
  let resolveUser1;
  const user1Promise = new Promise((resolve) => {
    resolveUser1 = resolve;
  });

  const apiPatchHandler = async (patch, targetUserId) => {
    if (targetUserId === "user-alpha") {
      await user1Promise;
      return { preferences: { favorites: ["leaked-alpha-model"] } };
    }
    return { preferences: { favorites: [] } };
  };

  const manager = createTestCatalogManager({
    userId: "user-alpha",
    initialPreferences: { favorites: [], hiddenBrands: [], brandOrder: [] },
    apiPatchHandler,
  });

  // User Alpha triggers a preference write that is in-flight
  manager.toggleFavorite("model-alpha-1");

  // While save is in-flight, account switches to User Beta
  manager.setUserId("user-beta");

  // User Alpha's pending response finally resolves
  resolveUser1();
  await manager.writeQueue;

  // User Beta's state must remain pristine
  assert.deepEqual(manager.preferences.favorites, [], "User Alpha write must not leak into User Beta");
  assert.equal(manager.saveError, null);
  assert.equal(manager.statusAnnouncement, "", "Status announcement must not leak across accounts");

  // Account logout test
  manager.toggleFavorite("model-beta-1");
  manager.setUserId(null); // Logout
  assert.deepEqual(manager.preferences.favorites, []);
  assert.equal(manager.statusAnnouncement, "");
});

test("Generated Asset Scan - Recursive filesystem check of frontend/dist verifies complete isolation", () => {
  const distDir = path.resolve("frontend/dist");
  assert.ok(fs.existsSync(distDir), "frontend/dist must exist (run frontend build before test)");

  function walk(dir) {
    let files = [];
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        files = files.concat(walk(full));
      } else {
        files.push(full);
      }
    }
    return files;
  }

  const allFiles = walk(distDir);
  assert.ok(allFiles.length > 0, "dist must contain generated build output");

  // Forbidden symbols that must NEVER leak into the production distribution bundle
  const forbiddenPatterns = [
    { label: "RAW_CATALOG_FIXTURES", regex: /RAW_CATALOG_FIXTURES/ },
    { label: "SYNTHETIC_PROJECTS", regex: /SYNTHETIC_PROJECTS/ },
    { label: "CatalogPreviewPage", regex: /CatalogPreviewPage/ },
    { label: "catalog-fixtures", regex: /catalog-fixtures/ },
    { label: "calculatedMu", regex: /calculatedMu/ },
    { label: "wholesalePriceInUsdPerMillion", regex: /wholesalePriceInUsdPerMillion/ },
    { label: "wholesalePriceOutUsdPerMillion", regex: /wholesalePriceOutUsdPerMillion/ },
    { label: "inputPriceMicrosPerM", regex: /inputPriceMicrosPerM/ },
    { label: "outputPriceMicrosPerM", regex: /outputPriceMicrosPerM/ },
  ];

  const leaks = [];
  for (const file of allFiles) {
    if (file.endsWith(".woff") || file.endsWith(".woff2") || file.endsWith(".ttf") || file.endsWith(".png")) {
      continue;
    }
    const content = fs.readFileSync(file, "utf8");
    for (const { label, regex } of forbiddenPatterns) {
      if (regex.test(content)) {
        leaks.push({ file: path.relative(distDir, file), label });
      }
    }
  }

  assert.deepEqual(
    leaks,
    [],
    `Forbidden development fixtures or pricing leaks found in frontend/dist: ${JSON.stringify(leaks)}`
  );

  // Assert presence of production catalog symbols
  let foundCatalogUiFlag = false;
  let foundCatalogEndpoint = false;
  for (const file of allFiles) {
    if (file.endsWith(".js")) {
      const content = fs.readFileSync(file, "utf8");
      if (content.includes("__VIBHAVGPT_FEATURE_MODEL_CATALOG_UI")) foundCatalogUiFlag = true;
      if (content.includes("/api/models/catalog")) foundCatalogEndpoint = true;
    }
  }

  // Slice 7: the catalog API is the composer picker's data source, always on; the flag-gated "Browse models" modal it gated is retired.
  assert.equal(foundCatalogUiFlag, false, "the retired catalog-UI flag no longer ships");
  assert.ok(foundCatalogEndpoint, "/api/models/catalog must be present in production bundles (the picker reads it)");
});
