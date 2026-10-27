import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { fetchPrivateFile, isPrivateFileUrl } from "../api.js";
import { Modal } from "./ui.jsx";
import { scrollRoot } from "./DiagramViewer.jsx";
import { DirectDownload } from "../native-download.js";

// How close to the visible area a lazy file must come before it downloads.
export const NEAR_VIEW_MARGIN = "600px";

// Downloads a protected file and hands each result to onResult. A lazy one
// waits until `node` comes within NEAR_VIEW_MARGIN of its scrolling area (at
// once where IntersectionObserver is missing). Returns the cleanup, which
// stops the watch, abandons the request and frees the blob URL.
export function startPrivateFile(path, onResult, {
  lazy = false, node = null, root = null, Observer = globalThis.IntersectionObserver, load = fetchPrivateFile,
  createUrl = (blob) => URL.createObjectURL(blob), revokeUrl = (url) => URL.revokeObjectURL(url),
} = {}) {
  const controller = new AbortController();
  let objectUrl;
  let observer = null;
  const begin = () => {
    load(path, { signal: controller.signal }).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = createUrl(blob);
      onResult({ path, url: objectUrl, blob });
    }).catch((error) => { if (!controller.signal.aborted) onResult({ path, error: error.message }); });
  };
  if (lazy && node && typeof Observer === "function") {
    observer = new Observer((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      observer = null;
      begin();
    }, { root, rootMargin: NEAR_VIEW_MARGIN });
    observer.observe(node);
  } else {
    begin();
  }
  return () => { observer?.disconnect(); controller.abort(); if (objectUrl) revokeUrl(objectUrl); };
}

function usePrivateFile(path, { lazy = false, nodeRef = null } = {}) {
  const [result, setResult] = useState({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) return;
    setResult({ path });
    const node = nodeRef?.current ?? null;
    return startPrivateFile(path, setResult, { lazy, node, root: lazy ? scrollRoot(node) : null });
  }, [path, attempt, lazy]);
  return { ...(result.path === path ? result : {}), retry: () => setAttempt((value) => value + 1) };
}

// `lazy`: download only once the image is close to view, so a long chat
// full of images fetches just the ones being read.
export function PrivateImage({ src, alt, lazy = false, ...props }) {
  const holderRef = useRef(null);
  const privatePath = isPrivateFileUrl(src) ? src : null;
  const { url, error } = usePrivateFile(privatePath, { lazy, nodeRef: holderRef });
  if (privatePath && !url) return <span ref={holderRef} className="private-media-status" role="status">{error || "Loading image…"}</span>;
  return <img {...props} src={privatePath ? url : src} alt={alt} />;
}

export async function saveFile(blob, name) {
  const filename = (name || "download").replace(/[\\/:*?"<>|]/g, "_");
  if (Capacitor.isNativePlatform()) {
    if (Capacitor.isPluginAvailable("DirectDownload")) {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("Couldn't read this file."));
        reader.readAsDataURL(blob);
      });
      await DirectDownload.saveFile({ data, filename, mimeType: blob.type || "application/octet-stream" });
      return;
    }
    if (!Capacitor.isPluginAvailable("Filesystem") || !Capacitor.isPluginAvailable("Share")) {
      throw new Error("Update the Android app to save files. You can still view this preview here.");
    }
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import("@capacitor/filesystem"), import("@capacitor/share")]);
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("Couldn't read this file."));
      reader.readAsDataURL(blob);
    });
    const path = `exports/${crypto.randomUUID()}/${filename}`;
    const { uri } = await Filesystem.writeFile({ path, directory: Directory.Cache, data, recursive: true });
    // Android returns when a target is chosen, before that app necessarily
    // reads the URI. Leave this OS-managed cache file available to the receiver.
    await Share.share({ files: [uri], title: filename });
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function FileViewer({ path, name, onClose }) {
  const { url, blob, error, retry } = usePrivateFile(path);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  return <Modal open onClose={onClose} title={name || "File preview"} size="lg">
    <button type="button" className="btn btn--quiet" onClick={onClose}>Close preview</button>
    {error ? <div role="alert"><p>{error}</p><button type="button" onClick={retry}>Retry</button></div> : !url ? <p role="status">Loading file…</p> :
      blob.type.startsWith("image/") ? <img className="private-file-preview" src={url} alt={name || "Image preview"} /> :
      <p>Your file is ready. Use Save file to open it in your preferred app.</p>}
    {saveError && <p role="alert">{saveError}</p>}
    <button type="button" className="btn btn--secondary" disabled={!blob || saving} onClick={async () => {
      setSaving(true); setSaveError("");
      try { await saveFile(blob, name); } catch (err) { setSaveError(err.message); }
      finally { setSaving(false); }
    }}>{saving ? "Saving…" : "Save file"}</button>
  </Modal>;
}

export function PrivateFileLink({ href, name, children, className, ...props }) {
  const [open, setOpen] = useState(false);
  return <>
    <button {...props} type="button" className={className} onClick={() => setOpen(true)}>{children}</button>
    {open && <FileViewer path={href} name={name} onClose={() => setOpen(false)} />}
  </>;
}

export function PrivateDownloadButton({ href, name, children, onError, ...props }) {
  const [busy, setBusy] = useState(false);
  return <button {...props} type="button" disabled={busy} aria-busy={busy} onClick={async () => {
    setBusy(true);
    try { await saveFile(await fetchPrivateFile(href), name); }
    catch (error) { onError?.(error.message); }
    finally { setBusy(false); }
  }}>{children}</button>;
}

export function ResourceLink({ href, children, ...props }) {
  return isPrivateFileUrl(href)
    ? <PrivateFileLink href={href} {...props}>{children}</PrivateFileLink>
    : <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
}
