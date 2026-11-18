import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Plug,
  Search,
  Check,
  AlertCircle,
  Plus,
  Trash2,
  Edit2,
  ArrowLeft,
  ChevronDown,
  RefreshCw,
  Upload,
  FileCode,
  Loader2,
  MoreHorizontal,
  Power,
  PowerOff,
} from "lucide-react";
import { Banner, Menu, MenuItem } from "../ui.jsx";
import { ServiceLogo } from "./ServiceLogo.jsx";
import { openConnectorAuthorization, pollConnectorAuthorization } from "./openConnectorAuth.js";
import {
  PLAIN_SERVICE_NAMES,
  availableStatusFilters,
  connectorMatchesDirectoryFilters,
  connectorNeedsPermissions,
  directoryResultLabel,
  groupConnectors,
} from "./connector-directory.js";
import "./extensions.css";
import "./extensions-directory.css";

export function Extensions({ api, user, tier, onBack, onOpenSettings, onUseSkill }) {
  const [activeTab, setActiveTab] = useState("connectors"); // "connectors" | "skills"
  const [connectors, setConnectors] = useState([]);
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [skillSearchQuery, setSkillSearchQuery] = useState("");
  const [pendingOps, setPendingOps] = useState({});
  const [manualAuthLink, setManualAuthLink] = useState(null);
  const [waitingFor, setWaitingFor] = useState(null);
  // Connector filter state. "not_connected" covers available, pending_auth, and configuration_required. Categories are the
  // list's own headings, not a second filter.
  const [statusFilter, setStatusFilter] = useState("all");
  // Which connected row has its Manage panel open, and how each row's last action ended ("success" | "error"), for its button.
  const [manageOpenId, setManageOpenId] = useState(null);
  const [rowResult, setRowResult] = useState({});
  const [skillOps, setSkillOps] = useState({});
  const pollAbortRef = useRef(null);

  // Skill modal state
  const [skillModalOpen, setSkillModalOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState(null);
  const [skillForm, setSkillForm] = useState({
    name: "",
    description: "",
    instructions: "",
    requiredConnectors: [],
  });

  // Skill import state
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importStage, setImportStage] = useState("upload"); // "upload" | "validating" | "preview"
  const [importPreview, setImportPreview] = useState(null);
  const [importConflictChoice, setImportConflictChoice] = useState("rename"); // "rename" | "overwrite"
  const [importError, setImportError] = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  const isPending = (id) => Boolean(pendingOps[id]);

  const setOpPending = (id, op) => {
    setPendingOps((prev) => (op ? { ...prev, [id]: op } : Object.fromEntries(Object.entries(prev).filter(([k]) => k !== id))));
  };

  // How a row's last action ended, for its button's success and error states. It clears when the next action starts.
  const markResult = (id, result) => {
    setRowResult((prev) => (result ? { ...prev, [id]: result } : Object.fromEntries(Object.entries(prev).filter(([k]) => k !== id))));
  };

  const getDisplayName = (connector) => {
    if (!connector) return "";
    return PLAIN_SERVICE_NAMES[connector.id] || connector.name || connector.id;
  };

  // Load connectors & skills from real database/API
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [connRes, skillRes] = await Promise.all([
        api("/api/connectors").catch((err) => {
          throw new Error(err.message || "Failed to load connectors.");
        }),
        api("/api/skills").catch(() => ({ skills: [] })),
      ]);
      setConnectors(connRes.connectors || []);
      setSkills(skillRes.skills || []);
    } catch (err) {
      setError(err.message || "Failed to load extensions catalog.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  // On mount: inspect if returning from external OAuth redirect (callback tab or deep link)
  useEffect(() => {
    const checkRedirectReturn = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const toolkit = params.get("toolkit") || params.get("connector");
        if (toolkit) {
          // Never trust query params alone — verify live account status through backend.
          await api("/api/connectors/sync", { method: "POST" }).catch(() => {});
          const status = await api(`/api/connectors/${encodeURIComponent(toolkit)}/status`).catch(() => null);
          if (status?.status === "connected") {
            setFeedback(`${PLAIN_SERVICE_NAMES[toolkit] || toolkit} connected successfully.`);
          }
          const cleanUrl = window.location.pathname + (params.get("page") ? `?page=${params.get("page")}` : "");
          window.history.replaceState({}, document.title, cleanUrl);
        }
      } catch {
        // ignore
      }
      await loadData();
    };

    checkRedirectReturn();
    return () => {
      pollAbortRef.current?.abort();
    };
  }, [api, loadData]);

  useEffect(() => {
    const onFocus = () => {
      if (!waitingFor) return;
      api(`/api/connectors/${encodeURIComponent(waitingFor)}/status`)
        .then(async (status) => {
          if (status?.status === "connected") {
            setWaitingFor(null);
            setFeedback(`${getDisplayName({ id: waitingFor })} connected successfully.`);
            setOpPending(waitingFor, null);
            await loadData();
          }
        })
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [waitingFor, api, loadData]);

  const startAuthPolling = (connectorId, displayName) => {
    pollAbortRef.current?.abort();
    const controller = new AbortController();
    pollAbortRef.current = controller;
    setWaitingFor(connectorId);
    setOpPending(connectorId, "waiting");
    setFeedback(`Waiting for authorization of ${displayName}.`);

    pollConnectorAuthorization({
      signal: controller.signal,
      checkStatus: async () => {
        await api("/api/connectors/sync", { method: "POST" }).catch(() => {});
        return api(`/api/connectors/${encodeURIComponent(connectorId)}/status`);
      },
    }).then(async (result) => {
      if (result?.status === "connected") {
        setWaitingFor(null);
        setManualAuthLink(null);
        setFeedback(`${displayName} connected successfully.`);
        await loadData();
      } else if (result?.status === "expired") {
        setWaitingFor(null);
        setError(`Authorization for ${displayName} expired. Try Connect again.`);
      }
      setOpPending(connectorId, null);
    });
  };

  // CONNECT: open authorization in a separate tab; keep VibhavGPT intact
  const handleConnect = async (connector) => {
    if (isPending(connector.id)) return;
    setError(null);
    setFeedback(null);
    setManualAuthLink(null);
    markResult(connector.id, null);
    setOpPending(connector.id, "connecting");

    const displayName = getDisplayName(connector);
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
        onError: (message) => { setError(message); markResult(connector.id, "error"); },
      });

      if (outcome.connected) {
        setFeedback(`${displayName} connected successfully.`);
        markResult(connector.id, "success");
        await loadData();
        setOpPending(connector.id, null);
        return;
      }

      startAuthPolling(connector.id, displayName);
    } catch (err) {
      setError(err.message || `Failed to connect to ${displayName}.`);
      markResult(connector.id, "error");
      setOpPending(connector.id, null);
    }
  };

  // DISCONNECT: revokes user's credentials and removes tool access
  const handleDisconnect = async (connector) => {
    if (isPending(connector.id)) return;
    const displayName = getDisplayName(connector);
    if (!window.confirm(`Disconnect ${displayName}? Tools from this service will stop being available to your assistant.`)) {
      return;
    }

    setError(null);
    setFeedback(null);
    markResult(connector.id, null);
    setOpPending(connector.id, "disconnecting");

    try {
      const res = await api(`/api/connectors/${encodeURIComponent(connector.id)}/disconnect`, {
        method: "POST",
      });
      if (res.success || res.disconnected) {
        setFeedback(`${displayName} disconnected.`);
        setManageOpenId(null);
        await loadData();
      } else {
        throw new Error(res.error || `Failed to disconnect ${displayName}.`);
      }
    } catch (err) {
      setError(err.message || `Failed to disconnect ${displayName}.`);
      markResult(connector.id, "error");
    } finally {
      setOpPending(connector.id, null);
    }
  };

  // ENABLE / DISABLE: toggles tool-use permission while keeping authorization separate
  const handleToggleEnabled = async (connector) => {
    if (isPending(connector.id)) return;
    const displayName = getDisplayName(connector);
    const nextState = !connector.enabled;

    setError(null);
    setFeedback(null);
    markResult(connector.id, null);
    setOpPending(connector.id, "toggling");

    try {
      const res = await api(`/api/connectors/${encodeURIComponent(connector.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: nextState }),
      });
      if (res.success && res.connector) {
        setFeedback(`${displayName} ${nextState ? "enabled" : "disabled"}.`);
        markResult(connector.id, "success");
        await loadData();
      } else {
        throw new Error(res.error || `Failed to update ${displayName}.`);
      }
    } catch (err) {
      setError(err.message || `Failed to update ${displayName}.`);
      markResult(connector.id, "error");
    } finally {
      setOpPending(connector.id, null);
    }
  };

  // Published connectors only (legacy bundles stay in API for ownership/sync).
  const visibleConnectors = useMemo(
    () => connectors.filter((c) => c.catalogVisible !== false),
    [connectors],
  );

  const filteredConnectors = useMemo(
    () => visibleConnectors.filter((connector) => connectorMatchesDirectoryFilters(connector, {
      query: searchQuery,
      statusFilter,
    })),
    [visibleConnectors, searchQuery, statusFilter],
  );

  // "Connected" first if any, then the rest under their category headings.
  const connectorGroups = useMemo(() => groupConnectors(filteredConnectors), [filteredConnectors]);

  const hasActiveFilters = statusFilter !== "all" || searchQuery.trim() !== "";

  // Only filters that would show something are offered; with nothing to choose between, there is no control.
  const statusChoices = useMemo(
    () => availableStatusFilters(visibleConnectors, { query: searchQuery, selected: statusFilter }),
    [visibleConnectors, searchQuery, statusFilter],
  );

  const clearFilters = () => {
    setSearchQuery("");
    setStatusFilter("all");
  };

  // Spoken, not shown: the directory has no counter, but a screen reader still hears how many rows a search left.
  const resultCountLabel = directoryResultLabel(filteredConnectors.length, visibleConnectors.length, hasActiveFilters);

  const filteredSkills = useMemo(() => {
    const q = skillSearchQuery.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) => {
      const name = (s.name || "").toLowerCase();
      const description = (s.description || "").toLowerCase();
      return name.includes(q) || description.includes(q);
    });
  }, [skills, skillSearchQuery]);

  const handleUseSkillInChat = (skill) => {
    if (!skill?.id) return;
    setSkillMenuOpenId(null);
    if (typeof onUseSkill === "function") {
      onUseSkill({ id: skill.id, name: skill.name, enabled: skill.enabled !== false });
      return;
    }
    setFeedback(`Skill “${skill.name}” is ready — open chat and type / to attach it.`);
  };

  // SKILL ACTIONS
  const handleFileUpload = async (file) => {
    if (!file) return;
    setImportError(null);
    setImportStage("validating");
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch("/api/skills/upload-preview", {
        method: "POST",
        body: formData,
        credentials: "same-origin",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to inspect skill file.");
      }
      setImportPreview(data);
      setImportConflictChoice(data.conflict ? "rename" : "overwrite");
      setImportStage("preview");
    } catch (err) {
      setImportError(err.message || "Failed to parse skill package.");
      setImportStage("upload");
    }
  };

  const handleConfirmImport = async () => {
    if (!importPreview) return;
    setImportError(null);
    try {
      const res = await api("/api/skills/import", {
        method: "POST",
        body: JSON.stringify({
          name: importPreview.name,
          description: importPreview.description,
          instructions: importPreview.instructions,
          requiredConnectors: importPreview.requiredConnectors,
          overwrite: importConflictChoice === "overwrite",
          skillId: importPreview.conflict?.existingId,
        }),
      });
      setFeedback(`Skill "${res.skill?.name || importPreview.name}" imported successfully.`);
      setImportModalOpen(false);
      setImportStage("upload");
      setImportPreview(null);
      await loadData();
    } catch (err) {
      setImportError(err.message || "Failed to import skill.");
    }
  };

  const openNewSkillModal = () => {
    setEditingSkill(null);
    setSkillForm({
      name: "",
      description: "",
      instructions: "",
      requiredConnectors: [],
    });
    setSkillModalOpen(true);
  };

  const openEditSkillModal = (skill) => {
    setEditingSkill(skill);
    setSkillForm({
      name: skill.name,
      description: skill.description || "",
      instructions: skill.instructions,
      requiredConnectors: skill.requiredConnectors || [],
    });
    setSkillModalOpen(true);
  };

  const handleSaveSkill = async (e) => {
    e.preventDefault();
    if (!skillForm.name.trim() || !skillForm.instructions.trim()) return;

    setError(null);
    try {
      if (editingSkill) {
        await api(`/api/skills/${editingSkill.id}`, {
          method: "PUT",
          body: JSON.stringify(skillForm),
        });
        setFeedback("Skill updated.");
      } else {
        await api("/api/skills", {
          method: "POST",
          body: JSON.stringify(skillForm),
        });
        setFeedback("Skill created.");
      }
      setSkillModalOpen(false);
      await loadData();
    } catch (err) {
      setError(err.message || "Failed to save skill.");
    }
  };

  const handleDeleteSkill = async (skillId) => {
    if (!window.confirm("Delete this reusable skill?")) return;
    setSkillOps((prev) => ({ ...prev, [skillId]: "deleting" }));
    try {
      await api(`/api/skills/${skillId}`, { method: "DELETE" });
      setFeedback("Skill deleted.");
      await loadData();
    } catch (err) {
      setError(err.message || "Failed to delete skill.");
    } finally {
      setSkillOps((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== skillId)));
    }
  };

  const handleToggleSkill = async (skill) => {
    setSkillOps((prev) => ({ ...prev, [skill.id]: "toggling" }));
    try {
      await api(`/api/skills/${skill.id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !skill.enabled }),
      });
      await loadData();
    } catch (err) {
      setError(err.message || "Failed to toggle skill.");
    } finally {
      setSkillOps((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== skill.id)));
    }
  };

  return (
    <main className="page page--wide extensions-page">
      {/* Header */}
      <header className="extensions-header">
        <div className="extensions-header__left">
          {onBack && (
            <button type="button" className="ext-btn ext-btn--text extensions-back" onClick={onBack} aria-label="Back to chat">
              <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
              <span>Chat</span>
            </button>
          )}
          <h1 className="extensions-title">Skills and connectors</h1>
          <p className="extensions-lede">Connect a service, or save a skill to use in chat.</p>
        </div>

        <button
          type="button"
          className="ext-btn ext-btn--quiet extensions-refresh-btn"
          onClick={loadData}
          disabled={loading}
          aria-busy={loading || undefined}
          title="Refresh connection state"
          aria-label="Refresh connection state"
        >
          <RefreshCw size={15} className={loading ? "ext-spin" : ""} aria-hidden="true" />
          <span>Refresh</span>
        </button>
      </header>

      {/* Notices */}
      {feedback && (
        <Banner tone="success">{feedback}</Banner>
      )}
      {error && (
        <Banner tone="error">{error}</Banner>
      )}
      {manualAuthLink && (
        <Banner tone="info" icon={Plug} title="Authorization needs a separate tab." help="Your browser blocked the window that signs you in to this service. Open the authorization link, sign in there, then come back to VibhavGPT to finish connecting." action={<a className="btn btn--secondary" href={manualAuthLink} target="_blank" rel="noopener noreferrer">Open authorization</a>} />
      )}

      {/* Tabs: text and a rule, no counts */}
      <nav className="extensions-tabs" role="tablist" aria-label="Extensions Navigation">
        <button
          type="button"
          role="tab"
          id="ext-tab-connectors"
          aria-controls="ext-panel-connectors"
          className={`extensions-tabs__tab ${activeTab === "connectors" || activeTab === "plugins" ? "extensions-tabs__tab--active" : ""}`}
          aria-selected={activeTab === "connectors" || activeTab === "plugins"}
          onClick={() => setActiveTab("connectors")}
        >
          Connectors
        </button>

        <button
          type="button"
          role="tab"
          id="ext-tab-skills"
          aria-controls="ext-panel-skills"
          className={`extensions-tabs__tab ${activeTab === "skills" ? "extensions-tabs__tab--active" : ""}`}
          aria-selected={activeTab === "skills"}
          onClick={() => setActiveTab("skills")}
        >
          Skills
        </button>
      </nav>

      {/* TAB 1: CONNECTORS. A dense list: Connected first, then plain category headings. */}
      {(activeTab === "connectors" || activeTab === "plugins") && (
        <section className="extensions-section" id="ext-panel-connectors" role="tabpanel" aria-labelledby="ext-tab-connectors">
          <div className="ext-controls">
            <div className="ext-search">
              <Search size={16} strokeWidth={2} className="ext-search__icon" aria-hidden="true" />
              <input
                type="search"
                className="ext-search__input"
                placeholder="Search connectors"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && searchQuery) {
                    event.preventDefault();
                    setSearchQuery("");
                  }
                }}
                aria-label="Search connectors by name"
                aria-controls="connectors-list"
              />
            </div>
            {statusChoices.length > 1 && (
              <div className="ext-select">
                <select
                  className="ext-select__control"
                  aria-label="Filter connectors"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  disabled={loading && connectors.length === 0}
                  aria-busy={(loading && connectors.length === 0) || undefined}
                  aria-invalid={(Boolean(error) && connectors.length === 0) || undefined}
                  data-state={statusFilter !== "all" ? "success" : undefined}
                >
                  {statusChoices.map((option) => (
                    <option key={option.id} value={option.id}>{option.id === "all" ? "All connectors" : option.label}</option>
                  ))}
                </select>
                <ChevronDown size={15} strokeWidth={2} className="ext-select__chevron" aria-hidden="true" />
              </div>
            )}
          </div>

          {/* The directory has no counter; this is for a screen reader. */}
          <p className="sr-only" role="status" aria-live="polite">{resultCountLabel}</p>

          <div id="connectors-list">
            {loading && connectors.length === 0 ? (
              <p className="ext-state" role="status">
                <Loader2 size={16} className="ext-spin" aria-hidden="true" />
                <span>Loading connectors…</span>
              </p>
            ) : filteredConnectors.length === 0 ? (
              <div className="ext-state ext-state--stacked" role="status">
                <p className="ext-state__title">{visibleConnectors.length === 0 ? "No connectors to show" : "No connectors match"}</p>
                <p>
                  {visibleConnectors.length === 0
                    ? "The connector directory is empty."
                    : searchQuery.trim()
                      ? `Nothing matches “${searchQuery.trim()}”.`
                      : "Nothing matches this filter."}
                </p>
                {hasActiveFilters && (
                  <button type="button" className="ext-btn" onClick={clearFilters}>
                    Clear filters
                  </button>
                )}
              </div>
            ) : null}

            {connectorGroups.map((group) => (
              <section key={group.id} className="ext-group" aria-labelledby={`ext-group-${group.id}`}>
                <h2 className="ext-group__title" id={`ext-group-${group.id}`}>{group.title}</h2>
                <ul className="ext-list" role="list">
                  {group.items.map((connector) => {
                    const displayName = getDisplayName(connector);
                    const isConnected = connector.status === "connected";
                    const isConfigRequired = connector.status === "configuration_required";
                    const needsVerification = connector.status === "verification_required";
                    const isWaiting = connector.status === "pending_auth";
                    // The provider no longer has a live connection (its sign-in expired or was removed): say so, and offer Reconnect.
                    const needsReconnect = connector.status === "needs_reconnect";
                    const needsPermissions = connectorNeedsPermissions(connector);
                    const isSystem = connector.configured && (connector.id === "weather" || connector.id === "web_search");
                    const op = pendingOps[connector.id];
                    const result = rowResult[connector.id];
                    const accountName = connector.metadata?.accountName || connector.metadata?.email;
                    const manageOpen = manageOpenId === connector.id;
                    const panelId = `ext-manage-${connector.id}`;
                    const notice = connector.blockerNotice && (isConfigRequired || needsVerification || needsPermissions || isWaiting || needsReconnect) ? connector.blockerNotice : null;

                    return (
                      <li
                        key={connector.id}
                        className="ext-row"
                        data-status={connector.status}
                        data-enabled={connector.enabled}
                        data-open={manageOpen || undefined}
                      >
                        <div className="ext-row__logo" aria-hidden="true">
                          <ServiceLogo serviceId={connector.id} size={28} />
                        </div>

                        <div className="ext-row__text">
                          <p className="ext-row__name">
                            <span>{displayName}</span>
                            {/* Rows under the "Connected" heading do not repeat it in sight; a screen reader still hears each row's state. */}
                            {isConnected && <span className="sr-only">Connected</span>}
                            {needsReconnect && (
                              <span className="ext-mark ext-mark--warn"><AlertCircle size={13} strokeWidth={2.25} aria-hidden="true" />Needs reconnecting</span>
                            )}
                            {isConfigRequired && <span className="ext-mark ext-mark--warn">Setup required</span>}
                            {needsVerification && <span className="ext-mark ext-mark--warn"><AlertCircle size={13} strokeWidth={2.25} aria-hidden="true" />Verification required</span>}
                            {isWaiting && <span className="ext-mark ext-mark--warn">Waiting for authorization</span>}
                            {needsPermissions && (
                              <span className="ext-mark ext-mark--warn"><AlertCircle size={13} strokeWidth={2.25} aria-hidden="true" />Needs permissions</span>
                            )}
                          </p>
                          {isConnected && accountName && (
                            <p className="ext-row__meta" title={`Linked account: ${accountName}`}>{accountName}</p>
                          )}
                          {notice && <p className="ext-row__meta" role="note">{notice}</p>}
                        </div>

                        <div className="ext-row__actions">
                          {isConnected ? (
                            <button
                              type="button"
                              className="ext-btn ext-btn--quiet"
                              aria-expanded={manageOpen}
                              aria-controls={panelId}
                              aria-label={`Manage ${displayName}`}
                              data-state={result}
                              onClick={() => setManageOpenId(manageOpen ? null : connector.id)}
                            >
                              <span>Manage</span>
                              <ChevronDown size={14} strokeWidth={2} className="ext-btn__chevron" aria-hidden="true" />
                            </button>
                          ) : needsVerification ? (
                            // Reconnecting gives the new account an alias tied to this person, which is what verifies it (account-ownership.js).
                            <button
                              type="button"
                              className="ext-btn"
                              onClick={() => handleConnect(connector)}
                              disabled={isPending(connector.id)}
                              aria-busy={op === "connecting" || op === "waiting" || undefined}
                              title={connector.blockerNotice || "Reconnect to verify"}
                              aria-label={`Reconnect ${displayName} to verify it`}
                            >
                              <span>Reconnect to verify</span>
                            </button>
                          ) : isConfigRequired ? (
                            <button
                              type="button"
                              className="ext-btn"
                              disabled
                              title={connector.blockerNotice || "Requires owner configuration"}
                              aria-label={`${displayName} requires owner setup`}
                            >
                              <span>Setup required</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="ext-btn"
                              onClick={() => handleConnect(connector)}
                              disabled={isPending(connector.id)}
                              aria-busy={op === "connecting" || op === "waiting" || undefined}
                              data-state={result}
                              aria-label={`${needsReconnect ? "Reconnect" : "Connect"} ${displayName}`}
                            >
                              {op === "connecting" ? (
                                <>
                                  <Loader2 size={14} className="ext-spin" aria-hidden="true" />
                                  <span>{needsReconnect ? "Reconnecting…" : "Connecting…"}</span>
                                </>
                              ) : (
                                <span>{needsReconnect ? "Reconnect" : "Connect"}</span>
                              )}
                            </button>
                          )}
                        </div>

                        {isConnected && manageOpen && (
                          <div className="ext-row__manage" id={panelId}>
                            <label className="ext-switch">
                              <input
                                type="checkbox"
                                role="switch"
                                checked={Boolean(connector.enabled)}
                                onChange={() => handleToggleEnabled(connector)}
                                disabled={isPending(connector.id)}
                                aria-label={`Enable or disable ${displayName}`}
                              />
                              <span className="ext-switch__track" aria-hidden="true" />
                              <span className="ext-switch__text">{connector.enabled ? "Enabled" : "Disabled"}</span>
                            </label>
                            {!isSystem && (
                              <button
                                type="button"
                                className="ext-btn ext-btn--quiet"
                                onClick={() => handleDisconnect(connector)}
                                disabled={isPending(connector.id)}
                                aria-busy={op === "disconnecting" || undefined}
                                aria-label={`Disconnect ${displayName}`}
                              >
                                {op === "disconnecting" ? <Loader2 size={14} className="ext-spin" aria-hidden="true" /> : null}
                                <span>Disconnect</span>
                              </button>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </section>
      )}

      {/* TAB 2: SKILLS. One set of actions; a plain explanation when there are none; the same dense list when there are. */}
      {activeTab === "skills" && (
        <section className="extensions-section skills-library" id="ext-panel-skills" role="tabpanel" aria-labelledby="ext-tab-skills">
          <div className="ext-toolbar">
            <h2 className="ext-toolbar__title">Skills</h2>
            <div className="ext-toolbar__actions">
              <button
                type="button"
                className="ext-btn"
                onClick={() => {
                  setImportStage("upload");
                  setImportPreview(null);
                  setImportError(null);
                  setImportModalOpen(true);
                }}
                aria-label="Import skill"
              >
                <Upload size={15} strokeWidth={2} aria-hidden="true" />
                <span>Import</span>
              </button>
              <button type="button" className="ext-btn ext-btn--primary" onClick={openNewSkillModal} aria-label="Create skill">
                <Plus size={15} strokeWidth={2.25} aria-hidden="true" />
                <span>Create skill</span>
              </button>
            </div>
          </div>

          {skills.length > 0 && (
            <div className="ext-search ext-search--skills">
              <Search size={16} strokeWidth={2} className="ext-search__icon" aria-hidden="true" />
              <input
                type="search"
                className="ext-search__input"
                placeholder="Search skills"
                value={skillSearchQuery}
                onChange={(e) => setSkillSearchQuery(e.target.value)}
                aria-label="Search skills"
              />
            </div>
          )}

          {loading ? (
            <p className="ext-state" role="status">
              <Loader2 size={16} className="ext-spin" aria-hidden="true" />
              <span>Loading skills…</span>
            </p>
          ) : error && skills.length === 0 ? (
            <div className="ext-state ext-state--stacked" role="alert">
              <p className="ext-state__title">Skills did not load</p>
              <p>{error}</p>
              <button type="button" className="ext-btn" onClick={loadData}>Retry</button>
            </div>
          ) : skills.length === 0 ? (
            <div className="ext-empty">
              <p>A skill is a set of instructions you save once, such as how you want a weekly update written.</p>
              <p>In chat, type / and pick a skill. Its instructions are added to the assistant&rsquo;s guidance for that reply.</p>
              <p>If you pick none, every enabled skill applies. Disable a skill to stop that.</p>
            </div>
          ) : filteredSkills.length === 0 ? (
            <div className="ext-state ext-state--stacked" role="status">
              <p className="ext-state__title">No matching skills</p>
              <p>Try a different search.</p>
            </div>
          ) : (
            <ul className="ext-list" role="list">
              {filteredSkills.map((skill) => {
                const enabled = skill.enabled !== false;
                const busy = Boolean(skillOps[skill.id]);
                return (
                  <li key={skill.id} className="ext-row ext-row--skill" data-enabled={enabled}>
                    <div className="ext-row__text">
                      <p className="ext-row__name">
                        <span>{skill.name}</span>
                        {!enabled && <span className="ext-mark">Disabled</span>}
                      </p>
                      {skill.description ? <p className="ext-row__meta">{skill.description}</p> : null}
                    </div>
                    <div className="ext-row__actions">
                      <button
                        type="button"
                        className="ext-btn"
                        onClick={() => handleUseSkillInChat(skill)}
                        disabled={!enabled || busy}
                        aria-label={`Use ${skill.name} in chat`}
                      >
                        <span>Use in chat</span>
                      </button>
                      <Menu
                        label={`Actions for ${skill.name}`}
                        align="end"
                        trigger={({ ref, open, toggle }) => (
                          <button
                            ref={ref}
                            type="button"
                            className="ext-btn ext-btn--icon"
                            aria-haspopup="menu"
                            aria-expanded={open}
                            aria-busy={busy || undefined}
                            disabled={busy}
                            aria-label={`More actions for ${skill.name}`}
                            onClick={toggle}
                          >
                            {busy ? <Loader2 size={16} className="ext-spin" aria-hidden="true" /> : <MoreHorizontal size={16} aria-hidden="true" />}
                          </button>
                        )}
                      >
                        <MenuItem icon={<Edit2 aria-hidden="true" />} onSelect={() => openEditSkillModal(skill)}>Edit</MenuItem>
                        <MenuItem icon={enabled ? <PowerOff aria-hidden="true" /> : <Power aria-hidden="true" />} onSelect={() => handleToggleSkill(skill)}>{enabled ? "Disable" : "Enable"}</MenuItem>
                        <MenuItem icon={<Trash2 aria-hidden="true" />} tone="danger" onSelect={() => handleDeleteSkill(skill.id)}>Delete</MenuItem>
                      </Menu>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* SKILL CREATION / EDIT MODAL */}
      {skillModalOpen && (
        <div className="ui-modal-backdrop" onClick={() => setSkillModalOpen(false)}>
          <div className="ui-modal skill-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-labelledby="skill-modal-title">
            <header className="ui-modal__head">
              <div>
                <h2 id="skill-modal-title" className="ui-modal__title">{editingSkill ? "Edit skill" : "Create skill"}</h2>
              </div>
            </header>

            <form onSubmit={handleSaveSkill} className="skill-dialog__form">
              <label className="field-group">
                <span className="field-label">Name</span>
                <input
                  type="text"
                  required
                  maxLength={80}
                  className="input"
                  placeholder="Name"
                  value={skillForm.name}
                  onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })}
                />
              </label>

              <label className="field-group">
                <span className="field-label">Brief description</span>
                <input
                  type="text"
                  maxLength={300}
                  className="input"
                  placeholder="Optional short description"
                  value={skillForm.description}
                  onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })}
                />
              </label>

              <label className="field-group">
                <span className="field-label">Instructions</span>
                <textarea
                  required
                  rows={6}
                  maxLength={50000}
                  className="input textarea-instructions"
                  placeholder="What should the assistant do when this skill is used?"
                  value={skillForm.instructions}
                  onChange={(e) => setSkillForm({ ...skillForm, instructions: e.target.value })}
                />
              </label>

              <div className="ui-modal__actions">
                <button type="button" className="btn btn--quiet" onClick={() => setSkillModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn--primary" disabled={!skillForm.name.trim() || !skillForm.instructions.trim()}>
                  {editingSkill ? "Save changes" : "Create skill"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* SKILL IMPORT MODAL (.md and .zip) */}
      {importModalOpen && (
        <div className="ui-modal-backdrop" onClick={() => setImportModalOpen(false)}>
          <div className="ui-modal skill-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-labelledby="import-skill-title">
            <header className="ui-modal__head">
              <div>
                <span className="ui-modal__eyebrow">Skills Package</span>
                <h2 id="import-skill-title" className="ui-modal__title">Import skill</h2>
              </div>
            </header>

            {importError && (
              <Banner tone="error" className="skill-import__error">{importError}</Banner>
            )}

            {importStage === "validating" && (
              <div style={{ padding: "40px 20px", textAlign: "center" }}>
                <RefreshCw size={28} className="spin" style={{ color: "var(--color-accent)", marginBottom: 12 }} />
                <p style={{ margin: 0, fontWeight: 550 }}>Validating package instructions…</p>
              </div>
            )}

            {importStage === "upload" && (
              <div style={{ padding: "20px 0 0" }}>
                <div
                  className={`skill-dropzone ${isDragging ? "skill-dropzone--dragging" : ""}`}
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDragging(false);
                    const file = e.dataTransfer?.files?.[0];
                    if (file) handleFileUpload(file);
                  }}
                  onClick={() => document.getElementById("skill-file-input")?.click()}
                  tabIndex={0}
                  role="button"
                  aria-label="Upload skill package (.md or .zip)"
                >
                  <input
                    id="skill-file-input"
                    type="file"
                    accept=".md,.zip,.markdown"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleFileUpload(file);
                    }}
                  />
                  <Upload size={32} strokeWidth={1.8} className="skill-dropzone__icon" />
                  <p className="skill-dropzone__title">Click to upload or drag and drop</p>
                  <p className="skill-dropzone__formats">Supports markdown files (.md) and skill packages (.zip)</p>
                </div>
                <p className="field-hint" style={{ marginTop: 12, textAlign: "center" }}>
                  Skills are reusable instructions. Connected actions still require your approval.
                </p>
                <div className="ui-modal__actions" style={{ marginTop: 20 }}>
                  <button type="button" className="btn btn--quiet" onClick={() => setImportModalOpen(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {importStage === "preview" && importPreview && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "20px 0 0" }}>
                <div className="skill-preview-box">
                  <div className="skill-preview-field">
                    <span className="skill-preview-label">Name</span>
                    <input
                      type="text"
                      className="input"
                      value={importPreview.name}
                      onChange={(e) => setImportPreview({ ...importPreview, name: e.target.value })}
                    />
                  </div>

                  {importPreview.description && (
                    <div className="skill-preview-field">
                      <span className="skill-preview-label">Description</span>
                      <span className="skill-preview-val">{importPreview.description}</span>
                    </div>
                  )}

                  <div className="skill-preview-field">
                    <span className="skill-preview-label">Instructions</span>
                    <div className="skill-preview-instructions">
                      {importPreview.instructions}
                    </div>
                  </div>

                  {importPreview.resources && importPreview.resources.length > 0 && (
                    <div className="skill-preview-field">
                      <span className="skill-preview-label">Supporting Resources</span>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                        {importPreview.resources.map((res, i) => (
                          <span key={i} className="skill-resources-pill">
                            <FileCode size={12} />
                            {res.name} ({Math.round(res.size / 1024)} KB)
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {importPreview.conflict && (
                  <div className="skill-conflict-alert">
                    <span className="skill-conflict-alert__title">
                      A skill named "{importPreview.conflict.existingName}" already exists.
                    </span>
                    <div className="skill-conflict-options">
                      <label className="skill-conflict-option">
                        <input
                          type="radio"
                          name="conflictChoice"
                          value="rename"
                          checked={importConflictChoice === "rename"}
                          onChange={() => setImportConflictChoice("rename")}
                        />
                        <span>Rename imported skill to "{importPreview.name} (Imported)"</span>
                      </label>
                      <label className="skill-conflict-option">
                        <input
                          type="radio"
                          name="conflictChoice"
                          value="overwrite"
                          checked={importConflictChoice === "overwrite"}
                          onChange={() => setImportConflictChoice("overwrite")}
                        />
                        <span>Update existing skill "{importPreview.conflict.existingName}"</span>
                      </label>
                    </div>
                  </div>
                )}

                <div className="ui-modal__actions">
                  <button
                    type="button"
                    className="btn btn--quiet"
                    onClick={() => {
                      setImportStage("upload");
                      setImportPreview(null);
                    }}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={!importPreview.name.trim() || !importPreview.instructions.trim()}
                    onClick={handleConfirmImport}
                  >
                    Confirm import
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

export default Extensions;
