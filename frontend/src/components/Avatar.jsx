import { useEffect, useRef, useState } from "react";
import { API_BASE } from "../api.js";

// A person's picture where an avatar is shown: the one they uploaded, else the Google photo they signed in with, else their
// initials. The initials are always drawn underneath, so a picture that is slow, blocked or broken leaves the initials showing
// and never an empty circle or a broken-image icon.

export const initialsOf = (displayName) => String(displayName ?? "").trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "V";

// The address a browser loads. An uploaded picture is served by this app to its owner only; the version in the address changes
// whenever the picture does, so a new one shows at once. The Google photo is used only when the server vouched for it (/api/me
// sends `image` only for Google's own picture host).
export function avatarSource(user) {
  if (user?.pictureVersion) return `${API_BASE}/api/profile/picture?v=${encodeURIComponent(user.pictureVersion)}`;
  return typeof user?.image === "string" && user.image ? user.image : null;
}

export default function Avatar({ user, displayName, className = "avatar", ...rest }) {
  const source = avatarSource(user);
  const [failed, setFailed] = useState(false);
  const photo = useRef(null);
  useEffect(() => { setFailed(false); }, [source]);
  // Some engines can finish a failed load before the error listener is attached, so a picture that already ended empty is caught here too.
  useEffect(() => {
    const element = photo.current;
    if (element?.complete && element.naturalWidth === 0) setFailed(true);
  }, [source, failed]);
  const showing = Boolean(source) && !failed;
  return (
    <span className={className} data-photo={showing ? "true" : undefined} aria-hidden="true" {...rest}>
      {initialsOf(displayName)}
      {showing && (
        <img
          ref={photo}
          className="avatar__photo"
          src={source}
          alt=""
          width="256"
          height="256"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable="false"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
