import { useState, useRef, useEffect } from "react";
import {
  ChevronDown,
  Brain,
  Blocks,
  Folder,
  Check,
  Lock,
  Layers,
} from "lucide-react";
import { BrandLogo } from "../catalog/BrandLogo.jsx";
import "./chat-header.css";

const CORE_MODELS = [
  {
    id: "auto",
    name: "Auto",
    fullName: "Auto (Recommended)",
    description: "Intelligent routing to the optimal compute model.",
    brandId: "vibhavgpt",
    orbColor: "#06b6d4",
    minTier: "free",
    supportsReasoning: true,
  },
  {
    id: "lumen",
    name: "Lumen",
    fullName: "VibhavGPT Lumen",
    description: "Fast everyday answers with minimal latency.",
    brandId: "vibhavgpt",
    orbColor: "#10b981",
    minTier: "free",
    supportsReasoning: false,
  },
  {
    id: "nova",
    name: "Nova",
    fullName: "VibhavGPT Nova",
    description: "General-purpose with balanced reasoning capacity.",
    brandId: "vibhavgpt",
    orbColor: "#eab308",
    minTier: "free",
    supportsReasoning: true,
  },
  {
    id: "nebula",
    name: "Nebula",
    fullName: "VibhavGPT Nebula",
    description: "Advanced coding and deep research capacity.",
    brandId: "vibhavgpt",
    orbColor: "#f97316",
    minTier: "plus",
    supportsReasoning: true,
  },
  {
    id: "vesper",
    name: "Vulcan",
    fullName: "VibhavGPT Vulcan",
    description: "Frontier reasoning model. Strictest request privacy.",
    brandId: "vibhavgpt",
    orbColor: "#ef4444",
    minTier: "pro",
    supportsReasoning: true,
  },
];

const THINKING_LEVELS = [
  { value: "off", label: "Thinking: Off", short: "Off" },
  { value: "low", label: "Thinking: Low", short: "Low" },
  { value: "normal", label: "Thinking: Normal", short: "Normal" },
  { value: "high", label: "Thinking: High", short: "High" },
];

export function ChatHeader({
  model = "auto",
  onSelectModel,
  onOpenCatalog,
  thinkingEffort = "normal",
  onChangeThinkingEffort,
  project = null,
  tier = "free",
  onOpenExtensions,
  onOpenBilling,
}) {
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const headerRef = useRef(null);

  // Close menus on outside click or Escape
  useEffect(() => {
    const handleOutsideClick = (e) => {
      if (headerRef.current && !headerRef.current.contains(e.target)) {
        setModelMenuOpen(false);
        setThinkingMenuOpen(false);
      }
    };
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        setModelMenuOpen(false);
        setThinkingMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const normalizedModelId = String(model?.id || model?.value || model || "auto").toLowerCase();
  const currentModel =
    CORE_MODELS.find((m) => m.id === normalizedModelId) || {
      id: "lumen",
      name: "Lumen",
      fullName: "VibhavGPT Lumen",
      brandId: "vibhavgpt",
      description: "Fast everyday answers with minimal latency.",
      supportsReasoning: false,
      minTier: "free",
      unavailable: Boolean(normalizedModelId && normalizedModelId !== "lumen"),
      previousId: normalizedModelId,
    };

  // Thinking controls only rendered for models that support reasoning
  const supportsThinking = Boolean(currentModel.supportsReasoning);

  const isModelLocked = (m) => {
    if (m.minTier === "free") return false;
    const userTier = String(tier || "free").toLowerCase();
    if (m.minTier === "plus") return userTier === "free";
    if (m.minTier === "pro") return userTier === "free" || userTier === "plus";
    return false;
  };

  const currentThinkingObj =
    THINKING_LEVELS.find((lvl) => lvl.value === thinkingEffort) || THINKING_LEVELS[2];

  // Retired third-party selections are shown as unavailable, not as live vendor cards.
  const isSelectedUnavailable = Boolean(currentModel.unavailable);

  return (
    <header className="chat-header" ref={headerRef} aria-label="Conversation controls">
      <div className="chat-header__left">
        {/* Project indicator badge if chat belongs to a project */}
        {project && (
          <div className="chat-header__project-badge" title={`In project: ${project.name}`}>
            <Folder size={14} strokeWidth={2} className="chat-header__project-icon" aria-hidden="true" />
            <span className="chat-header__project-name">{project.name}</span>
          </div>
        )}

        {/* Compact Model Selector */}
        <div className="chat-header__dropdown-container">
          <button
            type="button"
            className="chat-header__pill chat-header__pill--model"
            onClick={() => {
              setModelMenuOpen((prev) => !prev);
              setThinkingMenuOpen(false);
            }}
            aria-expanded={modelMenuOpen}
            aria-haspopup="listbox"
            aria-label={`Selected model: ${currentModel.name}. Click to change.`}
          >
            <BrandLogo brandId={currentModel.brandId} size={16} className="chat-header__brand-logo" />
            <span className="chat-header__model-name">{currentModel.name}</span>
            <ChevronDown size={14} strokeWidth={2} className="chat-header__chevron" aria-hidden="true" />
          </button>

          {modelMenuOpen && (
            <div className="chat-header__menu chat-header__menu--model" role="listbox">
              <div className="chat-header__menu-header">Select Model</div>
              <div className="chat-header__menu-list">
                {isSelectedUnavailable && (
                  <div className="chat-header__menu-item chat-header__menu-item--unavailable" role="option" aria-selected={false}>
                    <div className="chat-header__item-left">
                      <div className="chat-header__item-meta">
                        <div className="chat-header__item-title-row">
                          <span className="chat-header__item-name">Previous model unavailable</span>
                        </div>
                        <span className="chat-header__item-desc">Choose Lumen, Nova, Nebula, or Vulcan.</span>
                      </div>
                    </div>
                  </div>
                )}

                {CORE_MODELS.map((m) => {
                  const locked = isModelLocked(m);
                  const selected = m.id === normalizedModelId;

                  return (
                    <button
                      key={m.id}
                      type="button"
                      className={`chat-header__menu-item ${selected ? "chat-header__menu-item--selected" : ""}`}
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        if (locked) {
                          onOpenBilling?.();
                        } else {
                          onSelectModel?.(m.id);
                        }
                        setModelMenuOpen(false);
                      }}
                    >
                      <div className="chat-header__item-left">
                        <BrandLogo brandId={m.brandId} size={16} className="chat-header__item-logo" />
                        <div className="chat-header__item-meta">
                          <div className="chat-header__item-title-row">
                            <span className="chat-header__item-name">{m.name}</span>
                            {locked ? (
                              <span className="chat-header__lock-badge">
                                <Lock size={10} strokeWidth={2.4} /> Upgrade
                              </span>
                            ) : selected ? (
                              <Check size={14} strokeWidth={2.5} className="chat-header__check" />
                            ) : null}
                          </div>
                          <span className="chat-header__item-desc">{m.description}</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {onOpenCatalog && (
                <div className="chat-header__menu-footer">
                  <button
                    type="button"
                    className="chat-header__browse-btn"
                    onClick={() => {
                      setModelMenuOpen(false);
                      onOpenCatalog();
                    }}
                  >
                    <Layers size={14} strokeWidth={2} aria-hidden="true" />
                    <span>Browse all models…</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Thinking Controls: ONLY rendered for models that support reasoning */}
        {supportsThinking && (
          <div className="chat-header__dropdown-container">
            <button
              type="button"
              className="chat-header__pill chat-header__pill--thinking"
              onClick={() => {
                setThinkingMenuOpen((prev) => !prev);
                setModelMenuOpen(false);
              }}
              aria-expanded={thinkingMenuOpen}
              aria-haspopup="listbox"
              aria-label={`Thinking effort: ${currentThinkingObj.short}. Click to change.`}
            >
              <Brain size={14} strokeWidth={2} className="chat-header__brain-icon" aria-hidden="true" />
              <span className="chat-header__thinking-label">{currentThinkingObj.short}</span>
              <ChevronDown size={14} strokeWidth={2} className="chat-header__chevron" aria-hidden="true" />
            </button>

            {thinkingMenuOpen && (
              <div className="chat-header__menu chat-header__menu--thinking" role="listbox">
                <div className="chat-header__menu-header">Reasoning Effort</div>
                <div className="chat-header__menu-list">
                  {THINKING_LEVELS.map((lvl) => {
                    const selected = lvl.value === thinkingEffort;
                    return (
                      <button
                        key={lvl.value}
                        type="button"
                        className={`chat-header__menu-item ${selected ? "chat-header__menu-item--selected" : ""}`}
                        role="option"
                        aria-selected={selected}
                        onClick={() => {
                          onChangeThinkingEffort?.(lvl.value);
                          setThinkingMenuOpen(false);
                        }}
                      >
                        <span className="chat-header__item-name">{lvl.label}</span>
                        {selected && <Check size={14} strokeWidth={2.5} className="chat-header__check" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="chat-header__right">
        {/* Dedicated Extensions shortcut button */}
        {onOpenExtensions && (
          <button
            type="button"
            className="chat-header__pill chat-header__pill--extensions"
            onClick={onOpenExtensions}
            aria-label="Open Extensions Hub"
            title="Manage Composio connectors, tool plugins, and custom skills"
          >
            <Blocks size={14} strokeWidth={2} className="chat-header__blocks-icon" aria-hidden="true" />
            <span>Extensions</span>
          </button>
        )}
      </div>
    </header>
  );
}

export default ChatHeader;
