// What the composer says about upload limits, from the limits the server returns (GET /api/uploads/limits, the same table it enforces:
// src/uploads/service.js UPLOAD_LIMITS). Images and documents have different per-file limits, so neither is shown as "the" limit.
// Sizes are binary megabytes (1 MB = 1024 * 1024 bytes), as the server counts them, and a file is over the limit only when it is larger
// than it, as the server checks.

const PLAN_NAMES = { free: "Free", plus: "Plus", pro: "Pro", max: "Max", paid: "Pro" };
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const MB = 1024 * 1024;

/** An image by the server's own rule: its extension. */
export function isImageUpload(file) {
  const name = String(file?.name ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.has(name.slice(dot));
}

const megabytes = (bytes) => {
  const value = Number(bytes) / MB;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

/**
 * The line under the attachments. With nothing attached, or a mix, both limits; with only images, or only documents, just that one.
 * "Max plan", never "Max:", so it cannot be read as "maximum".
 */
export function attachmentGuidance(limits, files = []) {
  if (!limits || !Number.isFinite(Number(limits.imageBytes)) || !Number.isFinite(Number(limits.fileBytes))) return "Attach files";
  const plan = `${PLAN_NAMES[limits.tier] ?? "Free"} plan`;
  const images = files.filter(isImageUpload).length;
  const documents = files.length - images;
  const imageLine = `Images up to ${megabytes(limits.imageBytes)} MB`;
  const documentLine = `Documents up to ${megabytes(limits.fileBytes)} MB`;
  if (images && !documents) return `${plan} · ${imageLine}`;
  if (documents && !images) return `${plan} · ${documentLine}`;
  return `${plan} · ${imageLine} · ${documentLine}`;
}

/** The first file over its per-file limit, said plainly, or null. */
export function perFileProblem(limits, files = []) {
  if (!limits) return null;
  for (const file of files) {
    const image = isImageUpload(file);
    const limit = Number(image ? limits.imageBytes : limits.fileBytes);
    if (Number(file?.size) > limit) {
      return `${file.name} is larger than ${megabytes(limit)} MB, the ${image ? "image" : "document"} limit on the ${PLAN_NAMES[limits.tier] ?? "Free"} plan.`;
    }
  }
  return null;
}
