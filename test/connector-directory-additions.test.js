import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPOSIO_TOOLKITS,
  TOOLKIT_METADATA,
  TOOL_SLUG_MAP,
  TOOL_ARGUMENT_ALLOWLIST,
  pickToolArguments,
} from "../src/connectors/composio-adapter.js";
import { TOOL_TO_CONNECTOR_MAP, WRITE_MUTATION_TOOLS } from "../src/connectors/service.js";
import { CHAT_TOOLS } from "../src/chat/tool-calls.js";
import { filterToolsForEnabledConnectors } from "../src/chat/router.js";
import {
  connectorMatchesDirectoryFilters,
  connectorNeedsPermissions,
  directoryResultLabel,
} from "../frontend/src/components/extensions/connector-directory.js";
import { resolveServiceLogoId } from "../frontend/src/components/extensions/service-logo-id.js";

const NEW_CONNECTORS = [
  "googleslides",
  "googletasks",
  "asana",
  "todoist",
  "calendly",
  "figma",
  "zoom",
  "clickup",
  "youtube",
];

test("new connectors are published once and mapped through auth, tools, and approval", () => {
  assert.equal(TOOLKIT_METADATA.googleforms, undefined, "Google Forms stays unpublished because managed OAuth is unavailable");
  for (const id of NEW_CONNECTORS) {
    const toolkit = TOOLKIT_METADATA[id];
    assert.ok(toolkit, id);
    assert.equal(toolkit.catalogVisible, undefined);
    assert.ok(Object.values(COMPOSIO_TOOLKITS).includes(id));
    assert.equal(toolkit.authType, "oauth2");
    const actions = [...toolkit.readActions, ...toolkit.writeActions];
    assert.ok(actions.length >= 1, `${id} has a real tool`);
    for (const action of actions) {
      assert.ok(TOOL_SLUG_MAP[action], `${action} has a Composio slug`);
      assert.equal(TOOL_TO_CONNECTOR_MAP[action], id);
      assert.ok(CHAT_TOOLS.some((tool) => tool.function.name === action), `${action} is discoverable`);
      assert.ok(TOOL_ARGUMENT_ALLOWLIST[action], `${action} strips unrelated arguments`);
      if (toolkit.writeActions.includes(action)) assert.equal(WRITE_MUTATION_TOOLS.has(action), true);
      else assert.equal(WRITE_MUTATION_TOOLS.has(action), false);
    }
  }
  assert.equal(TOOLKIT_METADATA.google_workspace.catalogVisible, false);
  assert.equal(TOOLKIT_METADATA.microsoft.catalogVisible, false);
});

test("new tool arguments keep documented fields and provider defaults", () => {
  assert.deepEqual(
    pickToolArguments("youtube_search", { q: "lumen", query: "ignore", prompt: "ignore", location: "x" }),
    { q: "lumen" },
  );
  assert.deepEqual(pickToolArguments("clickup_list_workspaces", { query: "nope" }), {});
  assert.equal(pickToolArguments("zoom_list_meetings", {}).user_id, "me");
  assert.equal(pickToolArguments("calendly_get_user", {}).uuid, "me");
  assert.equal(pickToolArguments("google_drive_upload_file", { fileName: "a.txt", content: "hi" }).fileName, "a.txt");
});

test("connector directory filters compose and do not treat unverified connections as missing permissions", () => {
  const rows = [
    { id: "gmail", name: "Gmail", description: "Mail", category: "Communication", status: "connected", fullyAuthorized: false, scopeVerification: "unverified", missingApps: [], unavailableFeatures: [] },
    { id: "asana", name: "Asana", description: "Work", category: "Productivity", status: "available", missingApps: [], unavailableFeatures: [] },
    { id: "zoom", name: "Zoom", description: "Meetings", category: "Communication", status: "connected", missingApps: ["zoom"], unavailableFeatures: ["Zoom"] },
    { id: "figma", name: "Figma", description: "Design", category: "Design", status: "pending_auth", missingApps: [], unavailableFeatures: [] },
  ];
  assert.equal(connectorNeedsPermissions(rows[0]), false);
  assert.equal(connectorNeedsPermissions(rows[2]), true);
  assert.equal(rows.filter((row) => connectorMatchesDirectoryFilters(row, { statusFilter: "not_connected" })).map((row) => row.id).join(","), "asana,figma");
  assert.deepEqual(
    rows.filter((row) => connectorMatchesDirectoryFilters(row, { query: "zoom", categoryFilter: "Communication", statusFilter: "needs_permissions" })).map((row) => row.id),
    ["zoom"],
  );
  assert.equal(directoryResultLabel(1, 4, true), "1 of 4 connectors match");
  assert.equal(directoryResultLabel(4, 4, false), "4 connectors");
});

test("enabled connector tools are offered only for that account", () => {
  const selected = filterToolsForEnabledConnectors(CHAT_TOOLS, {
    connectorEnabled: { youtube: true, googledrive: true },
    selectedConnectors: ["youtube"],
  }).map((tool) => tool.function.name);
  assert.ok(selected.includes("youtube_search"));
  assert.equal(selected.includes("google_drive_search"), false);
  assert.equal(selected.includes("asana_list_workspaces"), false);
});

test("product logo ids resolve aliases without collapsing known products into the parent mark", () => {
  assert.equal(resolveServiceLogoId("google_docs"), "googledocs");
  assert.equal(resolveServiceLogoId("Google-Slides"), "googleslides");
  assert.equal(resolveServiceLogoId("one-drive"), "one_drive");
  assert.equal(resolveServiceLogoId("web"), "web_search");
  assert.equal(resolveServiceLogoId("gmail"), "gmail");
  assert.notEqual(resolveServiceLogoId("googletasks"), "google_workspace");
});
