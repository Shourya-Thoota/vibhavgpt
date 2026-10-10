import { asc, eq } from "drizzle-orm";
import { Router } from "express";
import { cancelActiveSubscriptionsForUser } from "../billing/service.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { attachments, billingCustomers, conversationGroups, conversations, creditLedger, imageFolders, memoryFacts, messages, subscriptions, usageEvents, userProfiles } from "../db/schema.js";
import { deleteAccountData } from "./deletion.js";
import { requireSession } from "../middleware/require-session.js";
import { deleteUserUploads } from "../uploads/service.js";

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

accountRouter.delete("/", async (req, res, next) => {
  const userId = req.authSession.user.id;
  try {
    const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);
    const hasUnexpiredPaidAccess = subscription
      && ["active", "trialing"].includes(subscription.status)
      && subscription.tier !== "free"
      && (!subscription.currentPeriodEndsAt || subscription.currentPeriodEndsAt > new Date());
    // A paid web subscription is canceled first, so deleting an account can
    // never leave a renewal behind. If that fails, nothing is deleted.
    if (hasUnexpiredPaidAccess && subscription.billingSource === "stripe") {
      if (!config.stripeSecretKey) return res.status(409).json({ error: "Your subscription must be cancelled before deletion." });
      const [customer] = await db.select({ customerId: billingCustomers.customerId }).from(billingCustomers).where(eq(billingCustomers.userId, userId)).limit(1);
      try {
        await cancelActiveSubscriptionsForUser(userId, {
          subscriptionId: subscription.subscriptionId,
          customerIds: [subscription.customerId, customer?.customerId],
        });
      } catch {
        return res.status(502).json({ error: "We couldn't cancel your subscription, so nothing was deleted. Cancel it in Plan and billing, then try again." });
      }
    }
    // Stored files go before their rows, and their rows before image folders.
    await deleteUserUploads(userId);
    await deleteAccountData(db, userId);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});
