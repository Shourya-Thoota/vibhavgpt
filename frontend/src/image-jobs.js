// The Image tab's generation job lives here, outside React, so switching to
// Chat or Study neither cancels it nor loses its result. The request is
// owned by this store, not by a component: unmounting never aborts it, and
// each job makes exactly one request. The Image view reads the job when it
// mounts and takes the finished images when it is ready.
//
// The provider returns a finished image in one response, with no progress
// steps or percentages, so a job records only what is known: that it is
// generating, since when, and how it ended. The percentage below is derived
// from that.

let state = { job: null };
const listeners = new Set();
let nextId = 1;

function set(next) {
  state = next;
  for (const listener of [...listeners]) listener();
}

function update(id, fields) {
  if (state.job?.id !== id) return;
  set({ job: { ...state.job, ...fields } });
}

export const imageJobs = {
  get: () => state,
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  // Starts a job unless one is already generating. `kind` is "create" or
  // "variation"; `shape` sizes the pending tile. Returns the job id, or null.
  start(api, { body, kind = "create", shape = "square", now = Date.now }) {
    if (state.job?.status === "generating") return null;
    const id = nextId++;
    set({ job: { id, kind, shape, prompt: body?.prompt ?? "", hadReference: Boolean(body?.referenceAttachmentId), startedAt: now(), status: "generating", images: [], referenceApplied: null, error: "" } });
    api("/api/generation/image", { method: "POST", body: JSON.stringify(body) })
      .then((result) => update(id, { status: "done", images: Array.isArray(result?.images) ? result.images : [], referenceApplied: result?.referenceApplied ?? null }))
      .catch((error) => update(id, { status: "failed", error: error?.message || "The image couldn't be created. Try again." }));
    return id;
  },
  // The Image view calls this once it has shown a finished or failed job.
  acknowledge(id) {
    if (state.job?.id === id && state.job.status !== "generating") set({ job: null });
  },
  // On sign-out: forget the job, so another account on this tab never sees
  // it. A result that arrives later is ignored.
  clear() {
    if (state.job) set({ job: null });
  },
};

// The percentage shown while an image is made is an estimate from elapsed
// time, not a figure from the provider. It eases toward 99% and never
// reaches it while waiting: about 90% at the typical duration, then slower
// and slower. The real result shows 100%. Production image requests took 15
// to 58 s (median about 25 s), so 25 s is the typical duration.
export const IMAGE_TYPICAL_MS = 25_000;
const CEILING = 99;
const RATE = Math.log(CEILING / (CEILING - 90)) / IMAGE_TYPICAL_MS;

export function imageProgress(startedAt, now = Date.now(), typicalMs = IMAGE_TYPICAL_MS) {
  const elapsed = Math.max(0, now - startedAt);
  const rate = typicalMs === IMAGE_TYPICAL_MS ? RATE : Math.log(CEILING / (CEILING - 90)) / typicalMs;
  return Math.min(CEILING, Math.floor(CEILING * (1 - Math.exp(-rate * elapsed))));
}

export const progressLabel = (percent) => `Generating... ${percent}%`;
export const generatingLabel = (startedAt, now = Date.now()) => progressLabel(imageProgress(startedAt, now));
