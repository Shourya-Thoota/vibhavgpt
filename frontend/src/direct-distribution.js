import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";

const DIRECT_FLAG = "vibhavgpt-direct-android";
const DIRECT_VERSION_CODE = "vibhavgpt-direct-version-code";

function readParams() {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return null;
  }
}

/**
 * The direct APK has its own native application id. The web bundle is
 * shared, so the build records its
 * distribution in the initial Capacitor URL and persists it for subsequent
 * navigation/auth callbacks.
 */
export function directAndroidInfo() {
  if (Capacitor.getPlatform() !== "android") return { direct: false, versionCode: 0 };
  const params = readParams();
  try {
    if (params?.get("distribution") === "direct") localStorage.setItem(DIRECT_FLAG, "true");
    const versionCode = params?.get("versionCode");
    if (versionCode && /^\d+$/.test(versionCode)) localStorage.setItem(DIRECT_VERSION_CODE, versionCode);
    return {
      direct: localStorage.getItem(DIRECT_FLAG) === "true",
      versionCode: Number(localStorage.getItem(DIRECT_VERSION_CODE) || 0),
    };
  } catch {
    return { direct: params?.get("distribution") === "direct", versionCode: Number(params?.get("versionCode") || 0) };
  }
}

export function isDirectAndroidDistribution() {
  return directAndroidInfo().direct;
}

/**
 * Compare native Android build numbers, never the web bundle/package version.
 * A malformed or missing value is treated as unknown rather than outdated so
 * an update-check problem can never block the app from opening.
 */
export function shouldOfferDirectUpdate(installedVersionCode, remoteVersionCode) {
  const installed = Number(installedVersionCode);
  const remote = Number(remoteVersionCode);
  if (!Number.isSafeInteger(installed) || installed < 0) return false;
  if (!Number.isSafeInteger(remote) || remote < 0) return false;
  return remote > installed;
}

export async function checkDirectAndroidUpdate() {
  const current = directAndroidInfo();
  if (!current.direct) return null;
  try {
    // Capacitor's App plugin is the source of truth for the installed native
    // build. The URL query/localStorage value is only a distribution marker;
    // it must never make a missing version look out of date.
    const nativeInfo = await CapacitorApp.getInfo();
    const installedVersionCode = Number(nativeInfo?.build);
    if (!Number.isSafeInteger(installedVersionCode) || installedVersionCode < 0) return null;
    try { localStorage.setItem(DIRECT_VERSION_CODE, String(installedVersionCode)); } catch {}

    const response = await fetch("/android/version.json", { cache: "no-store", credentials: "omit" });
    if (!response.ok) return null;
    const release = await response.json();
    if (!shouldOfferDirectUpdate(installedVersionCode, release?.versionCode)) return null;
    return release;
  } catch {
    return null;
  }
}
