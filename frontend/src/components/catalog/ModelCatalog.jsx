import { useState, useEffect, useRef } from "react";
import {
  Search,
  X,
  Star,
  ChevronDown,
  ChevronRight,
  Info,
  Lock,
  Check,
  Eye,
  EyeOff,
  Sparkles,
  Zap,
  Brain,
  Wrench,
  AlertCircle,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { BrandLogo } from "./BrandLogo.jsx";

const FILTER_CHIPS = [
  { key: "all", label: "All Models" },
  { key: "fast", label: "Fast", icon: Zap },
  { key: "balanced", label: "Balanced", icon: Sparkles },
  { key: "best_intelligence", label: "Best intelligence", icon: Brain },
  { key: "vision", label: "Vision", icon: Eye },
  { key: "reasoning", label: "Thinking", icon: Brain },
  { key: "tools", label: "Tools", icon: Wrench },
];

export function ModelCatalog({
  open,
  onClose,
  adaptedData,
  searchQuery = "",
  onSearchChange = () => {},
  capabilityFilter = "all",
  onCapabilityFilterChange = () => {},
  selectedModelId,
  onSelectModel = () => {},
  onUpgrade = () => {},
  favorites = [],
  onToggleFavorite = () => {},
  onMoveBrand = () => {},
  brandVisibility = {},
  onToggleBrandVisibility = () => {},
  onOpenDetails = () => {},
  loading = false,
  error = null,
  saveError = null,
  onRetry = null,
  isReadOnly = false,
  statusAnnouncement = "",
}) {
  const modalRef = useRef(null);
  const searchInputRef = useRef(null);
  const [collapsedBrands, setCollapsedBrands] = useState({});

  // Escape key handler & focus management
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    setTimeout(() => {
      searchInputRef.current?.focus();
    }, 50);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  const toggleBrandCollapse = (brandId) => {
    setCollapsedBrands((prev) => ({
      ...prev,
      [brandId]: !prev[brandId],
    }));
  };

  if (!open) return null;

  const { brands = [], favorites: favModels = [], totalCount = 0, filteredCount = 0 } = adaptedData || {};
  const isFiltered = Boolean(searchQuery?.trim() || (capabilityFilter && capabilityFilter !== "all"));

  return (
    <div
      className="catalog-modal-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="catalog-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="catalog-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <header className="catalog-modal__header">
          <div className="catalog-modal__header-left">
            <h2 id="catalog-modal-title" className="catalog-modal__title">
              Model Catalog
            </h2>
            <span
              className="catalog-modal__count-pill"
              aria-label={
                loading
                  ? "Loading models"
                  : error
                  ? "Catalog unavailable"
                  : `${filteredCount} of ${totalCount} models available`
              }
            >
              {loading
                ? "Loading…"
                : error
                ? "Unavailable"
                : `${filteredCount} ${filteredCount === 1 ? "model" : "models"}`}
            </span>
          </div>
          <button
            type="button"
            className="catalog-modal__close-btn"
            onClick={onClose}
            aria-label="Close catalog modal"
          >
            <X size={20} strokeWidth={2} aria-hidden="true" />
          </button>
        </header>

        {/* Disclaimer Banner: only shown when explicitly in read-only mode */}
        {isReadOnly && (
          <div className="catalog-modal__disclaimer" role="note">
            <AlertCircle size={15} strokeWidth={2} aria-hidden="true" />
            <span>
              Browse models · Catalog execution is disconnected from chat. Active chat continues using your native model.
            </span>
          </div>
        )}

        {/* Save error banner if optimistic update failed */}
        {saveError && (
          <div className="catalog-save-error-banner" role="alert">
            <AlertCircle size={14} strokeWidth={2} aria-hidden="true" />
            <span>Failed to save preferences. Your change has been rolled back.</span>
          </div>
        )}

        {/* Screen reader live announcements */}
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {statusAnnouncement}
        </div>

        {/* Search & Performance / Capability Filter Bar */}
        <div className="catalog-modal__controls">
          <div className="catalog-search-wrap">
            <Search className="catalog-search-icon" size={16} strokeWidth={2} aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="text"
              className="catalog-search-input"
              placeholder="Search by model name, developer, or capability..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              aria-label="Search models"
              disabled={loading || Boolean(error)}
            />
            {searchQuery && (
              <button
                type="button"
                className="catalog-search-clear"
                onClick={() => onSearchChange("")}
                aria-label="Clear search input"
              >
                <X size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>

          <div
            className="catalog-filter-chips"
            role="toolbar"
            aria-label="Model performance and capability filters"
          >
            {FILTER_CHIPS.map((chip) => {
              const Icon = chip.icon;
              const active = capabilityFilter === chip.key;
              return (
                <button
                  key={chip.key}
                  type="button"
                  className={`catalog-chip ${active ? "catalog-chip--active" : ""}`}
                  onClick={() => onCapabilityFilterChange(chip.key)}
                  aria-pressed={active}
                  disabled={loading || Boolean(error)}
                >
                  {Icon && <Icon size={13} strokeWidth={2} aria-hidden="true" />}
                  <span>{chip.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Modal Scrollable Body */}
        <div className="catalog-modal__body">
          {loading ? (
            <div className="catalog-loading-state" role="status" aria-live="polite">
              <div className="catalog-spinner" aria-hidden="true" />
              <span className="catalog-loading-text">Loading model catalog…</span>
            </div>
          ) : error ? (
            <div className="catalog-error-state" role="alert">
              <AlertCircle size={32} strokeWidth={1.5} className="catalog-error-icon" aria-hidden="true" />
              <h3 className="catalog-error-title">
                {error.status === 401
                  ? "Session Expired"
                  : error.status === 404
                  ? "Catalog Unavailable"
                  : "Failed to Load Catalog"}
              </h3>
              <p className="catalog-error-desc">
                {error.status === 401
                  ? "Your session has expired. Please sign in again to browse the catalog."
                  : error.status === 404
                  ? "The model catalog is not currently available."
                  : error.message || "An unexpected error occurred while loading models. Please try again."}
              </p>
              {error.status !== 401 && error.status !== 404 && onRetry && (
                <button type="button" className="catalog-reset-btn" onClick={onRetry}>
                  Retry
                </button>
              )}
            </div>
          ) : totalCount === 0 ? (
            <div className="catalog-empty-state" role="status">
              <AlertCircle size={32} strokeWidth={1.5} className="catalog-empty-icon" aria-hidden="true" />
              <h3 className="catalog-empty-title">No models available</h3>
              <p className="catalog-empty-desc">
                The catalog is currently empty.
              </p>
            </div>
          ) : (
            <>
              {/* Favorites Group */}
              {favModels.length > 0 && (
                <section className="catalog-section catalog-section--favorites" aria-labelledby="heading-favorites">
                  <div className="catalog-section-header">
                    <div className="catalog-section-header__left">
                      <Star size={16} className="star-icon star-icon--active" fill="currentColor" aria-hidden="true" />
                      <h3 id="heading-favorites" className="catalog-section-header__title">
                        Favorites
                      </h3>
                      <span className="catalog-section-header__count">{favModels.length}</span>
                    </div>
                  </div>
                  <div className="catalog-models-grid" role="list">
                    {favModels.map((model) => (
                      <ModelCard
                        key={`fav-${model.id}`}
                        model={model}
                        isReadOnly={isReadOnly}
                        isSelected={selectedModelId === model.id}
                        onSelect={() => {
                          if (!model.lockState.locked) {
                            onSelectModel(model.id);
                            onClose();
                          }
                        }}
                        onUpgrade={onUpgrade}
                        onToggleFavorite={() => onToggleFavorite(model.id)}
                        onOpenDetails={() => onOpenDetails(model)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {/* Brand Accordion Groups */}
              {brands.map((brand, brandIndex) => {
                const isVisible = brand.visible !== false;
                const isCollapsed = Boolean(collapsedBrands[brand.brandId]);
                const isFirst = brandIndex === 0;
                const isLast = brandIndex === brands.length - 1;

                if (!isVisible && !isFiltered) {
                  return (
                    <div key={brand.brandId} className="catalog-brand-hidden-banner">
                      <span className="catalog-brand-hidden-banner__text">
                        Brand group <strong>{brand.brandName}</strong> is hidden
                      </span>
                      <button
                        type="button"
                        className="catalog-brand-btn"
                        onClick={() => onToggleBrandVisibility(brand.brandId)}
                        aria-label={`Show ${brand.brandName} group`}
                      >
                        <Eye size={14} strokeWidth={2} aria-hidden="true" />
                        <span>Show</span>
                      </button>
                    </div>
                  );
                }

                return (
                  <section
                    key={brand.brandId}
                    className="catalog-section catalog-brand-group"
                    aria-labelledby={`heading-brand-${brand.brandId}`}
                  >
                    {/* Accordion Header */}
                    <div className="catalog-brand-header">
                      <button
                        type="button"
                        className="catalog-brand-toggle"
                        onClick={() => toggleBrandCollapse(brand.brandId)}
                        aria-expanded={!isCollapsed}
                        aria-controls={`brand-content-${brand.brandId}`}
                      >
                        {isCollapsed ? (
                          <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
                        ) : (
                          <ChevronDown size={18} strokeWidth={2} aria-hidden="true" />
                        )}
                        <BrandLogo brandId={brand.brandId} size={20} className="catalog-brand-header__logo" />
                        <h3 id={`heading-brand-${brand.brandId}`} className="catalog-brand-title">
                          {brand.brandName}
                        </h3>
                        <span className="catalog-brand-count">
                          {brand.models.length} {brand.models.length === 1 ? "model" : "models"}
                        </span>
                        {brand.isNative && (
                          <span className="catalog-brand-native-pill">Native Tier</span>
                        )}
                      </button>

                      <div className="catalog-brand-controls" role="toolbar" aria-label={`${brand.brandName} controls`}>
                        <button
                          type="button"
                          className="catalog-brand-icon-btn"
                          onClick={() => onMoveBrand(brand.brandId, "up")}
                          disabled={isFirst}
                          title="Move brand up"
                          aria-label={`Move ${brand.brandName} up`}
                        >
                          <ArrowUp size={14} strokeWidth={2} aria-hidden="true" />
                        </button>

                        <button
                          type="button"
                          className="catalog-brand-icon-btn"
                          onClick={() => onMoveBrand(brand.brandId, "down")}
                          disabled={isLast}
                          title="Move brand down"
                          aria-label={`Move ${brand.brandName} down`}
                        >
                          <ArrowDown size={14} strokeWidth={2} aria-hidden="true" />
                        </button>

                        <button
                          type="button"
                          className="catalog-brand-icon-btn"
                          onClick={() => onToggleBrandVisibility(brand.brandId)}
                          title="Hide brand group"
                          aria-label={`Hide ${brand.brandName} group`}
                        >
                          <EyeOff size={14} strokeWidth={2} aria-hidden="true" />
                        </button>
                      </div>
                    </div>

                    {/* Accordion Body */}
                    {!isCollapsed && (
                      <div
                        id={`brand-content-${brand.brandId}`}
                        className="catalog-models-grid"
                        role="list"
                      >
                        {brand.models.length === 0 ? (
                          <div className="catalog-no-brand-models">
                            No models match your current filter in this brand group.
                          </div>
                        ) : (
                          brand.models.map((model) => (
                            <ModelCard
                              key={model.id}
                              model={model}
                              isReadOnly={isReadOnly}
                              isSelected={selectedModelId === model.id}
                              onSelect={() => {
                                if (!model.lockState.locked) {
                                  onSelectModel(model.id);
                                  onClose();
                                }
                              }}
                              onUpgrade={onUpgrade}
                              onToggleFavorite={() => onToggleFavorite(model.id)}
                              onOpenDetails={() => onOpenDetails(model)}
                            />
                          ))
                        )}
                      </div>
                    )}
                  </section>
                );
              })}

              {/* Empty Search / Filter State */}
              {filteredCount === 0 && (
                <div className="catalog-empty-state" role="status">
                  <Search size={32} strokeWidth={1.5} className="catalog-empty-icon" aria-hidden="true" />
                  <h4 className="catalog-empty-title">No matching models found</h4>
                  <p className="catalog-empty-desc">
                    Try searching with different keywords or reset your filters.
                  </p>
                  <button
                    type="button"
                    className="catalog-reset-btn"
                    onClick={() => {
                      onSearchChange("");
                      onCapabilityFilterChange("all");
                    }}
                  >
                    Reset Search and Filters
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Individual Model Card component.
 */
function ModelCard({
  model,
  isSelected,
  onSelect,
  onUpgrade,
  onToggleFavorite,
  onOpenDetails,
  isReadOnly = false,
}) {
  const { displayName, developer, brandName, brandId, description, capabilities, consumptionTier, performanceCategory, lockState, isFavorite } = model;
  const isLocked = lockState.locked;

  return (
    <article
      className={`catalog-model-card ${isSelected ? "catalog-model-card--selected" : ""} ${
        isLocked ? "catalog-model-card--locked" : ""
      } ${isReadOnly ? "catalog-model-card--readonly" : ""}`}
      role="listitem"
      onClick={isReadOnly ? () => onOpenDetails() : undefined}
    >
      <div className="catalog-model-card__header">
        <div className="catalog-model-card__brand-row">
          <BrandLogo brandId={brandId} size={18} className="catalog-model-card__logo" />
          <span className="catalog-model-card__developer">{developer || brandName}</span>
        </div>

        <div className="catalog-model-card__title-row">
          <h4 className="catalog-model-card__name">{displayName}</h4>
          <button
            type="button"
            className="catalog-model-card__fav-btn"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite();
            }}
            aria-label={isFavorite ? `Remove ${displayName} from favorites` : `Add ${displayName} to favorites`}
          >
            <Star
              size={15}
              strokeWidth={2}
              className={`star-icon ${isFavorite ? "star-icon--active" : ""}`}
              fill={isFavorite ? "currentColor" : "none"}
              aria-hidden="true"
            />
          </button>
        </div>

        <p className="catalog-model-card__desc">{description}</p>
      </div>

      <div className="catalog-model-card__meta">
        {/* Performance Category Badge */}
        <span className={`perf-badge perf-badge--${performanceCategory || "balanced"}`}>
          {performanceCategory === "fast" ? (
            <><Zap size={11} strokeWidth={2.4} aria-hidden="true" /><span>Fast</span></>
          ) : performanceCategory === "best_intelligence" ? (
            <><Brain size={11} strokeWidth={2.4} aria-hidden="true" /><span>Best intelligence</span></>
          ) : (
            <><Sparkles size={11} strokeWidth={2.4} aria-hidden="true" /><span>Balanced</span></>
          )}
        </span>

        {/* Accessible Consumption Tier Pill */}
        <span
          className={`consumption-badge consumption-badge--${consumptionTier.key}`}
          title={consumptionTier.description}
        >
          <span
            className="consumption-dot"
            style={{ backgroundColor: consumptionTier.color }}
            aria-hidden="true"
          />
          <span className="consumption-text">{consumptionTier.shortLabel}</span>
        </span>

        {/* Capability Indicators */}
        <div className="catalog-model-card__caps" aria-label="Capabilities">
          {capabilities.reasoning && (
            <span className="cap-icon-pill" title="Reasoning model">
              <Brain size={12} strokeWidth={2} aria-hidden="true" />
              <span>Thinking</span>
            </span>
          )}
          {capabilities.vision && (
            <span className="cap-icon-pill" title="Vision modality supported">
              <Eye size={12} strokeWidth={2} aria-hidden="true" />
              <span>Vision</span>
            </span>
          )}
          {capabilities.tools && (
            <span className="cap-icon-pill" title="Tools supported">
              <Wrench size={12} strokeWidth={2} aria-hidden="true" />
              <span>Tools</span>
            </span>
          )}
        </div>
      </div>

      <div className="catalog-model-card__footer">
        {/* Info / Details Button */}
        <button
          type="button"
          className="catalog-model-card__info-btn"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDetails();
          }}
          title="View technical specifications"
          aria-label={`View specifications for ${displayName}`}
        >
          <Info size={14} strokeWidth={2} aria-hidden="true" />
          <span>Details</span>
        </button>

        {isSelected ? (
          <div className="catalog-model-card__active-badge" role="status">
            <Check size={14} strokeWidth={2.5} aria-hidden="true" />
            <span>Active</span>
          </div>
        ) : isLocked ? (
          lockState.type === "subscription" ? (
            <button
              type="button"
              className="catalog-model-card__upgrade-btn"
              onClick={(e) => {
                e.stopPropagation();
                onUpgrade?.();
              }}
              title={lockState.reason || "Available with upgraded plan"}
            >
              <Lock size={12} strokeWidth={2.2} aria-hidden="true" />
              <span>Upgrade</span>
            </button>
          ) : (
            <button
              type="button"
              className="catalog-model-card__unavailable-btn"
              disabled
              title={lockState.reason || "Temporarily unavailable"}
            >
              <Lock size={12} strokeWidth={2.2} aria-hidden="true" />
              <span>Unavailable</span>
            </button>
          )
        ) : (
          <button
            type="button"
            className="catalog-model-card__select-btn"
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
            aria-label={`Select ${displayName}`}
          >
            <span>Select</span>
          </button>
        )}
      </div>
    </article>
  );
}

export default ModelCatalog;
