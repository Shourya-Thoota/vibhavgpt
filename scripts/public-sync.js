// Builds the public repository's snapshot from a private commit, minus the
// paths in public-sync.json (DECANet's proprietary role-play bank), with
// public stand-ins put in their place. The public repository has its own
// history, so only the snapshot's own files are ever sent there.
//
//   node scripts/public-sync.js                    build and verify only (dry run)
//   node scripts/public-sync.js --commit -m "..."  also create the public commit
//   node scripts/public-sync.js --commit --push -m "..."
//
// Set GIT_AUTHOR_* and GIT_COMMITTER_* for the commit's author. The build
// refuses to commit if the snapshot contains any excluded path, any judge
// name, judge question or situation from the private bank, an .env file, or
// anything shaped like a secret key.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const ref = option("--ref", "main");
const message = option("-m", null);
const settings = JSON.parse(readFileSync(new URL("../public-sync.json", import.meta.url), "utf8"));

const work = mkdtempSync(join(tmpdir(), "public-sync-"));
const env = { ...process.env, GIT_INDEX_FILE: join(work, "index") };
const git = (gitArgs, options = {}) => execFileSync("git", gitArgs, { encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024, ...options }).trim();
const fail = (reason) => { console.error(`REFUSED: ${reason}`); rmSync(work, { recursive: true, force: true }); process.exit(1); };

try {
  const commit = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  git(["fetch", "-q", settings.remote, `${settings.branch}:refs/remotes/public/${settings.branch}`]);
  const publicHead = git(["rev-parse", `refs/remotes/public/${settings.branch}`]);

  // The snapshot: the private tree, minus exclusions, plus stand-ins.
  git(["read-tree", `${commit}^{tree}`]);
  for (const path of settings.exclude) git(["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", path]);
  for (const [path, source] of Object.entries(settings.overrides)) {
    const blob = git(["rev-parse", `${commit}:${source}`]);
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
  }
  const tree = git(["write-tree"]);
  const paths = git(["ls-tree", "-r", "--name-only", tree]).split("\n").filter(Boolean);

  // 1. No excluded path, other than its public stand-in.
  const leaked = paths.filter((path) => settings.exclude.some((prefix) => path.startsWith(prefix)) && !settings.overrides[path]);
  if (leaked.length) fail(`excluded paths in snapshot: ${leaked.join(", ")}`);
  // 2. No excluded file under another name.
  const privateBlobs = new Set(settings.exclude.flatMap((prefix) => git(["ls-tree", "-r", commit, "--", prefix]).split("\n").filter(Boolean).map((line) => line.split(/\s+/)[2])));
  const snapshotBlobs = git(["ls-tree", "-r", tree]).split("\n").filter(Boolean).map((line) => line.split(/\s+/));
  const copied = snapshotBlobs.filter(([, , blob]) => privateBlobs.has(blob)).map(([, , , path]) => path);
  if (copied.length) fail(`private files copied elsewhere: ${copied.join(", ")}`);
  // 3. No bank content quoted anywhere: judge names, judge questions, situation openings.
  const { CATALOG } = await import(new URL("../src/decanet/catalog.js", import.meta.url));
  if (!CATALOG.size) fail("the private role-play bank isn't loaded, so nothing can be checked against it");
  const needles = [...new Set([...CATALOG.values()].flatMap((roleplay) => [roleplay.judge.name, ...roleplay.questions, ...roleplay.situation.map((paragraph) => paragraph.slice(0, 80))]))];
  writeFileSync(join(work, "needles"), `${needles.join("\n")}\n`);
  let quoted = "";
  try { quoted = git(["grep", "-l", "-F", "-f", join(work, "needles"), tree, "--"]); } catch (error) { if (error.status !== 1) throw error; }
  if (quoted) fail(`bank content quoted in: ${quoted.split("\n").map((line) => line.slice(tree.length + 1)).join(", ")}`);
  // 4. No environment files or secret-shaped strings.
  const envFiles = paths.filter((path) => /(^|\/)\.env(\..+)?$/.test(path) && !path.endsWith(".env.example"));
  if (envFiles.length) fail(`environment files: ${envFiles.join(", ")}`);
  const secretPattern = "(^|[^A-Za-z0-9_-])(sk-(proj-)?[A-Za-z0-9_-]{24,}|sk_live_[A-Za-z0-9]{10,}|rk_live_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)";
  // Keys must start at a word boundary, so file names like "...grotesk-cyrillic" don't match.
  let secrets = "";
  try { secrets = git(["grep", "-l", "-E", secretPattern, tree, "--"]); } catch (error) { if (error.status !== 1) throw error; }
  if (secrets) fail(`secret-shaped strings in: ${secrets.split("\n").map((line) => line.slice(tree.length + 1)).join(", ")}`);

  const privateTree = git(["rev-parse", `${commit}^{tree}`]);
  const changed = git(["diff", "--name-status", `${publicHead}^{tree}`, tree]);
  console.log(JSON.stringify({ privateCommit: commit.slice(0, 7), privateTree: privateTree.slice(0, 7), snapshotTree: tree.slice(0, 7), publicHead: publicHead.slice(0, 7), files: paths.length, excluded: settings.exclude, checks: "passed" }, null, 2));
  console.log(`Changes against public ${publicHead.slice(0, 7)}:\n${changed || "(none)"}`);
  if (!changed) { console.log("Public repository is already up to date."); process.exit(0); }
  if (!flag("--commit")) { console.log("Dry run: nothing committed."); process.exit(0); }
  if (!message) fail("a commit message is required (-m)");
  const publicCommit = git(["commit-tree", tree, "-p", publicHead, "-m", message]);
  console.log(`Public commit: ${publicCommit}`);
  if (flag("--push")) {
    git(["push", settings.remote, `${publicCommit}:refs/heads/${settings.branch}`], { stdio: ["ignore", "pipe", "pipe"] });
    console.log(`Pushed ${publicCommit.slice(0, 7)} to ${settings.remote} ${settings.branch} (a fast-forward of ${publicHead.slice(0, 7)}).`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
