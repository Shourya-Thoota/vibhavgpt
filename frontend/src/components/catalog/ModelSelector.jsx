import { useState, useRef, useEffect } from "react";
import {
  ChevronDown,
  Sparkles,
  Brain,
  Wrench,
  Plug,
  Folder,
  Check,
  Lock,
  Layers,
  Search,
  Zap,
  Globe,
  Palette,
  GraduationCap,
  FileCode,
  ExternalLink,
  Shield,
  CloudSun,
} from "lucide-react";

export function ModelSelector({
  userPlan = "free",
  projects = [],
  activeProjectId,
  onSelectProject,
  activeModel,
  recentModels = [],
  onSelectModel,
  onOpenCatalog,
  thinkingLevel = "normal", // "off" | "low" | "normal" | "high"
  onChangeThinkingLevel,
  activeTools = { webSearch: true, canvas: true, study: true, images: false },
  onToggleTool,
  onOpenConnectors,
  connectors = [],
}) {
  const [openDropdown, setOpenDropdown] = useState(null); // "project" | "model" | "thinking" | "tools" | "plugins" | null
  const selectorRef = useRef(null);

  // Close dropdown on outside click or Escape
  useEffect(() => {
    const handleOutsideClick = (e) => {
      if (selectorRef.current && !selectorRef.current.contains(e.target)) {
        setOpenDropdown(null);
      }
    };

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        setOpenDropdown(null);
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const toggleDropdown = (name) => {
    setOpenDropdown((prev) => (prev === name ? null : name));
  };

  const isFreePlan = userPlan.toLowerCase() === "free";
  const isPlusPlan = userPlan.toLowerCase() === "plus";
  const activeProj = projects.find((p) => p.id === activeProjectId) || projects[0] || {
    id: "proj-default",
    name: "Personal Workspace",
  };

  const currentModelId = String(activeModel?.id || activeModel?.value || activeModel || "lumen").toLowerCase();
  const isAuto = currentModelId === "auto";

  // Native core models list
  const coreModels = [
    {
      id: "auto",
      displayName: "Auto Router",
      shortName: "Auto",
      isAuto: true,
      description: "Automated complexity classifier routing to optimal compute tier.",
      consumptionTier: { shortLabel: "Auto", color: "#06b6d4" },
      locked: false,
    },
    {
      id: "lumen",
      displayName: "VibhavGPT Lumen",
      shortName: "Lumen",
      isNative: true,
      description: "Low consumption everyday assistance.",
      consumptionTier: { shortLabel: "Low", color: "#10b981" },
      locked: false,
    },
    {
      id: "nova",
      displayName: "VibhavGPT Nova",
      shortName: "Nova",
      isNative: true,
      description: "General-purpose help with balanced reasoning capacity.",
      consumptionTier: { shortLabel: "Medium", color: "#eab308" },
      locked: false,
    },
    {
      id: "nebula",
      displayName: "VibhavGPT Nebula",
      shortName: "Nebula",
      isNative: true,
      description: "High-compute technical analysis and coding capacity.",
      consumptionTier: { shortLabel: "High", color: "#f97316" },
      locked: false,
    },
    {
      id: "vesper",
      displayName: "VibhavGPT Vulcan",
      shortName: "Vulcan",
      isNative: true,
      description: "Flagship frontier reasoning model. Strictest request privacy.",
      consumptionTier: { shortLabel: "Extra High", color: "#ef4444" },
      locked: isFreePlan || isPlusPlan,
      lockReason: "Extra High (Red Dot) compute models require a Pro subscription.",
    },
  ];

  const currentModelObj = coreModels.find((m) => m.id === currentModelId) || {
    id: currentModelId,
    displayName: activeModel?.displayName || activeModel?.label || currentModelId,
    shortName: currentModelId,
    consumptionTier: { shortLabel: "Standard", color: "#10b981" },
  };

  const supportsReasoning = ["nova", "nebula", "vesper", "auto"].includes(currentModelId);

  return (
    <nav className="catalog-top-selector" ref={selectorRef} aria-label="Model and Workspace Controls">
      {/* 1. Project Selector Dropdown */}
      <div className="selector-item">
        <button
          type="button"
          className="selector-btn selector-btn--project"
          onClick={() => toggleDropdown("project")}
          aria-expanded={openDropdown === "project"}
          aria-haspopup="listbox"
          aria-label={`Current project: ${activeProj.name}. Click to switch project.`}
        >
          <Folder size={15} strokeWidth={2} className="selector-icon" aria-hidden="true" />
          <span className="selector-text selector-text--project">{activeProj.name}</span>
          <ChevronDown size={14} strokeWidth={2} className="selector-chevron" aria-hidden="true" />
        </button>

        {openDropdown === "project" && (
          <div className="selector-menu selector-menu--project" role="listbox">
            <div className="selector-menu__header">Switch Workspace</div>
            {projects.length > 0 ? (
              projects.map((proj) => (
                <button
                  key={proj.id}
                  type="button"
                  className={`selector-menu__item ${proj.id === activeProj.id ? "selector-menu__item--active" : ""}`}
                  role="option"
                  aria-selected={proj.id === activeProj.id}
                  onClick={() => {
                    onSelectProject?.(proj.id);
                    setOpenDropdown(null);
                  }}
                >
                  <Folder size={14} strokeWidth={2} aria-hidden="true" />
                  <span className="selector-menu__label">{proj.name}</span>
                  {proj.id === activeProj.id && (
                    <Check size={14} strokeWidth={2.5} className="selector-menu__check" aria-hidden="true" />
                  )}
                </button>
              ))
            ) : (
              <div className="selector-menu__item selector-menu__item--active">
                <Folder size={14} strokeWidth={2} aria-hidden="true" />
                <span className="selector-menu__label">Personal Workspace</span>
                <Check size={14} strokeWidth={2.5} className="selector-menu__check" aria-hidden="true" />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="selector-divider" aria-hidden="true" />

      {/* 2. Active Model Pill and Dropdown */}
      <div className="selector-item">
        <button
          type="button"
          className={`selector-btn selector-btn--model ${
            isAuto ? "selector-btn--auto" : "selector-btn--native"
          }`}
          onClick={() => toggleDropdown("model")}
          aria-expanded={openDropdown === "model"}
          aria-haspopup="true"
          aria-label={`Selected model: ${currentModelObj.displayName}. Click to change model.`}
        >
          {isAuto ? (
            <Sparkles size={15} strokeWidth={2} className="selector-icon selector-icon--auto" aria-hidden="true" />
          ) : (
            <span
              className="consumption-dot"
              style={{ backgroundColor: currentModelObj.consumptionTier?.color || "#10b981" }}
              aria-hidden="true"
            />
          )}

          <span className="selector-text selector-text--model">
            {currentModelObj.shortName || currentModelObj.displayName}
          </span>

          {currentModelObj.consumptionTier && (
            <span className="selector-consumption-badge">
              {currentModelObj.consumptionTier.shortLabel}
            </span>
          )}

          <ChevronDown size={14} strokeWidth={2} className="selector-chevron" aria-hidden="true" />
        </button>

        {openDropdown === "model" && (
          <div className="selector-menu selector-menu--model" role="menu">
            <div className="selector-menu__header">Select Working Model</div>

            {coreModels.map((m) => {
              const isSelected = m.id === currentModelId;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`selector-menu__item ${isSelected ? "selector-menu__item--active" : ""} ${
                    m.locked ? "selector-menu__item--locked" : ""
                  }`}
                  disabled={m.locked}
                  title={m.locked ? m.lockReason : m.description}
                  onClick={() => {
                    if (!m.locked) {
                      onSelectModel?.(m.id);
                      setOpenDropdown(null);
                    }
                  }}
                >
                  {m.isAuto ? (
                    <Sparkles size={14} strokeWidth={2} className="selector-icon--auto" aria-hidden="true" />
                  ) : (
                    <span
                      className="consumption-dot"
                      style={{ backgroundColor: m.consumptionTier.color }}
                      aria-hidden="true"
                    />
                  )}
                  <div className="selector-menu__item-info">
                    <span className="selector-menu__label">{m.displayName}</span>
                    <span className="selector-menu__hint">{m.description}</span>
                  </div>
                  {m.locked ? (
                    <Lock size={13} strokeWidth={2} className="selector-menu__lock" aria-hidden="true" />
                  ) : isSelected ? (
                    <Check size={14} strokeWidth={2.5} className="selector-menu__check" aria-hidden="true" />
                  ) : null}
                </button>
              );
            })}

            {/* Quick action: Open Full Catalog */}
            <div className="selector-menu__action-row">
              <button
                type="button"
                className="selector-menu__catalog-btn"
                onClick={() => {
                  setOpenDropdown(null);
                  onOpenCatalog?.();
                }}
              >
                <Layers size={15} strokeWidth={2} aria-hidden="true" />
                <span>Browse Models Catalog…</span>
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="selector-divider" aria-hidden="true" />

      {/* 3. Capability-Aware Thinking Controls */}
      <div className="selector-item">
        <button
          type="button"
          className={`selector-btn selector-btn--thinking ${
            !supportsReasoning ? "selector-btn--disabled" : thinkingLevel !== "off" ? "selector-btn--active" : ""
          }`}
          onClick={() => supportsReasoning && toggleDropdown("thinking")}
          disabled={!supportsReasoning}
          aria-expanded={openDropdown === "thinking"}
          aria-haspopup="listbox"
          aria-label={`Thinking effort: ${thinkingLevel}. ${
            supportsReasoning ? "Click to adjust reasoning depth." : "Reasoning not supported on this model."
          }`}
        >
          <Brain size={15} strokeWidth={2} className="selector-icon" aria-hidden="true" />
          <span className="selector-text selector-text--thinking">
            Thinking: {thinkingLevel.charAt(0).toUpperCase() + thinkingLevel.slice(1)}
          </span>
          <ChevronDown size={14} strokeWidth={2} className="selector-chevron" aria-hidden="true" />
        </button>

        {openDropdown === "thinking" && supportsReasoning && (
          <div className="selector-menu selector-menu--thinking" role="listbox">
            <div className="selector-menu__header">Reasoning Depth</div>
            {[
              { level: "off", label: "Off", hint: "Zero reasoning tokens; immediate response" },
              { level: "low", label: "Low", hint: "Fast lightweight reasoning pass (~1,024 tokens)" },
              { level: "normal", label: "Normal", hint: "Standard balanced reasoning (~2,048 tokens)" },
              { level: "high", label: "High", hint: "Deep step-by-step reasoning (~4,096 tokens)" },
            ].map(({ level, label, hint }) => (
              <button
                key={level}
                type="button"
                className={`selector-menu__item ${thinkingLevel === level ? "selector-menu__item--active" : ""}`}
                role="option"
                aria-selected={thinkingLevel === level}
                onClick={() => {
                  onChangeThinkingLevel?.(level);
                  setOpenDropdown(null);
                }}
              >
                <div className="selector-menu__item-info">
                  <span className="selector-menu__label">{label}</span>
                  <span className="selector-menu__hint">{hint}</span>
                </div>
                {thinkingLevel === level && (
                  <Check size={14} strokeWidth={2.5} className="selector-menu__check" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="selector-divider" aria-hidden="true" />

      {/* 4. Plus Optimization Toggles (Tools & Modes) */}
      <div className="selector-item">
        <button
          type="button"
          className="selector-btn selector-btn--tools"
          onClick={() => toggleDropdown("tools")}
          aria-expanded={openDropdown === "tools"}
          aria-haspopup="true"
          aria-label="Capabilities and Tooling Toggles"
        >
          <Wrench size={15} strokeWidth={2} className="selector-icon" aria-hidden="true" />
          <span className="selector-text selector-text--tools">Tools</span>
          <ChevronDown size={14} strokeWidth={2} className="selector-chevron" aria-hidden="true" />
        </button>

        {openDropdown === "tools" && (
          <div className="selector-menu selector-menu--tools">
            <div className="selector-menu__header">Active Context Capabilities</div>

            <label className="selector-menu__toggle-item">
              <div className="selector-menu__toggle-left">
                <Globe size={15} strokeWidth={2} aria-hidden="true" />
                <div>
                  <div className="selector-menu__label">Web Search</div>
                  <div className="selector-menu__hint">Live factual search and cited sources</div>
                </div>
              </div>
              <input
                type="checkbox"
                className="selector-toggle-input"
                checked={Boolean(activeTools.webSearch)}
                onChange={() => onToggleTool?.("webSearch")}
              />
            </label>

            <label className="selector-menu__toggle-item">
              <div className="selector-menu__toggle-left">
                <GraduationCap size={15} strokeWidth={2} aria-hidden="true" />
                <div>
                  <div className="selector-menu__label">Study Tools</div>
                  <div className="selector-menu__hint">Interactive flashcards, diagrams and quizzes</div>
                </div>
              </div>
              <input
                type="checkbox"
                className="selector-toggle-input"
                checked={Boolean(activeTools.study)}
                onChange={() => onToggleTool?.("study")}
              />
            </label>

            <div className={`selector-menu__toggle-item ${isFreePlan ? "selector-menu__toggle-item--disabled" : ""}`}>
              <div className="selector-menu__toggle-left">
                <Palette size={15} strokeWidth={2} aria-hidden="true" />
                <div>
                  <div className="selector-menu__label-row">
                    <span className="selector-menu__label">Image Generation</span>
                    {isFreePlan && <span className="selector-tool-locked-badge">Paid plans only</span>}
                  </div>
                  <div className="selector-menu__hint">
                    {isFreePlan ? "Upgrade to Plus, Pro, or Max to generate images" : "Synthetic visual assets"}
                  </div>
                </div>
              </div>
              <input
                type="checkbox"
                className="selector-toggle-input"
                checked={Boolean(activeTools.images) && !isFreePlan}
                disabled={isFreePlan}
                onChange={() => onToggleTool?.("images")}
                aria-disabled={isFreePlan}
              />
            </div>
          </div>
        )}
      </div>

      <div className="selector-divider" aria-hidden="true" />

      {/* 5. First-Party Connectors Dropdown */}
      <div className="selector-item">
        <button
          type="button"
          className="selector-btn selector-btn--plugins"
          onClick={() => toggleDropdown("plugins")}
          aria-expanded={openDropdown === "plugins"}
          aria-haspopup="menu"
          aria-label="First-Party Connectors & Plugins"
        >
          <Plug size={15} strokeWidth={2} className="selector-icon" aria-hidden="true" />
          <span className="selector-text selector-text--plugins">Connectors</span>
          <ChevronDown size={14} strokeWidth={2} className="selector-chevron" aria-hidden="true" />
        </button>

        {openDropdown === "plugins" && (
          <div className="selector-menu selector-menu--plugins" role="menu">
            <div className="selector-menu__header">First-Party Connectors (VibhavGPT/*)</div>
            <div className="selector-menu__notice" role="note">
              Consequential external actions require explicit human approval before execution.
            </div>

            <div className="selector-plugin-item">
              <div className="selector-plugin-item__left">
                <span className="selector-plugin-status-dot selector-plugin-status-dot--active" aria-hidden="true" />
                <span className="selector-plugin-name">Google Workspace</span>
              </div>
              <span className="selector-plugin-badge">OAuth 2.0</span>
            </div>

            <div className="selector-plugin-item">
              <div className="selector-plugin-item__left">
                <span className="selector-plugin-status-dot" aria-hidden="true" />
                <span className="selector-plugin-name">GitHub</span>
              </div>
              <span className="selector-plugin-badge">OAuth</span>
            </div>

            <div className="selector-plugin-item">
              <div className="selector-plugin-item__left">
                <span className="selector-plugin-status-dot selector-plugin-status-dot--active" aria-hidden="true" />
                <span className="selector-plugin-name">Weather (NOAA)</span>
              </div>
              <span className="selector-plugin-badge selector-plugin-badge--active">Built-in</span>
            </div>

            <div className="selector-plugin-item">
              <div className="selector-plugin-item__left">
                <span className="selector-plugin-status-dot selector-plugin-status-dot--active" aria-hidden="true" />
                <span className="selector-plugin-name">Web Search</span>
              </div>
              <span className="selector-plugin-badge selector-plugin-badge--active">Built-in</span>
            </div>

            <div className="selector-menu__action-row">
              <button
                type="button"
                className="selector-menu__catalog-btn"
                onClick={() => {
                  setOpenDropdown(null);
                  onOpenConnectors?.();
                }}
              >
                <Shield size={14} strokeWidth={2} aria-hidden="true" />
                <span>Manage Connectors in Settings</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}

export default ModelSelector;
