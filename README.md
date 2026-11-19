# Bedford part-time job map

A mobile-first, single-page map of part-time job prospects within 6 miles of
the Mercure Bedford Centre Hotel, Bedford. Static files only — no build
step, no npm, no framework beyond Leaflet.

## Open it locally

The page reads its data with `fetch()`, so it needs a local web server —
opening `index.html` straight from disk will not work. From this folder run:

```sh
python3 -m http.server 8765
```

then visit <http://127.0.0.1:8765/>.

## Data

The businesses are read from [`./businesses.json`](businesses.json), a plain
JSON array in this folder. Every distance is computed in the browser as the
crow flies from the centre point, and the search, distance, category and
travel-mode filters all run locally too. The page sets no cookies and
collects no analytics.

- **Centre point:** Mercure Bedford Centre Hotel, 2 St Marys Street, Bedford
  MK42 0AR — GPS 52.133977, -0.465752, from the
  [official Accor hotel page](https://all.accor.com/hotel/B541/index.en.shtml).
- **Distances** are great-circle ("as the crow flies") and approximate, so
  check opening hours and vacancies before travelling. The vacancy
  information is a snapshot and can change at any time.
- **No personal data** about any jobseeker is included — the page carries
  only public business details.

## External loads

[Leaflet 1.9.4](https://leafletjs.com/) and
[Leaflet.markercluster 1.5.3](https://github.com/Leaflet/Leaflet.markercluster)
load from the jsDelivr CDN, and the map tiles come from
[OpenStreetMap](https://www.openstreetmap.org/copyright) — so viewing the
page needs an internet connection, and the
[OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
applies to the tile traffic. Everything else lives in this folder.

## Files

| File | What it is |
|---|---|
| `index.html` | The page shell: header, map, filters, business list. |
| `app.js` | All logic: data loading, distances, filters, pagination, markers. |
| `styles.css` | Mobile-first styles. |
| `businesses.json` | The business records the page reads. |
