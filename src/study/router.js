import express from "express";
import rateLimit from "express-rate-limit";
import { accessStatus } from "../../frontend/src/access-status.js";
import { checkModeration } from "../chat/moderation.js";
import { callModelWithFallback, InferenceUnavailableError } from "../chat/providers.js";
import { requireSession } from "../middleware/require-session.js";
import { createUsageTracker } from "../usage/service.js";
import { detectAiWriting, estimateTokens, humanizeText, upstreamConfig, WritingToolError } from "./writing-tools.js";

const STUDY_MODEL_KEY = "study";

// The Study Writing Tools API. Dependencies are injectable for tests; the
// app uses the defaults (real sessions, the Study model, Study usage).
export function createStudyRouter({
  sessionMiddleware = requireSession,
  callModel = callModelWithFallback,
  createTracker = (userId) => createUsageTracker(userId, STUDY_MODEL_KEY, "normal"),
  moderate = checkModeration,
  fetchImpl = fetch,
  upstream = () => upstreamConfig(),
  limiter = rateLimit({ windowMs: 60 * 1000, limit: 12, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Please wait a moment before trying again." } }),
} = {}) {
  const router = express.Router();
  const fail = (res, error, next) => {
    if (error instanceof WritingToolError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (accessStatus(error)) return next(error);
    if (error instanceof InferenceUnavailableError) return res.status(503).json({ error: "The Humanizer is temporarily unavailable. Please try again shortly.", code: "humanizer-unavailable" });
    return next(error);
  };

  // Free and instant: computed here, no model call.
  router.post("/detect", sessionMiddleware, limiter, (req, res, next) => {
    try {
      const { humanScore, aiScore, sentences } = detectAiWriting(req.body?.text);
      return res.json({ humanScore, aiScore, sentences });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  router.post("/humanize", sessionMiddleware, limiter, async (req, res, next) => {
    try {
      const userId = req.authSession.user.id;
      const text = req.body?.text;
      if (typeof text === "string" && text.trim()) {
        const moderation = await moderate(text);
        if (moderation?.flagged) return res.status(422).json({ error: "This text can't be rewritten. If you think it was flagged by mistake, try different text.", code: "moderation" });
      }
      const meter = createTracker(userId);
      const result = await humanizeText(text, req.body?.tone, {
        upstream: upstream(),
        fetchImpl,
        callModel,
        usageTracker: createTracker(userId),
        requestId: req.get?.("x-request-id") ?? "unknown",
        upstreamMeter: {
          before: (messages) => meter.beforeCall(messages, [], estimateTokens(text) + 400),
          settle: (input, output) => meter.record({ prompt_tokens: estimateTokens(input) + 300, completion_tokens: estimateTokens(output) }),
          release: () => meter.release(),
        },
      });
      return res.json({ text: result.text, tone: result.tone });
    } catch (error) {
      return fail(res, error, next);
    }
  });

  return router;
}

export const studyRouter = createStudyRouter();
