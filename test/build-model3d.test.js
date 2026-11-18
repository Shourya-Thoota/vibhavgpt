// Build's 3D models (frontend/src/model3d.js): an ASCII STL or OBJ file Tecton writes is checked as geometry before it is saved, is the
// file the person downloads, and is drawn in the sandboxed preview. Synthetic files only.
import test from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { MODEL_LIMITS, ModelError, readModel } from "../frontend/src/model3d.js";
import { PREVIEW_CSP, PreviewError, buildPreviewDocument } from "../frontend/src/build-preview.js";
import { extractBuildArtifact } from "../src/build/artifacts.js";

// A 10 x 10 x 2 box: 12 triangles.
const boxCorners = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 2], [10, 0, 2], [10, 10, 2], [0, 10, 2]];
const boxFaces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
const BOX_STL = ["solid box", ...boxFaces.flatMap((f) => ["  facet normal 0 0 0", "    outer loop", ...f.map((i) => `      vertex ${boxCorners[i].join(" ")}`), "    endloop", "  endfacet"]), "endsolid box"].join("\n");
const BOX_OBJ = ["# box", ...boxCorners.map((c) => `v ${c.join(" ")}`), "f 1 3 2 4", ...boxFaces.slice(2).map((f) => `f ${f.map((i) => `${i + 1}/1/1`).join(" ")}`)].join("\n");

test("an ASCII STL is read as triangles with its size", () => {
  const model = readModel(BOX_STL, "plate.stl");
  assert.equal(model.triangles, 12);
  assert.deepEqual(model.size, [10, 10, 2]);
  assert.deepEqual(model.min, [0, 0, 0]);
});

test("an OBJ is read too: quads become two triangles, v/vt/vn indices and negative indices work", () => {
  const model = readModel(BOX_OBJ, "box.obj");
  assert.equal(model.triangles, 2 + 10);
  assert.deepEqual(model.size, [10, 10, 2]);
  assert.equal(readModel("v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1", "t.obj").triangles, 1);
});

test("files that are not valid geometry are refused, with the reason", () => {
  const bad = [
    ["no-solid.stl", "facet normal 0 0 0\nouter loop\nvertex 0 0 0\nendloop\nendfacet", /must start with "solid"/],
    ["two.stl", "solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nendloop\nendfacet\nendsolid", /exactly three vertices/],
    ["nan.stl", "solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 NaN\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid", /not a number/],
    ["huge.stl", "solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 1e9\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid", /out of range/],
    ["empty.stl", "solid x\nendsolid x", /no triangles/],
    ["ref.obj", "v 0 0 0\nv 1 0 0\nf 1 2 3", /vertex 3, which isn't defined/],
    ["flat.obj", "v 0 0 0\nv 1 0 0\nv 2 0 0\nf 1 2 3", /flat or a single point/],
    ["model.ply", "ply", /not an STL or OBJ/],
  ];
  for (const [name, text, why] of bad) assert.throws(() => readModel(text, name), (error) => error instanceof ModelError && why.test(error.message), name);
});

test("the triangle limit holds", () => {
  const many = ["v 0 0 0", "v 1 0 0", "v 0 1 0", "v 0 0 1", ...Array.from({ length: MODEL_LIMITS.maxTriangles + 1 }, () => "f 1 2 3")].join("\n");
  assert.throws(() => readModel(many, "many.obj"), /more than 60000 triangles/);
});

const file = (path, content) => `<<<FILE path="${path}">>>\n${content}\n<<<END FILE>>>`;
const reply = (entry, files) => ["A 10 mm square plate.", `<<<PROJECT kind="model" entry="${entry}">>>`, ...files].join("\n");

test("a model project is saved with its STL as a real file; broken geometry or a non-model entry is not saved", () => {
  const ok = extractBuildArtifact(reply("plate.stl", [file("plate.stl", BOX_STL), file("README.md", "10 x 10 x 2 mm")]));
  assert.equal(ok.status, "files");
  assert.equal(ok.kind, "model");
  assert.equal(ok.files.find((f) => f.path === "plate.stl").type, "model/stl");
  assert.equal(ok.files.find((f) => f.path === "plate.stl").content, BOX_STL, "the export is exactly the file written");
  const broken = extractBuildArtifact(reply("plate.stl", [file("plate.stl", "solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nendloop\nendfacet\nendsolid")]));
  assert.equal(broken.status, "invalid");
  assert.match(broken.problem, /exactly three vertices\. The model was not saved\./);
  const wrongEntry = extractBuildArtifact(reply("README.md", [file("plate.stl", BOX_STL), file("README.md", "x")]));
  assert.equal(wrongEntry.status, "invalid");
  assert.match(wrongEntry.problem, /entry must be its model\.json description or its \.stl or \.obj file/);
});

test("the preview of a model is the viewer and its data in the same locked-down sandbox page", async () => {
  const html = await buildPreviewDocument({ kind: "model", entry: "plate.stl", files: [{ path: "plate.stl", content: BOX_STL }] }, { esbuild, loadRuntime: async () => { throw new Error("no runtime for a model"); } });
  assert.ok(html.includes(`content="${PREVIEW_CSP}"`), "the preview's own no-network policy");
  assert.match(html, /window\.__vgModel=\{"positions":\[/);
  assert.match(html, /getContext\("webgl"/);
  assert.match(html, /plate\.stl: 12 triangles · 10 × 10 × 2/);
  assert.doesNotMatch(html, /__vgModules|<script src=/);
  await assert.rejects(buildPreviewDocument({ kind: "model", entry: "plate.stl", files: [{ path: "plate.stl", content: "solid x\nendsolid" }] }, { esbuild, loadRuntime: async () => "" }),
    (error) => error instanceof PreviewError && /no triangles/.test(error.message));
});
