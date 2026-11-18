#!/usr/bin/env node
// Compares what the public pages were BUILT to say about AI credits with what the server says it
// is ENFORCING, using public, read-only requests only (no sign-in, no account data, no writes).
//
//   npm run credits:verify
//   npm run credits:verify -- --site https://vibhavgpt.com --api https://api.vibhavgpt.com --expect off
//
// Exit code: 0 consistent (and equal to --expect when given), 1 inconsistent, 2 could not check.
// Use it after every activation and every rollback (docs/credits-policy.md).

import { pathToFileURL } from "node:url";

const MODES = ["off", "expiry", "carry"];

/** The credits mode a built page declares, from its marker, or from its wording if the marker is missing. */
export function readPageCreditsCopy(html) {
  const marker = html.match(/<meta\s+name=["']vibhavgpt-credits-copy["']\s+content=["']([^"']*)["']/i)?.[1];
  const wording = /\bAI credits\b/.test(html) ? "credits" : /15 AI requests|token (?:caps|allowances)/i.test(html) ? "legacy" : "unknown";
  return { marker: MODES.includes(marker) ? marker : null, wording };
}

/** What the server enforces, from the body of GET /api/usage/policy. */
export function readServerCredits(policy) {
  return { mode: policy?.active && MODES.includes(policy.carryMode) ? policy.carryMode : "off", reason: policy?.reason ?? null, scheduledFor: policy?.scheduledFor ?? null, version: policy?.version ?? null };
}

/**
 * The verdict. `static-copy-stale` is not a customer-visible contradiction for people using the
 * site (the running page follows the server), but it is for a crawler or a visitor without
 * JavaScript, so it still fails the check: rebuild the frontend to match.
 */
export function compareCreditsDeployment({ page, policy, expect = null }) {
  const problems = [];
  const server = readServerCredits(policy);
  if (page.marker === null) problems.push("page-marker-missing: the built page has no credits marker (an older build)");
  const declared = page.marker ?? (page.wording === "credits" ? "credits" : "off");
  const wordingAgrees = page.marker === null ? true : (page.marker === "off" ? page.wording !== "credits" : page.wording === "credits");
  if (!wordingAgrees) problems.push(`page-wording-disagrees-with-its-marker: marker "${page.marker}" but the page text reads "${page.wording}"`);
  if (page.marker !== null && page.marker !== server.mode) {
    problems.push(`static-copy-stale: the pages were built for "${page.marker}" but the server enforces "${server.mode}"`);
  }
  if (expect !== null) {
    if (server.mode !== expect) problems.push(`server-not-as-expected: expected "${expect}", the server enforces "${server.mode}"`);
    if (page.marker !== null && page.marker !== expect) problems.push(`pages-not-as-expected: expected "${expect}", the pages were built for "${page.marker}"`);
  }
  return { ok: problems.length === 0, problems, page: { declared, wording: page.wording }, server };
}

async function main(argv) {
  const arg = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
  const site = (arg("site", "https://vibhavgpt.com")).replace(/\/+$/, "");
  const api = (arg("api", "https://api.vibhavgpt.com")).replace(/\/+$/, "");
  const expect = arg("expect", null);
  if (expect !== null && !MODES.includes(expect)) { console.error(`--expect must be one of: ${MODES.join(", ")}`); return 2; }
  let html;
  let policy;
  try {
    const [pageResponse, policyResponse] = await Promise.all([fetch(`${site}/pricing`, { redirect: "follow" }), fetch(`${api}/api/usage/policy`, { headers: { Accept: "application/json" } })]);
    if (!pageResponse.ok || !policyResponse.ok) throw new Error(`HTTP ${pageResponse.status} for the page, ${policyResponse.status} for the policy`);
    html = await pageResponse.text();
    policy = await policyResponse.json();
  } catch (error) {
    console.error(`Could not check: ${error.message}`);
    return 2;
  }
  const verdict = compareCreditsDeployment({ page: readPageCreditsCopy(html), policy, expect });
  console.log(`site   ${site}/pricing  built for: ${verdict.page.declared}  (page text reads: ${verdict.page.wording})`);
  console.log(`server ${api}/api/usage/policy  enforcing: ${verdict.server.mode}  (reason: ${verdict.server.reason}${verdict.server.scheduledFor ? `, scheduled for ${verdict.server.scheduledFor}` : ""})`);
  if (verdict.ok) { console.log("CONSISTENT"); return 0; }
  for (const problem of verdict.problems) console.log(`PROBLEM ${problem}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
