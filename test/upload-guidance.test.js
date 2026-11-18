// The composer's upload guidance (frontend/src/upload-guidance.js) against the limits the server enforces (src/uploads/service.js). Owner
// report, 2026-11-15: "Max: up to 80 MB per file" was shown beside a JPG, though images are limited to 20 MB.
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real-at-least-32-chars";
const { UPLOAD_LIMITS, fileLimitsForTier } = await import("../src/uploads/service.js");
const { attachmentGuidance, perFileProblem, isImageUpload } = await import("../frontend/src/upload-guidance.js");

const MB = 1024 * 1024;
const limitsFor = (tier) => ({ tier, ...fileLimitsForTier(tier) });
const jpg = (size) => ({ name: "plant_cell.jpg", size });
const pdf = (size) => ({ name: "notes.pdf", size });

test("each plan's guidance names images and documents separately, with the server's own numbers", () => {
  const expected = {
    free: "Free plan · Images up to 5 MB · Documents up to 5 MB",
    plus: "Plus plan · Images up to 10 MB · Documents up to 25 MB",
    pro: "Pro plan · Images up to 20 MB · Documents up to 80 MB",
    max: "Max plan · Images up to 20 MB · Documents up to 80 MB",
  };
  for (const [tier, line] of Object.entries(expected)) {
    assert.equal(attachmentGuidance(limitsFor(tier)), line, tier);
    assert.equal(UPLOAD_LIMITS[tier].imageBytes / MB, Number(line.match(/Images up to (\d+)/)[1]), `${tier}: images match the server`);
    assert.equal(UPLOAD_LIMITS[tier].fileBytes / MB, Number(line.match(/Documents up to (\d+)/)[1]), `${tier}: documents match the server`);
  }
});

test("with a JPG attached, the Max plan says images up to 20 MB, never 80 MB", () => {
  const line = attachmentGuidance(limitsFor("max"), [jpg(2 * MB)]);
  assert.equal(line, "Max plan · Images up to 20 MB");
  assert.doesNotMatch(line, /80 MB/);
  assert.doesNotMatch(line, /^Max:/, "not readable as 'maximum'");
  assert.equal(attachmentGuidance(limitsFor("max"), [pdf(1)]), "Max plan · Documents up to 80 MB");
  assert.equal(attachmentGuidance(limitsFor("max"), [jpg(1), pdf(1)]), "Max plan · Images up to 20 MB · Documents up to 80 MB");
});

test("boundaries are the server's: exactly the limit is allowed, one byte more is not; images are told apart by extension", () => {
  const max = limitsFor("max");
  assert.equal(perFileProblem(max, [jpg(20 * MB)]), null);
  assert.equal(perFileProblem(max, [jpg(20 * MB + 1)]), "plant_cell.jpg is larger than 20 MB, the image limit on the Max plan.");
  assert.equal(perFileProblem(max, [pdf(80 * MB)]), null);
  assert.match(perFileProblem(max, [pdf(80 * MB + 1)]), /larger than 80 MB, the document limit on the Max plan/);
  assert.equal(isImageUpload({ name: "PHOTO.JPEG" }), true);
  assert.equal(isImageUpload({ name: "report.pdf" }), false);
  assert.equal(attachmentGuidance(null), "Attach files", "nothing is claimed before the server answers");
});
