import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// The Windows desktop app (desktop/): a frameless window whose title bar is
// the page's own top strip, a tray it hides to, a summon shortcut, external
// links in the default browser, and a preload that exposes only
// window.desktop. Electron is faked; the shell's own files run as written.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// Values made inside the VM come from another realm; compare them as data.
const plain = (value) => JSON.parse(JSON.stringify(value));

class Emitter {
  constructor() { this.handlers = {}; }
  on(name, handler) { (this.handlers[name] ??= []).push(handler); return this; }
  once(name, handler) { return this.on(name, handler); }
  emit(name, ...args) { for (const handler of this.handlers[name] ?? []) handler(...args); }
}

function loadMain({ packaged = true, argv = ["electron.exe"] } = {}) {
  const windows = [];
  const opened = [];
  const shortcuts = {};
  let trayMenu = null;
  let quit = 0;
  const ipc = Object.assign(new Emitter(), { handlers: {}, handle(channel, handler) { this.handlers[channel] = handler; } });
  const appEvents = new Emitter();
  const updater = Object.assign(new Emitter(), { checks: 0, installs: 0, checkForUpdates() { this.checks += 1; return Promise.resolve(null); }, quitAndInstall() { this.installs += 1; } });
  const timers = [];
  class BrowserWindow extends Emitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.overlay = options.titleBarOverlay;
      this.loaded = [];
      this.sent = [];
      this.messages = [];
      const win = this;
      this.webContents = Object.assign(new Emitter(), {
        url: "https://vibhavgpt.com/app/chat",
        getURL() { return this.url; },
        isLoading: () => false,
        send: (channel, payload) => { win.sent.push(channel); win.messages.push([channel, payload]); },
        setWindowOpenHandler(handler) { this.openHandler = handler; },
        executeJavaScript: async () => ({ ok: false }),
      });
      windows.push(this);
    }
    static fromWebContents() { return windows[0]; }
    static getAllWindows() { return windows; }
    loadURL(url) { this.loaded.push(url); }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    isMinimized() { return false; }
    setTitleBarOverlay(overlay) { this.overlay = overlay; }
  }
  const electron = {
    app: Object.assign(appEvents, {
      isPackaged: packaged,
      getVersion: () => "1.2.0",
      requestSingleInstanceLock: () => true,
      setAsDefaultProtocolClient() {},
      whenReady: () => ({ then: (run) => run() }),
      quit: () => { quit += 1; appEvents.emit("before-quit"); },
    }),
    BrowserWindow,
    globalShortcut: { register: (accelerator, handler) => { shortcuts[accelerator] = handler; return true; }, unregisterAll() {} },
    ipcMain: ipc,
    Menu: { setApplicationMenu() {}, buildFromTemplate: (template) => ({ template, popup() {} }) },
    shell: { openExternal: (url) => { opened.push(url); return Promise.resolve(); } },
    Tray: class extends Emitter { setToolTip() {} setContextMenu(menu) { trayMenu = menu.template; } },
  };
  const windowState = { x: 10, y: 20, width: 1400, height: 900, managed: null, manage(win) { this.managed = win; } };
  const modules = { electron, "electron-updater": { autoUpdater: updater }, "electron-window-state": (defaults) => Object.assign(windowState, { defaults }) };
  const sandbox = {
    require: (name) => modules[name] ?? require(name),
    __dirname: "C:/app", process: { ...process, argv, platform: "win32" }, URL, URLSearchParams, console, Promise, String, Number, Math, Boolean,
    setTimeout: (run, ms) => { timers.push({ run, ms }); return timers.length; },
  };
  vm.runInNewContext(read("desktop/main.js"), sandbox, { filename: "desktop/main.js" });
  return { windows, opened, shortcuts, ipc, appEvents, updater, timers, trayMenu: () => trayMenu, quits: () => quit, windowState };
}
const require = (await import("node:module")).createRequire(import.meta.url);

test("the window is frameless with Windows caption buttons over a 38px title bar, and keeps its size", () => {
  const shell = loadMain();
  const [win] = shell.windows;
  assert.equal(win.options.titleBarStyle, "hidden");
  assert.deepEqual({ ...win.options.titleBarOverlay }, { color: "#00000000", symbolColor: "#94a3b8", height: 38 }, "no background box behind the buttons");
  assert.equal(win.options.minWidth, 800);
  assert.equal(win.options.minHeight, 600);
  assert.deepEqual([win.options.x, win.options.y, win.options.width, win.options.height], [10, 20, 1400, 900], "saved bounds restored");
  assert.deepEqual({ ...shell.windowState.defaults }, { defaultWidth: 1280, defaultHeight: 800 });
  assert.equal(shell.windowState.managed, win, "size, position and maximized state are saved");
  const prefs = win.options.webPreferences;
  assert.equal(prefs.preload.replaceAll("\\", "/"), "C:/app/preload.js");
  assert.deepEqual([prefs.contextIsolation, prefs.nodeIntegration, prefs.sandbox, prefs.devTools], [true, false, true, false]);
  assert.deepEqual(win.loaded, ["https://vibhavgpt.com/app"]);
});

test("the caption button symbols follow the theme while their background stays transparent", () => {
  const shell = loadMain();
  const [win] = shell.windows;
  shell.ipc.emit("desktop:title-bar-colors", { sender: win.webContents }, { symbolColor: "#1e293b" });
  assert.deepEqual({ ...win.overlay }, { color: "#00000000", symbolColor: "#1e293b", height: 38 });
  // A page cannot paint a background back in, and only a #rrggbb symbol colour is taken.
  shell.ipc.emit("desktop:title-bar-colors", { sender: win.webContents }, { color: "#ffffff", symbolColor: "#94a3b8" });
  assert.deepEqual({ ...win.overlay }, { color: "#00000000", symbolColor: "#94a3b8", height: 38 });
  shell.ipc.emit("desktop:title-bar-colors", { sender: win.webContents }, { symbolColor: "red; height: 900" });
  assert.equal(win.overlay.symbolColor, "#94a3b8");
});

test("closing hides to the tray; the tray opens, starts a new chat and quits", () => {
  const shell = loadMain();
  const [win] = shell.windows;
  win.show();
  let prevented = false;
  win.emit("close", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(win.visible, false, "hidden, not closed");
  const menu = shell.trayMenu();
  assert.deepEqual(plain(menu.map((item) => item.label ?? item.type)), ["Open VibhavGPT", "New Chat", "separator", "Quit"]);
  menu[0].click();
  assert.equal(win.visible, true);
  menu[1].click();
  assert.deepEqual(plain(win.sent), ["desktop:new-chat"], "the open app starts its own new chat");
  win.webContents.url = "https://vibhavgpt.com/pricing";
  menu[1].click();
  assert.equal(win.loaded.at(-1), "https://vibhavgpt.com/app", "elsewhere, the app opens on a new chat");
  menu[3].click();
  assert.equal(shell.quits(), 1);
  prevented = false;
  win.emit("close", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false, "after Quit the window really closes");
});

test("Ctrl+Shift+Space summons the window from anywhere", () => {
  const shell = loadMain();
  const [win] = shell.windows;
  win.hide();
  shell.shortcuts["CommandOrControl+Shift+Space"]();
  assert.equal(win.visible, true);
});

test("external links open in the default browser; the app's own pages stay in the window", () => {
  const shell = loadMain();
  const [win] = shell.windows;
  const navigate = (url) => {
    let prevented = false;
    win.webContents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, url);
    return prevented;
  };
  assert.equal(navigate("https://vibhavgpt.com/app/study"), false);
  assert.equal(navigate("https://github.com/Shourya-Thoota/vibhavgpt"), true);
  assert.equal(win.webContents.openHandler({ url: "https://docs.example.com/" }).action, "deny");
  assert.deepEqual(shell.opened, ["https://github.com/Shourya-Thoota/vibhavgpt", "https://docs.example.com/"]);
  assert.equal(win.webContents.openHandler({ url: "javascript:alert(1)" }).action, "deny");
  assert.equal(shell.opened.length, 2, "only web and mail links are handed to Windows");
  assert.equal((win.webContents.handlers["context-menu"] ?? []).length, 0, "no right-click menu when packaged");
});

test("a development run can point at the local Vite server; a packaged build cannot", () => {
  const dev = loadMain({ packaged: false, argv: ["electron.exe", ".", "--app-url=http://localhost:5173/app"] });
  assert.deepEqual(dev.windows[0].loaded, ["http://localhost:5173/app"]);
  assert.equal(dev.windows[0].options.webPreferences.devTools, true);
  const packaged = loadMain({ packaged: true, argv: ["VibhavGPT.exe", "--app-url=http://evil.example/app"] });
  assert.deepEqual(packaged.windows[0].loaded, ["https://vibhavgpt.com/app"]);
});

function runPreload({ paper = "#071227" } = {}) {
  const exposed = {};
  const sent = [];
  const ipcHandlers = {};
  const invoked = [];
  const listeners = {};
  const element = (tag) => ({ tag, attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } });
  const head = { children: [], append(child) { this.children.push(child); } };
  const body = { children: [], prepend(child) { this.children.unshift(child); } };
  const root = { dataset: {} };
  const document = { documentElement: root, head, body, createElement: element };
  let observed = null;
  const sandbox = {
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
      ipcRenderer: {
        on: (channel, handler) => { ipcHandlers[channel] = handler; },
        removeListener: (channel, handler) => { if (ipcHandlers[channel] === handler) delete ipcHandlers[channel]; },
        send: (channel, value) => sent.push([channel, value]),
        invoke: (channel, ...args) => { invoked.push([channel, ...args]); return Promise.resolve(channel === "app:get-version" ? "1.2.0" : undefined); },
      },
    }),
    process: { platform: "win32" },
    document,
    window: { addEventListener: (name, handler) => { listeners[name] = handler; }, dispatchEvent: (event) => sent.push(["dom", event.type]), matchMedia: () => ({ addEventListener() {} }) },
    getComputedStyle: (node) => ({ getPropertyValue: () => (node === root ? paper : ""), backgroundColor: "rgba(0, 0, 0, 0)" }),
    MutationObserver: class { constructor(callback) { observed = callback; } observe() {} },
    Event: class { constructor(type) { this.type = type; } },
  };
  vm.runInNewContext(read("desktop/preload.js"), sandbox, { filename: "desktop/preload.js" });
  listeners.DOMContentLoaded();
  return { exposed, sent, invoked, ipcHandlers, document, observed, setPaper: (value) => { paper = value; } };
}

test("the preload exposes only isDesktop and platform, and makes the top strip the title bar", () => {
  const page = runPreload();
  assert.deepEqual(plain(page.exposed.desktop), { isDesktop: true, platform: "win32" });
  assert.ok(Object.isFrozen(page.exposed.desktop));
  assert.equal(page.document.documentElement.dataset.desktop, "win32");
  const [bar] = page.document.body.children;
  assert.equal(bar.id, "desktop-title-bar", "first in the page");
  const css = page.document.head.children[0].textContent;
  assert.match(css, /#desktop-title-bar \{[^}]*height: 38px;[^}]*width: env\(titlebar-area-width, calc\(100% - 138px\)\);[^}]*pointer-events: none; -webkit-app-region: drag; app-region: drag;/);
  assert.match(css, /html\[data-desktop\] :is\(a, button, input, select, textarea[^)]*\) \{\s*-webkit-app-region: no-drag; app-region: no-drag;/);
  assert.deepEqual(plain(page.sent), [["desktop:title-bar-colors", { symbolColor: "#94a3b8" }]], "light symbols on the dark theme");
  // Switching to the light sky updates the symbols once.
  page.setPaper("#eef2f9");
  page.observed();
  page.observed();
  assert.deepEqual(plain(page.sent.slice(1)), [["desktop:title-bar-colors", { symbolColor: "#1e293b" }]], "dark symbols on the light theme");
  page.ipcHandlers["desktop:new-chat"]();
  assert.deepEqual(plain(page.sent.at(-1)), ["dom", "desktop:new-chat"]);
});

test("the web app leaves room for the title bar only in the desktop app, and starts a chat from the tray", () => {
  const css = read("frontend/src/desktop.css");
  // Every style rule is scoped to the desktop app, by the preload's
  // html[data-desktop] or the web app's body.is-desktop-app; keyframe steps
  // and the @media wrapper are not style rules.
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "").replace(/@media[^{]*\{/g, "");
  const selectors = [...body.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(([, list]) => list.split(",").map((selector) => selector.trim())).filter(Boolean);
  assert.ok(selectors.length > 10);
  for (const selector of selectors) assert.match(selector, /^(?:html\[data-desktop\]|\.is-desktop-app)(?:\s|$)/, selector);
  assert.match(css, /html\[data-desktop\] \.workspace__main \{ padding-top: var\(--desktop-title-bar-h\); \}/);
  assert.match(read("frontend/src/main.jsx"), /import "\.\/desktop\.css";/);
  assert.match(read("frontend/src/App.jsx"), /window\.addEventListener\("desktop:new-chat", onDesktopNewChat\)/);
});

test("the desktop build stays out of the API's install and packages the preload", () => {
  const root = JSON.parse(read("package.json"));
  for (const name of ["electron", "electron-builder", "electron-window-state"]) {
    assert.ok(!root.dependencies[name] && !root.devDependencies[name], `${name} is not installed with the API`);
  }
  assert.equal(root.scripts["desktop:dev"], "npm run dev:local --prefix desktop");
  assert.equal(root.scripts["desktop:build"], "npm run dist --prefix desktop");
  const desktop = JSON.parse(read("desktop/package.json"));
  assert.ok(desktop.dependencies["electron-window-state"], "packaged with the app");
  assert.ok(desktop.build.files.includes("preload.js"));
  assert.equal(desktop.build.directories.output, "dist-desktop");
  assert.equal(desktop.build.appId, "com.pansophy.vibhavgpt.desktop", "same app id, so installs upgrade in place");
  assert.deepEqual(desktop.build.win.target, [{ target: "nsis", arch: ["x64"] }]);
});

test("the installer is a one-click, per-user install with shortcuts and a clean uninstall", () => {
  const { nsis } = JSON.parse(read("desktop/package.json")).build;
  assert.equal(nsis.oneClick, true, "no wizard pages");
  assert.equal(nsis.perMachine, false, "no admin prompt");
  assert.equal(nsis.allowToChangeInstallationDirectory, undefined, "no folder page");
  assert.equal(nsis.runAfterFinish, true);
  assert.deepEqual([nsis.createDesktopShortcut, nsis.createStartMenuShortcut, nsis.shortcutName], [true, true, "VibhavGPT"]);
  assert.equal(nsis.uninstallDisplayName, "VibhavGPT");
  assert.equal(nsis.deleteAppDataOnUninstall, true, "no local data left behind");
  for (const key of ["installerIcon", "uninstallerIcon", "installerHeaderIcon"]) assert.equal(nsis[key], "build/icon.ico", key);
  // The icon carries every size Windows asks for, up to 256 px.
  const ico = readFileSync(new URL("../desktop/build/icon.ico", import.meta.url));
  const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => ico[6 + index * 16] || 256).sort((a, b) => a - b);
  assert.deepEqual(sizes, [16, 32, 48, 256]);
});

test("the Windows download page describes the version the desktop package builds", () => {
  const page = read("frontend/public/vibhavgpt-windows/index.html");
  const { version } = JSON.parse(read("desktop/package.json"));
  const hero = page.match(/<span class="download-meta">Version ([\d.]+), ([\d.]+ MB)<\/span>/);
  assert.ok(hero, "the download button names the version and size");
  assert.equal(hero[1], version);
  assert.match(page, new RegExp(`<dt>Version</dt><dd>${version.replaceAll(".", "\.")}</dd>`));
  assert.match(page, new RegExp(`<dt>Download size</dt><dd>${hero[2].replace(".", "\.")}</dd>`), "the facts agree with the button");
  assert.match(page, /<span class="checksum" id="checksum">[0-9a-f]{64}<\/span>/);
  assert.match(page, /href="https:\/\/github\.com\/Shourya-Thoota\/vibhavgpt-releases\/releases\/latest\/download\/VibhavGPT-Setup-x64\.exe"/);
});

test("the updater downloads in the background, installs on quit, and checks 10 s after an installed app starts", async () => {
  const shell = loadMain({ packaged: true });
  assert.equal(shell.updater.autoDownload, true);
  assert.equal(shell.updater.autoInstallOnAppQuit, true);
  const startup = shell.timers.find((timer) => timer.ms === 10_000);
  assert.ok(startup, "a delayed check is scheduled");
  assert.equal(shell.updater.checks, 0, "not straight away");
  startup.run();
  assert.equal(shell.updater.checks, 1);
  assert.equal(loadMain({ packaged: false }).timers.some((timer) => timer.ms === 10_000), false, "no automatic check in development");
});

test("each updater event reaches the page as updater:status, and the latest one can be asked for", async () => {
  const shell = loadMain({ packaged: true });
  const [win] = shell.windows;
  const statuses = () => plain(win.messages.filter(([channel]) => channel === "updater:status").map(([, payload]) => payload));
  shell.updater.emit("checking-for-update");
  shell.updater.emit("update-available", { version: "1.2.0" });
  shell.updater.emit("download-progress", { percent: 12.4 });
  shell.updater.emit("download-progress", { percent: 12.9 });
  shell.updater.emit("download-progress", { percent: 57.2 });
  shell.updater.emit("update-downloaded", { version: "1.2.0" });
  assert.deepEqual(statuses(), [
    { status: "checking" },
    { status: "available", version: "1.2.0" },
    { status: "downloading", percent: 12 },
    { status: "downloading", percent: 57 },
    { status: "downloaded", version: "1.2.0" },
  ], "progress is sent once per whole percent");
  shell.updater.emit("update-not-available");
  shell.updater.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"));
  assert.deepEqual(statuses().slice(-2), [{ status: "not-available" }, { status: "error", message: "net::ERR_INTERNET_DISCONNECTED" }]);
  const page = { sender: win.webContents, senderFrame: { url: "https://vibhavgpt.com/app/settings/account" } };
  assert.deepEqual(plain(await shell.ipc.handlers["app:get-update-status"](page)), { status: "error", message: "net::ERR_INTERNET_DISCONNECTED" });
  assert.equal(await shell.ipc.handlers["app:get-version"](page), "1.2.0");
});

test("only the app's own page can check or install, and Install & Restart works only once an update has downloaded", async () => {
  const shell = loadMain({ packaged: true });
  const [win] = shell.windows;
  const page = { sender: win.webContents, senderFrame: { url: "https://vibhavgpt.com/app" } };
  const stranger = { sender: win.webContents, senderFrame: { url: "https://evil.example/" } };
  await shell.ipc.handlers["app:check-for-updates"](stranger);
  assert.equal(shell.updater.checks, 0);
  await shell.ipc.handlers["app:check-for-updates"](page);
  assert.equal(shell.updater.checks, 1);
  shell.ipc.emit("app:restart-and-install", page);
  assert.equal(shell.updater.installs, 0, "nothing downloaded yet");
  shell.updater.emit("update-downloaded", { version: "1.2.0" });
  shell.ipc.emit("app:restart-and-install", stranger);
  assert.equal(shell.updater.installs, 0);
  shell.ipc.emit("app:restart-and-install", page);
  assert.equal(shell.updater.installs, 1);
  // The hide-to-tray close handler steps aside so the installer can replace the app.
  let prevented = false;
  win.emit("close", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
});

test("a development run reports that updates need the installed app instead of checking", async () => {
  const shell = loadMain({ packaged: false });
  const [win] = shell.windows;
  await shell.ipc.handlers["app:check-for-updates"]({ sender: win.webContents, senderFrame: { url: "https://vibhavgpt.com/app" } });
  assert.equal(shell.updater.checks, 0);
  assert.deepEqual(plain(win.messages.at(-1)), ["updater:status", { status: "error", message: "Updates are checked in the installed app only." }]);
});

test("the preload's desktopAPI wires each method to its fixed message, and a status listener cleans up", async () => {
  const page = runPreload();
  const api = page.exposed.desktopAPI;
  assert.ok(Object.isFrozen(api));
  assert.deepEqual(plain(Object.keys(api).sort()), ["checkForUpdates", "getAppVersion", "getUpdaterStatus", "onUpdaterStatus", "restartAndInstall"]);
  assert.equal(await api.checkForUpdates(), undefined);
  assert.equal(await api.getAppVersion(), "1.2.0");
  api.restartAndInstall();
  assert.deepEqual(plain(page.invoked.map(([channel]) => channel)), ["app:check-for-updates", "app:get-version"]);
  assert.deepEqual(plain(page.sent.at(-1)), ["app:restart-and-install", null]);
  const seen = [];
  const stop = api.onUpdaterStatus((status) => seen.push(status));
  page.ipcHandlers["updater:status"]({}, { status: "downloading", percent: 40 });
  stop();
  assert.equal(page.ipcHandlers["updater:status"], undefined, "the listener is removed");
  assert.deepEqual(plain(seen), [{ status: "downloading", percent: 40 }]);
  assert.equal(typeof api.onUpdaterStatus("not a function"), "function");
});

test("releases publish to vibhavgpt-releases under one stable name, and local builds never publish", () => {
  const desktop = JSON.parse(read("desktop/package.json"));
  assert.ok(desktop.dependencies["electron-updater"], "packaged with the app");
  assert.deepEqual(desktop.build.publish, [{ provider: "github", owner: "Shourya-Thoota", repo: "vibhavgpt-releases", releaseType: "release" }]);
  // latest.yml names this file; the download page links to the same name.
  assert.equal(desktop.build.nsis.artifactName, "VibhavGPT-Setup-x64.${ext}");
  assert.match(desktop.scripts.dist, /--publish never$/);
  assert.match(read("frontend/public/vibhavgpt-windows/index.html"), /releases\/latest\/download\/VibhavGPT-Setup-x64\.exe/);
});
