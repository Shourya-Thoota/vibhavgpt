// Web sources a reply used, grouped by site. Each URL counts once, and only
// http(s) links are kept.
export function groupSources(sources = []) {
  const groups = new Map();
  const seen = new Set();
  for (const source of sources) {
    try {
      const url = new URL(source.url);
      if (!["https:", "http:"].includes(url.protocol) || seen.has(url.href)) continue;
      seen.add(url.href);
      const host = url.hostname.replace(/^www\./, "");
      if (!groups.has(host)) groups.set(host, { host, favicon: `${url.origin}/favicon.ico`, sources: [] });
      groups.get(host).sources.push(source);
    } catch { /* Ignore malformed source URLs. */ }
  }
  return [...groups.values()];
}

export const sourceCount = (sources) => groupSources(sources).reduce((sum, group) => sum + group.sources.length, 0);
