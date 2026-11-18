import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { api } from "../../api.js";
import { adaptServerCatalogForPresentation } from "./catalog-adapter.js";

/**
 * Hook managing the lifecycle and state of authenticated model catalog browsing.
 *
 * Responsibilities:
 * 1. Fetches GET /api/models/catalog and GET /api/models/preferences in parallel.
 * 2. Manages loading, error (401 session-expired, 404 disabled, network), and retry.
 * 3. Handles optimistic updates for user preferences (favorites, brandOrder, hiddenBrands)
 *    with rollback on write failure.
 * 4. Sequences asynchronous PATCH writes to prevent out-of-order race overwrites.
 * 5. Wipes cached preferences immediately when user switches account or logs out.
 * 6. Never touches or falls back to synthetic fixtures.
 */
export function useAuthenticatedCatalog({ userId = null, enabled = false } = {}) {
  const [catalog, setCatalog] = useState(null);
  const [preferences, setPreferences] = useState({
    favorites: [],
    hiddenBrands: [],
    brandOrder: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [capabilityFilter, setCapabilityFilter] = useState("all");
  const [selectedModelForDetails, setSelectedModelForDetails] = useState(null);
  const [statusAnnouncement, setStatusAnnouncement] = useState("");

  const writeSeqRef = useRef(0);
  const writeQueueRef = useRef(Promise.resolve());
  const confirmedPreferencesRef = useRef({
    favorites: [],
    hiddenBrands: [],
    brandOrder: [],
  });
  const activeUserIdRef = useRef(userId);
  const abortControllerRef = useRef(null);

  // Clear all state when userId changes (switching account or logging out)
  useEffect(() => {
    if (activeUserIdRef.current !== userId) {
      activeUserIdRef.current = userId;
      writeQueueRef.current = Promise.resolve();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      confirmedPreferencesRef.current = { favorites: [], hiddenBrands: [], brandOrder: [] };
      setCatalog(null);
      setPreferences({ favorites: [], hiddenBrands: [], brandOrder: [] });
      setLoading(false);
      setError(null);
      setSaving(false);
      setSaveError(null);
      setSearchQuery("");
      setCapabilityFilter("all");
      setSelectedModelForDetails(null);
      setStatusAnnouncement("");
    }
  }, [userId]);

  // Load catalog and preferences from API
  const loadData = useCallback(async () => {
    if (!enabled || !userId) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const [catalogData, prefsData] = await Promise.all([
        api("/api/models/catalog", { signal: controller.signal }),
        api("/api/models/preferences", { signal: controller.signal }),
      ]);

      if (controller.signal.aborted) return;

      const rawPrefs = prefsData?.preferences || prefsData;
      const loadedPrefs = {
        favorites: Array.isArray(rawPrefs?.favorites) ? rawPrefs.favorites : [],
        hiddenBrands: Array.isArray(rawPrefs?.hiddenBrands) ? rawPrefs.hiddenBrands : [],
        brandOrder: Array.isArray(rawPrefs?.brandOrder) ? rawPrefs.brandOrder : [],
      };
      confirmedPreferencesRef.current = loadedPrefs;

      setCatalog(catalogData || { models: [], groups: [], userPlan: "free" });
      setPreferences(loadedPrefs);
      setStatusAnnouncement("Model catalog loaded.");
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err);
      setStatusAnnouncement(`Failed to load catalog: ${err.message || "Unknown error"}`);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [enabled, userId]);

  useEffect(() => {
    if (enabled && userId) {
      loadData();
    }
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [enabled, userId, loadData]);

  // Ordered write queue ensures same-field writes are dispatched in strict sequence to the server.
  // Last-confirmed rollback ensures failures never revert to an older-than-confirmed state.
  const updatePreferences = useCallback(
    (patch, successAnnouncement, failAnnouncement) => {
      if (!userId) return;
      const targetUserId = userId;
      const seq = ++writeSeqRef.current;
      setSaving(true);
      setSaveError(null);
      if (successAnnouncement) {
        setStatusAnnouncement(successAnnouncement);
      }

      writeQueueRef.current = writeQueueRef.current.catch(() => {}).then(async () => {
        // If user changed accounts while queued, abort
        if (activeUserIdRef.current !== targetUserId) return;

        try {
          const result = await api("/api/models/preferences", {
            method: "PATCH",
            body: JSON.stringify(patch),
          });

          // If user changed accounts while in-flight, ignore
          if (activeUserIdRef.current !== targetUserId) return;

          // Commit confirmed preferences from server result
          if (result) {
            const rawPrefs = result.preferences || result;
            confirmedPreferencesRef.current = {
              favorites: Array.isArray(rawPrefs.favorites) ? rawPrefs.favorites : [],
              hiddenBrands: Array.isArray(rawPrefs.hiddenBrands) ? rawPrefs.hiddenBrands : [],
              brandOrder: Array.isArray(rawPrefs.brandOrder) ? rawPrefs.brandOrder : [],
            };
          }

          // If this is the latest write in the queue:
          if (seq === writeSeqRef.current) {
            if (result) {
              setPreferences({ ...confirmedPreferencesRef.current });
            }
            setSaving(false);
            setSaveError(null);
            setStatusAnnouncement("Preferences saved.");
          }
        } catch (err) {
          // If user changed accounts, ignore
          if (activeUserIdRef.current !== targetUserId) return;

          // Only revert if this was the latest write
          if (seq === writeSeqRef.current) {
            if (confirmedPreferencesRef.current) {
              setPreferences({ ...confirmedPreferencesRef.current });
            }
            setSaving(false);
            setSaveError(err);
            setStatusAnnouncement(
              failAnnouncement || "Failed to save preferences. Changes rolled back."
            );
          }
        }
      });
    },
    [userId]
  );

  const toggleFavorite = useCallback(
    (modelId) => {
      setPreferences((prev) => {
        const exists = prev.favorites.includes(modelId);
        const nextFavorites = exists
          ? prev.favorites.filter((id) => id !== modelId)
          : [...prev.favorites, modelId];

        const patch = { favorites: nextFavorites };

        updatePreferences(
          patch,
          exists ? `Removed ${modelId} from favorites.` : `Added ${modelId} to favorites.`,
          "Failed to update favorite. Change rolled back."
        );

        return { ...prev, favorites: nextFavorites };
      });
    },
    [updatePreferences]
  );

  const toggleBrandVisibility = useCallback(
    (brandId) => {
      setPreferences((prev) => {
        const normId = brandId.toLowerCase();
        const exists = prev.hiddenBrands.includes(normId);
        const nextHidden = exists
          ? prev.hiddenBrands.filter((id) => id !== normId)
          : [...prev.hiddenBrands, normId];

        const patch = { hiddenBrands: nextHidden };

        updatePreferences(
          patch,
          exists ? `Showing brand group ${brandId}.` : `Hidden brand group ${brandId}.`,
          "Failed to update brand visibility. Change rolled back."
        );

        return { ...prev, hiddenBrands: nextHidden };
      });
    },
    [updatePreferences]
  );

  const moveBrand = useCallback(
    (brandId, direction) => {
      setPreferences((prev) => {
        const normId = brandId.toLowerCase();
        const currentOrder =
          prev.brandOrder?.length > 0
            ? [...prev.brandOrder]
            : ["native", "vibhavgpt", "experimental"];

        if (!currentOrder.includes(normId)) {
          currentOrder.push(normId);
        }

        const index = currentOrder.indexOf(normId);
        if (index === -1) return prev;
        const targetIndex = direction === "up" ? index - 1 : index + 1;
        if (targetIndex < 0 || targetIndex >= currentOrder.length) return prev;

        const nextOrder = [...currentOrder];
        const temp = nextOrder[index];
        nextOrder[index] = nextOrder[targetIndex];
        nextOrder[targetIndex] = temp;

        const patch = { brandOrder: nextOrder };

        updatePreferences(
          patch,
          `Moved brand ${brandId} ${direction}.`,
          "Failed to reorder brands. Change rolled back."
        );

        return { ...prev, brandOrder: nextOrder };
      });
    },
    [updatePreferences]
  );

  const adaptedData = useMemo(() => {
    if (!catalog) return null;
    return adaptServerCatalogForPresentation({
      catalog,
      searchQuery,
      capabilityFilter,
      favorites: preferences.favorites,
      brandOrder: preferences.brandOrder,
      hiddenBrands: preferences.hiddenBrands,
    });
  }, [catalog, searchQuery, capabilityFilter, preferences]);

  return {
    catalog,
    preferences,
    adaptedData,
    loading,
    error,
    saving,
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
    reload: loadData,
  };
}
