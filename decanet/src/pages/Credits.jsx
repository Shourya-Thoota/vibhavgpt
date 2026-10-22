import { Coins, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api, formatDate, formatMoney } from "../api.js";
import { Notice, Spinner } from "../components/ui.jsx";
import { VibhavButton } from "../components/VibhavButton.jsx";
import { navigate, useLocation } from "../router.jsx";
import { useSession } from "../session.jsx";

const KIND_LABELS = { purchase: "Purchase", roleplay: "Role-play", vibhavgpt_grant: "VibhavGPT perk", chapter_allocation: "From your chapter", chapter_reclaim: "Returned to chapter" };

// Lands back from Stripe with ?checkout=<session id> and confirms it.
export function useCheckoutReturn(onConfirmed) {
  const { query } = useLocation();
  const { notify, refresh } = useSession();
  const checkout = query.get("checkout");
  useEffect(() => {
    if (!checkout) return;
    navigate(location.pathname, { replace: true });
    if (checkout === "cancelled") { notify("Checkout cancelled. You weren't charged."); return; }
    api("/checkout/confirm", { method: "POST", body: { sessionId: checkout } })
      .then(async (result) => {
        notify(result.status === "complete" ? `Payment received: ${result.credits} credit${result.credits === 1 ? "" : "s"} added.` : "Payment is processing. Credits will appear shortly.");
        await refresh();
        onConfirmed?.();
      })
      .catch((error) => notify(error.message));
  }, [checkout]);
}

export function Credits() {
  const { account, refresh, catalog } = useSession();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = () => api("/credits").then(setData).catch((failure) => setError(failure.message));
  useEffect(() => { load(); }, []);
  useCheckoutReturn(load);

  async function buy(pack) {
    setBusy(pack); setError("");
    try { location.href = (await api("/checkout", { method: "POST", body: { kind: "individual", pack } })).url; } catch (failure) { setError(failure.message); setBusy(""); }
  }

  if (!data) return error ? <div className="page"><Notice tone="red">{error}</Notice></div> : <Spinner />;
  const packs = catalog?.pricing.individual ?? { single: { credits: 1, cents: 250 }, five: { credits: 5, cents: 1000 } };
  return (
    <div className="page page--narrow stack stack--lg">
      <div className="row row--between">
        <div>
          <span className="eyebrow">Credits</span>
          <h1 className="title">1 credit = 1 role-play</h1>
        </div>
        <div className="credit-chip"><Coins size={18} color="var(--blue)" /><span><strong>{data.balance}</strong> available</span></div>
      </div>

      <div className="grid two-col">
        <div className="card card--pad price">
          <span className="label">Single</span>
          <div className="price__amount">{formatMoney(packs.single.cents)}</div>
          <p className="muted small">One role-play in any event.</p>
          <button className="btn btn--ghost" onClick={() => buy("single")} disabled={Boolean(busy)}>{busy === "single" ? "Opening checkout…" : "Buy 1 credit"}</button>
        </div>
        <div className="card card--pad price price--featured">
          <span className="row"><span className="label">Five-pack</span><span className="pill pill--blue">Save 20%</span></span>
          <div className="price__amount">{formatMoney(packs.five.cents)}</div>
          <p className="muted small">Five role-plays, {formatMoney(packs.five.cents / 5)} each.</p>
          <button className="btn btn--primary" onClick={() => buy("five")} disabled={Boolean(busy)}>{busy === "five" ? "Opening checkout…" : "Buy 5 credits"}</button>
        </div>
      </div>
      {error && <Notice tone="red">{error}</Notice>}
      <p className="tiny muted">Secure checkout by Stripe. Credits don't expire. Purchases are final once a credit is used.</p>

      <section className="card card--pad stack">
        <h2 className="subtitle row"><Sparkles size={20} color="var(--blue)" /> VibhavGPT member perk</h2>
        {data.subscriber.tier ? (
          <Notice tone="green">You're on VibhavGPT {data.subscriber.tier === "pro" ? "Pro" : "Plus"}: <b>{data.subscriber.creditsPerPeriod} free credit{data.subscriber.creditsPerPeriod === 1 ? "" : "s"}</b> every two months. Next ones arrive {formatDate(data.subscriber.nextGrantAt)}.</Notice>
        ) : account.vibhavgpt.connected ? (
          <p className="muted">Your VibhavGPT account is connected. Upgrade to <a href="https://vibhavgpt.com/pricing">Plus or Pro</a> to get 1 or 2 free DECANet credits every two months.</p>
        ) : (
          <>
            <p className="muted">VibhavGPT Plus members get 1 free credit every two months, and Pro members get 2. Connect your VibhavGPT account to claim them.</p>
            <div style={{ maxWidth: 320 }}><VibhavButton label="Connect VibhavGPT" onDone={async () => { await refresh(); load(); }} onError={setError} /></div>
          </>
        )}
      </section>

      <section>
        <h2 className="subtitle" style={{ marginBottom: 12 }}>Activity</h2>
        {data.history.length ? (
          <div className="card table-wrap">
            <table className="history"><tbody>
              {data.history.map((entry) => (
                <tr key={entry.id}>
                  <td><b>{KIND_LABELS[entry.kind] ?? entry.kind}</b>{entry.note && <div className="small muted">{entry.note}</div>}</td>
                  <td className="muted small">{formatDate(entry.createdAt)}</td>
                  <td style={{ textAlign: "right", fontWeight: 800, color: entry.delta > 0 ? "var(--green)" : "var(--ink)" }}>{entry.delta > 0 ? `+${entry.delta}` : entry.delta}</td>
                </tr>
              ))}
            </tbody></table>
          </div>
        ) : <div className="card empty">No credit activity yet.</div>}
      </section>
    </div>
  );
}
