import { Router } from "express";
import { requireSession } from "../middleware/require-session.js";
import { CREDIT_COSTS, GENERATION_LIMITS, LIMITS, getCreditsSummary, getCurrentUsage } from "./service.js";
import { buildUsageOverview } from "./overview.js";
import { publicCreditsPolicy, resolveCreditsPolicy } from "./credits.js";

// `now` is the clock for the credits figures, so a test can run against a fixed date.
export function createUsageRouter({ now = () => new Date() } = {}) {
  const router = Router();

  // Which allowance policy this server is enforcing. Public and tiny: a page, an
  // app or an operator can compare it with what was deployed to the front end and
  // spot a mismatch (npm run credits:verify does exactly that). It names no
  // provider and carries no account data.
  router.get("/policy", (_req, res) => {
    res.set("Cache-Control", "no-store");
    return res.json(publicCreditsPolicy(resolveCreditsPolicy(undefined, now())));
  });

  router.get("/", requireSession, async (req, res, next) => {
    try {
      const userId = req.authSession.user.id;
      const at = now();
      const usage = await getCurrentUsage(userId);
      const policy = resolveCreditsPolicy(undefined, at);
      // The token tables stay in the response for older clients and internal use; a
      // client shows credits instead whenever `credits` is present and active.
      const credits = policy.active ? await getCreditsSummary(userId, undefined, at, { flexCreditBalance: usage.creditBalance }) : null;
      // The plain-language overview: images, documents and the purchased balance, from the same numbers the server enforces.
      const overview = buildUsageOverview({ usage, limits: GENERATION_LIMITS[usage.tier] ?? GENERATION_LIMITS.free, flexBalance: usage.creditBalance });
      return res.json({ ...usage, limits: LIMITS[usage.tier], creditCosts: CREDIT_COSTS, policy: publicCreditsPolicy(policy), credits, overview });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

export const usageRouter = createUsageRouter();
