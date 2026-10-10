export function usagePercentage(used, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((Math.max(0, Number(used) || 0) / limit) * 100)));
}

export function modelTokenUsage(usage, key) {
  const monthlyPending = Math.max(0, Number(usage?.reservedTokenBreakdown?.[key]) || 0);
  const rollingPending = Math.max(0, Number(usage?.rollingReservedTokenBreakdown?.[key] ?? monthlyPending) || 0);
  return {
    monthly: Math.max(0, Number(usage?.tokenBreakdown?.[key]?.total) || 0) + monthlyPending,
    rolling: Math.max(0, Number(usage?.rollingTokenBreakdown?.[key]?.total) || 0) + rollingPending,
    monthlyPending, rollingPending,
  };
}

// Combined summaries weight tokens by allowance, including pending holds.
// Model pools remain independent; this view does not grant shared capacity.
export function combinedTokenUsage(usage, modelKeys = Object.keys(usage?.limits ?? {})) {
  const totals = { monthly: { used: 0, limit: 0 }, rolling: { used: 0, limit: 0 } };
  for (const key of modelKeys) {
    const counted = modelTokenUsage(usage, key);
    for (const window of ["monthly", "rolling"]) {
      const allowance = usage?.limits?.[key]?.[window];
      if (!Number.isFinite(allowance) || allowance < 0) continue;
      totals[window].limit += allowance;
      totals[window].used += counted[window];
    }
  }
  return totals;
}

export function overallTokenPercentage(usage, modelKeys) {
  const { monthly } = combinedTokenUsage(usage, modelKeys);
  return usagePercentage(monthly.used, monthly.limit);
}
