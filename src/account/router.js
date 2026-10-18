import { asc, eq } from "drizzle-orm";
import { Router } from "express";
import { db } from "../db/client.js";
import { attachments, conversationGroups, conversations, creditLedger, imageFolders, memoryFacts, messages, subscriptions, usageEvents, userProfiles } from "../db/schema.js";
import { deleteAccountData, deletionBlock } from "./deletion.js";
import { auth } from "../auth.js";
import { expressCookieOptions } from "../auth/native-oauth.js";
import { requireSession } from "../middleware/require-session.js";
import { removeFiles } from "../uploads/service.js";

export const accountRouter = Router();
accountRouter.use(requireSession);

accountRouter.get("/export", async (req, res, next) => {
  try {
    const userId = req.authSession.user.id;
    const [profile, userConversations, facts, usage, credits, subscription] = await Promise.all([
      db.select().from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1),
      db.select().from(conversations).where(eq(conversations.userId, userId)).orderBy(asc(conversations.createdAt)),
      db.select().from(memoryFacts).where(eq(memoryFacts.userId, userId)).orderBy(asc(memoryFacts.createdAt)),
      db.select().from(usageEvents).where(eq(usageEvents.userId, userId)).orderBy(asc(usageEvents.createdAt)),
      db.select().from(creditLedger).where(eq(creditLedger.userId, userId)).orderBy(asc(creditLedger.createdAt)),
      db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1),
    ]);
    const ids = userConversations.map((conversation) => conversation.id);
    const conversationMessages = ids.length
      ? await db.select().from(messages).where(eq(messages.conversationId, ids[0])).orderBy(asc(messages.createdAt))
      : [];
    // A user can have several conversations; query the remaining ones without exposing another user's data.
    const remainingMessages = await Promise.all(
      ids.slice(1).map((id) =>
        db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt)),
      ),
    );
    const exported = {
      exportedAt: new Date().toISOString(),
      account: { id: userId, email: req.authSession.user.email, name: req.authSession.user.name },
      profile: profile[0] ?? null,
      conversations: userConversations,
      messages: [...conversationMessages, ...remainingMessages.flat()],
      memory: facts,
      attachments: await db.select().from(attachments).where(eq(attachments.userId, userId)).orderBy(asc(attachments.createdAt)),
      imageFolders: await db.select().from(imageFolders).where(eq(imageFolders.userId, userId)).orderBy(asc(imageFolders.createdAt)),
      projectsAndFolders: await db.select().from(conversationGroups).where(eq(conversationGroups.userId, userId)).orderBy(asc(conversationGroups.createdAt)),
      usage,
      credits,
      subscription: subscription[0] ? { tier: subscription[0].tier, status: subscription[0].status } : null,
    };
    res.setHeader("Content-Disposition", 'attachment; filename="vibhavgpt-account-data.json"');
    return res.json(exported);
  } catch (error) {
    return next(error);
  }
});

// The browser's sign-in cookies. The sessions behind them are deleted with
// the account, so they no longer work; clearing them signs the browser out
// at once instead of on its next request.
async function signInCookies() {
  const ctx = await auth.$context;
  const { sessionToken, sessionData, accountData, dontRememberToken } = ctx.authCookies;
  return [sessionToken, sessionData, accountData, dontRememberToken].filter(Boolean);
}

// Deleting an account never cancels a plan. While the account has a plan
// that could still renew or charge, the request is refused with 409 and
// nothing is deleted; the person cancels it first and tries again. A web plan
// whose cancellation is already scheduled does not block (see deletionBlock).
export function deleteAccountHandler({ database = db, removeStoredFiles = removeFiles, cookiesToClear = signInCookies } = {}) {
  return async (req, res, next) => {
    const userId = req.authSession.user.id;
    try {
      const [subscription] = await database.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);
      const block = deletionBlock(subscription);
      if (block) return res.status(409).json(block);
      // Every row goes in one transaction; the stored files only after it
      // commits, so a failed deletion leaves the account whole.
      const { storedFiles } = await deleteAccountData(database, userId);
      const failed = await removeStoredFiles(storedFiles);
      if (failed) console.warn(JSON.stringify({ event: "account_deletion_files_left", failed, total: storedFiles.length }));
      for (const cookie of await cookiesToClear()) {
        res.clearCookie(cookie.name, expressCookieOptions({ ...cookie.attributes, maxAge: undefined }));
      }
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  };
}

accountRouter.delete("/", deleteAccountHandler());
