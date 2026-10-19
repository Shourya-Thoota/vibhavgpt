# VibhavGPT for Windows

An Electron shell that loads the production VibhavGPT web app
(`https://vibhavgpt.com/app`) in a single window, the same approach as the
Android Capacitor build. No web code is bundled, so the app is always the
current site.

- `main.js`: the main process. Pages on `vibhavgpt.com` and its subdomains stay
  in the window; other links open in the default browser. DevTools and the
  menu bar are off in packaged builds.
- Google sign-in: Google refuses OAuth inside an embedded browser, so when
  the page heads for `accounts.google.com` the shell cancels it and runs the
  same system-browser flow as the Android app (`src/auth/native-oauth.js`).
  It posts a verifier hash to `/api/native-auth/google/start` from the page,
  opens the returned URL in the default browser, and receives the
  `vibhavgpt://account/auth?code=…` return link through Windows (the installer
  registers the `vibhavgpt` protocol; Windows starts a second instance, which
  hands the link to the running window). It then redeems the code with
  `/api/native-auth/exchange` from the page, so the session cookies land in
  the window. Email sign-in is untouched.
- Title bar: the window has no frame. The top 38px of every page is the
  title bar, and Windows draws its caption buttons (with Snap Layouts on
  maximize) over the right end. `preload.js` adds a draggable
  `#desktop-title-bar` strip, keeps links, buttons and fields clickable
  inside it. The caption buttons have a transparent background, so the
  page's header shows through behind them, and their symbols switch between
  dark and light with the theme. The web app starts each screen below the
  strip when `html[data-desktop]` is set (`frontend/src/desktop.css`).
- `preload.js` exposes only `window.desktop = { isDesktop: true, platform }`
  to the page, and relays the tray's New Chat as a `desktop:new-chat` event.
- Window size, position and maximized state are kept between launches
  (`electron-window-state`).
- Closing the window hides it to the tray. The tray menu has Open VibhavGPT,
  New Chat and Quit; Ctrl+Shift+Space brings the window back from anywhere.
- No right-click menu in packaged builds; development runs offer Inspect
  Element.
- `build/icon.ico`: app, installer, tray and window icon, generated from
  `frontend/public/brand/vibhavgpt-icon-512.png` with `npm run icon`.

The shell has its own `package.json`, so Electron is never installed with
the API (the Railway build installs only the root package).

## Build

```powershell
cd desktop
npm install
npm run dev        # run against the live site
npm run dev:local  # run against the local Vite server (starts it too)
npm run dist       # NSIS installer, latest.yml and blockmap in dist-desktop/
```

From the repository root, `npm run desktop:dev` and `npm run desktop:build`
do the same as `dev:local` and `dist` (run `npm install --prefix desktop`
once first). `dev:local` needs the API on port 3001 for signing in, as for
`npm run dev --prefix frontend`.

If `npm run dev` fails with `Cannot read properties of undefined (reading
'requestSingleInstanceLock')`, the shell has `ELECTRON_RUN_AS_NODE` set (some
editor-hosted terminals do). Clear it first: `Remove-Item Env:ELECTRON_RUN_AS_NODE`.

## Publish a release

Release files are published in the separate `vibhavgpt-releases` repository,
not in this one. Bump `version` in `package.json`, run `npm run dist`, and
upload these from `dist-desktop/` to a new release there (tag `v<version>`),
unrenamed, then list each file's version and SHA-256 in the release notes:

- `VibhavGPT-Setup-x64.exe`: the installer. The download page links to
  `releases/latest/download/VibhavGPT-Setup-x64.exe`, so the name never changes.
- `latest.yml` and `VibhavGPT-Setup-x64.exe.blockmap`: what installed apps read
  to find, check and download the update. Without `latest.yml` in the latest
  release, no installed app updates.

Every release carries the Android APK too, because the download links always
point at the latest release. When only one app changes, re-attach the
unchanged file from the previous release.

`npm run dist` never publishes by itself (`--publish never`); the `publish`
block in `package.json` only tells the built app where to look for updates.

## Updates

The installed app checks for updates 10 seconds after it starts, and from
Settings, Account, Desktop app, "Check for updates". A newer release downloads
in the background, then a banner offers "Install & Restart"; otherwise it
installs the next time VibhavGPT quits. Versions up to 1.1.1 have no updater,
so their users install the first release that has one by hand, once.

## Installer

A one-click installer (NSIS `oneClick`): opening it shows a single progress
window with the app icon, installs for the current user only (no admin
prompt) in `%LOCALAPPDATA%\Programs\VibhavGPT`, adds Start menu and desktop
shortcuts, and opens VibhavGPT when it finishes. There are no wizard pages and
no folder choice. A newer installer replaces the installed version in place,
since the app id is unchanged. Uninstalling (Settings, Apps) removes the app,
its shortcuts and its local data (the window's saved sign-in, cache and window
size); the VibhavGPT account itself is untouched. Updates keep that data.

The installer is unsigned, so Windows SmartScreen warns on first run until a
code-signing certificate is added.
