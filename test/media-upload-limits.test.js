import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??= "test-only-auth-secret-at-least-32-characters";
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
const { auth } = await import("../src/auth.js");
const { db } = await import("../src/db/client.js");
const { uploadRouter } = await import("../src/uploads/router.js");

test("reading a gallery does not exhaust a Free user's upload bucket", async (t) => {
  const user = { id: "00000000-0000-0000-0000-000000000001" };
  t.mock.method(auth.api, "getSession", async () => ({ user }));
  // Missing files are sufficient here: authorization runs normally, and the
  // route must reach its ownership lookup on every read, never return 429.
  t.mock.method(db, "select", () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }));
  const app = express();
  app.use("/api/uploads", uploadRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/uploads/${user.id}`;
  for (let index = 0; index < 12; index += 1) {
    const response = await fetch(`${base}/${index % 2 ? "download" : "preview"}`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("ratelimit"), null);
  }
});
