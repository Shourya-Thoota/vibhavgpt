// Windows shell for VibhavGPT: one window on the live web app, the same
// approach as the Android Capacitor build. No bundled web code, so the app
// is always the current production site.
const { app, BrowserWindow, globalShortcut, ipcMain, Menu, shell, Tray } = require("electron");
const windowStateKeeper = require("electron-window-state");
const { createHash, randomBytes } = require("node:crypto");
const path = require("node:path");

const APP_ORIGIN = "https://vibhavgpt.com";
// `--app-url=http://localhost:5173/app` points a development run at the
// local Vite server (npm run dev:local); packaged builds always load the site.
const DEV_URL = app.isPackaged ? null : process.argv.find((arg) => arg.startsWith("--app-url="))?.slice("--app-url=".length) ?? null;
const APP_URL = DEV_URL ?? `${APP_ORIGIN}/app`;
const API_ORIGIN = "https://api.vibhavgpt.com";
// The return link the server sends after Google sign-in (src/auth/native-oauth.js),
// the same one the Android app handles.
const PROTOCOL = "vibhavgpt";
const ICON = path.join(__dirname, "build", "icon.ico");
const SUMMON_SHORTCUT = "CommandOrControl+Shift+Space";

// The page runs edge to edge: the title bar is a 38px strip of the page
// itself (see preload.js), and Windows draws only the caption buttons, with
// Snap Layouts on maximize, over its right end. Deep Space until the page
// reports its own colours.
const TITLE_BAR_HEIGHT = 38;
const TITLE_BAR_OVERLAY = { color: "#071227", symbolColor: "#94a3b8", height: TITLE_BAR_HEIGHT };

let mainWindow = null;
let tray = null;
// Closing the window hides it to the tray; only Quit (tray menu, or Windows
// shutting down) ends the app.
let quitting = false;
// The verifier for the Google sign-in in progress. It never leaves this
// process except to redeem the one-time code, so a stolen return link is
// useless to anyone else.
let pendingVerifier = null;

// Pages on vibhavgpt.com (and its subdomains, which carry the API) stay in
// the window; anything else opens in the default browser.
function isAppUrl(url) {
  try {
    const { protocol, hostname, origin } = new URL(url);
    if (DEV_URL && origin === new URL(DEV_URL).origin) return true;
    return protocol === "https:" && (hostname === "vibhavgpt.com" || hostname.endsWith(".vibhavgpt.com"));
  } catch {
    return false;
  }
}

function isGoogleSignIn(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && hostname === "accounts.google.com";
  } catch {
    return false;
  }
}

function openExternal(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === "https:" || protocol === "http:" || protocol === "mailto:") shell.openExternal(url);
  } catch {
    // Not a URL; ignore it.
  }
}

// Calls the API from inside the page, so the request carries the page's
// origin and any cookies it sets land in the window's own session.
async function apiFromPage(pathname, body) {
  const script = `fetch(${JSON.stringify(API_ORIGIN + pathname)}, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: ${JSON.stringify(JSON.stringify(body))},
  }).then(async (response) => ({ ok: response.ok, data: await response.json().catch(() => null) }))`;
  const { ok, data } = await mainWindow.webContents.executeJavaScript(script, true);
  if (!ok) throw new Error(data?.error ?? "Request failed");
  return data;
}

// Google refuses sign-in inside an embedded browser, so the whole OAuth round
// trip runs in the default browser, as in the Android app: the server hands
// back a one-time code on vibhavgpt://account/auth, which this process
// redeems with the verifier.
async function startGoogleSignIn() {
  const verifier = randomBytes(32).toString("base64url");
  const verifierHash = createHash("sha256").update(verifier).digest("base64url");
  try {
    const { url } = await apiFromPage("/api/native-auth/google/start", { verifierHash });
    if (!isAppUrl(url)) throw new Error("Unexpected sign-in address");
    pendingVerifier = verifier;
    await shell.openExternal(url);
  } catch {
    pendingVerifier = null;
    mainWindow.loadURL(`${APP_URL}?error=google_unavailable`);
  }
}

async function finishGoogleSignIn(returnUrl) {
  const verifier = pendingVerifier;
  pendingVerifier = null;
  const code = returnUrl.searchParams.get("code");
  const failure = returnUrl.searchParams.get("error");
  if (failure || !code || !verifier) {
    mainWindow.loadURL(`${APP_URL}?error=${encodeURIComponent(failure || "expired")}`);
    return;
  }
  try {
    const { params } = await apiFromPage("/api/native-auth/exchange", { code, verifier });
    // Carries the second-factor step through when the account has one.
    const query = new URLSearchParams(params ?? {});
    mainWindow.loadURL(`${APP_URL}${query.size ? `?${query}` : ""}`);
  } catch {
    mainWindow.loadURL(`${APP_URL}?error=expired`);
  }
}

function handleProtocolArgs(argv) {
  const link = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
  if (!link || !mainWindow) return;
  let url;
  try { url = new URL(link); } catch { return; }
  if (url.hostname === "account" && url.pathname === "/auth") void finishGoogleSignIn(url);
}

function focusWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// A new chat in the open app (the page listens for the event preload.js
// relays); from any other page, the app opens on a fresh chat.
function newChat() {
  focusWindow();
  const current = mainWindow.webContents.getURL();
  let inApp = false;
  try { inApp = isAppUrl(current) && new URL(current).pathname.startsWith("/app"); } catch { inApp = false; }
  if (inApp && !mainWindow.webContents.isLoading()) mainWindow.webContents.send("desktop:new-chat");
  else mainWindow.loadURL(APP_URL);
}

function createTray() {
  tray = new Tray(ICON);
  tray.setToolTip("VibhavGPT");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open VibhavGPT", click: focusWindow },
    { label: "New Chat", click: newChat },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", focusWindow);
}

function createWindow() {
  // Size, position and maximized state carry over between launches.
  const state = windowStateKeeper({ defaultWidth: 1280, defaultHeight: 800 });
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 800,
    minHeight: 600,
    title: "VibhavGPT",
    icon: ICON,
    // Deep Space, so the first paint before the site loads is not white.
    backgroundColor: "#071227",
    titleBarStyle: "hidden",
    titleBarOverlay: TITLE_BAR_OVERLAY,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = win;
  state.manage(win);

  win.once("ready-to-show", () => win.show());
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => { mainWindow = null; });

  // Packaged builds show no right-click menu (Electron has none of its own);
  // development runs offer Inspect Element.
  if (!app.isPackaged) {
    win.webContents.on("context-menu", (_event, { x, y }) => {
      Menu.buildFromTemplate([{ label: "Inspect Element", click: () => win.webContents.inspectElement(x, y) }]).popup({ window: win });
    });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isGoogleSignIn(url)) void startGoogleSignIn();
    else if (isAppUrl(url)) win.loadURL(url);
    else openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (isGoogleSignIn(url)) void startGoogleSignIn();
    else openExternal(url);
  });

  win.loadURL(APP_URL);
}

// One instance: a second launch, including the one Windows starts for a
// vibhavgpt:// link, hands its arguments to the running window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // In development the link must relaunch electron.exe with this folder.
  if (process.defaultApp) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  else app.setAsDefaultProtocolClient(PROTOCOL);

  app.on("second-instance", (_event, argv) => {
    focusWindow();
    handleProtocolArgs(argv);
  });

  // The page's title bar strip reports its background, so the caption
  // buttons match the light and dark themes. Only colours are accepted.
  const COLOUR = /^#[0-9a-f]{6}$/i;
  ipcMain.on("desktop:title-bar-colors", (event, { color, symbolColor } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !COLOUR.test(color ?? "") || !COLOUR.test(symbolColor ?? "")) return;
    win.setTitleBarOverlay({ color, symbolColor, height: TITLE_BAR_HEIGHT });
  });

  app.on("before-quit", () => { quitting = true; });
  app.on("will-quit", () => globalShortcut.unregisterAll());

  app.whenReady().then(() => {
    // No menu bar in production; keep the default (reload, devtools) in dev.
    if (app.isPackaged) Menu.setApplicationMenu(null);
    createWindow();
    createTray();
    // Summons the window from anywhere in Windows. Another app may own the
    // shortcut already; the app works the same without it.
    globalShortcut.register(SUMMON_SHORTCUT, focusWindow);
    // Launched by a return link while closed: the sign-in it belongs to was
    // lost with the old process, so this shows the expired message.
    mainWindow.webContents.once("did-finish-load", () => handleProtocolArgs(process.argv));
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
