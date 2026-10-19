import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createUpdateStore, desktopUpdater, updateStatusLabel } from "../frontend/src/desktop-updates.js";

// The web app's side of the Windows app's updater: Settings shows the
// version, a Check for updates button and the progress, and a banner offers
// Install & Restart once an update has downloaded. On the web, where
// window.desktopAPI does not exist, none of it appears or runs.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeApi({ status = { status: "idle" } } = {}) {
  const calls = [];
  let listener = null;
  return {
    calls,
    emit: (next) => listener?.(next),
    api: {
      checkForUpdates: () => { calls.push("check"); return Promise.resolve(); },
      restartAndInstall: () => calls.push("install"),
      getAppVersion: () => Promise.resolve("1.2.0"),
      getUpdaterStatus: () => Promise.resolve(status),
      onUpdaterStatus: (callback) => { listener = callback; return () => { listener = null; }; },
    },
  };
}

test("on the web there is no updater: nothing is offered and nothing runs", async () => {
  assert.equal(desktopUpdater({}), null);
  assert.equal(desktopUpdater({ desktopAPI: { checkForUpdates() {} } }), null, "an incomplete bridge counts as none");
  const store = createUpdateStore(null);
  assert.equal(store.available, false);
  await store.check();
  store.install();
  assert.deepEqual(store.getSnapshot(), { status: "idle", version: null });
});

test("each updater step has a plain label for Settings", () => {
  assert.equal(updateStatusLabel({ status: "checking" }), "Checking for updates...");
  assert.equal(updateStatusLabel({ status: "not-available" }), "You're up to date.");
  assert.equal(updateStatusLabel({ status: "downloading", percent: 42.7 }), "Downloading update (42%)...");
  assert.equal(updateStatusLabel({ status: "downloading", percent: 140 }), "Downloading update (100%)...");
  assert.equal(updateStatusLabel({ status: "downloaded", version: "1.2.0" }), "VibhavGPT 1.2.0 is ready to install.");
  assert.equal(updateStatusLabel({ status: "error", message: "net::ERR_INTERNET_DISCONNECTED at https://..." }), "Couldn't check for updates. Try again later.", "the raw error is not shown");
  assert.equal(updateStatusLabel({ status: "idle" }), "");
  for (const status of ["checking", "available", "downloading", "downloaded", "not-available", "error"]) assert.doesNotMatch(updateStatusLabel({ status, version: "1.2.0", percent: 5 }), /—/);
});

test("the store follows the main process, knows the version, and installs only a downloaded update", async () => {
  const fake = fakeApi();
  const store = createUpdateStore(fake.api);
  let changes = 0;
  store.subscribe(() => { changes += 1; });
  await settle();
  assert.equal(store.available, true);
  assert.equal(store.getSnapshot().appVersion, "1.2.0");
  await store.check();
  assert.equal(store.getSnapshot().status, "checking", "the button shows progress straight away");
  assert.deepEqual(fake.calls, ["check"]);
  store.install();
  assert.deepEqual(fake.calls, ["check"], "nothing to install yet");
  fake.emit({ status: "downloading", percent: 30 });
  fake.emit({ status: "downloaded", version: "1.3.0" });
  assert.equal(store.getSnapshot().version, "1.3.0");
  store.install();
  assert.deepEqual(fake.calls, ["check", "install"]);
  fake.emit({ nonsense: true });
  assert.equal(store.getSnapshot().status, "downloaded", "malformed messages are ignored");
  assert.ok(changes >= 4);
});

test("a page opened after the download still knows the update is waiting", async () => {
  const store = createUpdateStore(fakeApi({ status: { status: "downloaded", version: "1.3.0" } }).api);
  await settle();
  assert.deepEqual({ status: store.getSnapshot().status, version: store.getSnapshot().version }, { status: "downloaded", version: "1.3.0" });
});

test("Settings and the workspace show the updater only in the desktop app", () => {
  const app = read("frontend/src/App.jsx");
  assert.match(app, /function DesktopUpdateSettings\(\) \{\s*const \{ store, state \} = useDesktopUpdates\(\);\s*if \(!store\.available\) return null;/);
  assert.match(app, /<SettingsGroup title="Desktop app">/);
  assert.match(app, /Check for updates<\/button>/);
  assert.match(app, />Install & Restart<\/button>/);
  assert.match(app, /<\/SettingsGroup>\s*<DesktopUpdateSettings \/>\s*<\/div>\s*\)\}/, "in Settings, Account");
  assert.match(app, /function DesktopUpdateBanner\(\) \{[\s\S]*?if \(!store\.available \|\| state\.status !== "downloaded"/);
  assert.match(app, /<DesktopUpdateBanner \/>/);
});
