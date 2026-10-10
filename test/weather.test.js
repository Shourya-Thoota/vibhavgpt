import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config.js";
import { getWeather, isWeatherRequest, weatherContext, weatherLocationFromText } from "../src/weather/service.js";

test("weather requests resolve a location without generic web search", () => {
  assert.equal(isWeatherRequest("What's the weather in Buffalo right now?"), true);
  assert.equal(weatherLocationFromText("What's the weather in Buffalo right now?"), "Buffalo");
});

test("weather tool normalizes the trusted provider response", async () => {
  const result = await getWeather("Buffalo", {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ name: "Buffalo", sys: { country: "US" }, dt: 1_700_000_000, main: { temp: 12, feels_like: 10, humidity: 60 }, wind: { speed: 3 }, weather: [{ description: "clear sky" }] }),
    }),
    apiKey: "test-key",
  });
  assert.deepEqual(result, { location: "Buffalo, US", observedAt: "2023-11-14T22:13:20.000Z", temperatureC: 12, feelsLikeC: 10, humidity: 60, windMps: 3, conditions: "clear sky", source: config.weatherSourceName });
  assert.match(weatherContext(result), /TrustedWeatherObservation/);
});

test("weather retries a U.S. state suffix when the provider rejects the raw city string", async () => {
  const queries = [];
  const result = await getWeather("Buffalo NY", {
    fetchImpl: async (url) => {
      queries.push(new URL(url).searchParams.get("q"));
      if (queries.length === 1) return { ok: false, status: 404, json: async () => ({ message: "city not found" }) };
      return { ok: true, json: async () => ({ name: "Buffalo", sys: { country: "US" }, main: { temp: 20 }, weather: [{ description: "clear sky" }] }) };
    },
    apiKey: "test-key",
  });
  assert.deepEqual(queries, ["Buffalo NY", "Buffalo,US"]);
  assert.equal(result.location, "Buffalo, US");
});
