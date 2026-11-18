# Third-party notices

Notices for data and assets that ship with VibhavGPT but are not VibhavGPT's own. (The licences of the two supplied homepage
components are kept next to them, in `frontend/src/components/ui/LICENSES.md`.)

## Place data: GeoNames

`src/location/cities.tsv` is built from the GeoNames "cities15000" place list, the country list and the first-level administrative
names, from https://download.geonames.org/export/dump/. It is used only for the optional Location setting, entirely on VibhavGPT's own
servers: no request goes to GeoNames or any other service when a place is looked up.

GeoNames data is licensed under the Creative Commons Attribution 4.0 International licence
(https://creativecommons.org/licenses/by/4.0/). Source: https://www.geonames.org/. The file was reduced to the columns the lookup
needs (id, name, ASCII name, latitude and longitude rounded to three decimals, country, region, timezone, population); it is rebuilt
with `scripts/build-location-data.mjs`.

## Planet photographs

`frontend/public/planets/earth-sphere.webp` is cropped from "The Blue Marble" taken by the Apollo 17 crew
(NASA/Apollo 17 crew; taken by either Harrison Schmitt or Ron Evans), 1972, via Wikimedia Commons
(https://commons.wikimedia.org/wiki/File:The_Earth_seen_from_Apollo_17.jpg). Wikimedia Commons lists it as public domain
(a work of NASA); the credit is kept here out of courtesy.

`frontend/public/planets/jupiter-sphere.webp` is cropped from "Jupiter and its shrunken Great Red Spot", Hubble Space Telescope, 2014
(NASA, ESA, and A. Simon, Goddard Space Flight Center), via Wikimedia Commons
(https://commons.wikimedia.org/wiki/File:Jupiter_and_its_shrunken_Great_Red_Spot.jpg), listed there as public domain. ESA/Hubble also
publishes this image under Creative Commons Attribution 4.0 (https://www.spacetelescope.org/images/heic1410a/), so the full credit
"NASA, ESA, and A. Simon (Goddard Space Flight Center)" is kept here to satisfy either.

Both were cut to a circle and resized to 512 px; nothing else was changed. The shading on the page is painted in CSS.
