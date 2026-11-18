import test from "node:test";
import assert from "node:assert/strict";
import { createIsolatedAuthFixture, TURNSTILE_TEST_CONFIG } from "./helpers/auth-test-harness.js";
import { listUserSkills, createUserSkill } from "../src/skills/service.js";
import { getConnectorsSummary } from "../src/connectors/service.js";

test("Isolated auth test harness initializes in-memory PGlite and establishes authenticated user", async () => {
  const fixture = await createIsolatedAuthFixture({ tier: "plus" });

  assert.ok(fixture.user.id.startsWith("usr_"));
  assert.equal(fixture.user.email, "test-engineer@example.com");
  assert.ok(fixture.session.token.startsWith("tok_"));
  assert.ok(fixture.cookieHeader.includes("better-auth.session_token="));
  assert.equal(fixture.authHeaders.cookie, fixture.cookieHeader);

  // Verify skills service works against isolated test DB
  const initialSkills = await listUserSkills(fixture.user.id);
  assert.deepEqual(initialSkills, []);

  const created = await createUserSkill(fixture.user.id, {
    name: "Harness Test Skill",
    description: "Testing skills in isolated fixture",
    instructions: "Always return concise answers.",
  });
  assert.equal(created.name, "Harness Test Skill");

  const skillsAfter = await listUserSkills(fixture.user.id);
  assert.equal(skillsAfter.length, 1);
  assert.equal(skillsAfter[0].id, created.id);

  // Verify connectors service works against isolated test DB
  const connectors = await getConnectorsSummary(fixture.user.id);
  assert.ok(Array.isArray(connectors));
  assert.ok(connectors.length > 0);

  // Verify Turnstile test keys are defined
  assert.equal(TURNSTILE_TEST_CONFIG.secretKey, "1x0000000000000000000000000000000AA");
});

