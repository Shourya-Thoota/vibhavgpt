import { Router } from "express";
import { requireSession } from "../middleware/require-session.js";
import { CREDIT_COSTS, LIMITS, getCurrentUsage } from "./service.js";

export const usageRouter = Router();
usageRouter.get("/", requireSession, async (req, res, next) => {
  try {
    const usage = await getCurrentUsage(req.authSession.user.id);
    return res.json({ ...usage, limits: LIMITS[usage.tier], creditCosts: CREDIT_COSTS });
  } catch (error) {
    return next(error);
  }
});
