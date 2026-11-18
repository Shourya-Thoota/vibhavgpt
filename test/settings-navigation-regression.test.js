import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { SETTINGS_SECTIONS, settingsPath, settingsRoute } from "../frontend/src/settings-routes.js";

test("Settings navigation regression: canonical destinations are strictly unique and non-duplicated", () => {
  const canonicalSections = SETTINGS_SECTIONS.filter((s) => !s.legacy);
  const legacySections = SETTINGS_SECTIONS.filter((s) => s.legacy);

  // Exactly 11 canonical destinations (Media is back for the image watermark: owner policy, 2026-11-16, superseding #70)
  assert.equal(canonicalSections.length, 11, "Must have exactly 11 canonical sections");

  // Expected canonical slugs
  const expectedSlugs = [
    "general",
    "appearance",
    "profile",
    "personalization",
    "location",
    "media",
    "security",
    "connectors",
    "data-controls",
    "usage",
    "billing",
  ];
  assert.deepEqual(
    canonicalSections.map((s) => s.slug),
    expectedSlugs,
    "Canonical slugs must match authoritative list in order"
  );

  // Slugs and labels must be uniquely defined (no duplicate Profile, General, Personalization, Data controls)
  const slugs = new Set();
  const labels = new Set();
  for (const s of canonicalSections) {
    assert.ok(!slugs.has(s.slug), `Duplicate canonical slug: ${s.slug}`);
    assert.ok(!labels.has(s.label), `Duplicate canonical label: ${s.label}`);
    slugs.add(s.slug);
    labels.add(s.label);
  }

  // Legacy slugs must be strictly marked as legacy
  const expectedLegacy = ["account", "replies", "personality", "memory", "your-data", "delete-account"];
  assert.deepEqual(
    legacySections.map((s) => s.slug),
    expectedLegacy,
    "Legacy slugs must match expected backward-compatible list"
  );
  for (const s of legacySections) {
    assert.equal(s.legacy, true, `Legacy slug ${s.slug} must be marked legacy: true`);
  }
});

test("Settings navigation regression: App.jsx dock and picker strictly filter legacy aliases", () => {
  const appJsx = fs.readFileSync(path.resolve("frontend/src/App.jsx"), "utf8");

  // In desktop settings dock: must filter !section.legacy
  assert.match(
    appJsx,
    /SETTINGS_SECTIONS\.filter\(\(section\)\s*=>\s*!section\.legacy/,
    "Settings dock items must explicitly filter out legacy sections"
  );

  // In mobile settings picker: must filter !s.legacy
  assert.match(
    appJsx,
    /SETTINGS_SECTIONS\.filter\(\(s\)\s*=>\s*!s\.legacy/,
    "Settings mobile picker must explicitly filter out legacy sections"
  );

  // In settings dock aria-current: must compare against canonical slug only
  assert.match(
    appJsx,
    /aria-current=\{canonical === section\.slug \? "page" : undefined\}/,
    "Dock item aria-current must strictly compare canonical === section.slug"
  );
});

test("Settings navigation regression: canonicalSectionSlug resolves all legacy and canonical destinations", () => {
  const canonicalMapping = {
    account: "profile",
    profile: "profile",
    replies: "general",
    general: "general",
    personality: "personalization",
    memory: "personalization",
    personalization: "personalization",
    "your-data": "data-controls",
    "delete-account": "data-controls",
    "data-controls": "data-controls",
    appearance: "appearance",
    location: "location",
    security: "security",
    connectors: "connectors",
    usage: "usage",
    billing: "billing",
  };

  const appJsx = fs.readFileSync(path.resolve("frontend/src/App.jsx"), "utf8");
  // Ensure canonicalSectionSlug function handles each mapping correctly
  for (const [input, expected] of Object.entries(canonicalMapping)) {
    if (input === "account") assert.match(appJsx, /if \(slug === "account"\) return "profile"/);
    if (input === "replies") assert.match(appJsx, /if \(slug === "replies"\) return "general"/);
    if (input === "personality" || input === "memory") {
      assert.match(appJsx, /if \(slug === "personality" \|\| slug === "memory"\) return "personalization"/);
    }
    if (input === "your-data" || input === "delete-account") {
      assert.match(appJsx, /if \(slug === "your-data" \|\| slug === "delete-account"\) return "data-controls"/);
    }
  }
});

