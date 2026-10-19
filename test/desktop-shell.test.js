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
  const ipc = new Emitter();
  const appEvents = new Emitter();
  class BrowserWindow extends Emitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.overlay = options.titleBarOverlay;
      this.loaded = [];
      this.sent = [];
      const win = this;
      this.webContents = Object.assign(new Emitter(), {
        url: "https://vibhavgpt.com/app/chat",
        getURL() { return this.url; },
        isLoading: () => false,
        send: (channel) => win.sent.push(channel),
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
  const modules = { electron, "electron-window-state": (defaults) => Object.assign(windowState, { defaults }) };
  const sandbox = {
    require: (name) => modules[name] ?? require(name),
    __dirname: "C:/app", process: { ...process, argv, platform: "win32" }, URL, URLSearchParams, console,
  };
  vm.runInNewContext(read("desktop/main.js"), sandbox, { filename: "desktop/main.js" });
  return { windows, opened, shortcuts, ipc, appEvents, trayMenu: () => trayMenu, quits: () => quit, windowState };
}
const require = (await import("node:module")).createRequire(import.meta.url);

test("the window is frameless with Windows caption buttons over a 38px title bar, and keeps its size", () => {
  const shell = loadMain();
  const [win] = shell.windows;
  assert.equal(win.options.titleBarStyle, "hidden");
  assert.deepEqual({ ...win.options.titleBarOverlay }, { color: "#071227", symbolColor: "#94a3b8", height: 38 });
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

test("the caption buttons follow the page's colours, and only colours are accepted", () => {
  const shell = loadMain();
  const [win] = shell.windows;
  shell.ipc.emit("desktop:title-bar-colors", { sender: win.webContents }, { color: "#eef2f9", symbolColor: "#334155" });
  assert.deepEqual({ ...win.overlay }, { color: "#eef2f9", symbolColor: "#334155", height: 38 });
  shell.ipc.emit("desktop:title-bar-colors", { sender: win.webContents }, { color: "red; height: 900", symbolColor: "#334155" });
  assert.equal(win.overlay.color, "#eef2f9");
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
      ipcRenderer: { on: (channel, handler) => { ipcHandlers[channel] = handler; }, send: (channel, value) => sent.push([channel, value]) },
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
  return { exposed, sent, ipcHandlers, document, observed, setPaper: (value) => { paper = value; } };
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
  assert.deepEqual(plain(page.sent), [["desktop:title-bar-colors", { color: "#071227", symbolColor: "#94a3b8" }]]);
  // Switching to the light sky updates the caption buttons once.
  page.setPaper("#eef2f9");
  page.observed();
  page.observed();
  assert.deepEqual(plain(page.sent.slice(1)), [["desktop:title-bar-colors", { color: "#eef2f9", symbolColor: "#334155" }]]);
  page.ipcHandlers["desktop:new-chat"]();
  assert.deepEqual(plain(page.sent.at(-1)), ["dom", "desktop:new-chat"]);
});

test("the web app leaves room for the title bar only in the desktop app, and starts a chat from the tray", () => {
  const css = read("frontend/src/desktop.css");
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((rule) => rule.trim()).filter(Boolean);
  for (const rule of rules) for (const selector of rule.split("{")[0].split(",")) assert.match(selector.trim(), /^html\[data-desktop\]/, selector);
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
