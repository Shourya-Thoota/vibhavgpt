# VibhavGPT Android app (Capacitor)

An Android shell that loads `https://vibhavgpt.com` in a Capacitor WebView. It
does not bundle the frontend, so UI changes ship with a web deploy; rebuild the
APK only when something in this folder changes.

This folder is the source of truth for the native project. Permissions, deep
links and plugins live here, in particular:

- `android/app/src/main/AndroidManifest.xml`: permissions (internet only; the
  app does not request the microphone) and the `vibhavgpt://account` deep link
  used by billing and Google sign-in returns.
- `package.json`: Capacitor plugins (`@capacitor/app`, `@capacitor/browser`).

`npx cap sync` does not modify the manifest, so edits here persist. Do not
regenerate `android/` with `cap add`; that would discard them.

Keep `server` in `capacitor.config.json` free of an `allowNavigation` entry
for `*.vibhavgpt.com`: Google sign-in relies on `api.vibhavgpt.com` opening
outside the WebView.

## Build

```powershell
cd mobile-capacitor
npm install
npm run sync      # copies config and registers plugins
npm run android   # opens Android Studio; choose a device and press Run
```

Command-line debug build (needs the Android SDK path in
`android/local.properties`, which Android Studio creates, and a JDK 21):

```powershell
$env:JAVA_HOME = "$env:USERPROFILE\.jdks\jbr-21.0.11"
cd android
.\gradlew.bat assembleDebug
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.
