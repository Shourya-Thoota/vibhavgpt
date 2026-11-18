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
import { CUSTOMER_CHAT_MODEL_IDS, isCustomerChatModel, isRetiredHouseModel } from "../models/customer-catalog.js";
import { isThirdPartyModel } from "../../frontend/src/model-marketplace.js";

const STYLE_OPTIONS = new Set(["concise", "balanced", "detailed", "friendly"]);
const THINKING_EFFORTS = new Set(["normal", "low", "high", "xhigh", "max"]);
const MAX_INSTRUCTIONS = 4000;
const MODEL_OPTIONS = new Set(CUSTOMER_CHAT_MODEL_IDS);

export function isValidModelSelection(model) {
  if (!model) return false;
  const canonical = canonicalModelKey(model);
  return MODEL_OPTIONS.has(canonical) || isCustomerChatModel(canonical) || isThirdPartyModel(canonical);
}

function modelAllowedForTier(model, tier, creditBalance = 0) {
  const canonical = canonicalModelKey(model);
  if (!isValidModelSelection(canonical)) return false;
  if (canonical === "lumen" || canonical === "nova") return true;
  // Third-party models (Slice 7) are on every plan; Zenith is Max only.
  if (isThirdPartyModel(canonical)) return true;
  if (canonical === "zenith") return tier === "max";
  if (canonical === "tecton") return tier === "pro" || tier === "max" || tier === "paid";
  if (tier === "free") return false;
  if (tier === "plus") return canonical !== "vesper";
  return true;
}

function profileResponse(profile) {
  const pref = profile?.preferredModel ? canonicalModelKey(profile.preferredModel) : null;
  const last = profile?.lastUsedModel ? canonicalModelKey(profile.lastUsedModel) : null;
  return {
    responseStyle: profile?.responseStyle ?? "balanced",
    customInstructions: profile?.customInstructions ?? "",
    preferredModel: isValidModelSelection(pref) ? pref : null,
    lastUsedModel: isValidModelSelection(last) ? last : null,
    // The saved model was a retired tier (Nova, Nebula): named here so the app asks for a model rather than quietly using another one.
    // The stored value is not rewritten.
    retiredModel: [pref, last].find((key) => key && isRetiredHouseModel(key)) ?? null,
    productMode: profile?.productMode ?? "chat",
    thinkingEffort: profile?.thinkingEffort ?? "low",
    // The Settings memory switch, so the composer menu can show its own switch as unavailable when memory is off.
    memoryEnabled: profile?.memoryEnabled !== false,
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
    const raw = String(req.body?.lastUsedModel ?? "").trim();
    const lastUsedModel = canonicalModelKey(raw);
    if (!isValidModelSelection(lastUsedModel)) return res.status(400).json({ error: "Choose a valid model." });
    const [profile] = await db
      .insert(userProfiles)
      .values({ userId, lastUsedModel, thinkingEffort: "low" })
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
    if (!["chat", "study", "image", "build"].includes(productMode)) return res.status(400).json({ error: "Choose an available workspace." });
    await db.insert(userProfiles).values({ userId: req.authSession.user.id, productMode, thinkingEffort: "low" })
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
      .values({ userId, onboardingCompleted: true, onboardingCompletedAt: new Date(), onboardingAnswers: answers, thinkingEffort: "low" })
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
    
    let preferredModel = null;
    if (req.body?.preferredModel !== undefined) {
      if (req.body.preferredModel !== null && String(req.body.preferredModel).trim() !== "") {
        const candidate = canonicalModelKey(String(req.body.preferredModel).trim());
        if (!isValidModelSelection(candidate)) {
          return res.status(400).json({ error: "Choose a valid model." });
        }
        preferredModel = candidate;
      }
    } else if (existing?.preferredModel) {
      const candidate = canonicalModelKey(String(existing.preferredModel).trim());
      if (isValidModelSelection(candidate)) {
        preferredModel = candidate;
      }
    }

    let lastUsedModel = null;
    if (req.body?.lastUsedModel !== undefined) {
      if (req.body.lastUsedModel !== null && String(req.body.lastUsedModel).trim() !== "") {
        const candidate = canonicalModelKey(String(req.body.lastUsedModel).trim());
        if (!isValidModelSelection(candidate)) {
          return res.status(400).json({ error: "Choose a valid model." });
        }
        lastUsedModel = candidate;
      }
    } else if (existing?.lastUsedModel) {
      const candidate = canonicalModelKey(String(existing.lastUsedModel).trim());
      if (isValidModelSelection(candidate)) {
        lastUsedModel = candidate;
      }
    }

    const thinkingEffort = String(req.body?.thinkingEffort ?? existing?.thinkingEffort ?? "low").toLowerCase();
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
