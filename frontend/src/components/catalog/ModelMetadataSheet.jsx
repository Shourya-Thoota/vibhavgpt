import { useEffect, useRef } from "react";
import { X, Eye, Cpu, Zap, Lock, Sparkles, Check, AlertCircle } from "lucide-react";

export function ModelMetadataSheet({ model, open, onClose }) {
  const sheetRef = useRef(null);
  const closeButtonRef = useRef(null);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    setTimeout(() => {
      closeButtonRef.current?.focus();
    }, 50);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, onClose]);

  if (!open || !model) return null;

  const caps = model.capabilities || {};
  const lock = model.lockState || {};
  const tier = model.consumptionTier || {};

  return (
    <div
      className="catalog-sheet-backdrop"
      onClick={onClose}
      aria-hidden={!open}
    >
      <div
        className="catalog-sheet"
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-model-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="catalog-sheet__header">
          <div className="catalog-sheet__title-wrap">
            <span className="catalog-sheet__brand">{model.brandName}</span>
            <h2 id="sheet-model-title" className="catalog-sheet__title">
              {model.displayName}
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="catalog-sheet__close"
            onClick={onClose}
            aria-label="Close model details sheet"
          >
            <X size={20} strokeWidth={2} aria-hidden="true" />
          </button>
        </header>

        <div className="catalog-sheet__banner" role="note">
          <AlertCircle size={16} strokeWidth={2} aria-hidden="true" />
          <span>
            {model.isFixture
              ? "Synthetic preview fixture for local testing. Not verified production specifications."
              : "Technical Specifications · Model execution is disconnected from chat. Active chat continues using your native model."}
          </span>
        </div>

        <div className="catalog-sheet__content">
          {/* Status and Tier Card */}
          <section className="catalog-sheet__section" aria-label="Consumption and Availability">
            <div className="catalog-sheet__meta-grid">
              <div className="catalog-sheet__meta-card">
                <span className="catalog-sheet__meta-label">Consumption Tier</span>
                <div className="catalog-sheet__tier-badge">
                  <span
                    className="catalog-dot"
                    style={{ backgroundColor: tier.color }}
                    aria-hidden="true"
                  />
                  <span className="catalog-sheet__tier-name">{tier.label}</span>
                </div>
                <p className="catalog-sheet__meta-desc">{tier.description}</p>
              </div>

              <div className="catalog-sheet__meta-card">
                <span className="catalog-sheet__meta-label">Plan Access</span>
                <div className="catalog-sheet__access-badge">
                  {lock.locked ? (
                    <span className="catalog-badge catalog-badge--locked">
                      <Lock size={12} strokeWidth={2} aria-hidden="true" />
                      Locked
                    </span>
                  ) : (
                    <span className="catalog-badge catalog-badge--unlocked">
                      <Check size={12} strokeWidth={2.4} aria-hidden="true" />
                      Available
                    </span>
                  )}
                  <span className="catalog-sheet__plan-name">
                    {lock.locked
                      ? (lock.lockType === "compliance"
                          ? "Compliance Restricted"
                          : lock.lockType === "configuration"
                          ? "Configuration Restricted"
                          : lock.lockType === "pricing"
                          ? "Pricing Review Pending"
                          : (lock.reason || "Subscription Required"))
                      : model.planEligibility === "free"
                      ? "Free Tier & Above"
                      : model.planEligibility === "pro_only"
                      ? "Pro Plan Only"
                      : model.planEligibility === "paid"
                      ? "Plus & Pro Plans"
                      : "Included with your plan"}
                  </span>
                </div>
                {lock.locked && lock.reason && (
                  <p className="catalog-sheet__lock-reason" role="status">
                    {lock.reason}
                  </p>
                )}
              </div>
            </div>
          </section>

          {/* Description */}
          <section className="catalog-sheet__section">
            <h3 className="catalog-sheet__section-title">Overview</h3>
            <p className="catalog-sheet__text">{model.description}</p>
          </section>

          {/* Documented Strengths */}
          {model.documentedStrengths && (
            <section className="catalog-sheet__section">
              <h3 className="catalog-sheet__section-title">
                <Sparkles size={16} strokeWidth={2} aria-hidden="true" />
                Documented Strengths
              </h3>
              <p className="catalog-sheet__text catalog-sheet__strengths">
                {model.documentedStrengths}
              </p>
            </section>
          )}

          {/* Context Window & Token Capacity */}
          <section className="catalog-sheet__section">
            <h3 className="catalog-sheet__section-title">Context Capacity</h3>
            <dl className="catalog-sheet__spec-list">
              <div className="catalog-sheet__spec-item">
                <dt>Total Context Window</dt>
                <dd>{caps.contextWindowTokens ? `${caps.contextWindowTokens.toLocaleString()} tokens` : "Standard (128k)"}</dd>
              </div>
              <div className="catalog-sheet__spec-item">
                <dt>Max Generation Output</dt>
                <dd>{caps.maxOutputTokens ? `${caps.maxOutputTokens.toLocaleString()} tokens` : "Standard (8k)"}</dd>
              </div>
            </dl>
          </section>

          {/* Modalities & Verified Capabilities */}
          <section className="catalog-sheet__section">
            <h3 className="catalog-sheet__section-title">Capabilities</h3>
            <div className="catalog-sheet__caps-grid">
              <div className={`catalog-sheet__cap-pill ${caps.vision ? "is-supported" : "is-unsupported"}`}>
                <Eye size={15} strokeWidth={2} aria-hidden="true" />
                <span>Multimodal Vision: {caps.vision ? "Verified" : "Unsupported"}</span>
              </div>
              <div className={`catalog-sheet__cap-pill ${caps.tools ? "is-supported" : "is-unsupported"}`}>
                <Cpu size={15} strokeWidth={2} aria-hidden="true" />
                <span>Tool Calling: {caps.tools ? "Verified" : "Unsupported"}</span>
              </div>
              <div className={`catalog-sheet__cap-pill ${caps.streaming ? "is-supported" : "is-unsupported"}`}>
                <Zap size={15} strokeWidth={2} aria-hidden="true" />
                <span>Streaming SSE: {caps.streaming ? "Verified" : "Unsupported"}</span>
              </div>
              <div className={`catalog-sheet__cap-pill ${caps.reasoning ? "is-supported" : "is-unsupported"}`}>
                <Sparkles size={15} strokeWidth={2} aria-hidden="true" />
                <span>Thinking / Reasoning: {caps.reasoning ? "Supported" : "Unsupported"}</span>
              </div>
            </div>
          </section>

          {/* Reasoning Effort Levels */}
          {caps.reasoning && caps.reasoningModes?.length > 0 && (
            <section className="catalog-sheet__section">
              <h3 className="catalog-sheet__section-title">Supported Thinking Levels</h3>
              <div className="catalog-sheet__modes-list">
                {caps.reasoningModes.map((mode) => (
                  <span key={mode} className="catalog-sheet__mode-tag">
                    {mode.charAt(0).toUpperCase() + mode.slice(1)} Effort
                  </span>
                ))}
              </div>
            </section>
          )}

          {/* No per-model data-retention, training or compliance rows. They used to read "Guaranteed", "Exclusion Verified" and
              "Compliance Approved" for every real model with no evidence behind them. They may return only with documented
              per-model evidence from the model-lineup evaluation, shown for that model alone; the Privacy Policy covers the rest. */}
        </div>

        <footer className="catalog-sheet__footer">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onClose}
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

