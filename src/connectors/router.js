import { Router } from "express";
import { requireSession } from "../middleware/require-session.js";
import {
  getConnectorsSummary,
  initiateConnectorFlow,
  connectUserConnector,
  disconnectUserConnector,
  setUserConnectorEnabled,
  checkConnectorStatus,
  syncUserConnectorsFromComposio,
  listPendingActions,
  getActionForUser,
  approveAndExecuteAction,
  discardAction,
  reconcileUncertainAction,
  CONNECTOR_PROVIDERS,
} from "./service.js";
import { isComposioConfigured } from "./composio-adapter.js";
import { mapConnectorError, scrubVendorNames, serviceNameForTool } from "./error-mapper.js";

export function sanitizeActionForUser(action) {
  if (!action || typeof action !== "object") return action;
  const sanitized = { ...action };
  if (sanitized.result && typeof sanitized.result === "object") {
    const res = { ...sanitized.result };
    if (typeof res.error === "string") {
      res.error = scrubVendorNames(res.error, serviceNameForTool(sanitized.toolName));
    }
    sanitized.result = res;
  }
  return sanitized;
}

export const connectorsRouter = Router();

/**
 * Webhook handler for external connection lifecycle events from Composio.
 * Note: Placed before session middleware to accept provider event delivery.
 */
connectorsRouter.post("/webhook", (_req, res) => {
  // Disabled. This endpoint accepted any caller's event, with no signature check, and used the user id and connection id inside it to mark a person's
  // connector connected or disconnected. Nothing in the app depends on it (connection state is read from the provider by the signed-in person's own
  // requests), so it refuses everything until a verified delivery scheme is added.
  res.status(404).json({ error: "Not found." });
});

// All following routes require authenticated user session
connectorsRouter.use(requireSession);

/**
 * GET /api/connectors
 * Returns all available connectors, category, and user connection status.
 */
connectorsRouter.get("/", async (req, res, next) => {
  try {
    const summary = await getConnectorsSummary(req.user.id);
    res.json({ connectors: summary });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/connectors/sync
 * Refreshes and synchronizes all active connected accounts from Composio.
 */
connectorsRouter.post("/sync", async (req, res, next) => {
  try {
    if (!isComposioConfigured()) {
      const mapped = mapConnectorError("Connector service is not configured (missing COMPOSIO_API_KEY).", { code: "configuration_required" });
      return res.status(503).json({ error: mapped.message, code: mapped.code });
    }

    await syncUserConnectorsFromComposio(req.user.id);
    const summary = await getConnectorsSummary(req.user.id);
    res.json({ success: true, connectors: summary });
  } catch (error) {
    const mapped = mapConnectorError(error);
    res.status(mapped.status || 500).json({ error: mapped.message, code: mapped.code });
  }
});

/**
 * GET /api/connectors/:provider/status
 * Queries live external connection status for a provider and updates local state.
 */
connectorsRouter.get("/:provider/status", async (req, res, next) => {
  try {
    const { provider } = req.params;
    const status = await checkConnectorStatus(req.user.id, provider);
    res.json({ success: true, ...status });
  } catch (error) {
    const mapped = mapConnectorError(error, { service: req.params.provider });
    res.status(mapped.status || 500).json({ error: mapped.message, code: mapped.code });
  }
});

/**
 * POST /api/connectors/:provider/initiate
 * Generates an authorized Composio link / redirect URL for connecting.
 */
connectorsRouter.post("/:provider/initiate", async (req, res, next) => {
  try {
    const { provider } = req.params;
    const { callbackUrl } = req.body || {};

    if (!isComposioConfigured()) {
      const mapped = mapConnectorError("Connector service is not configured (missing COMPOSIO_API_KEY).", { code: "configuration_required" });
      return res.status(503).json({ error: mapped.message, code: mapped.code });
    }

    const flow = await initiateConnectorFlow(req.user.id, provider, { callbackUrl });
    res.json({ success: true, ...flow });
  } catch (error) {
    const mapped = mapConnectorError(error, { service: req.params.provider });
    res.status(mapped.status || 400).json({ error: mapped.message, code: mapped.code });
  }
});

/**
 * POST /api/connectors/:provider/connect
 * Completes connection for an authenticated user with verified credentials.
 */
connectorsRouter.post("/:provider/connect", (_req, res) => {
  // Disabled. This route stored whatever account id, connection id and address the caller sent, and the app later trusted them (for the account a
  // message is sent from, and for the account revoked on disconnect). Nothing in the app calls it: connecting is /initiate, then the app reads the
  // verified account from the provider.
  res.status(410).json({ error: "This way of connecting is no longer available. Use Connect in Extensions.", code: "connect_unavailable" });
});

/**
 * POST /api/connectors/:provider/disconnect
 * Disconnects and revokes stored credentials for a connector.
 */
connectorsRouter.post("/:provider/disconnect", async (req, res, next) => {
  try {
    const { provider } = req.params;
    const result = await disconnectUserConnector(req.user.id, provider);
    const upstreamError = result?.upstreamError
      ? mapConnectorError(result.upstreamError, { service: provider }).message
      : undefined;
    res.json({
      success: true,
      disconnected: true,
      localDisconnected: true,
      upstreamRevoked: Boolean(result?.upstreamRevoked),
      ...(upstreamError ? { upstreamError } : {}),
    });
  } catch (error) {
    const mapped = mapConnectorError(error, { service: req.params.provider });
    res.status(mapped.status || 400).json({ error: mapped.message, code: mapped.code });
  }
});

/**
 * PATCH /api/connectors/:provider
 * Enables or disables a connected connector for the authenticated user.
 */
connectorsRouter.patch("/:provider", async (req, res, next) => {
  try {
    const { provider } = req.params;
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "Field 'enabled' (boolean) is required." });
    }
    const updated = await setUserConnectorEnabled(req.user.id, provider, enabled);
    res.json({ success: true, connector: updated });
  } catch (error) {
    const mapped = mapConnectorError(error, { service: req.params.provider });
    res.status(400).json({ error: mapped.message, code: mapped.code });
  }
});

/**
 * POST /api/connectors/:provider/enable
 * Enables tool execution for an authorized connector.
 */
connectorsRouter.post("/:provider/enable", async (req, res, next) => {
  try {
    const updated = await setUserConnectorEnabled(req.user.id, req.params.provider, true);
    res.json({ success: true, connector: updated });
  } catch (error) {
    const mapped = mapConnectorError(error, { service: req.params.provider });
    res.status(400).json({ error: mapped.message, code: mapped.code });
  }
});

/**
 * POST /api/connectors/:provider/disable
 * Disables tool execution for a connector without revoking its credentials.
 */
connectorsRouter.post("/:provider/disable", async (req, res, next) => {
  try {
    const updated = await setUserConnectorEnabled(req.user.id, req.params.provider, false);
    res.json({ success: true, connector: updated });
  } catch (error) {
    const mapped = mapConnectorError(error, { service: req.params.provider });
    res.status(400).json({ error: mapped.message, code: mapped.code });
  }
});

/**
 * GET /api/connectors/actions/pending
 * Returns active pending write actions awaiting human approval.
 */
connectorsRouter.get("/actions/pending", async (req, res, next) => {
  try {
    const actions = await listPendingActions(req.user.id);
    res.json({ pendingActions: actions.map(sanitizeActionForUser) });
  } catch (error) {
    const mapped = mapConnectorError(error);
    res.status(mapped.status || 500).json({ error: mapped.message, code: mapped.code });
  }
});

connectorsRouter.get("/actions/:id", async (req, res, next) => {
  try {
    const action = await getActionForUser(req.user.id, req.params.id);
    if (!action) return res.status(404).json({ error: "Action not found or unauthorized." });
    res.json({ action: sanitizeActionForUser(action) });
  } catch (error) {
    const mapped = mapConnectorError(error);
    res.status(mapped.status || 500).json({ error: mapped.message, code: mapped.code });
  }
});

/**
 * POST /api/connectors/actions/:id/approve
 * Human-in-the-Loop: approves and executes a pending action.
 */
connectorsRouter.post("/actions/:id/approve", async (req, res, next) => {
  try {
    const { payloadHash } = req.body || {};
    const action = await approveAndExecuteAction(req.user.id, req.params.id, payloadHash);
    const success = action.status === "completed";
    if (action.status === "failed" || action.status === "expired") {
      const mapped = mapConnectorError(action.result?.error || "This approval can no longer be executed.", {
        service: serviceNameForTool(action.toolName),
        toolName: action.toolName,
      });
      return res.status(409).json({
        success: false,
        error: mapped.message,
        code: action.status,
        action: sanitizeActionForUser(action),
      });
    }
    res.json({ success, action: sanitizeActionForUser(action) });
  } catch (error) {
    const action = await getActionForUser(req.user.id, req.params.id).catch(() => null);
    const mapped = mapConnectorError(error, {
      service: action ? serviceNameForTool(action.toolName) : null,
      toolName: action?.toolName,
    });
    res.status(400).json({
      error: mapped.message,
      ...(action ? { action: sanitizeActionForUser(action), code: action.status } : {}),
    });
  }
});

/**
 * POST /api/connectors/actions/:id/discard
 * Human-in-the-Loop: discards a pending action.
 */
connectorsRouter.post("/actions/:id/discard", async (req, res, next) => {
  try {
    const result = await discardAction(req.user.id, req.params.id);
    res.json({ success: true, action: sanitizeActionForUser(result) });
  } catch (error) {
    const mapped = mapConnectorError(error);
    res.status(400).json({ error: mapped.message, code: mapped.code });
  }
});

/**
 * POST /api/connectors/actions/:id/reconcile  { outcome: "uploaded" | "not_uploaded" }
 * Settles an upload whose result never came back, after the person has checked their own Drive.
 */
connectorsRouter.post("/actions/:id/reconcile", async (req, res) => {
  try {
    const result = await reconcileUncertainAction(req.user.id, req.params.id, req.body?.outcome);
    res.json({ success: true, action: sanitizeActionForUser(result) });
  } catch (error) {
    res.status(400).json({ error: String(error?.message || "Could not settle this upload."), code: "reconcile_rejected" });
  }
});
