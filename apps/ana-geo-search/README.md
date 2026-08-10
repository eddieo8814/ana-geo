# ana-geo-search

Spatial predicates over real OpenStreetMap features: **ask for what satisfies a set of geographic conditions, then change one condition by talking.**

> Screenshot: run the app and capture `http://localhost:8803` (placeholder — add after first run).

**Core question:** *What satisfies these spatial conditions?*

## Run

```bash
node server.js          # dashboard + state + chat bridge + Overpass proxy → http://localhost:8803
node relay.js           # inbound relay (separate process) — pushes chat to the ANA session
```

Requires **Node.js >= 20 LTS**. Zero npm dependencies (Leaflet and Turf.js are vendored). No Python.

To act as ANA, run a coding agent (e.g. Claude Code) in this directory; it receives user messages from `relay.js` output (or `data/inbox.log`), edits `state.json` / the app code, and replies with `POST /api/agent`.

Offline check of the spatial engine, without a server or network:

```bash
node tools/smoke_spatial.mjs
```

## Dependencies

- Node.js >= 20 LTS (global `fetch`)
- Leaflet 1.9.4 (vendored at `vendor/leaflet/`)
- Turf.js 7 (vendored at `vendor/turf/turf.min.js`) — version 7 specifically, for `pointToPolygonDistance`

## External data sources

- **Overpass API** (`overpass-api.de`) for OpenStreetMap features, reached only through the server's allowlist proxy — the browser never calls it directly. Each acquisition is recorded in `state.provenance`.
- OpenStreetMap raster tiles (basemap only; © OpenStreetMap contributors)
- Your own GeoJSON files, usable as a target or reference set

## Example prompts

```text
"Find cafes within 2 km of universities."
"Change that to 3 km."
"Also require them to be within 1 km of a subway station."
"Exclude places within 500 m of hospitals."
"Show the five nearest results."
"Which cafes are inside a 10-minute walk?"   ← evolution: ANA proposes a code change
```

The first five map onto the condition model directly; the last one asks for travel time, which this app cannot measure — so ANA proposes adding it (see `SPEC.md` §14).

## Current capabilities

Acquire any of eleven POI categories from Overpass inside the current map view, or load GeoJSON. Then combine spatial conditions over them — `within` a polygon, `within_distance`, `outside_distance`, `nearest` N — joined by AND or OR, evaluated in the browser with Turf.js. Results render as their own layer with the query's buffers drawn around the reference features, both independently toggleable. The active query and result count stay visible in the status bar, with a per-condition match breakdown beside the query.

Every condition field is editable on its own: changing 2 km to 3 km rewrites one number in `state.json`, not the query. The whole condition model is the PRD §17.4 JSON, so ANA edits it the same way you do.

Categories: cafe, restaurant, hospital, pharmacy, school, university, park, parking, charging station, bus station, subway station.

## Limitations

- **No multi-criteria scoring.** Conditions filter — a feature passes or it does not. There is no way to say "prefer closer to a university but weigh transit access twice as heavily", or to rank the survivors. That is the next app.
- Straight-line (great-circle) distance only — no travel time, no street network.
- Distances measure from a target's representative point (its centroid, for areas), so a very large target polygon is treated as a point.
- OSM relations become a single point at their bounding-box centre; their member geometry is not stitched.
- Results are capped at 2,000 features per layer (PRD §26.1); a truncated set is flagged in the panel and with a `+` in the status bar.
- The public Overpass endpoint is frequently busy and rejects broad queries; failures are reported in plain language, but the fix is usually to zoom in and retry.
- Analysis runs in the browser, so a 2,000 × 2,000 feature comparison is noticeably slow on a laptop.
- Approval cards render as plain feed messages in this first version.

## Next evolution

**`ana-geo-site`** — *"Where is the best location?"*

```text
Current:
ana-geo-search

Question:
"What satisfies these spatial conditions?"

Limitation:
Can filter by spatial conditions, but cannot weigh them against each other or rank what survives.

Next:
ana-geo-site

New capability:
Hard constraints plus weighted soft criteria, producing ranked, explainable candidate locations.
```
