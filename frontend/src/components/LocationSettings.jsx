import { useCallback, useEffect, useRef, useState } from "react";
import { LocateFixed, MapPin, Search, Trash2 } from "lucide-react";
import { api } from "../api.js";
import "./SavedAvatars.css";

// Settings > Location. Off unless the person turns it on, in one of two ways they start themselves:
//   - type a city and pick it from the list, or
//   - press "Use device location", which is the only thing that asks the browser for permission.
// Nothing asks for permission on its own, nothing watches the position, and a position is used once, on the server, to find a city and
// is then dropped. The page keeps and sends no coordinates except in that one request.

const placeText = (location) => [location.city, location.region, location.country].filter(Boolean).join(", ");

// Why the browser could not give a position, in words, from the browser's own error code.
export function geolocationProblem(error) {
  if (!error) return "Your position could not be found.";
  if (error.code === 1) return "Permission to use your location was declined. You can allow it for this site in your browser's settings, or enter a city instead.";
  if (error.code === 2) return "Your device could not work out where it is. Try again, or enter a city instead.";
  if (error.code === 3) return "Finding your position took too long. Try again, or enter a city instead.";
  return "Your position could not be found. Enter a city instead.";
}

export default function LocationSettings() {
  const [state, setState] = useState({ loading: true, location: { mode: "off" }, error: "" });
  const [changing, setChanging] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState(null); // null: not searched; []: none found
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // "locating" while the browser works out the position, "saving" while the server finds the city: each said in words.
  const [deviceStep, setDeviceStep] = useState(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    try {
      const result = await api("/api/me/location", { cache: "no-store" });
      setState({ loading: false, location: result.location, error: "" });
    } catch {
      setState({ loading: false, location: { mode: "off" }, error: "Your location setting could not be loaded." });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Matches appear after typing pauses. The text goes to this app's own server in a request body, and is not kept.
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) { setMatches(null); return undefined; }
    const ticket = ++latest.current;
    const timer = setTimeout(() => {
      api("/api/me/location/search", { method: "POST", body: JSON.stringify({ q: text }) })
        .then((result) => { if (ticket === latest.current) setMatches(result.places ?? []); })
        .catch(() => { if (ticket === latest.current) setMatches(null); });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const done = (location, message) => { setState({ loading: false, location, error: "" }); setChanging(false); setQuery(""); setMatches(null); setNotice(message); };

  async function choose(place) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api("/api/me/location", { method: "PUT", body: JSON.stringify({ mode: "city", placeId: place.id }) });
      done(result.location, "Location saved.");
    } catch (failure) { setError(failure?.message || "That couldn't be saved. Please try again."); }
    finally { setBusy(false); }
  }

  function useDevice() {
    setError(""); setNotice("");
    if (!globalThis.isSecureContext || !navigator.geolocation) { setError("This browser can't share a position here. Enter a city instead."); return; }
    setBusy(true);
    setDeviceStep("locating");
    // Asked for now, once, because the person pressed the button. One reading, no watching, no cached position.
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        setDeviceStep("saving");
        try {
          const result = await api("/api/me/location/resolve", { method: "POST", body: JSON.stringify({ latitude: position.coords.latitude, longitude: position.coords.longitude }) });
          done(result.location, "Location saved. Only the city was kept, not your position.");
        } catch (failure) { setError(failure?.message || "That couldn't be saved. Please try again."); }
        finally { setBusy(false); setDeviceStep(null); }
      },
      (failure) => { setBusy(false); setDeviceStep(null); setError(geolocationProblem(failure)); },
      { enableHighAccuracy: false, maximumAge: 0, timeout: 15000 },
    );
  }

  async function remove() {
    setBusy(true); setError(""); setNotice("");
    try { await api("/api/me/location", { method: "DELETE" }); done({ mode: "off" }, "Location removed."); }
    catch (failure) { setError(failure?.message || "That couldn't be removed. Please try again."); }
    finally { setBusy(false); }
  }

  const on = state.location.mode && state.location.mode !== "off" && state.location.city;
  const chooser = !on || changing;

  return (
    <div className="saved-avatars location-settings">
      <p className="saved-avatars__intro">
        Helps answers with local weather, time and places. VibhavGPT stores only your city, region and timezone — never exact coordinates. Off by default.
      </p>
      {state.loading && <p className="saved-avatars__note" role="status">Loading…</p>}
      {state.error && <p className="note note--error" role="alert">{state.error}</p>}

      {!state.loading && on && (
        <div className="location__current" role="status">
          <MapPin size={18} aria-hidden="true" />
          <span><strong>{placeText(state.location)}</strong>{state.location.timezone ? <small> · {state.location.timezone}</small> : null}</span>
        </div>
      )}
      {!state.loading && !on && <p className="saved-avatars__note"><strong>Off.</strong> VibhavGPT does not know where you are.</p>}

      {!state.loading && chooser && (
        <div className="location__choose">
          <label className="location__search">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Enter a city</span>
            <input type="text" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Enter a city, for example Austin, Texas" maxLength={80} autoComplete="off" spellCheck={false} disabled={busy} />
          </label>
          {matches && matches.length > 0 && (
            <ul className="location__matches" aria-label="Matching cities">
              {matches.map((place) => (
                <li key={place.id}><button type="button" disabled={busy} onClick={() => void choose(place)}><MapPin size={14} aria-hidden="true" />{placeText(place)}</button></li>
              ))}
            </ul>
          )}
          {matches && matches.length === 0 && <p className="saved-avatars__note">No city matches that. Check the spelling, or add the country.</p>}
          <div className="saved-avatars__bar">
            <button type="button" className="btn btn--secondary" disabled={busy} onClick={useDevice}><LocateFixed size={16} /> Use device location</button>
            {changing && <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => { setChanging(false); setQuery(""); setMatches(null); }}>Cancel</button>}
          </div>
          {deviceStep && <p className="saved-avatars__note" role="status">{deviceStep === "locating" ? "Finding your location… Your browser may ask for permission." : "Finding your nearest city…"}</p>}
          <p className="saved-avatars__hint">Used once to look up your nearest city, then discarded.</p>
        </div>
      )}

      {!state.loading && on && !changing && (
        <div className="saved-avatars__bar">
          <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => { setChanging(true); setError(""); setNotice(""); }}>Update</button>
          <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void remove()}><Trash2 size={16} /> Remove</button>
        </div>
      )}

      {error && <p className="note note--error" role="alert">{error}</p>}
      {notice && !error && <p className="note" role="status">{notice}</p>}
      <p className="saved-avatars__hint">Place data from <a className="link" href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">GeoNames</a> (CC BY 4.0). Processed privately on VibhavGPT servers.</p>
    </div>
  );
}
