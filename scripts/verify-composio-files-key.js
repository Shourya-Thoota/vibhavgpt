// Owner-run check of the credential used for file hand-offs (COMPOSIO_FILES_API_KEY, or the gateway key when that is not set).
//
//   railway run -s vibhavgpt -e production -- npm run composio:verify-files-key [-- --account <connected account id>]
//
// It prints only fixed words and counts. It never prints the key, a response body, a connection id or an account name, and it creates, uploads and
// changes nothing (three GETs at most). Two separate questions are answered, and they are not the same thing:
//   1. credential: does the file route accept this key at all?              -> ACCEPTED / REJECTED / FORBIDDEN / UNREACHABLE / UNEXPECTED
//   2. project:    does this key's project hold the Drive connection?       -> MATCH / NO MATCH / UNVERIFIED
// Question 2 is only MATCH or NO MATCH when a connected account id is given with --account (the connection's id is looked up directly in the key's
// project; nothing else is listed). Without it, only a count of Google Drive connections in that project is shown and the answer stays UNVERIFIED.

const BASE = process.env.COMPOSIO_FILES_URL || "https://backend.composio.dev/api/v3.1";

const credentialWord = (status) => (status === 200 ? "ACCEPTED" : status === 401 ? "REJECTED (401: not a project key this service accepts)" : status === 403 ? "FORBIDDEN (403: key lacks the permission)" : status == null ? "UNREACHABLE" : `UNEXPECTED (${status})`);

/** Pure core: takes a fetch function, the key and an optional connected-account id; returns the lines to print. Exported for tests. */
export async function verifyFilesKey({ apiKey, accountId = "", fetchImpl = fetch }) {
  if (!apiKey) return ["files key: not set (the gateway key would be used)"];
  const get = async (path) => {
    try {
      const response = await fetchImpl(`${BASE}${path}`, { method: "GET", headers: { "x-api-key": apiKey } });
      let body = null;
      try { body = await response.json(); } catch { /* not json */ }
      return { status: response.status, body };
    } catch {
      return { status: null, body: null };
    }
  };
  const lines = [];
  const files = await get("/files/list?limit=1");
  lines.push(`credential (file route): ${credentialWord(files.status)}`);

  let project = "UNVERIFIED";
  if (accountId) {
    const account = await get(`/connected_accounts/${encodeURIComponent(accountId)}`);
    if (account.status === 200) project = "MATCH (the connected account is in this key's project)";
    else if (account.status === 404) project = "NO MATCH (404: not found in this key's project; a wrong id form gives the same answer, so use the id shown for the connection in the Composio dashboard)";
    else project = `UNVERIFIED (connected-account lookup: ${credentialWord(account.status)})`;
    lines.push(`project (named connected account): ${project}`);
  } else {
    const accounts = await get("/connected_accounts?toolkit_slugs=googledrive&limit=50");
    if (accounts.status === 200) {
      const items = Array.isArray(accounts.body?.items) ? accounts.body.items : null;
      lines.push(items
        ? `project: UNVERIFIED (this key's project has ${items.length}${accounts.body?.next_cursor ? "+" : ""} Google Drive connection(s); pass --account <id> to confirm yours is one of them)`
        : "project: UNVERIFIED (connection list had an unrecognised shape)");
    } else {
      lines.push(`project: UNVERIFIED (connection list: ${credentialWord(accounts.status)})`);
    }
  }
  const ready = files.status === 200 && project.startsWith("MATCH");
  lines.push(ready ? "verdict: READY (credential accepted and the connection is in the key's project)"
    : files.status === 200 ? "verdict: NOT CONFIRMED (the credential is accepted, but the project match is not established; do not treat uploads as working)"
    : "verdict: NOT READY (the file route does not accept this key; uploads of non-text files will not work with it)");
  return lines;
}

if (process.argv[1]?.endsWith("verify-composio-files-key.js")) {
  const apiKey = String(process.env.COMPOSIO_FILES_API_KEY ?? "").trim() || String(process.env.COMPOSIO_API_KEY ?? "").trim();
  const source = process.env.COMPOSIO_FILES_API_KEY ? "COMPOSIO_FILES_API_KEY" : "gateway key (COMPOSIO_API_KEY)";
  const at = process.argv.indexOf("--account");
  const given = at > 0 ? String(process.argv[at + 1] ?? "").trim() : "";
  if (at > 0 && (!given || given.startsWith("-"))) { console.log("--account needs a connected account id; nothing was checked"); process.exit(2); }
  const accountId = given;
  console.log(`key source: ${source}`);
  for (const line of await verifyFilesKey({ apiKey, accountId })) console.log(line);
}
