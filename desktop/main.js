// Windows shell for VibhavGPT: one window on the live web app, the same
// approach as the Android Capacitor build. No bundled web code, so the app
// is always the current production site.
const { app, BrowserWindow, Menu, shell } = require("electron");
const { createHash, randomBytes } = require("node:crypto");
const path = require("node:path");

const APP_ORIGIN = "https://vibhavgpt.com";
const APP_URL = `${APP_ORIGIN}/app`;
const API_ORIGIN = "https://api.vibhavgpt.com";
// The return link the server sends after Google sign-in (src/auth/native-oauth.js),
// the same one the Android app handles.
const PROTOCOL = "vibhavgpt";

let mainWindow = null;
// The verifier for the Google sign-in in progress. It never leaves this
// process except to redeem the one-time code, so a stolen return link is
// useless to anyone else.
let pendingVerifier = null;

// Pages on vibhavgpt.com (and its subdomains, which carry the API) stay in
// the window; anything else opens in the default browser.
function isAppUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
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
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 400,
    minHeight: 500,
    title: "VibhavGPT",
    icon: path.join(__dirname, "build", "icon.ico"),
    // Deep Space, so the first paint before the site loads is not white.
    backgroundColor: "#071227",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = win;

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => { mainWindow = null; });

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

  app.whenReady().then(() => {
    // No menu bar in production; keep the default (reload, devtools) in dev.
    if (app.isPackaged) Menu.setApplicationMenu(null);
    createWindow();
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
