import { useState, useEffect, useRef } from "react";
import { Plug, Check, AlertCircle, Lock, Loader2 } from "lucide-react";
import { api } from "../api.js";
import { ActionApprovalCard } from "./ActionApprovalCard.jsx";
import { ServiceLogo } from "./extensions/ServiceLogo.jsx";
import { PLAIN_SERVICE_NAMES } from "./extensions/connector-directory.js";
import { openConnectorAuthorization, pollConnectorAuthorization } from "./extensions/openConnectorAuth.js";

export function ConnectorsSettings() {
  const [connectors, setConnectors] = useState([]);
  const [pendingActions, setPendingActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [pendingOps, setPendingOps] = useState({});
  const [manualAuthLink, setManualAuthLink] = useState(null);
  const [waitingFor, setWaitingFor] = useState(null);
  const pollAbortRef = useRef(null);

  const isPending = (id) => Boolean(pendingOps[id]);
  const setOpPending = (id, op) => {
    setPendingOps((prev) => (op ? { ...prev, [id]: op } : Object.fromEntries(Object.entries(prev).filter(([k]) => k !== id))));
  };

  const getDisplayName = (connector) => {
    return PLAIN_SERVICE_NAMES[connector?.id] || connector?.name || connector?.id;
  };

  const loadData = async () => {
    try {
      setLoading(true);
      setError("");
      const [resConn, resActions] = await Promise.all([
        api("/api/connectors").catch(() => ({ connectors: [] })),
        api("/api/connectors/actions/pending").catch(() => ({ pendingActions: [] })),
      ]);
      setConnectors(resConn.connectors || []);
      setPendingActions(resActions.pendingActions || []);
    } catch (err) {
      setError(err.message || "Failed to load connectors.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    return () => {
      pollAbortRef.current?.abort();
    };
  }, []);

  // Recheck pending authorization when the VibhavGPT tab regains focus.
  useEffect(() => {
    const onFocus = () => {
      if (waitingFor) {
        api(`/api/connectors/${encodeURIComponent(waitingFor)}/status`)
          .then(async (status) => {
            if (status?.status === "connected") {
              setWaitingFor(null);
              setActionMessage(`${PLAIN_SERVICE_NAMES[waitingFor] || waitingFor} connected successfully.`);
              setOpPending(waitingFor, null);
              await loadData();
            }
          })
          .catch(() => {});
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [waitingFor]);

  const startAuthPolling = (connectorId, displayName) => {
    pollAbortRef.current?.abort();
    const controller = new AbortController();
    pollAbortRef.current = controller;
    setWaitingFor(connectorId);
    setOpPending(connectorId, "waiting");
    setActionMessage(`Waiting for authorization of ${displayName}.`);

    pollConnectorAuthorization({
      signal: controller.signal,
      checkStatus: async () => {
        await api("/api/connectors/sync", { method: "POST" }).catch(() => {});
        return api(`/api/connectors/${encodeURIComponent(connectorId)}/status`);
      },
      onUpdate: (status) => {
        if (status?.status === "connected") {
          setActionMessage(`${displayName} connected successfully.`);
        }
      },
    }).then(async (result) => {
      if (result?.status === "connected") {
        setWaitingFor(null);
        setManualAuthLink(null);
        setActionMessage(`${displayName} connected successfully.`);
        await loadData();
      } else if (result?.status === "expired") {
        setWaitingFor(null);
        setError(`Authorization for ${displayName} expired. Try Connect again.`);
      }
      setOpPending(connectorId, null);
    });
  };

  const handleConnect = async (connector) => {
    if (isPending(connector.id)) return;
    const displayName = getDisplayName(connector);
    setError("");
    setActionMessage("");
    setManualAuthLink(null);
    setOpPending(connector.id, "connecting");

    try {
      const returnUrl = `${window.location.origin}/app?page=extensions&tab=connectors&toolkit=${encodeURIComponent(connector.id)}`;
      const outcome = await openConnectorAuthorization({
        initiate: () =>
          api(`/api/connectors/${encodeURIComponent(connector.id)}/initiate`, {
            method: "POST",
            body: JSON.stringify({ callbackUrl: returnUrl }),
          }),
        onBlocked: (url) => {
          setManualAuthLink(url);
          setError(`Pop-up blocked. Open the authorization link for ${displayName} in a separate tab.`);
        },
        onError: (message) => setError(message),
      });

      if (outcome.connected) {
        setActionMessage(`Connected ${displayName} successfully.`);
        await loadData();
        setOpPending(connector.id, null);
        return;
      }

      // Keep VibhavGPT open; poll until backend verifies the connection.
      startAuthPolling(connector.id, displayName);
    } catch (err) {
      setError(err.message || `Connection failed for ${displayName}.`);
      setOpPending(connector.id, null);
    }
  };

  const handleDisconnect = async (connector) => {
    if (isPending(connector.id)) return;
    const displayName = getDisplayName(connector);
    if (!window.confirm(`Disconnect ${displayName}? Tools from this account will no longer be available.`)) {
      return;
    }

    setError("");
    setActionMessage("");
    setOpPending(connector.id, "disconnecting");

    try {
      await api(`/api/connectors/${encodeURIComponent(connector.id)}/disconnect`, { method: "POST" });
      setActionMessage(`Disconnected ${displayName}.`);
      await loadData();
    } catch (err) {
      setError(err.message || `Failed to disconnect ${displayName}.`);
    } finally {
      setOpPending(connector.id, null);
    }
  };

  const handleToggleEnabled = async (connector) => {
    if (isPending(connector.id)) return;
    const displayName = getDisplayName(connector);
    const nextState = !connector.enabled;

    setError("");
    setActionMessage("");
    setOpPending(connector.id, "toggling");

    try {
      const res = await api(`/api/connectors/${encodeURIComponent(connector.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: nextState }),
      });
      if (res.success && res.connector) {
        setActionMessage(`${displayName} ${nextState ? "enabled" : "disabled"}.`);
        await loadData();
      } else {
        throw new Error(res.error || `Failed to update ${displayName}.`);
      }
    } catch (err) {
      setError(err.message || `Failed to update ${displayName}.`);
    } finally {
      setOpPending(connector.id, null);
    }
  };

  return (
    <div className="connectors-settings">
      <div className="connectors-settings__hero">
        <p className="connectors-settings__subtext">
          Manage your external services. Consequential write actions require explicit one-click approval before execution.
        </p>
      </div>

      {actionMessage && (
        <div className="connectors-alert connectors-alert--success" role="status">
          <Check size={16} />
          <span>{actionMessage}</span>
        </div>
      )}

      {error && (
        <div className="connectors-alert connectors-alert--error" role="alert">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {manualAuthLink && (
        <div className="connectors-alert connectors-alert--success" role="status">
          <Plug size={16} />
          <span>
            Authorization needs a separate tab.{" "}
            <a className="link" href={manualAuthLink} target="_blank" rel="noopener noreferrer">
              Open authorization
            </a>
          </span>
        </div>
      )}

      {/* Pending Actions Section */}
      {pendingActions.length > 0 && (
        <div className="connectors-pending-section">
          <h3 className="connectors-pending__title">
            <Lock size={16} strokeWidth={2} />
            <span>Actions Pending Your Approval ({pendingActions.length})</span>
          </h3>
          <p className="connectors-pending__desc">
            A model requested external changes. Review each action below. Actions expire automatically after 5 minutes.
          </p>

          <div className="connectors-pending__list">
            {pendingActions.map((action) => (
              <ActionApprovalCard key={action.id} pendingAction={action} onResolved={() => loadData()} />
            ))}
          </div>
        </div>
      )}

      {/* Connectors Compact List */}
      <div className="connectors-list" role="list">
        {connectors.filter((connector) => connector.catalogVisible !== false).map((connector) => {
          const displayName = getDisplayName(connector);
          const isConnected = connector.status === "connected";
          const isWaiting = connector.status === "pending_auth" || waitingFor === connector.id || pendingOps[connector.id] === "waiting";
          const isConfigRequired = connector.status === "configuration_required";
          const needsVerification = connector.status === "verification_required";
          const isBuiltIn = connector.id === "weather" || connector.id === "web_search";
          const op = pendingOps[connector.id];
          const accountName = connector.metadata?.accountName || connector.metadata?.email;

          return (
            <div
              key={connector.id}
              className="connector-row"
              data-connected={isConnected || undefined}
              data-enabled={connector.enabled}
              role="listitem"
            >
              <div className="connector-row__left">
                <div className="connector-row__logo" aria-hidden="true">
                  <ServiceLogo serviceId={connector.id} size={28} />
                </div>
                <div className="connector-row__meta">
                  <div className="connector-row__name-line">
                    <span className="connector-row__name">{displayName}</span>
                    {isConnected ? (
                      <span className="status-badge status-badge--connected">
                        <Check size={11} strokeWidth={3} /> Connected
                      </span>
                    ) : isWaiting ? (
                      <span className="status-badge status-badge--warning">Waiting for authorization</span>
                    ) : needsVerification ? (
                      <span className="status-badge status-badge--warning">Verification required</span>
                    ) : isConfigRequired ? (
                      <span className="status-badge status-badge--warning">Setup Required</span>
                    ) : (
                      <span className="status-badge status-badge--available">Disconnected</span>
                    )}
                  </div>
                  {isConnected && accountName && (
                    <span className="connector-row__account">{accountName}</span>
                  )}
                  {connector.blockerNotice && (
                    <span className="connector-row__notice">{connector.blockerNotice}</span>
                  )}
                  {isConnected && connector.missingApps?.length > 0 && (
                    <span className="connector-row__notice">
                      Missing access: {connector.missingApps.join(", ")}. Reconnect to grant full access.
                    </span>
                  )}
                </div>
              </div>

              <div className="connector-row__actions">
                {isConnected ? (
                  <>
                    <label
                      className={`connector-toggle ${isPending(connector.id) ? "connector-toggle--disabled" : ""}`}
                      title={connector.enabled ? `Enabled - click to disable ${displayName}` : `Disabled - click to enable ${displayName}`}
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(connector.enabled)}
                        onChange={() => handleToggleEnabled(connector)}
                        disabled={isPending(connector.id)}
                        aria-label={`Enable or disable ${displayName}`}
                      />
                      <span className="connector-toggle__slider" aria-hidden="true"></span>
                      <span className="connector-toggle__label">
                        {connector.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </label>

                    {!isBuiltIn && (
                      <button
                        type="button"
                        className="btn btn--quiet btn--sm connector-disconnect-btn"
                        onClick={() => handleDisconnect(connector)}
                        disabled={isPending(connector.id)}
                        aria-label={`Disconnect ${displayName}`}
                      >
                        {op === "disconnecting" ? <Loader2 size={13} className="spin" /> : null}
                        <span>Disconnect</span>
                      </button>
                    )}
                  </>
                ) : needsVerification ? (
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => handleConnect(connector)}
                    title={connector.blockerNotice || "Reconnect to verify"}
                  >
                    Reconnect to verify
                  </button>
                ) : isConfigRequired ? (
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    disabled
                    title={connector.blockerNotice || "Requires owner configuration"}
                  >
                    Setup Required
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--primary btn--sm connector-connect-btn"
                    onClick={() => handleConnect(connector)}
                    disabled={isPending(connector.id)}
                  >
                    {op === "connecting" ? (
                      <>
                        <Loader2 size={13} className="spin" />
                        <span>Connecting…</span>
                      </>
                    ) : (
                      <span>Connect</span>
                    )}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ConnectorsSettings;
