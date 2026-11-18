import { useRef, useState } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { api } from "../api.js";
import Avatar from "./Avatar.jsx";

// Settings > Account > Picture: upload, replace or remove. The browser checks the obvious things first (type and size) so a wrong
// file is answered at once; the server then checks what the file really is and makes the stored copy (square, 256 px, no metadata).

export const PICTURE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const PICTURE_MAX_BYTES = 5 * 1024 * 1024;

export function pictureProblem(file) {
  if (!file) return "Choose a picture to upload.";
  if (!PICTURE_TYPES.includes(file.type)) return "Use a JPEG, PNG or WebP picture.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > PICTURE_MAX_BYTES) return "That picture is over 5 MB. Choose a smaller one.";
  return "";
}

export default function ProfilePicture({ user, displayName, onChanged }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const uploaded = Boolean(user?.pictureVersion);

  const run = async (work, done) => {
    setBusy(true); setError(""); setNotice("");
    try { await work(); await onChanged?.(); setNotice(done); }
    catch (failure) { setError(failure?.message || "Couldn't change your picture. Please try again."); }
    finally { setBusy(false); }
  };
  const choose = (event) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // so choosing the same file again still fires
    if (!file) return;
    const problem = pictureProblem(file);
    if (problem) { setNotice(""); setError(problem); return; }
    const form = new FormData();
    form.append("picture", file);
    run(() => api("/api/profile/picture", { method: "PUT", body: form }), uploaded ? "Picture replaced." : "Picture added.");
  };
  const remove = () => run(() => api("/api/profile/picture", { method: "DELETE" }), "Picture removed.");

  return (
    <div className="profile-picture">
      <Avatar user={user} displayName={displayName} className="avatar avatar--large" />
      <div className="profile-picture__copy">
        <div className="profile-picture__actions">
          <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
            <ImagePlus size={16} /> {uploaded ? "Replace picture" : "Upload picture"}
          </button>
          {uploaded && (
            <button type="button" className="btn btn--secondary" disabled={busy} onClick={remove}>
              <Trash2 size={16} /> Remove picture
            </button>
          )}
        </div>
        <input ref={inputRef} className="sr-only" type="file" tabIndex={-1} aria-label="Choose a profile picture" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" onChange={choose} />
        <p className="profile-picture__hint">Shown beside your name in the sidebar and on the home page. JPEG, PNG or WebP, up to 5 MB, cropped to a square.{!uploaded && user?.image ? " Until you upload one, your Google photo is used." : ""}</p>
        {error && <p className="note note--error" role="alert">{error}</p>}
        {notice && !error && <p className="note" role="status">{notice}</p>}
      </div>
    </div>
  );
}
