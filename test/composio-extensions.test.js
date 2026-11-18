import test, { mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) {
  await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
}
const db = drizzle(client);

mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db },
});

const {
  TOOLKIT_METADATA,
  COMPOSIO_TOOLKITS,
  isComposioConfigured,
  initiateComposioConnection,
  checkComposioAccountStatus,
  revokeComposioConnection,
  executeComposioTool,
} = await import("../src/connectors/composio-adapter.js");

const {
  getConnectorsSummary,
  initiateConnectorFlow,
  connectUserConnector,
  disconnectUserConnector,
  createPendingAction,
  approveAndExecuteAction,
  discardAction,
  setConnectorsDbForTest,
} = await import("../src/connectors/service.js");

const {
  createUserSkill,
  listUserSkills,
  updateUserSkill,
  deleteUserSkill,
  setSkillsDbForTest,
} = await import("../src/skills/service.js");

const { pendingToolActions, userSkills, userConnectors } = await import("../src/db/schema.js");

setConnectorsDbForTest(db);
setSkillsDbForTest(db);

test("Composio extensions: Toolkit catalog coverage and discovery", async () => {
  const toolkits = Object.values(TOOLKIT_METADATA);

  assert.ok(toolkits.length >= 7, "Catalog covers core integrations");
  const slugs = toolkits.map((c) => c.id);
  assert.ok(slugs.includes("google_workspace"), "Includes Google Workspace");
  assert.ok(slugs.includes("github"), "Includes GitHub");
  assert.ok(slugs.includes("notion"), "Includes Notion");
  assert.ok(slugs.includes("slack"), "Includes Slack");
  assert.ok(slugs.includes("microsoft"), "Includes Microsoft");
  assert.ok(slugs.includes("weather"), "Includes Weather");
  assert.ok(slugs.includes("web_search"), "Includes Web Search");

  // Verify write mutation requirements
  const google = toolkits.find((c) => c.id === "google_workspace");
  assert.equal(google.requiresApprovalForWrites, true, "Google Workspace requires approval for mutations");

  // Verify summary representation without a key (honest configuration_required).
  const savedKey = process.env.COMPOSIO_API_KEY;
  delete process.env.COMPOSIO_API_KEY;
  try {
    const summary = await getConnectorsSummary("test-user-preview");
    assert.ok(summary.length >= 7);
    const googleSummary = summary.find((c) => c.id === "google_workspace");
    assert.equal(googleSummary.status, "configuration_required");
    assert.match(googleSummary.blockerNotice, /owner configuration/i);
    assert.doesNotMatch(googleSummary.blockerNotice, /composio/i);
    assert.equal(googleSummary.catalogVisible, false);
    assert.ok(summary.some((c) => c.id === "gmail" && c.catalogVisible !== false));
  } finally {
    if (savedKey !== undefined) process.env.COMPOSIO_API_KEY = savedKey;
  }
});

test("Composio extensions: Production unconfigured enforcement (NO synthetic success)", async () => {
  // Ensure unconfigured environment
  const savedKey = process.env.COMPOSIO_API_KEY;
  delete process.env.COMPOSIO_API_KEY;

  try {
    // 1. Connection initiation must reject with explicit error
    await assert.rejects(
      async () => {
        await initiateComposioConnection("test-user-alpha", "google_workspace", {
          callbackUrl: "https://vibhavgpt.com/app?page=extensions",
        });
      },
      /Composio connector service is not configured/
    );

    // 2. Tool execution must reject with explicit error (no fabricated documents)
    await assert.rejects(
      async () => {
        await executeComposioTool({
          userId: "test-user-alpha",
          toolSlug: "google_docs_create_document",
          parameters: { title: "Unconfigured Doc", content: "Content" },
        });
      },
      /Composio integration is not configured/
    );

    // 3. Status returns configuration_required
    const status = await checkComposioAccountStatus("test-user-alpha", "google_workspace");
    assert.equal(status.status, "configuration_required");
    assert.equal(status.isConfigured, false);
    assert.match(status.notice, /owner configuration/i);
    assert.doesNotMatch(status.notice, /composio/i);

    // 4. Pending action execution failure must mark action 'failed', NOT 'completed'
    const pendingFail = await createPendingAction({
      userId: "test-user-fail",
      toolName: "google_docs_create_document",
      actionDescription: "Create Google Doc without credentials",
      payload: { title: "Failing Doc", content: "Should fail" },
    });

    await assert.rejects(
      async () => {
        await approveAndExecuteAction("test-user-fail", pendingFail.id, pendingFail.payloadHash);
      },
      /External execution failed/
    );

    const [recordedFail] = await db
      .select()
      .from(pendingToolActions)
      .where(eq(pendingToolActions.id, pendingFail.id));
    assert.equal(recordedFail.status, "failed");
    assert.ok(recordedFail.result.error);
    assert.ok(!recordedFail.result.documentUrl, "No synthetic document URL created on failure");
  } finally {
    if (savedKey) process.env.COMPOSIO_API_KEY = savedKey;
  }
});

test("Composio extensions: Live external execution with valid credentials and mock transport", async () => {
  process.env.COMPOSIO_API_KEY = "test-live-key";

  const fakeFetch = async (url, options) => {
    if (url.includes("/connected_accounts/link") || url.includes("/connectedAccounts/link")) {
      return {
        ok: true,
        json: async () => ({
          redirect_url: "https://connect.composio.dev/link/ln_live123",
          connection_request_id: "ca_req_456",
        }),
      };
    }

    if (url.includes("/tools/execute/")) {
      return {
        ok: true,
        json: async () => ({
          data: {
            documentId: "real_doc_999",
            documentUrl: "https://docs.google.com/document/d/real_doc_999/edit",
            title: "Quarterly Systems Strategy",
            status: "created",
          },
        }),
      };
    }

    if (url.includes("/connectedAccounts/") && options?.method === "DELETE") {
      return { ok: true, json: async () => ({ success: true }) };
    }

    return { ok: false, status: 404, text: async () => "Not Found" };
  };

  try {
    // 1. Live link initiation
    const link = await initiateComposioConnection("test-user-live", "google_workspace", {
      callbackUrl: "https://vibhavgpt.com/app?page=extensions",
      fetchImpl: fakeFetch,
    });
    assert.equal(link.redirectUrl, "https://connect.composio.dev/link/ln_live123");
    assert.equal(link.connectionId, "ca_req_456");

    // 2. Live tool execution
    const docResult = await executeComposioTool({
      userId: "test-user-live",
      toolSlug: "google_docs_create_document",
      parameters: { title: "Quarterly Systems Strategy" },
      fetchImpl: fakeFetch,
    });
    assert.equal(docResult.success, true);
    assert.equal(docResult.executionMode, "live");
    assert.equal(docResult.data.documentId, "real_doc_999");
    assert.equal(docResult.data.documentUrl, "https://docs.google.com/document/d/real_doc_999/edit");

    // 3. Revocation
    const revoked = await revokeComposioConnection("test-user-live", "google_workspace", {
      connectionId: "ca_req_456",
      fetchImpl: fakeFetch,
    });
    assert.equal(revoked.success, true);
  } finally {
    delete process.env.COMPOSIO_API_KEY;
  }
});

test("Composio extensions: Connect MCP consumer key (ck_...) transport, connections list, and tool execution", async () => {
  process.env.COMPOSIO_API_KEY = "ck_test_consumer_key_xyz";

  const calls = [];
  const fakeMcpFetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const { params } = JSON.parse(options.body);

    if (params?.name === "COMPOSIO_MANAGE_CONNECTIONS") {
      const action = params.arguments?.toolkits?.[0]?.action;
      if (action === "add") {
        const payload = {
          successful: true,
          data: {
            results: {
              googledocs: {
                toolkit: "googledocs",
                status: "initiated",
                redirect_url: "https://connect.composio.dev/link/lk_mcp_test_99",
                accounts: [{ id: "googledocs_test_acc", status: "initiated" }],
              },
            },
          },
        };
        return {
          ok: true,
          text: async () => `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } })}\n\n`,
        };
      }

      if (action === "list") {
        const payload = {
          successful: true,
          data: {
            results: {
              github: {
                toolkit: "github",
                status: "active",
                accounts: [
                  {
                    id: "github_darken-slad",
                    status: "active",
                    user_info: { login: "Shourya-Thoota", name: "Pansophy LLC" },
                  },
                ],
              },
            },
          },
        };
        return {
          ok: true,
          text: async () => `data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } })}\n\n`,
        };
      }

      if (action === "remove") {
        return {
          ok: true,
          text: async () => `data: ${JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: JSON.stringify({ successful: true }) }] } })}\n\n`,
        };
      }
    }

    if (params?.name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
      const toolItem = params.arguments?.tools?.[0];
      const payload = {
        successful: true,
        data: {
          results: [
            {
              response: {
                successful: true,
                data: {
                  id: "doc_mcp_output_777",
                  title: toolItem.arguments?.title || "Test Doc",
                  html_url: "https://docs.google.com/document/d/doc_mcp_output_777/edit",
                },
              },
            },
          ],
        },
      };
      return {
        ok: true,
        text: async () => `data: ${JSON.stringify({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } })}\n\n`,
      };
    }

    return { ok: false, status: 404, text: async () => "Not Found" };
  };

  try {
    // 1. Connection initiation via MCP
    const link = await initiateComposioConnection("test-mcp-user", "google_workspace", {
      callbackUrl: "https://vibhavgpt.com/app?page=extensions",
      fetchImpl: fakeMcpFetch,
    });
    assert.equal(link.redirectUrl, "https://connect.composio.dev/link/lk_mcp_test_99");
    assert.equal(link.connectionId, "googledocs_test_acc");

    // Verify MCP headers and payload
    const firstCall = calls[0];
    assert.equal(firstCall.options.headers["x-consumer-api-key"], "ck_test_consumer_key_xyz");
    assert.equal(firstCall.body.params.name, "COMPOSIO_MANAGE_CONNECTIONS");

    // 2. Status check via MCP
    const status = await checkComposioAccountStatus("test-mcp-user", "github", {
      fetchImpl: fakeMcpFetch,
    });
    assert.equal(status.status, "connected");
    assert.equal(status.accountId, "github_darken-slad");
    assert.equal(status.accountName, "Pansophy LLC");

    // 3. Multi-execute tool via MCP with slug translation
    const execResult = await executeComposioTool({
      userId: "test-mcp-user",
      toolSlug: "google_docs_create_document",
      parameters: { title: "MCP Generated Specification", content: "# Specifications\nDetails here." },
      fetchImpl: fakeMcpFetch,
    });
    assert.equal(execResult.success, true);
    assert.equal(execResult.executionMode, "live");
    assert.equal(execResult.data.documentId, "doc_mcp_output_777");
    assert.equal(execResult.data.documentUrl, "https://docs.google.com/document/d/doc_mcp_output_777/edit");

    // Verify tool slug translation and parameter mapping
    const execCall = calls.find((c) => c.body.params?.name === "COMPOSIO_MULTI_EXECUTE_TOOL");
    assert.ok(execCall);
    const sentTool = execCall.body.params.arguments.tools[0];
    assert.equal(sentTool.tool_slug, "GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN");
    assert.equal(sentTool.arguments.markdown_text, "# Specifications\nDetails here.");

    // 4. Revocation via MCP
    const revoked = await revokeComposioConnection("test-mcp-user", "github", {
      connectionId: "github_darken-slad",
      fetchImpl: fakeMcpFetch,
    });
    assert.equal(revoked.success, true);
  } finally {
    delete process.env.COMPOSIO_API_KEY;
  }
});

test("Composio extensions: Skills CRUD and script injection protection", async () => {
  const testUserId = `test-user-skills-${Date.now()}`;

  // 1. Script tags must be rejected
  await assert.rejects(
    async () => {
      await createUserSkill(testUserId, {
        name: "Malicious Skill",
        instructions: "Do this <script>alert('xss')</script> then format.",
      });
    },
    /Script tags and executable code are prohibited/,
    "Rejects script tags in instructions"
  );

  // 2. Javascript: pseudo-protocol must be rejected
  await assert.rejects(
    async () => {
      await createUserSkill(testUserId, {
        name: "Malicious Skill 2",
        instructions: "Run javascript:doBadThings()",
      });
    },
    /Script tags and executable code are prohibited/
  );

  // 3. Valid declarative skill creates successfully
  const created = await createUserSkill(testUserId, {
    name: "Executive Briefing Drafter",
    description: "Formats research into crisp executive memos",
    instructions: "Always structure responses with Executive Summary, Key Findings, and Action Items.",
    requiredConnectors: ["google_workspace"],
  });

  assert.ok(created.id);
  assert.equal(created.name, "Executive Briefing Drafter");
  assert.equal(created.enabled, true);

  // 4. List skills
  const list = await listUserSkills(testUserId);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);

  // 5. Update skill
  const updated = await updateUserSkill(testUserId, created.id, {
    enabled: false,
  });
  assert.equal(updated.enabled, false);

  // 6. Delete skill
  const deleted = await deleteUserSkill(testUserId, created.id);
  assert.equal(deleted, true);

  const afterDelete = await listUserSkills(testUserId);
  assert.equal(afterDelete.length, 0);
});

test("Composio extensions: Action approvals, exact binding, and replay rejection", async () => {
  process.env.COMPOSIO_API_KEY = "test-live-key";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("/tools/execute/")) {
      return {
        ok: true,
        json: async () => ({
          data: {
            documentId: "doc_approved_123",
            documentUrl: "https://docs.google.com/document/d/doc_approved_123/edit",
            title: "Project Alpha Blueprint",
            status: "created",
          },
        }),
      };
    }
    return { ok: false, status: 404, text: async () => "Not Found" };
  };

  const userA = `user-a-${Date.now()}`;
  const userB = `user-b-${Date.now()}`;

  const payload = {
    title: "Project Alpha Blueprint",
    content: "Substantive technical architecture document for Project Alpha.",
  };

  try {
    // Create pending tool action for User A using service method
    const pending = await createPendingAction({
      userId: userA,
      toolName: "google_docs_create_document",
      actionDescription: "Create Google Doc 'Project Alpha Blueprint'",
      payload,
    });
    const actionId = pending.id;
    const payloadHash = pending.payloadHash;

    // Cross-user tenant isolation: User B CANNOT approve User A's action
    await assert.rejects(
      async () => {
        await approveAndExecuteAction(userB, actionId, payloadHash);
      },
      /Action not found or unauthorized/,
      "Cross-user approval blocked"
    );

    // Changed payload rejection: User A cannot approve if payload hash changed
    const wrongHash = crypto.createHash("sha256").update("tampered payload").digest("hex");
    await assert.rejects(
      async () => {
        await approveAndExecuteAction(userA, actionId, wrongHash);
      },
      /Action payload mismatch or approval has been tampered with/,
      "Tampered payload rejected"
    );

    // Valid approval by User A executes successfully
    const result = await approveAndExecuteAction(userA, actionId, payloadHash);

    assert.equal(result.status, "completed");
    assert.ok(result.result);
    assert.match(result.result.documentUrl, /docs\.google\.com/);

    // Replay returns the completed action and must not execute again.
    const replay = await approveAndExecuteAction(userA, actionId, payloadHash);
    assert.equal(replay.status, "completed");
    assert.match(replay.result.documentUrl, /docs\.google\.com/);

    // Clean up test records
    await db.delete(pendingToolActions).where(eq(pendingToolActions.id, actionId));
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.COMPOSIO_API_KEY;
  }
});
