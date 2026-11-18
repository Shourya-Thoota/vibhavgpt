import { useAuthenticatedCatalog } from "./useAuthenticatedCatalog.js";
import { ModelCatalog } from "./ModelCatalog.jsx";
import { ModelMetadataSheet } from "./ModelMetadataSheet.jsx";

/**
 * Authenticated Model Catalog Modal.
 *
 * Connects reusable catalog components to:
 * - GET /api/models/catalog
 * - GET /api/models/preferences
 * - PATCH /api/models/preferences
 *
 * Execution is connected directly to active chat:
 * - Allows selecting any eligible model.
 * - Enforces server-side plan eligibility and reasoning controls.
 * - Honors user favorites, brand visibility, and ordering preferences.
 */
export function AuthenticatedCatalogModal({
  open,
  onClose,
  userId,
  selectedModelId,
  onSelectModel,
  onUpgrade,
}) {
  const {
    adaptedData,
    loading,
    error,
    saveError,
    searchQuery,
    setSearchQuery,
    capabilityFilter,
    setCapabilityFilter,
    selectedModelForDetails,
    setSelectedModelForDetails,
    statusAnnouncement,
    toggleFavorite,
    toggleBrandVisibility,
    moveBrand,
    reload,
  } = useAuthenticatedCatalog({ userId, enabled: open });

  if (!open) return null;

  return (
    <>
      <ModelCatalog
        open={open}
        onClose={onClose}
        adaptedData={adaptedData}
        loading={loading}
        error={error}
        saveError={saveError}
        onRetry={reload}
        isReadOnly={false}
        selectedModelId={selectedModelId}
        onSelectModel={(modelId) => {
          onSelectModel?.(modelId);
          onClose();
        }}
        onUpgrade={onUpgrade}
        statusAnnouncement={statusAnnouncement}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        capabilityFilter={capabilityFilter}
        onCapabilityFilterChange={setCapabilityFilter}
        onToggleFavorite={toggleFavorite}
        onMoveBrand={moveBrand}
        onToggleBrandVisibility={toggleBrandVisibility}
        onOpenDetails={(model) => setSelectedModelForDetails(model)}
      />
      <ModelMetadataSheet
        model={selectedModelForDetails}
        open={Boolean(selectedModelForDetails)}
        onClose={() => setSelectedModelForDetails(null)}
      />
    </>
  );
}

export default AuthenticatedCatalogModal;
