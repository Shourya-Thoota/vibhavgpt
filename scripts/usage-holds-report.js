#!/usr/bin/env node
// Dry run: how much of this period's allowances is held by usage rows with no settled cost (src/usage/hold-report.js). Read-only: one
// READ ONLY transaction, always rolled back. It prints totals; it never releases, settles, deletes or edits anything.
//
//   DATABASE_URL=... npm run usage:holds
//   DATABASE_URL=... npm run usage:holds -- --stranded-after 60 --since 2026-11-01 --top 20
//   DATABASE_URL=... npm run usage:holds -- --reveal-users     (raw account ids, for support follow-up only)
//
// Accounts are otherwise shown as one-way labels that change on every run. Exit code: 0 on success, 2 if the report could not run.

import pg from "pg";

const arg = (argv, name, fallback = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };

async function main(argv) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("Set DATABASE_URL to the database to read."); return 2; }
  const strandedAfterMinutes = Number(arg(argv, "stranded-after", 30));
  const sinceValue = arg(argv, "since");
  const since = sinceValue ? new Date(sinceValue) : null;
  if (!(strandedAfterMinutes > 0) || (since && Number.isNaN(since.getTime()))) { console.error("--stranded-after takes minutes; --since takes a date."); return 2; }
  const { usageHoldReport } = await import("../src/usage/hold-report.js");
  const ssl = process.env.DATABASE_SSL === "false" ? undefined : (/sslmode=disable|localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" });
  const client = new pg.Client({ connectionString: url, ssl, application_name: "usage-holds-report (read-only)" });
  try {
    await client.connect();
    const report = await usageHoldReport(client, { since, strandedAfterMinutes, revealUsers: argv.includes("--reveal-users"), top: Number(arg(argv, "top", 10)) || 10 });
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    console.error(`The report could not run: ${error.message}`);
    return 2;
  } finally {
    await client.end().catch(() => {});
  }
}

process.exitCode = await main(process.argv.slice(2));
