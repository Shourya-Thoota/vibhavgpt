import { useLayoutEffect, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowUp, Download, FolderInput, FolderPlus, ImageOff, ImagePlus, Lightbulb, Lock, MoreHorizontal, Pencil, RefreshCw, Wand2, X,
} from "lucide-react";
import { IconButton, Menu, MenuItem, Modal, Select } from "./ui.jsx";
import { PrivateDownloadButton, PrivateImage } from "./PrivateMedia.jsx";
import { generatingLabel, imageJobs, progressLabel } from "../image-jobs.js";
import "../studio.css";

// "Generating... X%" for the pending plate: an estimate from elapsed time
// (see image-jobs.js), refreshed often enough to climb smoothly.
function GeneratingPercent({ startedAt }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  return generatingLabel(startedAt, now);
}

// How long a finished image holds at 100% before it appears.
const LANDING_MS = 300;

/* ==========================================================================
   Image studio.

   One plate to write on and a gallery to develop into. The prompt is set in
   the display serif because it is the thing being made; the controls under
   it are the few the image endpoint actually honours (shape, a style that
   becomes art direction in the prompt, and an optional reference image to
   work from). While an image is being made, a placeholder plate in the
   chosen shape sits at the head of the gallery so the result lands where you
   were already looking.
   ========================================================================== */

const imageTitle = (image) => image.displayName || image.prompt || "Generated image";

// Keys match IMAGE_ASPECT_RATIOS on the server (square 1:1, portrait 9:16,
// landscape 16:9); anything else is sent back as square.
const SHAPES = [
  { value: "square", label: "Square" },
  { value: "portrait", label: "Portrait" },
  { value: "landscape", label: "Landscape" },
];

// Keys match IMAGE_STYLES on the server, which turns each into art direction.
const STYLE_PRESETS = [
  { value: "", label: "No style" },
  { value: "photo", label: "Photo" },
  { value: "cinematic", label: "Cinematic" },
  { value: "illustration", label: "Illustration" },
  { value: "watercolor", label: "Watercolor" },
  { value: "3d", label: "3D render" },
  { value: "anime", label: "Anime" },
  { value: "line-art", label: "Line art" },
  { value: "pixel-art", label: "Pixel art" },
];
const styleLabel = (value) => STYLE_PRESETS.find((style) => style.value === value)?.label ?? value;


const IMAGE_CATEGORIES = [
  { value: "all", label: "All ideas" },
  { value: "art", label: "Art" },
  { value: "wallpaper", label: "Wallpaper" },
  { value: "logo", label: "Logo" },
  { value: "character", label: "Character" },
  { value: "photo", label: "Photography" },
  { value: "product", label: "Product" },
  { value: "poster", label: "Poster" },
  { value: "fantasy", label: "Fantasy" },
];

// Each idea also suggests the shape and style that suit it; choosing one
// sets all three, and any of them can be changed before creating.
const IMAGE_IDEAS = [
  { category: "photo", title: "Cinematic city at night", detail: "Neon reflections after rain", shape: "landscape", style: "cinematic", prompt: "A lively city street at night after rain, neon signs reflecting in wet pavement, people with umbrellas, atmospheric haze" },
  { category: "wallpaper", title: "Futuristic bedroom", detail: "A calm room above the clouds", shape: "landscape", style: "3d", prompt: "A serene futuristic bedroom above the clouds, soft blue sunrise through a curved window, sculptural furniture, wide composition" },
  { category: "fantasy", title: "Fantasy landscape", detail: "Ancient ruins in a glowing valley", shape: "landscape", style: "illustration", prompt: "An expansive fantasy landscape with ancient ruins in a glowing valley, dramatic mountains and two tiny travelers on the path" },
  { category: "logo", title: "Minimalist logo", detail: "A clean mark for a new brand", shape: "square", style: "line-art", prompt: "A minimalist geometric logo mark for a modern creative studio, one simple memorable silhouette, deep navy and cyan on a plain background" },
  { category: "character", title: "Character concept", detail: "A hero with a story to tell", shape: "portrait", style: "illustration", prompt: "A character concept portrait of a thoughtful space explorer in a practical, well-worn suit, expressive face, neutral studio backdrop" },
  { category: "product", title: "Product concept", detail: "A beautiful object on a set", shape: "square", style: "photo", prompt: "A sculptural wireless speaker on a stone plinth, soft studio lighting, refined matte materials, commercial product photography" },
  { category: "poster", title: "Album cover", detail: "A bold visual with room for type", shape: "square", style: "illustration", prompt: "An album cover showing a moonlit ocean and a single glowing sailboat, bold modern art direction, open sky at the top" },
  { category: "art", title: "Abstract art", detail: "Color, texture, and movement", shape: "portrait", style: "", prompt: "An expressive abstract artwork in layered cyan, cobalt and warm coral, tactile paper texture, balanced gallery composition" },
];

function ShapeGlyph({ shape }) {
  return <span className="studio-shape" data-shape={shape} aria-hidden="true" />;
}

function formatCreated(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function ImageWorkspace({ api }) {
  const [images, setImages] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [shape, setShape] = useState("square");
  const [style, setStyle] = useState("");
  // An optional picture to work from: { file, previewUrl, id, uploading }.
  // It is uploaded as soon as it is chosen, so a size or type problem shows
  // before Generate, and it stays for the next image until removed.
  const [reference, setReference] = useState(null);
  const [notice, setNotice] = useState("");
  const referenceInput = useRef(null);
  const [ideasOpen, setIdeasOpen] = useState(false);
  const [ideaCategory, setIdeaCategory] = useState("all");
  // The generation job lives in a store outside this component, so it keeps
  // running when another tab is open and is still here on return.
  const { job } = useSyncExternalStore(imageJobs.subscribe, imageJobs.get);
  const running = job?.status === "generating" ? job : null;
  // The placeholder plate while a request runs: { shape, startedAt }.
  const pending = running ? { shape: running.shape, startedAt: running.startedAt } : null;
  const [inspecting, setInspecting] = useState(null);
  // A finished image's plate, held at 100% for a moment before it appears.
  const [landing, setLanding] = useState(null);
  const variationBusy = running?.kind === "variation";
  const [recentOnly, setRecentOnly] = useState(false);
  const [folders, setFolders] = useState([]);
  const [selectedFolder, setSelectedFolder] = useState("all");
  const [editing, setEditing] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState("");
  const [saving, setSaving] = useState(false);
  const galleryRequest = useRef(0);
  const activeFolder = useRef(selectedFolder);
  activeFolder.current = selectedFolder;
  // Thumbnails whose preview request actually failed, so a broken image
  // reads as "unavailable" instead of the browser's bare broken-icon glyph.
  const [brokenImageIds, setBrokenImageIds] = useState(() => new Set());
  const promptInput = useRef(null);
  const scrollRef = useRef(null);
  const generating = Boolean(pending) && !variationBusy;
  const busy = Boolean(pending);

  useLayoutEffect(() => {
    const input = promptInput.current;
    if (!input) return undefined;
    const resize = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
    };
    resize();
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      resize();
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [prompt]);

  function markBroken(id) {
    setBrokenImageIds((current) => (current.has(id) ? current : new Set(current).add(id)));
  }

  async function loadFirstPage(folder = selectedFolder) {
    const request = ++galleryRequest.current;
    setLoading(true); setLoadingMore(false); setError("");
    try {
      const result = await api(`/api/generation/images?folder=${encodeURIComponent(folder)}`);
      if (request !== galleryRequest.current || activeFolder.current !== folder) return;
      setImages(result.images); setNextCursor(result.nextCursor);
    } catch (err) { if (request === galleryRequest.current) setError(err.message); }
    finally { if (request === galleryRequest.current) setLoading(false); }
  }
  useEffect(() => {
    loadFirstPage(selectedFolder);
    return () => { galleryRequest.current++; };
  }, [selectedFolder]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let cancelled = false;
    api("/api/generation/image-folders").then((result) => { if (!cancelled) setFolders(result.folders); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A first visit with an empty gallery opens the ideas, so the page never
  // starts as a blank box.
  useEffect(() => {
    if (!loading && images.length === 0 && selectedFolder === "all") setIdeasOpen(true);
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const request = galleryRequest.current;
    const folder = selectedFolder;
    setLoadingMore(true);
    try {
      const result = await api(`/api/generation/images?folder=${encodeURIComponent(folder)}&cursor=${encodeURIComponent(nextCursor)}`);
      if (request !== galleryRequest.current || activeFolder.current !== folder) return;
      setImages((current) => [...current, ...result.images]); setNextCursor(result.nextCursor);
    } catch (err) { if (request === galleryRequest.current) setError(err.message); }
    finally { if (request === galleryRequest.current) setLoadingMore(false); }
  }

  function openEdit(kind, image = null) {
    setInspecting(null);
    setEditing({ kind, image }); setEditError("");
    setEditValue(kind === "rename-folder" ? folders.find((folder) => folder.id === selectedFolder)?.name ?? ""
      : kind === "rename-image" ? image.displayName ?? ""
      : kind === "move-image" ? image.folderId ?? "unfiled" : "");
  }

  async function saveEdit(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setEditError("");
    try {
      if (editing.kind === "create-folder" || editing.kind === "rename-folder") {
        const creating = editing.kind === "create-folder";
        const result = await api(`/api/generation/image-folders${creating ? "" : `/${selectedFolder}`}`, {
          method: creating ? "POST" : "PATCH", body: JSON.stringify({ name: editValue.trim() }),
        });
        setFolders((current) => [...current.filter((folder) => folder.id !== result.folder.id), result.folder].sort((a, b) => a.name.localeCompare(b.name)));
        if (creating) setSelectedFolder(result.folder.id);
      } else {
        const moving = editing.kind === "move-image";
        const body = moving ? { folderId: editValue === "unfiled" ? null : editValue } : { displayName: editValue.trim() || null };
        const result = await api(`/api/generation/images/${editing.image.id}`, { method: "PATCH", body: JSON.stringify(body) });
        if (moving) await loadFirstPage();
        else setImages((current) => current.map((image) => image.id === result.image.id ? result.image : image));
      }
      setEditing(null);
    } catch (err) { setEditError(err.message); }
    finally { setSaving(false); }
  }

  // New images belong at the head of All images; from a folder, the view
  // returns to All so they are visible at once.
  function landImages(created) {
    // A reloaded gallery may already hold an image that finished while
    // another tab was open, so each lands once.
    if (activeFolder.current === "all") setImages((current) => [...created.filter((image) => !current.some((item) => item.id === image.id)), ...current]);
    else setSelectedFolder("all");
    setRecentOnly(false);
    scrollRef.current?.scrollTo?.({ top: 0, behavior: "smooth" });
  }

  // A finished job lands once: here, or on return if it finished while
  // another tab was open. A success shows 100% for a moment first; a failure
  // clears the plate at once and shows the error.
  useEffect(() => {
    if (!job || job.status === "generating") return undefined;
    if (job.status === "failed") {
      setError(job.error);
      imageJobs.acknowledge(job.id);
      return undefined;
    }
    setLanding({ shape: job.shape });
    const timer = setTimeout(() => {
      setLanding(null);
      landImages(job.images);
      if (job.kind === "variation") setInspecting(job.images[0] ?? null);
      else {
        if (job.hadReference && job.referenceApplied === false) setNotice("The reference image couldn't be used this time, so this one was made from your description alone.");
        setPrompt("");
        setIdeasOpen(false);
      }
      imageJobs.acknowledge(job.id);
    }, LANDING_MS);
    return () => clearTimeout(timer);
  }, [job]); // eslint-disable-line react-hooks/exhaustive-deps

  function submitComposer(event) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;
    if (reference?.uploading) return;
    setError(""); setNotice("");
    imageJobs.start(api, {
      kind: "create",
      shape,
      // standalone marks a brand-new conversation from the Image page (not
      // an image made mid-chat) so it lands in the Image sessions list.
      body: { prompt: text, aspectRatio: shape, style, ...(reference?.id ? { referenceAttachmentId: reference.id } : {}), standalone: true },
    });
  }

  async function chooseReference(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Choose an image file to use as a reference."); return; }
    if (reference?.previewUrl) URL.revokeObjectURL(reference.previewUrl);
    const previewUrl = URL.createObjectURL(file);
    setReference({ file, previewUrl, id: null, uploading: true });
    setError(""); setNotice("");
    try {
      const form = new FormData();
      form.append("files", file);
      const result = await api("/api/uploads", { method: "POST", body: form });
      const uploaded = result.attachments?.[0];
      if (!uploaded?.id) throw new Error("The reference image couldn't be uploaded. Try again.");
      setReference((current) => (current?.previewUrl === previewUrl ? { ...current, id: uploaded.id, uploading: false } : current));
    } catch (err) {
      URL.revokeObjectURL(previewUrl);
      setReference((current) => (current?.previewUrl === previewUrl ? null : current));
      setError(err.message);
    }
  }

  function removeReference() {
    if (reference?.previewUrl) URL.revokeObjectURL(reference.previewUrl);
    setReference(null);
    if (referenceInput.current) referenceInput.current.value = "";
  }

  function refine(image) {
    setInspecting(null);
    setPrompt(image.prompt ?? "");
    if (image.meta?.aspectRatio) setShape(image.meta.aspectRatio);
    setStyle(image.meta?.style ?? "");
    setError("");
    requestAnimationFrame(() => { scrollRef.current?.scrollTo?.({ top: 0, behavior: "smooth" }); promptInput.current?.focus(); });
  }

  function chooseIdea(idea) {
    setPrompt(idea.prompt);
    setShape(idea.shape ?? "square");
    setStyle(idea.style ?? "");
    setError("");
    requestAnimationFrame(() => promptInput.current?.focus());
  }

  function generateVariation(image) {
    setError("");
    imageJobs.start(api, {
      kind: "variation",
      shape: image.meta?.aspectRatio ?? "square",
      body: { prompt: image.prompt, aspectRatio: image.meta?.aspectRatio ?? "square", style: image.meta?.style ?? "", variations: 1, parentAttachmentId: image.id, referenceAttachmentId: image.id, standalone: true },
    });
  }

  // This gallery is private; no cross-user popularity signal is collected.
  // Recent is simply the past seven days of your own images.
  const visibleImages = recentOnly ? images.filter((image) => new Date(image.createdAt).getTime() >= Date.now() - 7 * 86400000) : images;
  const visibleIdeas = ideaCategory === "all" ? IMAGE_IDEAS : IMAGE_IDEAS.filter((idea) => idea.category === ideaCategory);
  const customFolder = !["all", "unfiled"].includes(selectedFolder);
  const createLabel = generating ? "Generating…" : "Generate";

  return (
    <section className="image-workspace studio">
      <div className="studio__scroll" ref={scrollRef}>
        <form className="studio-plate" onSubmit={submitComposer} aria-label="Create an image">
          <label className="sr-only" htmlFor="image-prompt">Describe the image you want</label>
          <textarea
            id="image-prompt"
            ref={promptInput}
            className="studio-plate__prompt"
            rows="2"
            value={prompt}
            disabled={busy}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submitComposer(event); }
            }}
            placeholder="Describe what you want to see"
          />

          <div className="studio-plate__controls">
            <div className="studio-segment" role="radiogroup" aria-label="Shape">
              {SHAPES.map((option) => (
                <button key={option.value} type="button" role="radio" aria-checked={shape === option.value} title={option.label} disabled={busy} onClick={() => setShape(option.value)}>
                  <ShapeGlyph shape={option.value} />
                  <span className="studio-segment__label">{option.label}</span>
                </button>
              ))}
            </div>

            <Select
              size="sm"
              className="studio-style"
              label="Style"
              value={style}
              onChange={setStyle}
              disabled={busy}
              options={STYLE_PRESETS}
            />

            <input
              ref={referenceInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => void chooseReference(event.target.files?.[0])}
            />
            <button type="button" className="studio-plate__reference" disabled={busy} aria-pressed={Boolean(reference)} onClick={() => referenceInput.current?.click()}>
              <ImagePlus size={15} strokeWidth={1.9} aria-hidden="true" />
              {reference ? "Change reference" : "Reference"}
            </button>

            <span className="studio-plate__spacer" />

            <button type="button" className="studio-plate__ideas" aria-expanded={ideasOpen} onClick={() => setIdeasOpen((open) => !open)}>
              <Lightbulb size={15} strokeWidth={1.9} aria-hidden="true" />
              Ideas
            </button>
            <button type="submit" className="btn btn--primary studio-plate__create" disabled={busy || !prompt.trim() || reference?.uploading}>
              {generating ? <RefreshCw size={16} className="studio-spin" aria-hidden="true" /> : <ArrowUp size={16} aria-hidden="true" />}
              {createLabel}
            </button>
          </div>
          {reference && (
            <div className="studio-reference" role="status">
              <img src={reference.previewUrl} alt="" />
              <span className="studio-reference__text">
                <strong>{reference.uploading ? "Uploading reference…" : "Reference image"}</strong>
                <small>{reference.file.name}</small>
              </span>
              <IconButton className="studio-reference__remove" label="Remove reference image" disabled={busy} onClick={removeReference}><X size={15} /></IconButton>
            </div>
          )}

          {ideasOpen && (
            <div className="studio-ideas">
              <div className="studio-ideas__categories" role="group" aria-label="Idea categories">
                {IMAGE_CATEGORIES.map((category) => (
                  <button key={category.value} type="button" aria-pressed={ideaCategory === category.value} onClick={() => setIdeaCategory(category.value)}>{category.label}</button>
                ))}
              </div>
              <ul className="studio-ideas__list">
                {visibleIdeas.map((idea) => (
                  <li key={idea.title}>
                    <button type="button" onClick={() => chooseIdea(idea)}>
                      <ShapeGlyph shape={idea.shape} />
                      <span>
                        <strong>{idea.title}</strong>
                        <small>{idea.detail}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </form>

        {error && <p className="banner banner--error studio-error" role="alert">{error}</p>}
        {notice && <p className="banner studio-error" role="status">{notice}</p>}

        <div className="studio-shelf">
          <nav className="studio-folders" aria-label="Image folders">
            <button type="button" aria-pressed={selectedFolder === "all"} onClick={() => setSelectedFolder("all")}>All images</button>
            <button type="button" aria-pressed={selectedFolder === "unfiled"} onClick={() => setSelectedFolder("unfiled")}>Unfiled</button>
            {folders.map((folder) => (
              <button key={folder.id} type="button" aria-pressed={selectedFolder === folder.id} onClick={() => setSelectedFolder(folder.id)}>{folder.name}</button>
            ))}
            <button type="button" className="studio-folders__add" onClick={() => openEdit("create-folder")}><FolderPlus size={15} aria-hidden="true" />New folder</button>
          </nav>
          <div className="studio-shelf__tools">
            {customFolder && <IconButton label="Rename folder" onClick={() => openEdit("rename-folder")}><Pencil size={15} /></IconButton>}
            <button type="button" className="studio-recent" aria-pressed={recentOnly} title="Your images from the past seven days" onClick={() => setRecentOnly((value) => !value)}>Recent</button>
            <span className="studio-private" title="Only you can see these images"><Lock size={13} aria-hidden="true" />Private gallery</span>
          </div>
        </div>

        {loading ? (
          <p className="studio-empty" role="status">Loading your images…</p>
        ) : images.length === 0 && !pending && !landing ? (
          <div className="studio-empty">
            <strong>{selectedFolder === "all" ? "Your first image will develop here" : "Nothing in this folder yet"}</strong>
            <span>{selectedFolder === "all" ? "Describe something above, or pick one of the ideas." : "Open All images and use Move to folder on any image."}</span>
          </div>
        ) : (
          <>
            <div className="studio-gallery">
              {(pending || landing) && (
                <div className="studio-tile studio-tile--pending" data-aspect={(pending ?? landing).shape} role="status" aria-label="Generating image">
                  <span className="studio-tile__developing" />
                  <span className="studio-tile__pending-label">{pending ? <GeneratingPercent startedAt={pending.startedAt} /> : progressLabel(100)}</span>
                </div>
              )}
              {visibleImages.map((image) => (
                <figure key={image.id} className="studio-tile" data-aspect={image.meta?.aspectRatio ?? "square"}>
                  {/* Open and download are siblings layered with CSS: a
                      button cannot contain another focusable control. */}
                  <button type="button" className="studio-tile__open" onClick={() => setInspecting(image)} aria-label={`Open ${imageTitle(image)}`}>
                    {brokenImageIds.has(image.id) ? (
                      <span className="studio-tile__broken"><ImageOff size={20} strokeWidth={1.6} /><small>Unavailable</small></span>
                    ) : (
                      <PrivateImage src={image.previewUrl} alt={imageTitle(image)} loading="lazy" onError={() => markBroken(image.id)} />
                    )}
                  </button>
                  <figcaption className="studio-tile__caption">{imageTitle(image)}</figcaption>
                  <div className="studio-tile__actions">
                    <Menu label={`Actions for ${imageTitle(image)}`} align="end" trigger={({ ref, open, toggle }) => (
                      <button ref={ref} type="button" className="studio-tile__button" aria-label={`Actions for ${imageTitle(image)}`} aria-haspopup="menu" aria-expanded={open} onClick={toggle}><MoreHorizontal size={17} /></button>
                    )}>
                      <MenuItem icon={<Pencil size={16} />} onSelect={() => openEdit("rename-image", image)}>Rename image</MenuItem>
                      <MenuItem icon={<FolderInput size={16} />} onSelect={() => openEdit("move-image", image)}>Move to folder</MenuItem>
                      <MenuItem icon={<Wand2 size={16} />} onSelect={() => refine(image)}>Reuse prompt</MenuItem>
                    </Menu>
                    <PrivateDownloadButton className="studio-tile__button" href={image.downloadUrl} name={image.name} onError={setError} aria-label="Download image" title="Download image">
                      <Download size={15} strokeWidth={2} />
                    </PrivateDownloadButton>
                  </div>
                </figure>
              ))}
            </div>
            {recentOnly && visibleImages.length === 0 && !pending && !landing && <p className="studio-empty">Nothing from the past seven days. Turn off Recent to see everything.</p>}
            {nextCursor && <button type="button" className="btn btn--secondary studio-more" disabled={loadingMore} onClick={loadMore}>{loadingMore ? "Loading…" : "Load more"}</button>}
          </>
        )}
      </div>

      <Modal open={Boolean(editing)} onClose={() => { if (!saving) setEditing(null); }} title={{ "create-folder": "New folder", "rename-folder": "Rename folder", "rename-image": "Rename image", "move-image": "Move to folder" }[editing?.kind] ?? "Organize images"} onSubmit={saveEdit}>
        {editError && <p className="banner banner--error" role="alert">{editError}</p>}
        {editing?.kind === "move-image" ? <div className="studio-field">
          <span id="move-image-label">Destination folder</span>
          <Select
            label="Destination folder"
            value={editValue}
            onChange={setEditValue}
            disabled={saving}
            options={[
              { value: "unfiled", label: "Unfiled", description: "Not in any folder." },
              ...folders.map((folder) => ({ value: folder.id, label: folder.name })),
            ]}
          />
        </div> : <label className="studio-field">
          {editing?.kind === "rename-image" ? "Image name" : "Folder name"}
          <input className="input" autoFocus value={editValue} onChange={(event) => setEditValue(event.target.value)} maxLength={editing?.kind === "rename-image" ? 160 : 120} required={editing?.kind !== "rename-image"} disabled={saving} />
        </label>}
        {editing?.kind === "rename-image" && <p className="studio-field__hint">This changes the caption, not the original prompt. Leave it blank to show the prompt again.</p>}
        <div className="ui-modal__actions">
          <button type="button" className="btn btn--quiet" disabled={saving} onClick={() => setEditing(null)}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={saving || (editing?.kind?.includes("folder") && editing.kind !== "move-image" && !editValue.trim())}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </Modal>

      <Modal open={Boolean(inspecting)} onClose={() => setInspecting(null)} title={inspecting ? imageTitle(inspecting) : "Image"} size="lg">
        {inspecting && (
          <div className="studio-inspector">
            <IconButton className="studio-inspector__close" label="Close image" onClick={() => setInspecting(null)}><X size={18} /></IconButton>
            <div className="studio-inspector__frame" data-aspect={inspecting.meta?.aspectRatio ?? "square"}>
              {brokenImageIds.has(inspecting.id) ? (
                <div className="studio-inspector__broken"><ImageOff size={32} strokeWidth={1.4} /><p>This image couldn't be loaded.</p></div>
              ) : (
                <PrivateImage src={inspecting.previewUrl} alt={imageTitle(inspecting)} onError={() => markBroken(inspecting.id)} />
              )}
            </div>
            <div className="studio-inspector__side">
              {error && <p className="banner banner--error" role="alert">{error}</p>}
              {inspecting.prompt && <p className="studio-inspector__prompt">{inspecting.prompt}</p>}
              <dl className="studio-inspector__meta">
                <div><dt>Shape</dt><dd><ShapeGlyph shape={inspecting.meta?.aspectRatio ?? "square"} />{SHAPES.find((option) => option.value === (inspecting.meta?.aspectRatio ?? "square"))?.label}</dd></div>
                {inspecting.meta?.style && <div><dt>Style</dt><dd>{styleLabel(inspecting.meta.style)}</dd></div>}
                {inspecting.createdAt && <div><dt>Created</dt><dd>{formatCreated(inspecting.createdAt)}</dd></div>}
              </dl>
              <div className="studio-inspector__actions">
                <PrivateDownloadButton className="btn btn--primary" href={inspecting.downloadUrl} name={inspecting.name} onError={setError}><Download size={16} />Download</PrivateDownloadButton>
                <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => generateVariation(inspecting)}><RefreshCw size={16} className={variationBusy ? "studio-spin" : undefined} />{variationBusy ? "Generating…" : "Generate variation"}</button>
                <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => refine(inspecting)}><Wand2 size={16} />Reuse prompt</button>
                <div className="studio-inspector__quiet">
                  <button type="button" className="btn btn--quiet" onClick={() => openEdit("rename-image", inspecting)}><Pencil size={15} />Rename image</button>
                  <button type="button" className="btn btn--quiet" onClick={() => openEdit("move-image", inspecting)}><FolderInput size={15} />Move to folder</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}
