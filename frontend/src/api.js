import { accessStatus } from "./access-status.js";

export const API_BASE = import.meta.env?.VITE_API_URL ?? "";

export function responseError(data = {}, status) {
  const access = accessStatus(data.access ? { ...data.access, publicMessage: data.access.message } : data);
  const error = Object.assign(new Error(access?.message ?? data.error ?? data.message ?? "Couldn't complete this request. Please try again."), {
    code: data.code, status, access,
  });
  if (access && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("vibhavgpt:access-status", { detail: access }));
  return error;
}

// Only our API may receive the app's credentials. Also accepts absolute API
// URLs in old messages without treating arbitrary external links as private.
export function apiPath(value, base = API_BASE, origin = globalThis.location?.origin) {
  const root = new URL(base || origin);
  const url = new URL(value, root);
  if (url.origin !== root.origin || !url.pathname.startsWith("/api/") || url.username || url.password) {
    throw new Error("Invalid API resource.");
  }
  return `${url.pathname}${url.search}`;
}

export function isPrivateFileUrl(value) {
  try { return /^\/api\/(uploads|generation)\/[^/]+\/(preview|download)$/.test(apiPath(value).split("?")[0]); }
  catch { return false; }
}

export async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body != null && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let response;
  try { response = await fetch(`${API_BASE}${apiPath(path)}`, { ...options, headers, credentials: "include" }); }
  catch (error) {
    if (options.signal?.aborted || error.name === "AbortError") throw error;
    throw responseError({ code: "network-error" });
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw responseError(data ?? {}, response.status);
  }
  return response;
}

export async function api(path, options) {
  const response = await apiRequest(path, options);
  if (response.status === 204) return null;
  // A success with an unreadable body is still a failed request to the
  // reader; the parser's own message would mean nothing to them.
  try { return await response.json(); } catch { throw responseError({}, response.status); }
}

export async function fetchPrivateFile(path, options) {
  if (!isPrivateFileUrl(path)) throw new Error("Invalid file resource.");
  return (await apiRequest(path, options)).blob();
}
