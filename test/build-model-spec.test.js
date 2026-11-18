// Build's 3D helper (src/build/model-spec.js; owner decision, 2026-11-16): Tecton describes a model as JSON and the server generates the
// STL. Checks: the schema and its limits, valid closed outward-facing geometry for every part type, the same bytes every time, and the
// Build reply path (the description is saved, the generated STL is added and becomes the entry).
import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_SPEC_FORMAT, MODEL_SPEC_LIMITS, ModelSpecError, generateStl, validateModelSpec } from "../src/build/model-spec.js";
import { extractBuildArtifact } from "../src/build/artifacts.js";
import { readModel } from "../frontend/src/model3d.js";

const spec = (parts, extra = {}) => ({ format: MODEL_SPEC_FORMAT, name: "Test", units: "mm", parts, ...extra });
const PLATE = spec([{ type: "revolve", profile: [[0, 0], [50, 0], [60, 10], [60, 12], [57, 12], [48, 3], [0, 3]] }], { name: "Dinner plate" });

// Every edge used exactly once in each direction (closed), and a positive signed volume (faces point outward).
function solidity(stl) {
  const v = [...stl.matchAll(/vertex (\S+) (\S+) (\S+)/g)].map((m) => m.slice(1, 4).map(Number));
  const key = (p) => p.map((x) => x.toFixed(4)).join(",");
  const edges = new Map();
  let volume = 0;
  for (let i = 0; i < v.length; i += 3) {
    const [a, b, c] = [v[i], v[i + 1], v[i + 2]];
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) { const k = `${key(p)}>${key(q)}`; edges.set(k, (edges.get(k) ?? 0) + 1); }
  }
  let open = 0;
  for (const [k, n] of edges) { const [p, q] = k.split(">"); if ((edges.get(`${q}>${p}`) ?? 0) !== n) open += 1; }
  return { volume, open };
}

test("every part type gives closed, outward-facing geometry of the right size and volume", () => {
  const cases = [
    [{ type: "box", size: [10, 20, 30] }, [10, 20, 30], 6000],
    [{ type: "cylinder", radius: 5, height: 10, segments: 128 }, [10, 10, 10], Math.PI * 25 * 10],
    [{ type: "cone", radiusBottom: 5, radiusTop: 0, height: 10, segments: 128 }, [10, 10, 10], (Math.PI * 25 * 10) / 3],
    [{ type: "sphere", radius: 5, segments: 96, rings: 48 }, [10, 10, 10], (4 / 3) * Math.PI * 125],
    [{ type: "torus", majorRadius: 10, minorRadius: 2, segments: 128, tubeSegments: 48 }, [24, 24, 4], 2 * Math.PI ** 2 * 10 * 4],
  ];
  for (const [part, size, volume] of cases) {
    const out = generateStl(spec([part]));
    assert.deepEqual(out.size.map((v) => Number(v.toFixed(3))), size, `${part.type}: size`);
    const s = solidity(out.stl);
    assert.equal(s.open, 0, `${part.type}: closed`);
    assert.ok(s.volume > 0, `${part.type}: faces point outward`);
    assert.ok(Math.abs(s.volume - volume) / volume < 0.02, `${part.type}: volume ${s.volume.toFixed(1)} close to ${volume.toFixed(1)}`);
  }
});

test("a plate made by revolving a profile: 120 x 120 x 12 mm, closed, valid STL whichever way the profile is written", () => {
  const out = generateStl(PLATE);
  assert.deepEqual(out.size, [120, 120, 12]);
  assert.equal(out.units, "mm");
  const s = solidity(out.stl);
  assert.equal(s.open, 0);
  assert.ok(s.volume > 0);
  const reversed = generateStl(spec([{ type: "revolve", profile: PLATE.parts[0].profile.slice().reverse() }]));
  assert.ok(solidity(reversed.stl).volume > 0, "the direction of the profile does not matter");
  const model = readModel(out.stl, "plate.stl");
  assert.equal(model.triangles, out.triangles, "the shared STL reader agrees");
  assert.match(out.stl, /^solid Dinner_plate\n  facet normal /);
  assert.match(out.stl, /endsolid Dinner_plate\n$/);
});

test("parts are placed and rotated; the same description always gives the same bytes", () => {
  const moved = generateStl(spec([{ type: "box", size: [10, 10, 10], position: [100, 0, 0] }, { type: "box", size: [10, 10, 10], rotation: [0, 0, 45] }]));
  assert.ok(moved.size[0] > 110, "the second box is placed apart and turned");
  assert.equal(generateStl(PLATE).stl, generateStl(PLATE).stl);
});

test("the schema is strict: wrong format, unknown fields or types, bad numbers and limits are refused with a reason", () => {
  const bad = [
    [{ ...PLATE, format: "other" }, /"format" must be/],
    [{ ...PLATE, units: "furlongs" }, /"units" must be one of/],
    [{ ...PLATE, parts: [] }, /at least one part/],
    [{ ...PLATE, extra: 1 }, /unknown field "extra"/],
    [spec([{ type: "pyramid" }]), /unknown type/],
    [spec([{ type: "box", size: [10, 10] }]), /list of three numbers/],
    [spec([{ type: "box", size: [10, -1, 10] }]), /above 0/],
    [spec([{ type: "box", size: [10, 1e9, 10] }]), /at most 10000/],
    [spec([{ type: "box", size: [10, 10, 10], position: [0, "x", 0] }]), /must be a number/],
    [spec([{ type: "cylinder", radius: 5, height: 5, segments: 2 }]), /whole number from 3 to 256/],
    [spec([{ type: "cylinder", radius: 5, height: 5, segments: 1.5 }]), /whole number/],
    [spec([{ type: "torus", majorRadius: 5, minorRadius: 6 }]), /smaller than majorRadius/],
    [spec([{ type: "revolve", profile: [[0, 0], [0, 5]] }]), /reach out from the axis/],
    [spec([{ type: "revolve", profile: [[-1, 0], [5, 5]] }]), /radius must be 0 or more/],
    [spec([{ type: "box", size: [1, 1, 1], __proto__: { polluted: true } }]), null],
    [spec(Array.from({ length: MODEL_SPEC_LIMITS.maxParts + 1 }, () => ({ type: "box", size: [1, 1, 1] }))), /more than 64 parts/],
    [spec([{ type: "sphere", radius: 5, segments: 256, rings: 256 }]), /more than 16000 triangles/],
  ];
  for (const [input, why] of bad) {
    if (why === null) { assert.doesNotThrow(() => validateModelSpec(input)); assert.equal({}.polluted, undefined, "no prototype pollution"); continue; }
    assert.throws(() => generateStl(input), (error) => error instanceof ModelSpecError && why.test(error.message), String(why));
  }
});

const file = (path, content) => `<<<FILE path="${path}">>>\n${content}\n<<<END FILE>>>`;

test("a Build reply with model.json: the description is kept, the STL is generated and becomes the entry", () => {
  const reply = ["A 120 mm dinner plate.", '<<<PROJECT kind="model" entry="model.json">>>', file("model.json", JSON.stringify(PLATE, null, 2)), file("README.md", "120 x 120 x 12 mm")].join("\n");
  const out = extractBuildArtifact(reply);
  assert.equal(out.status, "files");
  assert.equal(out.entry, "model.stl");
  assert.deepEqual(out.files.map((f) => f.path), ["model.json", "model.stl", "README.md"].sort((a, b) => a.localeCompare(b)));
  const stl = out.files.find((f) => f.path === "model.stl");
  assert.equal(stl.type, "model/stl");
  assert.equal(stl.content, generateStl(PLATE).stl, "byte for byte the generated STL");
  assert.equal(out.totalBytes, out.files.reduce((sum, f) => sum + f.bytes, 0));
  // A named description: plate.model.json -> plate.stl.
  const named = extractBuildArtifact(["x", '<<<PROJECT kind="model" entry="plate.model.json">>>', file("plate.model.json", JSON.stringify(PLATE))].join("\n"));
  assert.equal(named.entry, "plate.stl");
});

test("a Build reply with a broken description, or one that also writes the STL by hand, is not saved", () => {
  const broken = extractBuildArtifact(["x", '<<<PROJECT kind="model" entry="model.json">>>', file("model.json", "{ not json")].join("\n"));
  assert.equal(broken.status, "invalid");
  assert.match(broken.problem, /model\.json: The model description is not valid JSON\. The model was not saved\./);
  const invalid = extractBuildArtifact(["x", '<<<PROJECT kind="model" entry="model.json">>>', file("model.json", JSON.stringify(spec([{ type: "box", size: [0, 1, 1] }])))].join("\n"));
  assert.match(invalid.problem, /size\[0\] must be a number above 0/);
  const both = extractBuildArtifact(["x", '<<<PROJECT kind="model" entry="model.json">>>', file("model.json", JSON.stringify(PLATE)), file("model.stl", "solid x\nendsolid x")].join("\n"));
  assert.equal(both.status, "invalid");
});
