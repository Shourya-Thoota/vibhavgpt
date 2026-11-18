import { Router } from "express";
import { config } from "../config.js";
import { requireSession } from "../middleware/require-session.js";
import {
  CatalogValidationError,
  getCatalogForUser,
  getCatalogPreferences,
  updateCatalogPreferences,
} from "./catalog-service.js";

/**
 * Gate middleware that verifies FEATURE_MODEL_CATALOG_API is enabled.
 * Returns 404 when disabled, consistent with repository feature gates.
 */
export function requireCatalogApiEnabled(_req, res, next) {
  if (!config.featureModelCatalogApi) {
    return res.status(404).json({
      error: "Model catalog API is not enabled.",
      code: "feature_disabled",
    });
  }
  next();
}

/**
 * Middleware that sets strict private no-store caching on all catalog responses.
 */
function privateNoStoreHeader(_req, res, next) {
  res.set("Cache-Control", "private, no-store");
  next();
}

/**
 * Factory for GET /api/models/catalog handler with optional database injection.
 */
export function createGetCatalogHandler(db = null) {
  return async function getCatalogHandler(req, res, next) {
    try {
      const userId = req.authSession.user.id;
      // Derive plan and eligibility entirely server-side; client cannot spoof plan
      const catalog = await getCatalogForUser({ userId, db });
      return res.status(200).json(catalog);
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * Factory for GET /api/models/preferences handler with optional database injection.
 */
export function createGetPreferencesHandler(db = null) {
  return async function getPreferencesHandler(req, res, next) {
    try {
      const userId = req.authSession.user.id;
      const preferences = await getCatalogPreferences(userId, db);
      return res.status(200).json({ preferences });
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * Factory for PUT / PATCH /api/models/preferences handler with optional database injection.
 */
export function createUpdatePreferencesHandler(db = null) {
  return async function updatePreferencesHandler(req, res, next) {
    try {
      const userId = req.authSession.user.id;
      const preferences = await updateCatalogPreferences(userId, req.body, db);
      return res.status(200).json({ preferences });
    } catch (error) {
      if (error instanceof CatalogValidationError) {
        return res.status(error.status || 400).json({
          error: error.message,
          code: error.code,
        });
      }
      return next(error);
    }
  };
}

export const getCatalogHandler = createGetCatalogHandler();
export const getPreferencesHandler = createGetPreferencesHandler();
export const updatePreferencesHandler = createUpdatePreferencesHandler();

/**
 * Factory for catalog router with optional database injection.
 */
export function createCatalogRouter({ db = null } = {}) {
  const router = Router();
  router.use(requireCatalogApiEnabled);
  router.use(requireSession);
  router.use(privateNoStoreHeader);

  router.get("/catalog", createGetCatalogHandler(db));
  router.get("/preferences", createGetPreferencesHandler(db));
  router.put("/preferences", createUpdatePreferencesHandler(db));
  router.patch("/preferences", createUpdatePreferencesHandler(db));

  return router;
}

/**
 * Factory for me preferences router with optional database injection.
 */
export function createMeCatalogPreferencesRouter({ db = null } = {}) {
  const router = Router();
  router.use(requireCatalogApiEnabled);
  router.use(requireSession);
  router.use(privateNoStoreHeader);

  router.get("/", createGetPreferencesHandler(db));
  router.put("/", createUpdatePreferencesHandler(db));
  router.patch("/", createUpdatePreferencesHandler(db));

  return router;
}

export const catalogRouter = createCatalogRouter();
export const meCatalogPreferencesRouter = createMeCatalogPreferencesRouter();
