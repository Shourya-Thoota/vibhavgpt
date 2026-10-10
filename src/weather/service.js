import { config } from "../config.js";

const WEATHER_WORDS = /\b(?:weather|forecast|temperature|rain|snow|wind|humidity|conditions?)\b/i;
const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
]);

export function isWeatherRequest(text) {
  return WEATHER_WORDS.test(String(text ?? ""));
}

export function weatherLocationFromText(text) {
  const value = String(text ?? "").trim();
  const match = value.match(/\b(?:in|for|at|near)\s+([A-Za-z][A-Za-z .,'-]{1,80}?)(?:\s+(?:today|tomorrow|right now|now|this week)\b|[?.!,]|$)/i);
  return (match?.[1] ?? "").replace(/\s+/g, " ").trim();
}

function weatherQueryVariants(place) {
  const normalized = place.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim();
  const variants = [normalized];
  const stateMatch = normalized.match(/^(.+?)(?:,?\s+)([A-Za-z]{2})$/);
  if (stateMatch && US_STATE_CODES.has(stateMatch[2].toUpperCase())) {
    variants.push(`${stateMatch[1].trim()},US`);
  }
  return [...new Set(variants.filter(Boolean))];
}

export async function getWeather(location, { fetchImpl = fetch, apiKey = config.weatherApiKey } = {}) {
  if (!apiKey || !config.weatherApiUrl) throw Object.assign(new Error("Weather is not configured yet."), { code: "weather-not-configured", status: 503 });
  const place = String(location ?? "").trim();
  if (!place) throw Object.assign(new Error("Tell me which city or location to check."), { code: "weather-location-required", status: 400 });
  let response;
  let data;
  for (const query of weatherQueryVariants(place)) {
    const params = new URLSearchParams({ q: query, appid: apiKey, units: "metric" });
    response = await fetchImpl(`${config.weatherApiUrl}?${params}`, { signal: AbortSignal.timeout(10_000) });
    data = await response.json().catch(() => ({}));
    if (response.ok || response.status !== 404) break;
  }
  if (!response?.ok) throw Object.assign(new Error(data?.message || "Weather is temporarily unavailable."), { code: "weather-unavailable", status: response?.status === 404 ? 404 : 502 });
  return {
    location: `${data.name}${data.sys?.country ? `, ${data.sys.country}` : ""}`,
    observedAt: data.dt ? new Date(data.dt * 1000).toISOString() : null,
    temperatureC: data.main?.temp,
    feelsLikeC: data.main?.feels_like,
    humidity: data.main?.humidity,
    windMps: data.wind?.speed,
    conditions: data.weather?.[0]?.description ?? null,
    source: config.weatherSourceName,
  };
}

export function weatherContext(weather) {
  return `\n\n<TrustedWeatherObservation>\n${JSON.stringify(weather)}\n</TrustedWeatherObservation>\nUse this observation for the answer. State the location and observation time; do not invent missing weather details.`;
}
