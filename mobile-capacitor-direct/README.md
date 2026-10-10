# VibhavGPT direct Android APK

An Android shell that loads the production VibhavGPT web app in a Capacitor
WebView. This direct-distribution variant uses `com.pansophy.vibhavgpt.direct`
and web/Stripe billing.

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

## Permanent release signing

Keep one permanent keystore outside this repository and use it for every direct
APK update. Set these variables only in the local build process; never commit
them or print them:

```powershell
$env:VIBHAVGPT_DIRECT_KEYSTORE_PATH = 'C:\secure\vibhavgpt-direct-release.jks'
$env:VIBHAVGPT_DIRECT_KEYSTORE_PASSWORD = '<local secret>'
$env:VIBHAVGPT_DIRECT_KEY_ALIAS = 'vibhavgpt-direct'
$env:VIBHAVGPT_DIRECT_KEY_PASSWORD = '<local secret>'
```

## Build

```powershell
cd mobile-capacitor-direct
npm install
npm run sync      # copies config and registers plugins
Push-Location android
.\gradlew.bat clean assembleRelease
Pop-Location
```

Command-line debug build (needs the Android SDK path in
`android/local.properties`, which Android Studio creates, and a JDK 21):

```powershell
$env:JAVA_HOME = "$env:USERPROFILE\.jdks\jbr-21.0.11"
cd android
.\gradlew.bat assembleDebug
```

The signed APK is written to `android/app/build/outputs/apk/release/app-release.apk`.
Increment `versionCode` for every future direct release and update the public
`frontend/public/android/version.json` metadata with its final size and hash.

## Publish a release

Release files are published in the separate `vibhavgpt-releases` repository,
not in this one. Upload the signed APK as `vibhavgpt-android.apk` to a new
release there, and list each file's version and SHA-256 in the release notes.
The download pages and `version.json` link to
`releases/latest/download/vibhavgpt-android.apk`, so the name must stay the same.

Every release carries BOTH files, the Windows installer and the Android APK,
because the download links always point at the latest release. When only one
app changes, re-attach the unchanged file from the previous release.
