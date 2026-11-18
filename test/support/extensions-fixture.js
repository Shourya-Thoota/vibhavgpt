// A signed-in VibhavGPT app for browser tests of the Extensions page and the composer: frontend/dist, served with the app's own
// boot endpoints (from scripts/design-capture.mjs) plus the connectors and skills endpoints, with state a test can read and change.
// Nothing here talks to a provider or a real account; connect, disconnect and enable only change this fixture's own list.
import http from "node:http";
import { serve as designServer } from "../../scripts/design-capture.mjs";

const connector = (id, name, category, status = "disconnected", extra = {}) => ({
  id, name, category, status, enabled: status === "connected", catalogVisible: true, configured: true, apps: [id], ...extra,
});

/** A directory of the size and shape the product's own has: some connected, some not, one needing permissions, one needing setup. */
export function defaultConnectors() {
  return [
    connector("gmail", "Gmail", "Communication", "connected", { metadata: { email: "avery@example.com" }, missingApps: ["gmail"], blockerNotice: "Reconnect to grant the missing access." }),
    connector("googledrive", "Google Drive", "Productivity", "connected", { metadata: { email: "avery@example.com" } }),
    connector("weather", "Weather", "Utilities", "connected"),
    connector("web_search", "Web Search", "Utilities", "connected"),
    connector("googlecalendar", "Google Calendar", "Productivity"),
    connector("googledocs", "Google Docs", "Productivity"),
    connector("googlesheets", "Google Sheets", "Productivity"),
    connector("notion", "Notion", "Productivity"),
    connector("dropbox", "Dropbox", "Productivity"),
    connector("slack", "Slack", "Communication", "configuration_required", { blockerNotice: "Needs setup by the owner." }),
    connector("outlook", "Outlook", "Communication"),
    connector("zoom", "Zoom", "Communication"),
    connector("github", "GitHub", "Developer"),
    connector("gitlab", "GitLab", "Developer"),
    connector("linear", "Linear", "Project management"),
    connector("jira", "Jira", "Project management"),
    connector("trello", "Trello", "Project management"),
    connector("asana", "Asana", "Project management"),
    connector("todoist", "Todoist", "Project management"),
    connector("clickup", "ClickUp", "Project management"),
    connector("airtable", "Airtable", "Data"),
    connector("figma", "Figma", "Design"),
    connector("calendly", "Calendly", "Scheduling"),
    connector("youtube", "YouTube", "Media"),
    // Legacy bundles stay in the API but are not published, so they are not listed.
    connector("google_workspace", "Google Workspace", "Productivity", "disconnected", { catalogVisible: false }),
  ];
}

export function sampleSkills() {
  return [
    { id: "skill_brief", name: "Weekly brief", description: "Turn my notes into a short weekly update.", enabled: true },
    { id: "skill_review", name: "Code review", description: "Read a diff and list risks first.", enabled: true },
    { id: "skill_paused", name: "Meeting notes", description: "", enabled: false },
  ];
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const body = (req) => new Promise((resolve) => { let text = ""; req.on("data", (c) => { text += c; }); req.on("end", () => { try { resolve(text ? JSON.parse(text) : {}); } catch { resolve({}); } }); });
const json = (res, status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };

/**
 * Starts the fixture. `state.connectors` and `state.skills` are the live lists; `state.calls` records every write as
 * "METHOD /path"; `state.initiate` is what Connect gets back: "connected" (it works) or "error" (it fails with a message).
 */
export async function startFixture({ connectors = defaultConnectors(), skills = [], initiate = "connected", memoryEnabled = true, memory = null } = {}) {
  const state = { connectors, skills, calls: [], bodies: [], initiate, memoryEnabled, memory };
  const base = designServer({ signedIn: true });
  await listen(base);
  const basePort = base.address().port;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const write = req.method !== "GET" && req.method !== "HEAD";
    if (path.startsWith("/api/connectors") || path.startsWith("/api/skills") || path === "/api/profile/preferences") {
      const data = write ? await body(req) : {};
      if (write) { state.calls.push(`${req.method} ${path}`); state.bodies.push(data); }
      if (path === "/api/profile/preferences") return json(res, 200, { preferredModel: "nova", lastUsedModel: "nova", thinkingEffort: "low", responseStyle: "balanced", customInstructions: "", memoryEnabled: state.memoryEnabled, theme: "dark" });
      if (path === "/api/connectors" && req.method === "GET") return json(res, 200, { connectors: state.connectors });
      if (path === "/api/connectors/sync") return json(res, 200, { success: true });
      const one = path.match(/^\/api\/connectors\/([^/]+)(?:\/(status|initiate|disconnect))?$/);
      if (one) {
        const item = state.connectors.find((c) => c.id === decodeURIComponent(one[1]));
        if (!item) return json(res, 404, { error: "Unknown connector." });
        if (one[2] === "status") return json(res, 200, { status: item.status });
        if (one[2] === "initiate") {
          if (state.initiate === "error") return json(res, 409, { error: `${item.name} could not start authorization. Try again.` });
          item.status = "connected"; item.enabled = true;
          return json(res, 200, { connected: true });
        }
        if (one[2] === "disconnect") { item.status = "disconnected"; item.enabled = false; return json(res, 200, { success: true }); }
        if (req.method === "PATCH") { item.enabled = Boolean(data.enabled); return json(res, 200, { success: true, connector: item }); }
      }
      if (path === "/api/skills" && req.method === "GET") return json(res, 200, { skills: state.skills });
      if (path === "/api/skills" && req.method === "POST") { const skill = { id: `skill_${state.skills.length + 1}`, enabled: true, ...data }; state.skills.push(skill); return json(res, 200, { skill }); }
      const skill = path.match(/^\/api\/skills\/([^/]+)$/);
      if (skill) {
        const item = state.skills.find((s) => s.id === skill[1]);
        if (req.method === "DELETE") { state.skills = state.skills.filter((s) => s.id !== skill[1]); return json(res, 200, { success: true }); }
        if (item && (req.method === "PATCH" || req.method === "PUT")) { Object.assign(item, data); return json(res, 200, { skill: item }); }
      }
      return json(res, 404, { error: "Not part of this fixture." });
    }
    // Memory, only when a test passes `memory: { facts, useEnabled, saveEnabled }`: the list and settings live in state.memory.
    if (state.memory && path.startsWith("/api/memory")) {
      const data = write ? await body(req) : {};
      if (write) { state.calls.push(`${req.method} ${path}`); state.bodies.push(data); }
      const m = state.memory;
      if (path === "/api/memory" && req.method === "GET") return json(res, 200, { facts: m.facts, enabled: m.useEnabled, useEnabled: m.useEnabled, saveEnabled: m.saveEnabled });
      if (path === "/api/memory/settings") {
        if (typeof data.use === "boolean") m.useEnabled = data.use;
        if (typeof data.save === "boolean") m.saveEnabled = data.save;
        return json(res, 200, { enabled: m.useEnabled, useEnabled: m.useEnabled, saveEnabled: m.saveEnabled });
      }
      const one = path.match(/^\/api\/memory\/([^/]+)$/);
      const fact = one && m.facts.find((f) => f.id === one[1]);
      if (one && !fact) return json(res, 404, { error: "Memory entry not found." });
      if (fact && req.method === "DELETE") { m.facts = m.facts.filter((f) => f !== fact); res.writeHead(204); return res.end(); }
      if (fact && req.method === "PATCH") {
        if (data.scope === "personal") Object.assign(fact, { scope: "personal", projectId: null, projectName: null });
        if (typeof data.content === "string") fact.content = data.content;
        return json(res, 200, { fact });
      }
      return json(res, 404, { error: "Not part of this fixture." });
    }
    // Everything else, including the page itself, comes from the design-capture app.
    const upstream = http.request({ host: "127.0.0.1", port: basePort, path: req.url, method: req.method, headers: req.headers }, (answer) => { res.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(res); });
    upstream.on("error", () => json(res, 502, { error: "fixture upstream" }));
    req.pipe(upstream);
  });
  await listen(server);
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => { server.close(); base.close(); } };
}
