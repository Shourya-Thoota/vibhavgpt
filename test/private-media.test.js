import test from "node:test";
import assert from "node:assert/strict";
import { apiPath, apiRequest, fetchPrivateFile, isPrivateFileUrl } from "../frontend/src/api.js";

test("private resource resolution rejects outside origins and non-API paths", () => {
  assert.equal(apiPath("/api/uploads/a/preview", "https://api.vibhavgpt.com"), "/api/uploads/a/preview");
  assert.equal(apiPath("https://api.vibhavgpt.com/api/uploads/a/download", "https://api.vibhavgpt.com"), "/api/uploads/a/download");
  for (const url of ["https://evil.example/api/uploads/a/download", "//evil.example/api/uploads/a/download", "/account", "/api/../account"]) {
    assert.throws(() => apiPath(url, "https://api.vibhavgpt.com"));
  }
});

test("JSON, multipart and protected bytes keep credentials, errors never become image blobs", async (t) => {
  const previousLocation = globalThis.location;
  globalThis.location = { origin: "https://vibhavgpt.com" };
  t.after(() => { if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation; });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return new Response("pixels", { headers: { "Content-Type": "image/png" } });
  });
  const form = new FormData(); form.append("files", new Blob(["notes"]), "notes.txt");
  await apiRequest("/api/uploads", { method: "POST", body: form });
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[0].options.headers.has("Content-Type"), false);
  assert.equal(calls[0].options.body, form);
  await apiRequest("/api/chat/stream", { method: "POST", body: JSON.stringify({ message: "hello" }) });
  assert.equal(calls[1].options.headers.get("Content-Type"), "application/json");
  assert.equal((await fetchPrivateFile("/api/uploads/a/preview")).type, "image/png");
  assert.equal(calls[2].options.credentials, "include");
  assert.equal(isPrivateFileUrl("/api/uploads/a/preview"), true);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Sign in is required." }), { status: 401 });
  await assert.rejects(fetchPrivateFile("/api/uploads/a/preview"), { message: "Sign in is required.", status: 401 });
});
