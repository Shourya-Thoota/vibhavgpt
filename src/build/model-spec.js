// Build's 3D helper (owner decision, 2026-11-16). Tecton does not write triangle coordinates (a live test showed it cannot do so reliably);
// it writes a small JSON description of the object, and this module turns it into a valid ASCII STL on the server. The JSON is checked
// against a fixed schema and fixed limits first; nothing in it is run. The STL is generated deterministically (the same JSON always gives
// the same bytes), with outward normals, and it is what the preview draws and what the person downloads.
//
// Schema "vibhavgpt-model/1":
//   { "format": "vibhavgpt-model/1", "name": "Plate", "units": "mm", "parts": [ <part>, ... ] }
// Parts (every one may also have "position": [x, y, z] and "rotation": [rx, ry, rz] in degrees, applied X then Y then Z):
//   { "type": "box", "size": [x, y, z] }                                   centred on its position
//   { "type": "cylinder", "radius": r, "height": h, "segments": n }        base on z = 0, around the Z axis
//   { "type": "cone", "radiusBottom": r1, "radiusTop": r2, "height": h, "segments": n }
//   { "type": "sphere", "radius": r, "segments": n, "rings": m }           centred on its position
//   { "type": "torus", "majorRadius": R, "minorRadius": r, "segments": n, "tubeSegments": m }
//   { "type": "revolve", "profile": [[r, z], ...], "segments": n }         a side profile turned around the Z axis (plates, cups, vases)
// Parts are placed together in one file; overlapping parts are joined by the slicer, as slicers do with multi-body STL files.

export const MODEL_SPEC_FORMAT = "vibhavgpt-model/1";
export const MODEL_SPEC_LIMITS = Object.freeze({ maxParts: 64, maxDimension: 10_000, minSegments: 3, maxSegments: 256, maxProfilePoints: 200, maxTriangles: 16_000, maxBytes: 64 * 1024, maxStlBytes: 4 * 1024 * 1024 });
const UNITS = new Set(["mm", "cm", "m", "in"]);
const TYPES = new Set(["box", "cylinder", "cone", "sphere", "torus", "revolve"]);

export class ModelSpecError extends Error {}

const fail = (message) => { throw new ModelSpecError(message); };
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
function size(value, where) {
  if (!isNumber(value) || value <= 0 || value > MODEL_SPEC_LIMITS.maxDimension) fail(`${where} must be a number above 0 and at most ${MODEL_SPEC_LIMITS.maxDimension}.`);
  return value;
}
function coordinate(value, where) {
  if (!isNumber(value) || Math.abs(value) > MODEL_SPEC_LIMITS.maxDimension) fail(`${where} must be a number between -${MODEL_SPEC_LIMITS.maxDimension} and ${MODEL_SPEC_LIMITS.maxDimension}.`);
  return value;
}
function segments(value, where, fallback) {
  const n = value === undefined ? fallback : value;
  if (!Number.isInteger(n) || n < MODEL_SPEC_LIMITS.minSegments || n > MODEL_SPEC_LIMITS.maxSegments) fail(`${where} must be a whole number from ${MODEL_SPEC_LIMITS.minSegments} to ${MODEL_SPEC_LIMITS.maxSegments}.`);
  return n;
}
function triple(value, where, check) {
  if (!Array.isArray(value) || value.length !== 3) fail(`${where} must be a list of three numbers.`);
  return value.map((v, i) => check(v, `${where}[${i}]`));
}
const allowed = (object, keys, where) => {
  for (const key of Object.keys(object)) if (!keys.includes(key)) fail(`${where} has an unknown field "${String(key).slice(0, 30)}".`);
};

/** Checks a spec and returns it normalised, or throws ModelSpecError with a plain reason. */
export function validateModelSpec(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("The model must be a JSON object.");
  allowed(input, ["format", "name", "units", "parts", "notes"], "The model");
  if (input.format !== MODEL_SPEC_FORMAT) fail(`The model's "format" must be "${MODEL_SPEC_FORMAT}".`);
  const units = input.units ?? "mm";
  if (!UNITS.has(units)) fail(`"units" must be one of ${[...UNITS].join(", ")}.`);
  const name = String(input.name ?? "Model").replace(/[^\w .-]/g, "").slice(0, 60).trim() || "Model";
  if (!Array.isArray(input.parts) || !input.parts.length) fail("The model needs at least one part.");
  if (input.parts.length > MODEL_SPEC_LIMITS.maxParts) fail(`The model has more than ${MODEL_SPEC_LIMITS.maxParts} parts.`);
  const parts = input.parts.map((part, index) => {
    const where = `Part ${index + 1}`;
    if (!part || typeof part !== "object" || Array.isArray(part)) fail(`${where} must be an object.`);
    if (!TYPES.has(part.type)) fail(`${where} has an unknown type; use one of ${[...TYPES].join(", ")}.`);
    const common = ["type", "position", "rotation", "name"];
    const placed = {
      type: part.type,
      position: part.position === undefined ? [0, 0, 0] : triple(part.position, `${where} position`, coordinate),
      rotation: part.rotation === undefined ? [0, 0, 0] : triple(part.rotation, `${where} rotation`, (v, w) => { if (!isNumber(v) || Math.abs(v) > 360) fail(`${w} must be degrees between -360 and 360.`); return v; }),
    };
    switch (part.type) {
      case "box": allowed(part, [...common, "size"], where); return { ...placed, size: triple(part.size, `${where} size`, size) };
      case "cylinder": allowed(part, [...common, "radius", "height", "segments"], where);
        return { ...placed, radiusBottom: size(part.radius, `${where} radius`), radiusTop: part.radius, height: size(part.height, `${where} height`), segments: segments(part.segments, `${where} segments`, 48) };
      case "cone": allowed(part, [...common, "radiusBottom", "radiusTop", "height", "segments"], where);
        if (!isNumber(part.radiusTop) || part.radiusTop < 0 || part.radiusTop > MODEL_SPEC_LIMITS.maxDimension) fail(`${where} radiusTop must be 0 or more.`);
        return { ...placed, radiusBottom: size(part.radiusBottom, `${where} radiusBottom`), radiusTop: part.radiusTop, height: size(part.height, `${where} height`), segments: segments(part.segments, `${where} segments`, 48) };
      case "sphere": allowed(part, [...common, "radius", "segments", "rings"], where);
        return { ...placed, radius: size(part.radius, `${where} radius`), segments: segments(part.segments, `${where} segments`, 32), rings: segments(part.rings, `${where} rings`, 16) };
      case "torus": allowed(part, [...common, "majorRadius", "minorRadius", "segments", "tubeSegments"], where); {
        const R = size(part.majorRadius, `${where} majorRadius`); const r = size(part.minorRadius, `${where} minorRadius`);
        if (r >= R) fail(`${where} minorRadius must be smaller than majorRadius.`);
        return { ...placed, majorRadius: R, minorRadius: r, segments: segments(part.segments, `${where} segments`, 48), tubeSegments: segments(part.tubeSegments, `${where} tubeSegments`, 16) };
      }
      case "revolve": allowed(part, [...common, "profile", "segments"], where); {
        if (!Array.isArray(part.profile) || part.profile.length < 2 || part.profile.length > MODEL_SPEC_LIMITS.maxProfilePoints) fail(`${where} profile must have 2 to ${MODEL_SPEC_LIMITS.maxProfilePoints} [radius, z] points.`);
        const profile = part.profile.map((point, i) => {
          if (!Array.isArray(point) || point.length !== 2) fail(`${where} profile point ${i + 1} must be [radius, z].`);
          const [r, z] = point;
          if (!isNumber(r) || r < 0 || r > MODEL_SPEC_LIMITS.maxDimension) fail(`${where} profile point ${i + 1}: the radius must be 0 or more.`);
          return [r, coordinate(z, `${where} profile point ${i + 1} z`)];
        });
        if (!profile.some(([r]) => r > 0)) fail(`${where} profile must reach out from the axis.`);
        return { ...placed, profile, segments: segments(part.segments, `${where} segments`, 64) };
      }
      default: return fail(`${where} has an unknown type.`);
    }
  });
  return { format: MODEL_SPEC_FORMAT, name, units, parts };
}

// ---- Geometry ------------------------------------------------------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const TAU = Math.PI * 2;

// A closed profile [r, z] turned around the Z axis. The profile is closed through the axis at both ends, and its direction is set so the
// surface faces outward. Triangles that collapse on the axis are skipped.
function revolveTriangles(profileIn, n) {
  const profile = profileIn.slice();
  if (profile[0][0] !== 0) profile.unshift([0, profile[0][1]]);
  if (profile.at(-1)[0] !== 0) profile.push([0, profile.at(-1)[1]]);
  // Signed area in the (r, z) plane, closing along the axis: positive is counter-clockwise.
  let area = 0;
  for (let i = 0; i < profile.length; i += 1) { const [r1, z1] = profile[i]; const [r2, z2] = profile[(i + 1) % profile.length]; area += r1 * z2 - r2 * z1; }
  const pts = area < 0 ? profile.slice().reverse() : profile;
  const ring = (k) => { const a = (k % n) * TAU / n; return [Math.cos(a), Math.sin(a)]; };
  const out = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [r1, z1] = pts[i]; const [r2, z2] = pts[i + 1];
    for (let k = 0; k < n; k += 1) {
      const [c1, s1] = ring(k); const [c2, s2] = ring(k + 1);
      const a = [r1 * c1, r1 * s1, z1]; const b = [r1 * c2, r1 * s2, z1]; const c = [r2 * c2, r2 * s2, z2]; const d = [r2 * c1, r2 * s1, z2];
      out.push([a, b, c], [a, c, d]);
    }
  }
  return out;
}

function partTriangles(part) {
  switch (part.type) {
    case "box": {
      const [x, y, z] = part.size.map((v) => v / 2);
      const v = [[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]];
      const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
      return faces.flatMap(([a, b, c, d]) => [[v[a], v[b], v[c]], [v[a], v[c], v[d]]]);
    }
    case "cylinder": case "cone":
      return revolveTriangles([[0, 0], [part.radiusBottom, 0], [part.radiusTop, part.height], [0, part.height]], part.segments);
    case "sphere": {
      const profile = [];
      for (let i = 0; i <= part.rings; i += 1) { const a = -Math.PI / 2 + (Math.PI * i) / part.rings; profile.push([Math.max(0, part.radius * Math.cos(a)), part.radius * Math.sin(a)]); }
      profile[0][0] = 0; profile.at(-1)[0] = 0;
      return revolveTriangles(profile, part.segments);
    }
    case "torus": {
      const profile = [];
      for (let i = 0; i < part.tubeSegments; i += 1) { const a = (TAU * i) / part.tubeSegments; profile.push([part.majorRadius + part.minorRadius * Math.cos(a), part.minorRadius * Math.sin(a)]); }
      profile.push(profile[0]);
      // A closed tube that never reaches the axis: turn its ring without closing through the axis.
      let area = 0;
      for (let i = 0; i < profile.length - 1; i += 1) area += profile[i][0] * profile[i + 1][1] - profile[i + 1][0] * profile[i][1];
      const pts = area < 0 ? profile.slice().reverse() : profile;
      const out = [];
      const n = part.segments;
      for (let i = 0; i < pts.length - 1; i += 1) {
        const [r1, z1] = pts[i]; const [r2, z2] = pts[i + 1];
        for (let k = 0; k < n; k += 1) {
          const a1 = (k * TAU) / n; const a2 = ((k + 1) % n) * TAU / n;
          const a = [r1 * Math.cos(a1), r1 * Math.sin(a1), z1]; const b = [r1 * Math.cos(a2), r1 * Math.sin(a2), z1];
          const c = [r2 * Math.cos(a2), r2 * Math.sin(a2), z2]; const d = [r2 * Math.cos(a1), r2 * Math.sin(a1), z2];
          out.push([a, b, c], [a, c, d]);
        }
      }
      return out;
    }
    case "revolve": return revolveTriangles(part.profile, part.segments);
    default: return [];
  }
}

function transform(triangles, { position, rotation }) {
  const [rx, ry, rz] = rotation.map((deg) => (deg * Math.PI) / 180);
  const rot = (p) => {
    let [x, y, z] = p;
    [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
    [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
    [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
    return [x + position[0], y + position[1], z + position[2]];
  };
  return triangles.map((t) => t.map(rot));
}

const num = (v) => { const s = (Math.abs(v) < 5e-7 ? 0 : v).toFixed(6).replace(/\.?0+$/, ""); return s === "-0" ? "0" : s; };

/** The STL for a spec: { stl, triangles, size: [x, y, z], units }. Throws ModelSpecError if the spec is not valid or too detailed. */
export function generateStl(input) {
  const spec = validateModelSpec(input);
  const triangles = [];
  for (const part of spec.parts) {
    for (const t of transform(partTriangles(part), part)) {
      const n = cross(sub(t[1], t[0]), sub(t[2], t[0]));
      const length = Math.hypot(...n);
      if (length < 1e-12) continue; // collapsed on the axis
      triangles.push({ n: n.map((v) => v / length), t });
      if (triangles.length > MODEL_SPEC_LIMITS.maxTriangles) fail(`The model would have more than ${MODEL_SPEC_LIMITS.maxTriangles} triangles; use fewer segments.`);
    }
  }
  if (!triangles.length) fail("The model has no surface.");
  const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
  for (const { t } of triangles) for (const p of t) for (let i = 0; i < 3; i += 1) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }
  const solid = spec.name.replace(/\s+/g, "_");
  const lines = [`solid ${solid}`];
  for (const { n, t } of triangles) {
    lines.push(`  facet normal ${n.map(num).join(" ")}`, "    outer loop", ...t.map((p) => `      vertex ${p.map(num).join(" ")}`), "    endloop", "  endfacet");
  }
  lines.push(`endsolid ${solid}`, "");
  const stl = lines.join("\n");
  if (Buffer.byteLength(stl, "utf8") > MODEL_SPEC_LIMITS.maxStlBytes) fail(`The model's STL would be larger than ${MODEL_SPEC_LIMITS.maxStlBytes / 1024 / 1024} MB; use fewer segments.`);
  return { stl, triangles: triangles.length, size: max.map((v, i) => Number((v - min[i]).toFixed(6))), units: spec.units, name: spec.name };
}

/** Reads a spec file's text: the parsed spec, or ModelSpecError (bad JSON, too large). */
export function parseModelSpec(text) {
  if (Buffer.byteLength(String(text), "utf8") > MODEL_SPEC_LIMITS.maxBytes) fail(`The model description is larger than ${MODEL_SPEC_LIMITS.maxBytes / 1024} KB.`);
  try { return JSON.parse(String(text)); } catch { return fail("The model description is not valid JSON."); }
}
