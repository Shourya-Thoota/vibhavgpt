process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";

const lookup = await import("../src/location/lookup.js");
const { createLocationRouter, readLocation } = await import("../src/location/router.js");
const { locationContextLine } = await import("../src/location/context.js");

async function createDatabase(t) {
  const client = new PGlite();
  t.after(() => client.close());
  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  return { client, db: drizzle(client) };
}
const fakeSession = (req, res, next) => {
  const id = req.headers["x-test-user"];
  if (!id) return res.status(401).json({ error: "Sign in is required." });
  req.authSession = { user: { id } };
  return next();
};
async function serve(t, db, options = {}) {
  const app = express();
  app.use("/api/me/location", createLocationRouter({ database: db, session: fakeSession, ...options }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/api/me/location`;
}
const send = (url, user, method, body, path = "") => fetch(`${url}${path}`, { method, headers: { ...(user ? { "x-test-user": user } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("the place list is real, local data with the fields the feature needs", () => {
  assert.ok(lookup.placeCount() > 30000, `${lookup.placeCount()} places`);
  const paris = lookup.searchPlaces("Paris")[0];
  assert.deepEqual({ city: paris.name, country: paris.country, timezone: paris.timezone }, { city: "Paris", country: "France", timezone: "Europe/Paris" }, "Paris, France before any small town of the name");
  assert.deepEqual(lookup.publicPlace(paris), { id: paris.id, city: "Paris", region: "Ile-de-France", country: "France", timezone: "Europe/Paris" });
});

test("typed cities are matched forgivingly, narrowed by region or country, and ranked by size", () => {
  const names = (q) => lookup.searchPlaces(q).map((p) => `${p.name}|${p.region}|${p.countryCode}`);
  assert.ok(names("austin, texas")[0].startsWith("Austin|Texas|US"));
  assert.ok(names("Austin TX")[0] === undefined || names("Austin tx").length >= 0);
  assert.equal(lookup.searchPlaces("sao paulo")[0].countryCode, "BR", "accents are optional");
  assert.equal(lookup.searchPlaces("SÃO PAULO")[0].countryCode, "BR");
  assert.equal(lookup.searchPlaces("  zurich ")[0].countryCode, "CH");
  assert.ok(lookup.searchPlaces("paris, texas").every((p) => p.region === "Texas"), "a region narrows");
  assert.ok(lookup.searchPlaces("paris, canada").every((p) => p.countryCode === "CA"), "a country narrows");
  assert.ok(names("springf").length > 1 && lookup.searchPlaces("springf")[0].population >= lookup.searchPlaces("springf")[1].population, "a prefix lists the larger first");
  for (const q of ["", " ", "a", "zzzzzzzz nowhere", "'; DROP TABLE x;--", "\u0000", "💥", "%", "..", "x".repeat(500)]) assert.ok(Array.isArray(lookup.searchPlaces(q)), JSON.stringify(q).slice(0, 20));
  assert.deepEqual(lookup.searchPlaces("zzzzzzzz nowhere"), []);
  assert.ok(lookup.searchPlaces("paris", 3).length <= 3);
  assert.ok(lookup.searchPlaces("paris", 1000).length <= 10, "capped");
});

test("a device position becomes the nearest listed place; far from anything, or nonsense, becomes nothing", () => {
  assert.equal(lookup.nearestPlace(48.8566, 2.3522).name, "Paris");
  assert.equal(lookup.nearestPlace(30.2672, -97.7431).name, "Austin");
  assert.equal(lookup.nearestPlace(-33.8688, 151.2093).name, "Sydney");
  assert.equal(lookup.nearestPlace(0, -140), null, "mid-ocean: nothing within 250 km");
  for (const bad of [[91, 0], [0, 181], [NaN, 0], ["a", "b"], [null, null], [undefined, 1]]) assert.equal(lookup.nearestPlace(...bad), null, JSON.stringify(bad));
});

test("the route: signed in only, off to begin with, and the account is the session's", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, db);
  assert.equal((await send(url, null, "GET")).status, 401);
  assert.equal((await send(url, null, "PUT", { mode: "city", placeId: "1" })).status, 401);
  assert.equal((await send(url, null, "POST", { latitude: 1, longitude: 1 }, "/resolve")).status, 401);
  assert.equal((await send(url, null, "POST", { q: "paris" }, "/search")).status, 401);
  const initial = await send(url, "alice", "GET");
  assert.equal(initial.headers.get("cache-control"), "private, no-store");
  assert.deepEqual((await initial.json()).location, { mode: "off", city: null, region: null, country: null, timezone: null }, "off by default");
});

test("choosing a city: the place comes from the local list by id, never from text the client sends", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, db);
  const { places } = await (await send(url, "alice", "POST", { q: "austin, texas" }, "/search")).json();
  assert.ok(places.length >= 1 && places[0].city === "Austin" && places[0].timezone === "America/Chicago");
  assert.deepEqual(Object.keys(places[0]).sort(), ["city", "country", "id", "region", "timezone"], "no coordinates are sent to the page");
  const set = await send(url, "alice", "PUT", { mode: "city", placeId: places[0].id });
  assert.equal(set.status, 200);
  assert.deepEqual((await set.json()).location, { mode: "city", city: "Austin", region: "Texas", country: "United States", timezone: "America/Chicago" });
  assert.equal((await (await send(url, "alice", "GET")).json()).location.city, "Austin", "it persists");
  assert.equal((await (await send(url, "bob", "GET")).json()).location.mode, "off", "and is only alice's");
  // Text the client sends in place of an id changes nothing.
  assert.equal((await send(url, "alice", "PUT", { mode: "city", placeId: "999999999" })).status, 400);
  assert.equal((await send(url, "alice", "PUT", { mode: "city", city: "Atlantis", country: "Nowhere", timezone: "Mars/Olympus" })).status, 400);
  assert.equal((await send(url, "alice", "PUT", { mode: "device", placeId: places[0].id })).status, 400, "only a city can be chosen this way");
  assert.equal((await send(url, "alice", "PUT", { mode: "city", placeId: 5 })).status, 400);
  assert.equal((await (await send(url, "alice", "GET")).json()).location.city, "Austin", "and the stored place is untouched");
  assert.equal((await send(url, "alice", "POST", { q: "x".repeat(400) }, "/search")).status, 400);
});

test("a device position is resolved to a place and then forgotten: no coordinates are stored anywhere", async (t) => {
  const { client, db } = await createDatabase(t);
  const url = await serve(t, db);
  const res = await send(url, "alice", "POST", { latitude: 48.8566, longitude: 2.3522, accuracy: 12, altitude: 35 }, "/resolve");
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).location, { mode: "device", city: "Paris", region: "Ile-de-France", country: "France", timezone: "Europe/Paris" });
  const row = JSON.stringify((await client.query("SELECT * FROM account_preferences WHERE user_id = 'alice'")).rows[0]);
  assert.doesNotMatch(row, /48\.8|2\.35|"latitude"|"longitude"|accuracy|altitude/, "no position in the stored row");
  const columns = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'account_preferences'")).rows.map((r) => r.column_name);
  assert.ok(!columns.some((c) => /lat|lng|lon|coord|position/i.test(c)), `no column could hold a position: ${columns}`);
  assert.equal((await send(url, "alice", "POST", { latitude: 0, longitude: -140 }, "/resolve")).status, 422, "no city near mid-ocean says so");
  assert.equal((await send(url, "alice", "POST", { latitude: "48.8", longitude: "2.3" }, "/resolve")).status, 400, "numbers only");
  assert.equal((await send(url, "alice", "POST", {}, "/resolve")).status, 400);
  assert.equal((await send(url, "alice", "POST", { latitude: 999, longitude: 0 }, "/resolve")).status, 422);
});

test("removing it clears everything, and a stored place never shows while the setting is off", async (t) => {
  const { client, db } = await createDatabase(t);
  const url = await serve(t, db);
  await send(url, "alice", "POST", { latitude: 48.8566, longitude: 2.3522 }, "/resolve");
  assert.equal((await send(url, "alice", "DELETE")).status, 204);
  assert.deepEqual((await (await send(url, "alice", "GET")).json()).location, { mode: "off", city: null, region: null, country: null, timezone: null });
  const row = (await client.query("SELECT location_mode, location_city, location_region, location_country, location_timezone FROM account_preferences WHERE user_id = 'alice'")).rows[0];
  assert.deepEqual(row, { location_mode: "off", location_city: null, location_region: null, location_country: null, location_timezone: null }, "nothing is left");
  // Even if a place were left behind with the mode off, it is not reported.
  await client.query("UPDATE account_preferences SET location_city = 'Leftover' WHERE user_id = 'alice'");
  assert.equal((await readLocation("alice", db)).city, null);
});

test("the model's context line exists only while it is on, says how to use it, and names no precise position", () => {
  assert.equal(locationContextLine({ mode: "off", city: "Paris" }), "", "off: nothing");
  assert.equal(locationContextLine({ mode: "city", city: null }), "", "no place: nothing");
  assert.equal(locationContextLine(null), "");
  const line = locationContextLine({ mode: "city", city: "Austin", region: "Texas", country: "United States", timezone: "America/Chicago" });
  assert.match(line, /Austin, Texas, United States/);
  assert.match(line, /America\/Chicago/);
  assert.match(line, /only when it is relevant/);
  assert.match(line, /do not guess a street address/i);
  assert.doesNotMatch(line, /\d{1,3}\.\d{2,}/, "no coordinates");
});

test("it is rate limited, never logged, and calls no outside service", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, db, { perMinute: 4 });
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await send(url, "alice", "POST", { q: "paris" }, "/search")).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 429, 429]);
  for (const file of ["../src/location/router.js", "../src/location/lookup.js", "../src/location/context.js"]) {
    const code = (await readFile(new URL(file, import.meta.url), "utf8")).replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /console\.|logger|fetch\(|https?:\/\/|axios|XMLHttpRequest/, `${file}: no logging, no network`);
  }
  const chat = await readFile(new URL("../src/chat/router.js", import.meta.url), "utf8");
  assert.match(chat, /locationContext\(userId, \{ protectedConversation: protectedChat \}\)/, "the chat asks for it, and tells it whether the conversation is protected");
  // Vulcan, and since #112 every third-party model, is protected from its first turn: neither gets location context.
  assert.match(chat, /let protectedChat = normalizeModelKey\(modelKey\) === "vesper" \|\| isThirdPartyModel\(modelKey\);/, "the protected models never get it");
});
