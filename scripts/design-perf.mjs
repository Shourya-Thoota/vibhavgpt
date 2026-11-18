// Lab performance of a built homepage: largest contentful paint, layout
// shift and bytes transferred, under fixed throttling (40 ms latency,
// 10 Mbps, 4x CPU slowdown), median of three cold loads per viewport.
// These are lab numbers from one machine, not field data.
//
//   node scripts/design-perf.mjs [distDir] [route]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const dist = path.resolve(process.argv[2] ?? "frontend/dist");
const route = process.argv[3] ?? "/";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end("{}"); }
  let file = path.join(dist, url.pathname === "/" || url.pathname === "/home" ? "home/index.html" : url.pathname === "/pricing" ? "pricing.html" : url.pathname.slice(1));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, "index.html");
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
  return undefined;
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const local = process.env.LOCALAPPDATA ?? "";
const executablePath = [process.env.BROWSER_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", path.join(local, "Google", "Chrome", "Application", "chrome.exe"), "/usr/bin/google-chrome"].find((candidate) => candidate && fs.existsSync(candidate));
const browser = await chromium.launch({ headless: true, executablePath });
const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];

try {
  for (const [label, viewport] of [["1440px", { width: 1440, height: 900 }], ["390px", { width: 390, height: 844 }]]) {
    const runs = [];
    for (let run = 0; run < 3; run += 1) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: (10 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8 });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      let bytes = 0;
      cdp.on("Network.loadingFinished", (event) => { bytes += event.encodedDataLength; });
      await page.addInitScript(() => {
        window.__lcp = 0; window.__cls = 0;
        new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__lcp = entry.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
        new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__cls += entry.value; }).observe({ type: "layout-shift", buffered: true });
      });
      await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      const { lcp, cls } = await page.evaluate(() => ({ lcp: window.__lcp, cls: window.__cls }));
      runs.push({ lcp, cls, bytes });
      await context.close();
    }
    console.log(JSON.stringify({ viewport: label, lcpMs: Math.round(median(runs.map((r) => r.lcp))), cls: Number(median(runs.map((r) => r.cls)).toFixed(3)), transferredKB: Math.round(median(runs.map((r) => r.bytes)) / 1024) }));
  }
} finally {
  await browser.close();
  server.close();
}
