import { useState, useMemo, useEffect } from "react";
import { RAW_CATALOG_FIXTURES, SYNTHETIC_PROJECTS } from "./catalog-fixtures.js";
import { adaptCatalogForPresentation } from "./catalog-adapter.js";
import { ModelSelector } from "./ModelSelector.jsx";
import { ModelCatalog } from "./ModelCatalog.jsx";
import { ModelMetadataSheet } from "./ModelMetadataSheet.jsx";
import "./catalog.css";
import { Sparkles, Layers, ShieldCheck, Cpu, Send, CheckCircle, Info } from "lucide-react";

export function CatalogPreviewPage() {
  // 1. Preview State
  const [userPlan, setUserPlan] = useState("plus"); // "free" | "plus" | "pro"
  const [activeProjectId, setActiveProjectId] = useState("proj-personal");
  const [searchQuery, setSearchQuery] = useState("");
  const [capabilityFilter, setCapabilityFilter] = useState("all");
  const [favorites, setFavorites] = useState(["openai-gpt-6-terra", "anthropic-claude-sonnet-45"]);
  const [brandOrder, setBrandOrder] = useState([
    "vibhavgpt",
    "openai",
    "anthropic",
    "google",
    "deepseek",
    "experimental",
  ]);
  const [brandVisibility, setBrandVisibility] = useState({});
  const [catalogModalOpen, setCatalogModalOpen] = useState(false);
  const [metadataSheetModel, setMetadataSheetModel] = useState(null);
  const [thinkingLevel, setThinkingLevel] = useState("normal");
  const [activeTools, setActiveTools] = useState({
    webSearch: true,
    canvas: true,
    study: true,
    images: true, // Will be gated on userPlan === "free"
  });
  const [promptText, setPromptText] = useState("");
  const [simulationLogs, setSimulationLogs] = useState([]);

  // 2. Presentation Adapter: sanitizes wholesale prices, sorts models, filters
  const adaptedData = useMemo(() => {
    return adaptCatalogForPresentation({
      userPlan,
      rawFixtures: RAW_CATALOG_FIXTURES,
      searchQuery,
      capabilityFilter,
      favorites,
      brandOrder,
      brandVisibility,
    });
  }, [userPlan, searchQuery, capabilityFilter, favorites, brandOrder, brandVisibility]);

  // 3. Active Model: default to first native model (e.g. Terra or Luna) or Auto
  const [activeModel, setActiveModel] = useState(() => {
    return (
      adaptedData.models.find((m) => m.id === "openai-gpt-6-terra") ||
      adaptedData.models[0] ||
      adaptedData.autoMode
    );
  });

  // Keep activeModel lock state synchronized when plan switches
  useEffect(() => {
    if (activeModel?.isAuto) return;
    const refreshed = adaptedData.models.find((m) => m.id === activeModel.id);
    if (refreshed) {
      setActiveModel(refreshed);
    }
  }, [userPlan, adaptedData.models]);

  // Adjust thinking level if model doesn't support reasoning
  useEffect(() => {
    if (activeModel && !activeModel.capabilities?.reasoning) {
      setThinkingLevel("off");
    } else if (activeModel && activeModel.capabilities?.reasoning && thinkingLevel === "off") {
      setThinkingLevel("normal");
    }
  }, [activeModel]);

  // 4. Quick Recent Models list (3-4 items)
  const recentModels = useMemo(() => {
    return adaptedData.models.slice(0, 4);
  }, [adaptedData.models]);

  // 5. Handlers
  const handleToggleFavorite = (modelId) => {
    setFavorites((prev) =>
      prev.includes(modelId) ? prev.filter((id) => id !== modelId) : [...prev, modelId]
    );
  };

  const handleMoveBrand = (brandId, direction) => {
    setBrandOrder((prev) => {
      const current = prev.length > 0 ? [...prev] : ["vibhavgpt", "openai", "anthropic", "google", "deepseek", "experimental"];
      const index = current.indexOf(brandId);
      if (index === -1) return current;

      if (direction === "up" && index > 0) {
        const temp = current[index];
        current[index] = current[index - 1];
        current[index - 1] = temp;
      } else if (direction === "down" && index < current.length - 1) {
        const temp = current[index];
        current[index] = current[index + 1];
        current[index + 1] = temp;
      }
      return current;
    });
  };

  const handleToggleBrandVisibility = (brandId) => {
    setBrandVisibility((prev) => ({
      ...prev,
      [brandId]: prev[brandId] === false ? true : false,
    }));
  };

  const handleToggleTool = (toolKey) => {
    if (toolKey === "images" && userPlan === "free") return; // Free plan restriction
    setActiveTools((prev) => ({
      ...prev,
      [toolKey]: !prev[toolKey],
    }));
  };

  const handleSelectModel = (model) => {
    if (model.lockState?.locked) return;
    setActiveModel(model);
  };

  const handleSimulatePrompt = (e) => {
    e?.preventDefault();
    if (!promptText.trim()) return;

    const enabledToolsList = Object.entries(activeTools)
      .filter(([key, val]) => val && !(key === "images" && userPlan === "free"))
      .map(([key]) => key);

    const logEntry = {
      id: Date.now(),
      timestamp: new Date().toLocaleTimeString(),
      prompt: promptText,
      modelName: activeModel?.displayName || "Auto",
      brand: activeModel?.brandName || "Broker",
      tier: activeModel?.consumptionTier?.shortLabel || "Dynamic",
      thinking: thinkingLevel,
      tools: enabledToolsList,
      plan: userPlan.toUpperCase(),
    };

    setSimulationLogs((prev) => [logEntry, ...prev.slice(0, 9)]);
    setPromptText("");
  };

  return (
    <div className="catalog-preview-page">
      {/* 1. Header Banner & Plan Switcher */}
      <header className="catalog-preview-banner">
        <div className="catalog-preview-banner__info">
          <span className="catalog-preview-banner__badge">Milestone 3 Preview</span>
          <span className="catalog-preview-banner__desc">
            Synthetic catalog fixtures · Zero wholesale token prices exposed · Disconnected from live API
          </span>
        </div>

        {/* Plan Switcher */}
        <div className="catalog-plan-switcher">
          <span className="catalog-plan-switcher__label">Simulated Plan:</span>
          <div className="catalog-plan-pills" role="radiogroup" aria-label="Simulated Subscription Plan">
            {["free", "plus", "pro"].map((plan) => (
              <button
                key={plan}
                type="button"
                className={`catalog-plan-pill ${userPlan === plan ? "catalog-plan-pill--active" : ""}`}
                role="radio"
                aria-checked={userPlan === plan}
                onClick={() => setUserPlan(plan)}
              >
                {plan.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* 2. Main Workspace with Top-Centered Selector */}
      <main className="catalog-preview-main">
        {/* Top-Centered Selector */}
        <ModelSelector
          userPlan={userPlan}
          projects={SYNTHETIC_PROJECTS}
          activeProjectId={activeProjectId}
          onSelectProject={setActiveProjectId}
          activeModel={activeModel}
          recentModels={recentModels}
          onSelectModel={handleSelectModel}
          onOpenCatalog={() => setCatalogModalOpen(true)}
          thinkingLevel={thinkingLevel}
          onChangeThinkingLevel={setThinkingLevel}
          activeTools={activeTools}
          onToggleTool={handleToggleTool}
        />

        {/* Active Model Preview & Simulation Canvas */}
        <section className="catalog-preview-canvas" aria-labelledby="canvas-heading">
          <div className="catalog-preview-canvas__header">
            <div>
              <h2 id="canvas-heading" className="catalog-preview-canvas__title">
                Active Selection: {activeModel?.displayName || "Auto"}
              </h2>
              <span className="catalog-sheet__brand">
                {activeModel?.brandName || "Intelligent Broker"} · {activeModel?.isNative ? "Native Tier" : "Registry Fixture"}
              </span>
            </div>

            <button
              type="button"
              className="selector-menu__catalog-btn"
              style={{ width: "auto" }}
              onClick={() => setCatalogModalOpen(true)}
            >
              <Layers size={15} strokeWidth={2} aria-hidden="true" />
              <span>Explore Full Catalog ({adaptedData.totalCount} Models)</span>
            </button>
          </div>

          {/* Model Specification Grid */}
          <div className="catalog-preview-canvas__specs">
            <div className="catalog-preview-spec-box">
              <span className="catalog-preview-spec-box__label">Consumption Tier</span>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "2px" }}>
                <span
                  className="consumption-dot"
                  style={{ backgroundColor: activeModel?.consumptionTier?.color || "#10b981" }}
                  aria-hidden="true"
                />
                <span className="catalog-preview-spec-box__val">
                  {activeModel?.consumptionTier?.label || "Dynamic"}
                </span>
              </div>
            </div>

            <div className="catalog-preview-spec-box">
              <span className="catalog-preview-spec-box__label">Context Window</span>
              <span className="catalog-preview-spec-box__val">
                {activeModel?.capabilities?.contextWindowTokens
                  ? `${Math.round(activeModel.capabilities.contextWindowTokens / 1024)}k tokens`
                  : "Dynamic"}
              </span>
            </div>

            <div className="catalog-preview-spec-box">
              <span className="catalog-preview-spec-box__label">Thinking Depth</span>
              <span className="catalog-preview-spec-box__val" style={{ textTransform: "capitalize" }}>
                {activeModel?.capabilities?.reasoning ? thinkingLevel : "Not Supported"}
              </span>
            </div>

            <div className="catalog-preview-spec-box">
              <span className="catalog-preview-spec-box__label">Active Plan Lock</span>
              <span className="catalog-preview-spec-box__val">
                {activeModel?.lockState?.locked ? activeModel.lockState.reason : "Unlocked for " + userPlan.toUpperCase()}
              </span>
            </div>
          </div>

          {/* Safe Interactive Playground (Simulated prompt execution, no network calls) */}
          <div className="catalog-preview-simulator">
            <form onSubmit={handleSimulatePrompt} className="catalog-preview-input-wrap">
              <input
                type="text"
                className="catalog-preview-input"
                placeholder="Test active selection with a prompt (e.g. 'Compare quantum computing and classical computing')..."
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                aria-label="Simulation prompt input"
              />
              <button type="submit" className="catalog-preview-send-btn">
                <span>Simulate</span>
              </button>
            </form>

            <div className="catalog-preview-log" aria-live="polite">
              <div style={{ fontWeight: 700, marginBottom: "4px", color: "var(--ink)" }}>
                Execution Boundary Status:
              </div>
              <div>
                • Target Route: <strong>[SYNTHETIC TEST HARNESS ONLY]</strong>
              </div>
              <div>
                • Wholesale Token Prices ($P_in, P_out): <strong>HIDDEN / STRIPPED</strong>
              </div>
              <div>
                • Live Provider Traffic: <strong>DISCONNECTED (0 paid calls)</strong>
              </div>
              {simulationLogs.length > 0 ? (
                <div style={{ marginTop: "10px", borderTop: "1px dashed rgba(255,255,255,0.1)", paddingTop: "8px" }}>
                  <div style={{ fontWeight: 600, color: "var(--ink)", marginBottom: "4px" }}>
                    Recent Simulation Logs:
                  </div>
                  {simulationLogs.map((log) => (
                    <div key={log.id} style={{ marginBottom: "6px" }}>
                      [{log.timestamp}] Plan: {log.plan} | Model: {log.modelName} | Thinking: {log.thinking} | Tools: [
                      {log.tools.join(", ")}] &rarr; "{log.prompt}"
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ marginTop: "8px", fontStyle: "italic" }}>
                  No simulated dispatches yet. Enter a prompt above to test local state coordination.
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      {/* 3. Catalog Modal */}
      <ModelCatalog
        open={catalogModalOpen}
        onClose={() => setCatalogModalOpen(false)}
        adaptedData={adaptedData}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        capabilityFilter={capabilityFilter}
        onCapabilityFilterChange={setCapabilityFilter}
        selectedModelId={activeModel?.id}
        onSelectModel={handleSelectModel}
        favorites={favorites}
        onToggleFavorite={handleToggleFavorite}
        onMoveBrand={handleMoveBrand}
        brandVisibility={brandVisibility}
        onToggleBrandVisibility={handleToggleBrandVisibility}
        onOpenDetails={(model) => setMetadataSheetModel(model)}
      />

      {/* 4. Slide-Over Metadata Sheet */}
      <ModelMetadataSheet
        model={metadataSheetModel}
        open={Boolean(metadataSheetModel)}
        onClose={() => setMetadataSheetModel(null)}
      />
    </div>
  );
}
export default CatalogPreviewPage;
