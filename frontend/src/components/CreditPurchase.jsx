import { useState } from "react";
import {
  CREDIT_PURCHASE, CREDIT_SPEND, FLEX_FORMER_NAME, FLEX_NAME, creditUnits, creditsForCents, formatCreditCount, formatDollars, parsePurchaseAmount, purchaseButtonLabel,
} from "../flex-credits.js";
import "./usage-overview.css";

// The purchased balance: what it is for, what a purchase gets, and the history. It starts with nothing chosen, never charges until the
// button is pressed, and for an account that could not spend the credits it explains why and offers no purchase. A balance held from
// before stays on screen whatever the plan is now.

const when = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "Date unavailable";
};
const STATUS = { paid: "Paid", recorded: "Recorded" };

export function CreditHistory({ purchases, loading }) {
  return (
    <div className="uo-history" data-uo-history>
      <h3 className="uo-subtitle" id="uo-history-title">Purchase history</h3>
      {loading ? <p className="uo-text" role="status">Loading purchases…</p> : purchases.length === 0 ? (
        <p className="uo-text">No purchases yet.</p>
      ) : (
        <ul className="uo-history__list" aria-labelledby="uo-history-title">
          {purchases.map((purchase) => (
            <li key={purchase.id}>
              <span className="uo-history__date">{when(purchase.purchasedAt)}</span>
              <span className="uo-history__paid">{Number.isFinite(purchase.amountCents) ? formatDollars(purchase.amountCents) : "Amount unavailable"}</span>
              <span className="uo-history__units">{creditUnits(purchase.creditsGranted)} added</span>
              <span className="uo-history__status">{STATUS[purchase.status] ?? "Recorded"}</span>
              {purchase.receiptUrl && <a className="link" href={purchase.receiptUrl} target="_blank" rel="noreferrer">Receipt</a>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CreditPurchase({ flex, balance, purchases = [], purchasesLoading = false, busy = false, error = "", native = false, onBuy, onSeePlans }) {
  const [choice, setChoice] = useState({ kind: null, value: "" }); // nothing is chosen until the person chooses
  const terms = flex?.terms ?? CREDIT_PURCHASE;
  const parsed = choice.kind === null ? null : parsePurchaseAmount(choice.value);
  const ready = parsed?.ok === true;

  return (
    <section className="uo-section" aria-labelledby="uo-extra-title" data-uo-section="extra" data-uo-state={flex?.canBuy ? "can-buy" : "cannot-buy"}>
      <h2 id="uo-extra-title" className="uo-title">{FLEX_NAME}</h2>
      <p className="uo-former">Previously called {FLEX_FORMER_NAME}.</p>

      <div className="uo-headline" aria-label={`${formatCreditCount(balance)} ${FLEX_NAME} available`}>
        <p className="uo-headline__label">Available</p>
        <p className="uo-headline__value" data-uo-value>{creditUnits(balance)}</p>
      </div>
      <p className="uo-text">These pay for extra documents beyond your plan's allowance. They don't add Chat &amp; Study credits, and they don't expire.</p>

      {!flex ? (
        <p className="uo-text" role="status">Purchases are unavailable right now.</p>
      ) : native ? (
        <p className="uo-text">Purchases are available on VibhavGPT web.</p>
      ) : !flex.canBuy ? (
        <div className="uo-ineligible" data-uo-ineligible>
          <p className="uo-text">{flex.reason}</p>
          {flex.action && onSeePlans && <button type="button" className="btn btn--secondary uo-action" onClick={onSeePlans}>{flex.action.label}</button>}
          {balance > 0 && <p className="uo-text">You keep the {creditUnits(balance)} you already have, and they can still be used on a plan that includes extra documents.</p>}
        </div>
      ) : (
        <form className="uo-buy" onSubmit={(event) => { event.preventDefault(); if (ready) onBuy(parsed.dollars); }} aria-describedby="uo-buy-power">
          <p className="uo-text" id="uo-buy-power">{CREDIT_SPEND.extraDocument === 1 ? "1 credit pays for 1 extra document." : `${CREDIT_SPEND.extraDocument} credits pay for 1 extra document.`} Images can't be bought beyond your plan's allowance.</p>
          <div className="uo-presets" role="radiogroup" aria-label="Choose an amount">
            {terms.presets.map((dollars) => {
              const credits = creditsForCents(dollars * 100);
              const selected = choice.kind === "preset" && Number(choice.value) === dollars;
              return (
                <button key={dollars} type="button" role="radio" aria-checked={selected} className="uo-preset" disabled={busy} onClick={() => setChoice({ kind: "preset", value: String(dollars) })}>
                  <strong>${dollars}</strong>
                  <span>{creditUnits(credits)}</span>
                  <small>{formatCreditCount(credits / CREDIT_SPEND.extraDocument)} extra documents</small>
                </button>
              );
            })}
          </div>
          <div className="uo-custom">
            <label htmlFor="uo-custom-amount">Or enter an amount</label>
            <div className="uo-custom__field">
              <span aria-hidden="true">$</span>
              <input id="uo-custom-amount" type="number" inputMode="decimal" min={terms.minimumCents / 100} max={terms.maximumCents / 100} step={terms.stepCents / 100} placeholder="12.50" value={choice.kind === "custom" ? choice.value : ""} disabled={busy} onChange={(event) => setChoice({ kind: "custom", value: event.target.value })} aria-describedby="uo-preview" />
            </div>
          </div>
          <p className="uo-preview" id="uo-preview" role="status" aria-live="polite" data-uo-preview>
            {choice.kind === null ? "Choose an amount to see what you get." : ready ? `You pay ${formatDollars(parsed.cents)} and get ${creditUnits(parsed.credits)}.` : parsed.error}
          </p>
          <button type="submit" className="btn btn--primary uo-buy__button" disabled={!ready || busy} aria-busy={busy || undefined}>{busy ? "Opening checkout…" : ready ? purchaseButtonLabel(parsed.cents) : "Choose an amount"}</button>
          <p className="uo-caption">You are charged only when you press the button, once, on a secure payment page. Amounts are $1 to $500 in $0.10 steps.</p>
        </form>
      )}
      {error && <p className="note note--error" role="alert">{error}</p>}
      <CreditHistory purchases={purchases} loading={purchasesLoading} />
    </section>
  );
}
