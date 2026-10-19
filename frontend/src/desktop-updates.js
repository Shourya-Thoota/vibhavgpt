// In-app updates for the Windows desktop app. The app's preload exposes
// window.desktopAPI (desktop/preload.js); on the web it is absent, and every
// export here is inert: no listeners, no calls, and nothing to show.

const METHODS = ["checkForUpdates", "restartAndInstall", "getAppVersion", "onUpdaterStatus"];

export function desktopUpdater(scope = globalThis) {
  const api = scope?.desktopAPI;
  return api && METHODS.every((name) => typeof api[name] === "function") ? api : null;
}

// What Settings shows for each step. The main process passes the updater's
// own error text along, but the page shows a plain sentence instead.
export function updateStatusLabel(state) {
  switch (state?.status) {
    case "checking": return "Checking for updates...";
    case "available": return state.version ? `Downloading VibhavGPT ${state.version}...` : "Downloading the update...";
    case "downloading": return `Downloading update (${Math.max(0, Math.min(100, Math.floor(Number(state.percent) || 0)))}%)...`;
    case "downloaded": return state.version ? `VibhavGPT ${state.version} is ready to install.` : "Update downloaded.";
    case "not-available": return "You're up to date.";
    case "error": return "Couldn't check for updates. Try again later.";
    default: return "";
  }
}

// One shared copy of the latest status for the whole page, so the banner and
// Settings agree; it starts from the main process's latest status, so a
// Settings page opened later still knows an update is waiting.
export function createUpdateStore(api = desktopUpdater()) {
  let state = { status: "idle", version: null };
  const listeners = new Set();
  const set = (next) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  if (api) {
    api.onUpdaterStatus((next) => { if (next && typeof next.status === "string") set(next); });
    Promise.resolve(api.getAppVersion()).then((version) => set({ appVersion: String(version ?? "") })).catch(() => {});
    if (typeof api.getUpdaterStatus === "function") {
      Promise.resolve(api.getUpdaterStatus()).then((next) => { if (next?.status && state.status === "idle") set(next); }).catch(() => {});
    }
  }
  return {
    available: Boolean(api),
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    check: () => {
      if (!api) return Promise.resolve();
      set({ status: "checking" });
      return Promise.resolve(api.checkForUpdates()).catch(() => set({ status: "error" }));
    },
    install: () => { if (api && state.status === "downloaded") api.restartAndInstall(); },
  };
}

let shared = null;
export function updateStore() {
  shared ??= createUpdateStore();
  return shared;
}
