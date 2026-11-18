import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, Pencil, Trash2, UserRound } from "lucide-react";
import { API_BASE, api } from "../api.js";
import { Modal } from "./ui.jsx";
import { PICTURE_MAX_BYTES, PICTURE_TYPES, pictureProblem } from "./ProfilePicture.jsx";
import "./SavedAvatars.css";

// Settings > Account > Saved avatars: reference photos kept for making images. They are private to this account, used only when
// one is chosen for an image (Image > Reference) or set as the profile picture by an explicit button here.

export default function SavedAvatars({ onProfilePictureChanged }) {
  const [state, setState] = useState({ loading: true, avatars: [], limit: 10, error: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // { id, name }
  const [removing, setRemoving] = useState(null);
  const inputRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const result = await api("/api/avatars", { cache: "no-store" });
      setState({ loading: false, avatars: result.avatars ?? [], limit: result.limit ?? 10, error: "" });
    } catch {
      setState((current) => ({ ...current, loading: false, error: "Your saved avatars could not be loaded." }));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(work, done) {
    setBusy(true); setError(""); setNotice("");
    try { await work(); await load(); if (done) setNotice(done); return true; }
    catch (failure) { setError(failure?.message || "That didn't work. Please try again."); return false; }
    finally { setBusy(false); }
  }
  function add(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const problem = pictureProblem(file);
    if (problem) { setNotice(""); setError(problem); return; }
    const form = new FormData();
    form.append("avatar", file);
    void run(() => api("/api/avatars", { method: "POST", body: form }), "Avatar added.");
  }
  const full = state.avatars.length >= state.limit;

  return (
    <div className="saved-avatars">
      <p className="saved-avatars__intro">
        Photos you keep to use as a reference when you make images. They are private to your account and used only when you pick one. Choose
        photos of yourself, or of people who have agreed to it. VibhavGPT does not identify people from photos, and does not use them to train models.
        When you use one, it is sent to the image model to make that image.
      </p>
      {state.loading && <p className="saved-avatars__note" role="status">Loading…</p>}
      {state.error && <p className="note note--error" role="alert">{state.error}</p>}
      {!state.loading && state.avatars.length === 0 && !state.error && <p className="saved-avatars__note">You have no saved avatars yet.</p>}
      {state.avatars.length > 0 && (
        <ul className="saved-avatars__grid">
          {state.avatars.map((avatar) => (
            <li key={avatar.id} className="saved-avatars__item">
              <img src={`${API_BASE}${avatar.imageUrl}`} alt={`Saved avatar: ${avatar.name}`} width="96" height="96" loading="lazy" decoding="async" />
              <strong title={avatar.name}>{avatar.name}</strong>
              <div className="saved-avatars__actions">
                <button type="button" className="saved-avatars__action" disabled={busy} onClick={() => setEditing({ id: avatar.id, name: avatar.name })} aria-label={`Rename ${avatar.name}`}><Pencil size={14} aria-hidden="true" />Rename</button>
                <button type="button" className="saved-avatars__action" disabled={busy} onClick={async () => { if (await run(() => api(`/api/avatars/${avatar.id}/use-as-profile-picture`, { method: "POST" }), "Set as your profile picture.")) await onProfilePictureChanged?.(); }} aria-label={`Use ${avatar.name} as your profile picture`}><UserRound size={14} aria-hidden="true" />Use as profile picture</button>
                <button type="button" className="saved-avatars__action saved-avatars__action--danger" disabled={busy} onClick={() => setRemoving(avatar)} aria-label={`Delete ${avatar.name}`}><Trash2 size={14} aria-hidden="true" />Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="saved-avatars__bar">
        <button type="button" className="btn btn--secondary" disabled={busy || full} onClick={() => inputRef.current?.click()}><ImagePlus size={16} /> Add an avatar</button>
        <span className="saved-avatars__count">{state.avatars.length} of {state.limit}{full ? ". Delete one to add another." : ""}</span>
        <input ref={inputRef} className="sr-only" type="file" tabIndex={-1} aria-label="Choose a photo to save as an avatar" accept={`${PICTURE_TYPES.join(",")},.jpg,.jpeg,.png,.webp`} onChange={add} />
      </div>
      <p className="saved-avatars__hint">JPEG, PNG or WebP, up to {PICTURE_MAX_BYTES / 1048576} MB. Location and camera details are removed when it is saved.</p>
      {error && <p className="note note--error" role="alert">{error}</p>}
      {notice && !error && <p className="note" role="status">{notice}</p>}

      <Modal open={Boolean(editing)} onClose={() => !busy && setEditing(null)} title="Rename avatar" onSubmit={async (event) => { event.preventDefault(); if (!editing?.name.trim()) return; if (await run(() => api(`/api/avatars/${editing.id}`, { method: "PATCH", body: JSON.stringify({ name: editing.name }) }), "Renamed.")) setEditing(null); }}>
        <label className="saved-avatars__field"><span>Name</span><input className="ui-input" value={editing?.name ?? ""} maxLength={40} autoFocus onChange={(event) => setEditing((current) => ({ ...current, name: event.target.value }))} /></label>
        <div className="ui-modal__actions"><button type="button" className="btn btn--secondary" onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="btn btn--primary" disabled={busy || !editing?.name.trim()}>Save</button></div>
      </Modal>
      <Modal open={Boolean(removing)} onClose={() => !busy && setRemoving(null)} title="Delete this avatar?" description="It is deleted for good. Images already made with it are not affected." onSubmit={async (event) => { event.preventDefault(); if (await run(() => api(`/api/avatars/${removing.id}`, { method: "DELETE" }), "Avatar deleted.")) setRemoving(null); }}>
        {removing && <p className="saved-avatars__field"><strong>{removing.name}</strong></p>}
        <div className="ui-modal__actions"><button type="button" className="btn btn--secondary" onClick={() => setRemoving(null)}>Cancel</button><button type="submit" className="btn btn--danger" disabled={busy}>Delete</button></div>
      </Modal>
    </div>
  );
}
