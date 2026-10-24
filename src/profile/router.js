import { canonicalModelKey } from "../../frontend/src/token-quotas.js";
import { Router } from "express";
import { accessError, accessPayload } from "../../frontend/src/access-status.js";
import { eq, sql } from "drizzle-orm";
import { normalizeOnboarding } from "../../frontend/src/onboarding.js";
import { db } from "../db/client.js";
import { userProfiles } from "../db/schema.js";
import { requireSession } from "../middleware/require-session.js";
import { NAME_NOT_ALLOWED, preferredNameFromInstructions, reviewDisplayName } from "../security/display-name.js";
import { getCurrentUsage } from "../usage/service.js";

const STYLE_OPTIONS = new Set(["concise", "balanced", "detailed", "friendly"]);
const THINKING_EFFORTS = new Set(["normal", "low", "high", "xhigh", "max"]);
const MAX_INSTRUCTIONS = 4000;
const MODEL_OPTIONS = new Set(["lumen", "nova", "nebula", "vesper"]);

function modelAllowedForTier(model, tier, creditBalance = 0) {
  if (!MODEL_OPTIONS.has(model)) return false;
  return tier !== "free" || model === "lumen" || model === "nova";
}

function profileResponse(profile) {
  return {
    responseStyle: profile?.responseStyle ?? "balanced",
    customInstructions: profile?.customInstructions ?? "",
    preferredModel: MODEL_OPTIONS.has(canonicalModelKey(profile?.preferredModel)) ? canonicalModelKey(profile.preferredModel) : null,
    lastUsedModel: MODEL_OPTIONS.has(canonicalModelKey(profile?.lastUsedModel)) ? canonicalModelKey(profile.lastUsedModel) : null,
    productMode: profile?.productMode ?? "chat",
    thinkingEffort: profile?.thinkingEffort ?? "normal",
  };
}

// Stored answers are re-validated with the client's own rules. The "Call me"
// name is dropped: it lives in the personal instructions, where it is reviewed.
export function storedOnboardingAnswers(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { onboarding_completed: _completed, preferred_name: _name, ...answers } = normalizeOnboarding(raw);
  return answers;
}

export function onboardingResponse(profile) {
  return {
    surveyCompleted: profile?.onboardingCompleted === true,
    surveyCompletedAt: profile?.onboardingCompletedAt ?? null,
    onboarding: storedOnboardingAnswers(profile?.onboardingAnswers),
  };
}

// The survey fields of /api/me.
export async function surveyStatus(userId) {
  const [profile] = await db
    .select({
      onboardingCompleted: userProfiles.onboardingCompleted,
      onboardingCompletedAt: userProfiles.onboardingCompletedAt,
      onboardingAnswers: userProfiles.onboardingAnswers,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  return onboardingResponse(profile);
}

export const profileRouter = Router();
profileRouter.use(requireSession);

profileRouter.get("/preferences", async (req, res, next) => {
  try {
    // Account preferences must never be revived from an old browser response
    // after a sign-out/sign-in cycle.
    res.set("Cache-Control", "no-store");
    const [profile] = await db
      .select({
        responseStyle: userProfiles.responseStyle,
        customInstructions: userProfiles.customInstructions,
        preferredModel: userProfiles.preferredModel,
        lastUsedModel: userProfiles.lastUsedModel,
        productMode: userProfiles.productMode,
        thinkingEffort: userProfiles.thinkingEffort,
      })
      .from(userProfiles)
      .where(eq(userProfiles.userId, req.authSession.user.id))
      .limit(1);
    return res.json(profileResponse(profile));
  } catch (error) {
    return next(error);
  }
});

// Keep the high-frequency model-picker write separate from the full settings
// upsert. This makes a last-used choice durable even while billing/tier data is
// being refreshed, without changing the user's response-style settings.
profileRouter.patch("/last-used-model", async (req, res, next) => {
  try {
    const userId = req.authSession.user.id;
    const lastUsedModel = String(req.body?.lastUsedModel ?? "").trim();
    if (!MODEL_OPTIONS.has(lastUsedModel)) return res.status(400).json({ error: "Choose a valid model." });
    const [profile] = await db
      .insert(userProfiles)
      .values({ userId, lastUsedModel })
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: { lastUsedModel, updatedAt: new Date() },
      })
      .returning({ lastUsedModel: userProfiles.lastUsedModel });
    return res.json({ lastUsedModel: profile.lastUsedModel });
  } catch (error) {
    return next(error);
  }
});

// A narrow atomic write cannot overwrite concurrently saved model/style preferences.
profileRouter.patch("/product-mode", async (req, res, next) => {
  try {
    const productMode = req.body?.productMode;
    if (!["chat", "study", "image"].includes(productMode)) return res.status(400).json({ error: "Choose an available workspace." });
    await db.insert(userProfiles).values({ userId: req.authSession.user.id, productMode })
      .onConflictDoUpdate({ target: userProfiles.userId, set: { productMode, updatedAt: new Date() } });
    return res.json({ productMode });
  } catch (error) { return next(error); }
});

// Finishing or skipping the survey marks it done for the account, so no other
// device asks again. Finishing (and later Settings tweaks) also send the
// answers; a skip sends none and leaves any earlier answers in place. The first
// completion time is kept. There is no "not completed": re-running the survey
// from Settings does not undo it.
profileRouter.patch("/onboarding", async (req, res, next) => {
  try {
    if (req.body?.completed !== true) return res.status(400).json({ error: "Only finishing the survey can be saved." });
    const userId = req.authSession.user.id;
    const answers = storedOnboardingAnswers(req.body?.answers);
    const set = { onboardingCompleted: true, onboardingCompletedAt: sql`coalesce(${userProfiles.onboardingCompletedAt}, now())`, updatedAt: new Date() };
    if (answers) set.onboardingAnswers = answers;
    const [profile] = await db
      .insert(userProfiles)
      .values({ userId, onboardingCompleted: true, onboardingCompletedAt: new Date(), onboardingAnswers: answers })
      .onConflictDoUpdate({ target: userProfiles.userId, set })
      .returning({
        onboardingCompleted: userProfiles.onboardingCompleted,
        onboardingCompletedAt: userProfiles.onboardingCompletedAt,
        onboardingAnswers: userProfiles.onboardingAnswers,
      });
    return res.json(onboardingResponse(profile));
  } catch (error) { return next(error); }
});

profileRouter.patch("/preferences", async (req, res, next) => {
  try {
    const userId = req.authSession.user.id;
    const [existing] = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
    const responseStyle = String(req.body?.responseStyle ?? existing?.responseStyle ?? "balanced");
    const customInstructions = String(req.body?.customInstructions ?? existing?.customInstructions ?? "").trim();
    const preferredModel = req.body?.preferredModel === null
      ? null
      : canonicalModelKey(String(req.body?.preferredModel ?? existing?.preferredModel ?? "").trim()) || null;
    const lastUsedModel = canonicalModelKey(String(req.body?.lastUsedModel ?? existing?.lastUsedModel ?? "").trim()) || null;
    const thinkingEffort = String(req.body?.thinkingEffort ?? existing?.thinkingEffort ?? "normal").toLowerCase();
    if (!STYLE_OPTIONS.has(responseStyle)) return res.status(400).json({ error: "Choose a valid response style." });
    if (!THINKING_EFFORTS.has(thinkingEffort)) return res.status(400).json({ error: "Choose a valid thinking effort." });
    if (customInstructions.length > MAX_INSTRUCTIONS) return res.status(400).json({ error: `Personal instructions must be ${MAX_INSTRUCTIONS} characters or fewer.` });
    // The survey's "Call me" answer is saved as a line of these instructions.
    // A new name gets the same check as an account name; an unchanged one is
    // left alone, so other settings stay savable.
    const preferredName = preferredNameFromInstructions(customInstructions);
    if (preferredName && preferredName !== preferredNameFromInstructions(existing?.customInstructions)
      && !(await reviewDisplayName(preferredName)).allowed) {
      return res.status(400).json(NAME_NOT_ALLOWED);
    }
    if ((preferredModel && !MODEL_OPTIONS.has(preferredModel)) || (lastUsedModel && !MODEL_OPTIONS.has(lastUsedModel))) {
      return res.status(400).json({ error: "Choose a valid model." });
    }
    const usage = await getCurrentUsage(userId);
    // A remembered model is allowed to remain stored across a plan change. The
    // client and chat route filter it against the user's current tier when it
    // is restored, while still letting a user's last-used choice persist when
    // their subscription status is briefly stale during a billing transition.
    // The chat route re-checks model access and both token caps before inference.
    if (preferredModel && !modelAllowedForTier(preferredModel, usage.tier, usage.creditBalance)) {
      const error = accessError("plan", { feature: "This model", requiredPlan: "Plus or Pro" });
      return res.status(error.status).json(accessPayload(error));
    }
    const [profile] = await db
      .insert(userProfiles)
      .values({ userId, responseStyle, customInstructions, preferredModel, lastUsedModel, thinkingEffort })
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: { responseStyle, customInstructions, preferredModel, lastUsedModel, thinkingEffort, updatedAt: new Date() },
      })
      .returning({
        responseStyle: userProfiles.responseStyle,
        productMode: userProfiles.productMode,
        customInstructions: userProfiles.customInstructions,
        preferredModel: userProfiles.preferredModel,
        lastUsedModel: userProfiles.lastUsedModel,
        thinkingEffort: userProfiles.thinkingEffort,
      });
    return res.json(profileResponse(profile));
  } catch (error) {
    return next(error);
  }
});
