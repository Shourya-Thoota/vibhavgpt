// Build's projects end to end (owner request, 2026-11-15) through the REAL chat router and /api/build, over a real Postgres (PGlite). The
// model upstream is scripted: it answers in the file protocol (src/build/artifacts.js). Synthetic users and files only; nothing is run.
import test, { mock, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import JSZip from "jszip";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
mock.module(new URL("../src/db/client.js", import.meta.url).href, { namedExports: { db: drizzle(client), pool: { query: (sql, params) => client.query(sql, params) } } });
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: { requireSession: (req, res, next) => (req.authSession ? next() : res.status(401).json({ error: "Sign in is required." })), loadOptionalSession: (_req, _res, next) => next() },
});
const { config, TECTON_MODEL } = await import("../src/config.js");
config.moderationApiKey = "";
config.providerKeys.primaryFree = "";
config.providerKeys.paid = "fixture-key";
config.providerBaseUrls.paid = "https://openrouter.ai/api/v1";
const { resetRoutePolicyStateForTests } = await import("../src/chat/route-policy-guard.js");
const { chatRouter } = await import("../src/chat/router.js");
const { createBuildRouter } = await import("../src/build/router.js");
const { assertUploadQuota, uploadLimitsForUser } = await import("../src/uploads/service.js");
const { default: express } = await import("express");

const encoder = new TextEncoder();
const file = (path, content) => `<<<FILE path="${path}">>>\n${content}\n<<<END FILE>>>`;
let nextReply = "";
let finish = "stop";
const bodies = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.startsWith(config.providerBaseUrls.paid)) {
    if (href.includes("/generation")) return new Response("{}", { status: 404 });
    bodies.push(JSON.parse(init.body));
    const text = nextReply;
    return new Response(new ReadableStream({ start(c) {
      for (let i = 0; i < text.length; i += 400) c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 400) } }] })}\n\n`));
      c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 50, completion_tokens: 200 } })}\n\n`));
      c.close();
    } }), { headers: { "Content-Type": "text/event-stream" } });
  }
  if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
  throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
};
const verifyRoute = () => resetRoutePolicyStateForTests("tecton", {
  status: "verified", reason: "verified", model: TECTON_MODEL, hosts: "cloudflare", checkedAt: Date.now(),
  evidence: { endpoint: { provider_name: "Cloudflare" }, dataPolicy: { training: false, retainsPrompts: false, safetyRetention: false } }, allowedHosts: ["cloudflare"], positiveEvidence: false,
});

for (const user of ["alice", "bob"]) {
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [user, `${user}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [user]);
  await client.query("INSERT INTO subscriptions (user_id, subscription_id, tier, status, current_period_ends_at) VALUES ($1, $2, 'pro', 'active', now() + interval '20 days')", [user, `sub_${user}`]);
}
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authSession = { user: { id: req.get("x-test-user") } }; next(); });
app.use("/api/chat", chatRouter);
app.use("/api/build", createBuildRouter());
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
after(async () => { globalThis.fetch = realFetch; await new Promise((resolve) => server.close(resolve)); server.closeAllConnections?.(); await client.close(); });
beforeEach(() => { bodies.length = 0; finish = "stop"; resetRoutePolicyStateForTests(); verifyRoute(); });

async function build(user, message, conversationId = null) {
  const response = await realFetch(`${baseUrl}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json", "x-test-user": user }, body: JSON.stringify({ message, model: "tecton", mode: "build", ...(conversationId ? { conversationId } : {}) }) });
  const events = (await response.text()).split("\n\n").map((b) => ({ event: b.match(/^event:\s*(.+)$/m)?.[1], data: b.match(/^data:\s*(.+)$/m)?.[1] })).filter((e) => e.event && e.data).map((e) => ({ event: e.event, data: JSON.parse(e.data) }));
  return { complete: events.find((e) => e.event === "complete")?.data, error: events.find((e) => e.event === "error")?.data, events };
}
const get = (user, path) => realFetch(`${baseUrl}${path}`, { headers: { "x-test-user": user } });
const PAGE = [`<<<PROJECT kind="web" entry="index.html">>>`, file("index.html", "<!doctype html><title>Timer</title><script src=\"app.js\"></script>"), file("app.js", "let seconds = 0;")].join("\n");

let shared = null;
test("a Build reply in the file format becomes version 1, and the person sees only the summary", async () => {
  nextReply = `I made a timer page.\n${PAGE}`;
  const { complete, error } = await build("alice", "Build me a timer page");
  assert.ok(complete, JSON.stringify(error));
  assert.equal(complete.reply, "I made a timer page.");
  assert.doesNotMatch(complete.reply, /<<<|let seconds/);
  assert.equal(complete.artifact.status, "saved");
  assert.equal(complete.artifact.revision, 1);
  assert.deepEqual(complete.artifact.files.map((f) => f.path), ["app.js", "index.html"]);
  const project = (await (await get("alice", `/api/build/conversations/${complete.conversationId}/project`)).json()).project;
  assert.equal(project.current.revision, 1);
  assert.equal(project.current.entry, "index.html");
  assert.equal("content" in project.current.files[0], false, "the listing carries no contents");
  shared = { conversationId: complete.conversationId, projectId: project.id };
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].messages.map((m) => m.content).join("\n"), /<<<PROJECT kind="web"/, "Tecton was told the file format");
  assert.equal("tools" in bodies[0], false);
  assert.equal(bodies[0].max_tokens >= 8000, true, "room for a whole project from the start");
});

test("each file downloads as itself, as an attachment that can never run on the app's origin, and the ZIP holds exactly the files", async () => {
  const response = await get("alice", `/api/build/projects/${shared.projectId}/revisions/1/file?path=index.html`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.match(response.headers.get("content-disposition"), /^attachment; filename="index\.html"$/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /sandbox/);
  assert.equal(await response.text(), "<!doctype html><title>Timer</title><script src=\"app.js\"></script>");
  const viewed = await get("alice", `/api/build/projects/${shared.projectId}/revisions/1/file?path=index.html&view=1`);
  assert.match(viewed.headers.get("content-type"), /^text\/plain/, "viewing is as plain text, never as a page");
  const zipResponse = await get("alice", `/api/build/projects/${shared.projectId}/revisions/1/zip`);
  assert.equal(zipResponse.headers.get("content-type"), "application/zip");
  const zip = await JSZip.loadAsync(Buffer.from(await zipResponse.arrayBuffer()));
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
  assert.deepEqual(names, ["build-me-a-timer-page/app.js", "build-me-a-timer-page/index.html"]);
  assert.equal(await zip.file("build-me-a-timer-page/app.js").async("string"), "let seconds = 0;");
  assert.equal((await get("alice", `/api/build/projects/${shared.projectId}/revisions/1/file?path=../secrets`)).status, 404);
});

test("nobody else can see, download, zip or restore someone's project", async () => {
  assert.equal((await (await get("bob", `/api/build/conversations/${shared.conversationId}/project`)).json()).project, null);
  assert.equal((await get("bob", `/api/build/projects/${shared.projectId}/revisions/1/file?path=index.html`)).status, 404);
  assert.equal((await get("bob", `/api/build/projects/${shared.projectId}/revisions/1/zip`)).status, 404);
  const restore = await realFetch(`${baseUrl}/api/build/projects/${shared.projectId}/restore`, { method: "POST", headers: { "Content-Type": "application/json", "x-test-user": "bob" }, body: JSON.stringify({ revision: 1 }) });
  assert.equal(restore.status, 404);
});

test("a follow-up sees the current files and saves version 2; restoring version 1 makes version 3", async () => {
  nextReply = `I made the buttons bigger.\n<<<PROJECT kind="web" entry="index.html">>>\n${file("index.html", "<!doctype html><title>Timer</title><style>button{font-size:2rem}</style>")}`;
  const { complete } = await build("alice", "Make the buttons bigger", shared.conversationId);
  assert.equal(complete.artifact.revision, 2);
  assert.match(bodies[0].messages.map((m) => m.content).join("\n"), /The current project \(version 1[\s\S]*let seconds = 0;/, "Tecton was given the current files");
  const restore = await realFetch(`${baseUrl}/api/build/projects/${shared.projectId}/restore`, { method: "POST", headers: { "Content-Type": "application/json", "x-test-user": "alice" }, body: JSON.stringify({ revision: 1 }) });
  assert.deepEqual(await restore.json(), { projectId: shared.projectId, revision: 3, restoredFrom: 1 });
  const project = (await (await get("alice", `/api/build/conversations/${shared.conversationId}/project`)).json()).project;
  assert.deepEqual(project.revisions.map((r) => r.revision), [1, 2, 3]);
  assert.deepEqual(project.current.files.map((f) => f.path), ["app.js", "index.html"], "version 1's files are back");
});

test("a cut-off reply saves nothing, says so, keeps the previous version, and is not rewritten behind the person's back", async () => {
  finish = "length";
  nextReply = `Here it is.\n<<<PROJECT kind="web" entry="index.html">>>\n${file("index.html", "<p>new</p>")}`;
  const { complete } = await build("alice", "Rewrite everything", shared.conversationId);
  assert.equal(complete.artifact.status, "invalid");
  assert.match(complete.reply, /cut off before it finished/);
  assert.match(complete.reply, /previous version, if there is one, is unchanged/);
  assert.equal(bodies.length, 1, "one paid call: no hidden rewrite");
  const project = (await (await get("alice", `/api/build/conversations/${shared.conversationId}/project`)).json()).project;
  assert.equal(project.current.revision, 3, "the good version stays current");
});

test("project versions count towards file storage, and a version that would not fit is not saved", async () => {
  const before = (await uploadLimitsForUser("alice")).accountBytes;
  const { rows: [{ total }] } = await client.query("SELECT coalesce(sum(total_bytes), 0)::int AS total FROM build_revisions WHERE user_id = 'alice'");
  assert.ok(total > 0);
  // Fill the rest of the allowance with an upload row, then an upload of one more byte is refused because the versions count too.
  await client.query("INSERT INTO attachments (user_id, original_name, stored_name, mime_type, kind, size_bytes) VALUES ('alice', 'big.pdf', 'alice-big.pdf', 'application/pdf', 'document', $1)", [before - total]);
  const refused = await assertUploadQuota("alice", [{ originalname: "one.txt", size: 1 }], await uploadLimitsForUser("alice")).then(() => null, (error) => error);
  assert.equal(refused?.code, "storage-limit");
  nextReply = `Updated.\n${PAGE}`;
  const { complete } = await build("alice", "Add a reset button", shared.conversationId);
  assert.equal(complete.artifact.status, "not_saved");
  assert.match(complete.artifact.problem, /storage is full/);
  await client.query("DELETE FROM attachments WHERE stored_name = 'alice-big.pdf'");
});

// ---- The live preview, bundled on the API (the app's policy does not allow a bundler in the page) -------------------------------

test("the preview: the owner gets the version bundled into one sandbox document; nobody else gets anything", async () => {
  const own = await get("alice", `/api/build/projects/${shared.projectId}/revisions/1/preview`);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("cache-control"), "private, no-store");
  const body = await own.json();
  assert.equal(body.revision, 1);
  assert.equal(body.runtime, false, "a plain page needs no React runtime");
  assert.match(body.html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline';/);
  // app.js (an unused variable) is bundled into an inline script; esbuild drops the dead code, which is correct.
  assert.ok(body.html.includes("<script>(() => {\n})();\n</script>"), "the page's script is bundled inline");
  assert.doesNotMatch(body.html, /src="app\.js"/, "nothing is left to fetch");
  assert.equal((await get("bob", `/api/build/projects/${shared.projectId}/revisions/1/preview`)).status, 404);
  assert.equal((await get("alice", `/api/build/projects/${shared.projectId}/revisions/99/preview`)).status, 404);
});

test("the preview: a React version comes back with a place for the runtime; a broken one says why", async () => {
  const react = [`<<<PROJECT kind="react" entry="src/main.jsx">>>`,
    file("src/main.jsx", 'import { createRoot } from "react-dom/client"; import App from "./App"; createRoot(document.getElementById("root")).render(<App />);'),
    file("src/App.jsx", "export default function App() { return <p>Hello</p>; }")].join("\n");
  nextReply = `${react}\nA React page.`;
  const made = await build("alice", "Make it a React app");
  const { project } = await (await get("alice", `/api/build/conversations/${made.complete.conversationId}/project`)).json();
  const ok = await (await get("alice", `/api/build/projects/${project.id}/revisions/${project.current.revision}/preview`)).json();
  assert.equal(ok.runtime, true);
  const { PREVIEW_RUNTIME_MARKER } = await import("../frontend/src/build-preview.js");
  assert.ok(ok.html.includes(PREVIEW_RUNTIME_MARKER), "the browser puts the runtime here");
  assert.match(ok.html, /window\.__vgModules\["react-dom\/client"\]/);

  nextReply = [`<<<PROJECT kind="react" entry="src/main.jsx">>>`, file("src/main.jsx", 'import x from "left-pad"; console.log(x);')].join("\n") + "\nUses a package.";
  const broken = await build("alice", "Use a package", made.complete.conversationId);
  assert.ok(broken.complete);
  const again = await (await get("alice", `/api/build/conversations/${made.complete.conversationId}/project`)).json();
  const failed = await get("alice", `/api/build/projects/${again.project.id}/revisions/${again.project.current.revision}/preview`);
  assert.equal(failed.status, 422);
  assert.match((await failed.json()).error, /can't load the package "left-pad"/);
});

test("the preview is bundled by esbuild on the API and never run there", async () => {
  const router = await import("node:fs").then((m) => m.readFileSync(new URL("../src/build/router.js", import.meta.url), "utf8"));
  assert.match(router, /import \* as esbuild from "esbuild"/);
  assert.match(router, /PREVIEW_CONCURRENCY = 2/);
  assert.match(router, /PREVIEW_TIMEOUT_MS = 15_000/);
  assert.doesNotMatch(router.replace(/^\s*\/\/.*$/gm, ""), /\bvm\b|new Function|eval\(|child_process/, "nothing executes the project's code on the server");
  const pkg = JSON.parse(await import("node:fs").then((m) => m.readFileSync(new URL("../package.json", import.meta.url), "utf8")));
  assert.equal(pkg.dependencies.esbuild, "0.25.12", "a production dependency, pinned");
});
