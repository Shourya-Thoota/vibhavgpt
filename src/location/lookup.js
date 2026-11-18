import { readFileSync } from "node:fs";

// A local lookup of places, from GeoNames (CC BY 4.0, see THIRD_PARTY_NOTICES.md): cities of more than 15,000 people, with country,
// region and timezone. Nothing here calls another service: a typed city is matched against this list, and a device position is
// turned into the nearest place on this list. The list is read once, the first time it is needed.

const FILE = new URL("./cities.tsv", import.meta.url);
let places = null;

function load() {
  if (places) return places;
  places = readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((line) => {
    const [id, name, ascii, lat, lng, countryCode, country, region, timezone, population] = line.split("\t");
    return { id, name, ascii, lat: Number(lat), lng: Number(lng), countryCode, country, region, timezone, population: Number(population), key: fold(name), altKey: fold(ascii) };
  });
  return places;
}

// "São Paulo", "sao paulo" and "SAO  PAULO" are the same place.
export function fold(text) {
  return String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export const publicPlace = (place) => ({ id: place.id, city: place.name, region: place.region || null, country: place.country, timezone: place.timezone });
export const placeById = (id) => load().find((place) => place.id === String(id)) ?? null;
export const placeCount = () => load().length;

export const SEARCH_MAX_LENGTH = 80;

// Matches a typed place such as "Austin", "austin, texas" or "paris france". The first words name the city; anything after a comma
// (or the rest of the words) narrows by region or country. Whole-name matches rank first, then names that start with the text,
// then by population, so "Paris" is Paris, France before a small town of the same name.
export function searchPlaces(query, limit = 6) {
  const text = String(query ?? "").slice(0, SEARCH_MAX_LENGTH);
  const parts = text.split(",").map(fold).filter(Boolean);
  if (!parts.length || parts[0].length < 2) return [];
  const [cityPart, ...narrow] = parts;
  const words = cityPart.split(" ");
  const scored = [];
  for (const place of load()) {
    let score = 0;
    const is = (key) => key === cityPart; const starts = (key) => key.startsWith(cityPart);
    if (is(place.key) || is(place.altKey)) score = 3;
    else if (starts(place.key) || starts(place.altKey)) score = 2;
    else {
      // "austin texas" with no comma: the city is the leading words, the rest narrows.
      const lead = words.slice(0, Math.max(1, words.length - 1)).join(" ");
      if (words.length > 1 && (place.key === lead || place.altKey === lead || place.key.startsWith(lead) || place.altKey.startsWith(lead)) && narrow.length === 0) {
        const rest = words.slice(lead.split(" ").length).join(" ");
        if (rest && (fold(place.region).includes(rest) || fold(place.country).includes(rest) || place.countryCode.toLowerCase() === rest)) score = (place.key === lead || place.altKey === lead) ? 3 : 2;
      }
    }
    if (!score) continue;
    if (narrow.length) {
      const wanted = narrow.join(" ");
      const where = `${fold(place.region)} ${fold(place.country)} ${place.countryCode.toLowerCase()}`;
      if (!wanted.split(" ").every((word) => where.includes(word))) continue;
    }
    scored.push({ place, score });
  }
  scored.sort((a, b) => b.score - a.score || b.place.population - a.place.population);
  return scored.slice(0, Math.min(Math.max(limit, 1), 10)).map((entry) => entry.place);
}

const RADIANS = Math.PI / 180;
function distanceKm(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * RADIANS;
  const dLng = (lng2 - lng1) * RADIANS;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RADIANS) * Math.cos(lat2 * RADIANS) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const CITY_RADIUS_KM = 15;

// The place a position is in, to city level. Big cities are listed with their districts (Paris has an entry for each arrondissement),
// so the nearest entry can be a district. Instead, among places within 15 km the biggest is taken, which is the city; failing that,
// the nearest within 250 km (a village or a remote area). Null when nothing is that close (open ocean). The position is used for
// this one calculation and is not kept.
export function nearestPlace(latitude, longitude, withinKm = 250) {
  const lat = Number(latitude); const lng = Number(longitude);
  if (latitude === null || longitude === null || typeof latitude === "boolean" || typeof longitude === "boolean") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  let nearest = null; let nearestDistance = Infinity;
  let biggest = null;
  for (const place of load()) {
    const d = distanceKm(lat, lng, place.lat, place.lng);
    if (d < nearestDistance) { nearest = place; nearestDistance = d; }
    if (d <= CITY_RADIUS_KM && (!biggest || place.population > biggest.population)) biggest = place;
  }
  if (biggest) return biggest;
  return nearestDistance <= withinKm ? nearest : null;
}
