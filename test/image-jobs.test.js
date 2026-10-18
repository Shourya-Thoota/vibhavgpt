import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IMAGE_TYPICAL_MS, generatingLabel, imageJobs, imageProgress, progressLabel } from "../frontend/src/image-jobs.js";

// The Image tab's generation job survives tab switches: it lives outside the
// component, owns its one request, and keeps its result until the Image view
// takes it.

function deferredApi() {
  const calls = [];
  const api = (path, init) => new Promise((resolve, reject) => { calls.push({ path, init, resolve, reject }); });
  return { api, calls };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => imageJobs.clear());

test("a job keeps running and keeps its result while the Image view is unmounted", async () => {
  const { api, calls } = deferredApi();
  const seen = [];
  const unsubscribe = imageJobs.subscribe(() => seen.push(imageJobs.get().job?.status));
  const id = imageJobs.start(api, { kind: "create", shape: "wide", body: { prompt: "A lighthouse at dusk", aspectRatio: "wide" }, now: () => 1_000 });
  assert.equal(calls.length, 1, "exactly one request");
  assert.equal(calls[0].path, "/api/generation/image");
  assert.deepEqual(JSON.parse(calls[0].init.body), { prompt: "A lighthouse at dusk", aspectRatio: "wide" });
  assert.equal(calls[0].init.signal, undefined, "switching tabs can never abort it");
  assert.deepEqual(imageJobs.get().job, { id, kind: "create", shape: "wide", prompt: "A lighthouse at dusk", hadReference: false, startedAt: 1_000, status: "generating", images: [], referenceApplied: null, error: "" });

  // The user switches to Chat: the Image view unmounts.
  unsubscribe();
  calls[0].resolve({ images: [{ id: "img-1" }], referenceApplied: false });
  await settle();
  assert.deepEqual(seen, ["generating"], "the unmounted view was not called");

  // Back on Image: the finished result is there at once.
  const { job } = imageJobs.get();
  assert.equal(job.status, "done");
  assert.deepEqual(job.images, [{ id: "img-1" }]);
  imageJobs.acknowledge(id);
  assert.equal(imageJobs.get().job, null, "taken once");
  assert.equal(calls.length, 1, "returning made no new request");
});

test("a second job cannot start while one is generating", async () => {
  const { api, calls } = deferredApi();
  assert.ok(imageJobs.start(api, { body: { prompt: "first" } }));
  assert.equal(imageJobs.start(api, { body: { prompt: "second" } }), null);
  assert.equal(calls.length, 1);
  calls[0].resolve({ images: [] });
  await settle();
  assert.equal(imageJobs.get().job.status, "done");
  // A finished but not yet seen job does not block the next one.
  assert.ok(imageJobs.start(api, { body: { prompt: "third" } }));
  assert.equal(calls.length, 2);
});

test("a failed job keeps its message until the Image view shows it", async () => {
  const { api, calls } = deferredApi();
  const id = imageJobs.start(api, { kind: "variation", body: { prompt: "x", referenceAttachmentId: "ref-1" } });
  assert.equal(imageJobs.get().job.hadReference, true);
  calls[0].reject(new Error("Image generation is temporarily unavailable. Please try again shortly."));
  await settle();
  assert.equal(imageJobs.get().job.status, "failed");
  assert.equal(imageJobs.get().job.error, "Image generation is temporarily unavailable. Please try again shortly.");
  imageJobs.acknowledge(id);
  assert.equal(imageJobs.get().job, null);
});

test("signing out forgets the job, and its late result is ignored", async () => {
  const { api, calls } = deferredApi();
  imageJobs.start(api, { body: { prompt: "private" } });
  imageJobs.clear();
  assert.equal(imageJobs.get().job, null);
  calls[0].resolve({ images: [{ id: "img-private" }] });
  await settle();
  assert.equal(imageJobs.get().job, null);
});

test("the estimated percentage starts at 0, nears 90% at the typical time, and never passes 99% while waiting", () => {
  assert.equal(IMAGE_TYPICAL_MS, 25_000);
  assert.equal(imageProgress(10_000, 10_000), 0);
  assert.equal(imageProgress(0, IMAGE_TYPICAL_MS), 90);
  let previous = -1;
  for (let ms = 0; ms <= 600_000; ms += 250) {
    const percent = imageProgress(0, ms);
    assert.ok(percent >= previous, `only climbs (${ms} ms)`);
    assert.ok(percent <= 99, `never 100% before the image arrives (${ms} ms)`);
    previous = percent;
  }
  assert.equal(imageProgress(0, 600_000), 99, "a very slow image eases to 99%");
  // Production durations: 15 s is well along, 58 s is close to done.
  assert.ok(imageProgress(0, 15_000) >= 70 && imageProgress(0, 15_000) < 90);
  assert.ok(imageProgress(0, 58_000) >= 97);
  assert.equal(generatingLabel(0, 0), "Generating... 0%");
  assert.equal(generatingLabel(0, IMAGE_TYPICAL_MS), "Generating... 90%");
  assert.equal(progressLabel(100), "Generating... 100%");
});

test("the Image view goes through the store, and the app marks a background job", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const workspace = read("../frontend/src/components/ImageWorkspace.jsx");
  const app = read("../frontend/src/App.jsx");
  assert.doesNotMatch(workspace, /api\("\/api\/generation\/image",/, "only the store calls the image endpoint");
  assert.equal(workspace.match(/imageJobs\.start\(api,/g)?.length, 2, "create and variation both start store jobs");
  assert.doesNotMatch(workspace, /AbortController|\.abort\(/, "nothing in the Image view aborts a generation");
  assert.match(workspace, /useSyncExternalStore\(imageJobs\.subscribe, imageJobs\.get\)/);
  assert.match(workspace, /imageJobs\.acknowledge\(job\.id\)/);
  assert.match(workspace, /created\.filter\(\(image\) => !current\.some\(\(item\) => item\.id === image\.id\)\)/, "a finished image lands once");
  assert.match(workspace, /\{pending \? <GeneratingPercent startedAt=\{pending\.startedAt\} \/> : progressLabel\(100\)\}/, "100% shows only for a finished image");
  assert.match(workspace, /if \(job\.status === "failed"\) \{\s*setError\(job\.error\);\s*imageJobs\.acknowledge\(job\.id\);/, "a failure clears the plate and shows the error");
  assert.match(workspace, /setLanding\(\{ shape: job\.shape \}\);\s*const timer = setTimeout\(/, "a success holds at 100% before the image appears");
  assert.match(app, /useEffect\(\(\) => \(\) => imageJobs\.clear\(\), \[\]\);/, "signing out clears the job");
  assert.match(app, /tab\.value === "image" && imageJob && !\(productMode === "image" && page === "chat"\)/);
});
