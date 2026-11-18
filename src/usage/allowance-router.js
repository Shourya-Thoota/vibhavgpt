import { Router } from "express";
import { config } from "../config.js";
import { requireSession } from "../middleware/require-session.js";
import { getAllowanceSummary } from "./allowance-summary.js";
import { resolveCreditsPolicy } from "./credits.js";

/**
 * Gate middleware that verifies FEATURE_ALLOWANCE_SUMMARY_API is enabled.
 * Returns 404 when disabled, consistent with repository feature gates.
 */
export function requireAllowanceSummaryApiEnabled(_req, res, next) {
  // Its amounts are dollars from a different ledger. Under AI credits the
  // credits object in GET /api/usage is the only allowance a customer sees.
  if (resolveCreditsPolicy().active) {
    return res.status(404).json({
      error: "Allowance summary API is not enabled.",
      code: "superseded_by_credits",
    });
  }
  if (!config.featureAllowanceSummaryApi) {
    return res.status(404).json({
      error: "Allowance summary API is not enabled.",
      code: "feature_disabled",
    });
  }
  next();
}

function privateNoStoreHeader(_req, res, next) {
  res.set("Cache-Control", "private, no-store");
  res.set("Vary", "Cookie");
  next();
}

/**
 * Factory for GET /api/usage/allowance with optional database injection.
 * The account comes only from the verified session; query and body are ignored.
 */
export function createGetAllowanceSummaryHandler(db = null) {
  return async function getAllowanceSummaryHandler(req, res, next) {
    try {
      const summary = await getAllowanceSummary({ userId: req.authSession.user.id, db });
      return res.status(200).json(summary);
    } catch (error) {
      return next(error);
    }
  };
}

export function createAllowanceRouter({ db = null } = {}) {
  const router = Router();
  router.use(requireAllowanceSummaryApiEnabled);
  router.use(requireSession);
  router.use(privateNoStoreHeader);
  router.get("/", createGetAllowanceSummaryHandler(db));
  return router;
}

export const allowanceRouter = createAllowanceRouter();
