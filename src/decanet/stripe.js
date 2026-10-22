import Stripe from "stripe";
import { config } from "../config.js";
import { decanetConfig, DecanetError } from "./config.js";
import { pool, transaction } from "./db.js";
import { chapterQuote, individualQuote } from "./pricing.js";

// DECANet sells through VibhavGPT's Stripe account with inline prices, so no
// products have to be created in the Stripe dashboard. Every session carries
// metadata.app = "decanet"; the shared webhook routes on that, and the
// credits granted always come from our own purchase row, never from metadata.
export const DECANET_APP = "decanet";

function stripeClient() {
  if (!config.stripeSecretKey) throw new DecanetError(503, "Payments aren't configured yet.");
  return new Stripe(config.stripeSecretKey);
}

export async function createCheckout({ account, kind, pack, quantity, chapterId }, { stripe = stripeClient(), db = pool } = {}) {
  const quote = kind === "chapter" ? chapterQuote(quantity) : individualQuote(pack);
  if (!quote) throw new DecanetError(400, kind === "chapter" ? "Choose between 1 and 5,000 credits." : "Choose a credit pack.");
  const label = kind === "chapter" ? "DECANet chapter credits" : `DECANet ${quote.credits === 1 ? "role-play credit" : `${quote.credits} role-play credits`}`;
  const lineItem = kind === "chapter"
    ? { price_data: { currency: "usd", unit_amount: quote.centsPerCredit, product_data: { name: label, description: "1 credit = 1 role-play, for chapter members" } }, quantity: quote.credits }
    : { price_data: { currency: "usd", unit_amount: quote.cents, product_data: { name: label, description: "1 credit = 1 role-play" } }, quantity: 1 };
  const back = kind === "chapter" ? "/chapter" : "/credits";
  const metadata = { app: DECANET_APP, decanet_account: account.id, decanet_kind: kind };
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [lineItem],
    customer_email: account.email,
    success_url: `${decanetConfig.appUrl}${back}?checkout={CHECKOUT_SESSION_ID}`,
    cancel_url: `${decanetConfig.appUrl}${back}?checkout=cancelled`,
    metadata,
    payment_intent_data: { metadata, description: label },
  });
  await db.query(
    `INSERT INTO decanet_purchases (checkout_session_id, account_id, chapter_id, pack, credits, amount_cents) VALUES ($1, $2, $3, $4, $5, $6)`,
    [session.id, account.id, kind === "chapter" ? chapterId : null, kind === "chapter" ? "chapter" : pack, quote.credits, quote.cents],
  );
  return { url: session.url };
}

export function isDecanetCheckoutEvent(event) {
  return ["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event?.type)
    && event?.data?.object?.metadata?.app === DECANET_APP;
}

// Grants a paid purchase exactly once: the ledger references are unique.
export async function applyCheckoutSession(session, db = pool) {
  if (session?.metadata?.app !== DECANET_APP || session.payment_status !== "paid") return false;
  return transaction(async (client) => {
    const { rows } = await client.query("SELECT * FROM decanet_purchases WHERE checkout_session_id = $1 FOR UPDATE", [session.id]);
    const purchase = rows[0];
    if (!purchase || purchase.status === "complete") return false;
    if (Number.isFinite(session.amount_total) && session.amount_total < purchase.amount_cents) return false;
    const reference = `stripe:${session.id}`;
    if (purchase.chapter_id) {
      await client.query(
        `INSERT INTO decanet_chapter_ledger (chapter_id, delta, kind, reference, actor_account_id, note) VALUES ($1, $2, 'purchase', $3, $4, $5) ON CONFLICT (reference) DO NOTHING`,
        [purchase.chapter_id, purchase.credits, reference, purchase.account_id, `Bought ${purchase.credits} credits`],
      );
    } else {
      await client.query(
        `INSERT INTO decanet_credit_ledger (account_id, delta, kind, reference, note) VALUES ($1, $2, 'purchase', $3, $4) ON CONFLICT (reference) DO NOTHING`,
        [purchase.account_id, purchase.credits, reference, `Bought ${purchase.credits} credit${purchase.credits === 1 ? "" : "s"}`],
      );
    }
    await client.query("UPDATE decanet_purchases SET status = 'complete', completed_at = now() WHERE checkout_session_id = $1", [session.id]);
    return true;
  }, db);
}

// Called when the buyer lands back on DECANet, so credits appear even if the
// webhook is slow or not set up yet. Only the buyer can confirm their session.
export async function confirmCheckout(account, sessionId, { stripe = stripeClient(), db = pool } = {}) {
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(String(sessionId ?? ""))) throw new DecanetError(400, "Invalid checkout.");
  const { rows } = await db.query("SELECT account_id, status, credits, chapter_id FROM decanet_purchases WHERE checkout_session_id = $1", [sessionId]);
  if (!rows[0] || rows[0].account_id !== account.id) throw new DecanetError(404, "Checkout not found.");
  if (rows[0].status === "complete") return { credits: rows[0].credits, chapter: Boolean(rows[0].chapter_id), status: "complete" };
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  await applyCheckoutSession(session, db);
  return { credits: rows[0].credits, chapter: Boolean(rows[0].chapter_id), status: session.payment_status === "paid" ? "complete" : "pending" };
}

export async function purchaseHistory(account, db = pool) {
  const { rows } = await db.query(
    `SELECT checkout_session_id, pack, credits, amount_cents, status, chapter_id, created_at FROM decanet_purchases WHERE account_id = $1 AND status = 'complete' ORDER BY created_at DESC LIMIT 50`,
    [account.id],
  );
  return rows.map((row) => ({ id: row.checkout_session_id.slice(-8), pack: row.pack, credits: row.credits, amountCents: row.amount_cents, chapter: Boolean(row.chapter_id), createdAt: row.created_at }));
}
