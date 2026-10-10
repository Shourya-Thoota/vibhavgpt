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
- `build/icon.ico`: app, installer and window icon, generated from
  `frontend/public/brand/vibhavgpt-icon-512.png` with `npm run icon`.

## Build

```powershell
cd desktop
npm install
npm run dev     # run against the live site
npm run dist    # NSIS installer in release/VibhavGPT-Setup-<version>-x64.exe
```

If `npm run dev` fails with `Cannot read properties of undefined (reading
'requestSingleInstanceLock')`, the shell has `ELECTRON_RUN_AS_NODE` set (some
editor-hosted terminals do). Clear it first: `Remove-Item Env:ELECTRON_RUN_AS_NODE`.

## Publish a release

Release files are published in the separate `vibhavgpt-releases` repository,
not in this one. Upload `release/VibhavGPT-Setup-<version>-x64.exe` renamed to
`VibhavGPT-Setup-x64.exe` to a new release there, and list each file's version
and SHA-256 in the release notes. The download page links to
`releases/latest/download/VibhavGPT-Setup-x64.exe`, so the name must stay the same.

Every release carries BOTH files, the Windows installer and the Android APK,
because the download links always point at the latest release. When only one
app changes, re-attach the unchanged file from the previous release.

The installer is unsigned, so Windows SmartScreen warns on first run until a
code-signing certificate is added.
