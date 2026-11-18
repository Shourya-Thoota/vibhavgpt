// Chat's decorative background: the React Bits <Topography /> contour lines, drawn behind the conversation.
//
// This module only decides. Whether it shows, and with which settings, depends on the reader's choice, the screen on show, their device and
// their motion preference. It is pure so it can be tested without a browser, and it never throws.
//
//   - Chat, and Study when the reader turns it on for Study. Image never gets it.
//   - The reader's sky (Match system, Daybreak, Deep Space) is untouched: this is a layer over it, switched on and off in Settings.
//   - The component's own values from the specification are the starting point; they are only ever reduced for comfort or cost.

export const TOPOGRAPHY_KEY = "vibhavgpt-chat-topography";

// Motion: "system" follows the device's reduced-motion setting; "reduce" stops background movement everywhere; "full" allows it.
export const MOTION_KEY = "vibhavgpt-motion";
export const MOTION_CHOICES = Object.freeze(["system", "reduce", "full"]);

/** The reader's motion choice on this device; anything unreadable or unknown means "system". */
export function readMotionPreference(storage) {
  try {
    const value = storage.getItem(MOTION_KEY);
    return MOTION_CHOICES.includes(value) ? value : "system";
  } catch { return "system"; }
}

/** Whether movement should stop, from the reader's choice and the device setting. */
export function resolveReducedMotion(preference, deviceReduces) {
  if (preference === "reduce") return true;
  if (preference === "full") return false;
  return Boolean(deviceReduces);
}

// Study's background is chosen separately from Chat's. Since Slice 6 it matches Chat by default (the same contours, readability scrim
// and reduced-motion behaviour); a reader who turned it off for Study keeps it off.
export const STUDY_TOPOGRAPHY_KEY = "vibhavgpt-study-topography";

/** "on" unless the reader turned it off for Study on this device. Storage that cannot be read means the default. */
export function readStudyTopographyPreference(storage) {
  try { return storage.getItem(STUDY_TOPOGRAPHY_KEY) === "off" ? "off" : "on"; } catch { return "on"; }
}

/** "on" unless the reader turned it off on this device. Storage that cannot be read means the default. */
export function readTopographyPreference(storage) {
  try { return storage.getItem(TOPOGRAPHY_KEY) === "off" ? "off" : "on"; } catch { return "on"; }
}

// The specification's usage example, verbatim where it states a value.
const SPEC = Object.freeze({
  lineCount: 22,
  lineWidth: 1.2,
  elevation: 1,
  foreground: 0.2,
  tilt: 32,
  speed: 0.25,
  direction: "forward",
  glow: 0.6,
  depthOfField: 0.4,
  fog: 0.35,
  hoverEffect: "lift",
  clickEffect: "pulse",
});
export const TOPOGRAPHY_COLORS = Object.freeze({ light: "#2554d8", dark: "#4f7cff" });

/**
 * @param {object} environment
 * @param {"light"|"dark"} environment.resolved      the sky on show
 * @param {boolean} environment.reducedMotion         prefers-reduced-motion: reduce
 * @param {boolean} environment.coarsePointer         a touch screen as the main input
 * @param {boolean} environment.narrow                a phone-width viewport
 * @param {boolean} environment.saveData              the browser's data-saver switch
 * @param {boolean} environment.lowPower              few cores or little memory
 * @returns {{ enabled: boolean, interactive: boolean, props: object }}
 */
export function topographyProfile({ resolved = "dark", reducedMotion = false, coarsePointer = false, narrow = false, saveData = false, lowPower = false, allowMotion = false } = {}) {
  // Data saver or a device that struggles: the plain sky, and no download of the drawing code at all.
  if (saveData || lowPower) return { enabled: false, interactive: false, props: {} };

  const light = resolved === "light";
  const touch = coarsePointer || narrow;
  // Anything that makes it still: no travel, no morph, no intro, no pointer response, no glitch. A static drawing remains.
  // On a phone or touch screen the moving drawing made the page choppy (an emulated phone measured 2.6 frames/s moving against 60 still),
  // so it stands still there unless the reader chose Allow in Settings > Motion.
  const still = reducedMotion || (touch && !allowMotion);
  const interactive = !still && !touch;

  const props = {
    ...SPEC,
    color: light ? TOPOGRAPHY_COLORS.light : TOPOGRAPHY_COLORS.dark,
    lightMode: light,
    // Kept low enough that messages, the message box, menus and dialogs stay readable over the lines.
    opacity: 0.5,
    intro: !still,
    speed: still ? 0 : touch ? 0.15 : SPEC.speed,
    morph: still ? 0 : 0.2,
    glitch: 0,
    mouseInteraction: interactive,
    hoverEffect: interactive ? SPEC.hoverEffect : "light",
    clickEffect: interactive ? SPEC.clickEffect : "none",
    parallax: interactive ? 0.5 : 0,
    markers: "none",
    // Less to draw on a phone: fewer lines, no bloom passes, one pixel per pixel.
    ...(touch ? { lineCount: 16, glow: 0, dpr: 1 } : {}),
  };
  return { enabled: true, interactive, still, props };
}

/** Reads the environment from the browser. Every query is guarded: a missing API means "not that". */
export function readEnvironment(win = typeof window === "undefined" ? null : window) {
  if (!win) return { reducedMotion: true, coarsePointer: false, narrow: false, saveData: false, lowPower: false };
  const match = (query) => { try { return Boolean(win.matchMedia?.(query).matches); } catch { return false; } };
  const nav = win.navigator ?? {};
  return {
    reducedMotion: match("(prefers-reduced-motion: reduce)"),
    coarsePointer: match("(pointer: coarse)"),
    narrow: match("(max-width: 760px)"),
    saveData: Boolean(nav.connection?.saveData),
    lowPower: (Number(nav.hardwareConcurrency) > 0 && Number(nav.hardwareConcurrency) <= 2) || (Number(nav.deviceMemory) > 0 && Number(nav.deviceMemory) <= 2),
  };
}
