// Builds src/location/cities.tsv from GeoNames' public dump files. Run by hand when the data is refreshed; the result is committed.
//
//   node scripts/build-location-data.mjs <folder holding cities15000.txt, countryInfo.txt and admin1CodesASCII.txt>
//
// Source: GeoNames (https://www.geonames.org/), "cities15000" (places with more than 15,000 people), the country list and the
// first-level administrative names. Licensed under Creative Commons Attribution 4.0 (https://creativecommons.org/licenses/by/4.0/).
// The attribution is kept in THIRD_PARTY_NOTICES.md and shown beside the Location setting.
//
// Output: one tab-separated line per place, in this order:
//   id  name  asciiName  latitude  longitude  countryCode  countryName  regionName  timezone  population
import fs from "node:fs";
import path from "node:path";

const folder = path.resolve(process.argv[2] ?? ".");
const read = (name) => fs.readFileSync(path.join(folder, name), "utf8").split(/\r?\n/);

const countries = new Map();
for (const line of read("countryInfo.txt")) {
  if (!line || line.startsWith("#")) continue;
  const cols = line.split("\t");
  countries.set(cols[0], cols[4]);
}
const regions = new Map();
for (const line of read("admin1CodesASCII.txt")) {
  if (!line) continue;
  const [code, , ascii] = line.split("\t");
  regions.set(code, ascii);
}

const rows = [];
for (const line of read("cities15000.txt")) {
  if (!line) continue;
  const c = line.split("\t");
  const [id, name, ascii, , lat, lng, , featureCode, cc, , admin1, , , , population, , , timezone] = c;
  if (!id || !name || !timezone || !cc) continue;
  // PPLX is a district or section of a larger place (such as a Paris arrondissement). The city itself is what a person means.
  if (featureCode === "PPLX") continue;
  const clean = (value) => String(value).replace(/[\t\r\n]+/g, " ").trim();
  rows.push([id, clean(name), clean(ascii), Number(lat).toFixed(3), Number(lng).toFixed(3), cc, clean(countries.get(cc) ?? cc), clean(regions.get(`${cc}.${admin1}`) ?? ""), timezone, Number(population) || 0].join("\t"));
}
const out = path.resolve("src/location/cities.tsv");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, rows.join("\n") + "\n");
console.log(`${rows.length} places, ${(fs.statSync(out).size / 1048576).toFixed(2)} MB -> ${out}`);
