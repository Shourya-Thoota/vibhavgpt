import { useEffect, useState } from "react";
import { subscriptionSummary } from "../subscription-display.js";

// Mounted when the menu opens, so every open reads the verified account record.
export function AccountBillingMenu({ api, userId }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let mounted = true;
    let version = 0;
    const refresh = () => {
      const requestId = ++version;
      setState({ loading: true });
      api("/api/billing/subscription")
        .then(({ subscription }) => { if (mounted && requestId === version) setState({ subscription }); })
        .catch(() => { if (mounted && requestId === version) setState({ error: true }); });
    };
    refresh();
    window.addEventListener("vibhavgpt:subscription-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => { mounted = false; window.removeEventListener("vibhavgpt:subscription-changed", refresh); window.removeEventListener("focus", refresh); };
  }, [api, userId]);

  if (state.loading || state.error) return <div className="account-menu__billing" role="status">{state.loading ? "Checking subscription…" : "Subscription unavailable"}</div>;
  const summary = subscriptionSummary(state.subscription);
  return <>
    <div className="account-menu__billing" role="status">
      <span>{summary.plan} plan{summary.provider ? ` · ${summary.provider}` : ""}</span>
      <span>{summary.status}</span>
    </div>
  </>;
}
