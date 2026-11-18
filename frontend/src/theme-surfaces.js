// Chat and Study each have their own background (the sky: Match system, Daybreak or Deep Space), each stored on the device.
//
// - Chat keeps the key it always had (vibhavgpt-theme), so the public pages, the sign-in screen and everything outside Study still follow
//   it, and nobody's Chat changes.
// - Study has vibhavgpt-theme-study. The first time it is read and absent, it is set to what Chat is right now: the migration. Until a
//   reader changes one of them, the two are the same, so nobody's look changes when this ships.
// - "Match system" counts only once the reader picked a sky themselves (vibhavgpt-theme-chosen), for both, as before.
export const THEME_KEYS = Object.freeze({ chat: "vibhavgpt-theme", study: "vibhavgpt-theme-study" });
export const THEME_CHOSEN_KEY = "vibhavgpt-theme-chosen";
export const THEME_IDS = Object.freeze(["system", "light", "dark"]);

/** A stored value as the app resolves it: light or dark as saved; "system" only if chosen on purpose; anything else is Deep Space. */
export function savedTheme(storage, key) {
  try {
    const saved = storage.getItem(key);
    if (saved === "light" || saved === "dark") return saved;
    if (saved === "system" && storage.getItem(THEME_CHOSEN_KEY) === "1") return "system";
  } catch { /* storage blocked: the default sky */ }
  return "dark";
}

/** { chat, study }, migrating Study from Chat the first time. Never throws. */
export function readSurfaceThemes(storage) {
  const chat = savedTheme(storage, THEME_KEYS.chat);
  let studyStored = null;
  try { studyStored = storage.getItem(THEME_KEYS.study); } catch { /* blocked */ }
  if (!THEME_IDS.includes(studyStored)) {
    // The migration: Study starts as a copy of Chat, so the look does not change.
    try { storage.setItem(THEME_KEYS.study, chat); } catch { /* blocked */ }
    return { chat, study: chat };
  }
  return { chat, study: savedTheme(storage, THEME_KEYS.study) };
}

/** Which background the screen on show uses: Study's only on the Study chat, Chat's everywhere else (Settings, Usage, Image, Library). */
export const surfaceForView = ({ page, productMode } = {}) => (page === "chat" && productMode === "study" ? "study" : "chat");
