# ANA Geo App Specification

## 1. Purpose

The first Agent-Native GIS stage that performs explicit spatial analysis: acquire target and reference features, express spatial conditions over them, and edit any single condition by conversation without rewriting the query.

## 2. Core Geographic Question

**What satisfies these spatial conditions?**

## 3. User Stories

- As a user, I acquire a POI category from Overpass inside my current map view and see it as a layer.
- As a user, I ask for "cafes within 2 km of universities" and see the matching cafes as their own layer, with the 2 km buffers drawn around the universities.
- As a user, I say "Change that to 3 km." and only that distance changes — the rest of the query stays as it was.
- As a user, I add a second condition ("also within 1 km of a subway station") and switch between AND and OR.
- As a user, I always see the active query and the result count without opening a panel.
- As a user, I ask for a capability the app lacks and ANA proposes a code change I can approve.

## 4. Watch Surface

Header + left panel (feature acquisition, editable query, layer list) + map (primary context) + status bar — layout per PRD §10.2. The status bar always shows the current condition summary and result count (PRD §23.2), and the query panel shows a per-condition match breakdown (PRD §23.3). Errors render in the Watch surface (PRD §25), not only the console.

Layer colours encode role: grey = acquired target features, amber = features referenced by a condition, green = search results, dashed blue = condition buffers. The buffer layer toggles independently of the result layer (FR-SEARCH-009).

## 5. Converse Surface

Bottom chat bar wired per PRD §8.3: `POST /api/chat` → server inbox → `relay.js` (separate process) long-polls `/api/inbox-wait` and pushes messages to the ANA session; ANA replies via `POST /api/agent`, rendered in the feed.

## 6. Data Sources

- OpenStreetMap via the Overpass API (`overpass-api.de`), reached only through the server proxy (PRD §8.4); the browser never calls it directly.
- User-provided GeoJSON files, usable as target or reference sets.
- OpenStreetMap raster tiles (basemap; browser-direct, exempt per PRD §8.4).

Every acquisition appends a provenance record (`operation`, `timestamp`, `source`, `query`, `bbox`, `resultCount`) to `state.provenance` per PRD §24.4 and §28.

## 7. Dependencies

- Node.js >= 20 LTS (global `fetch`) — no npm dependencies, no Python
- Leaflet 1.9.4, vendored at `vendor/leaflet/`
- Turf.js 7, vendored at `vendor/turf/turf.min.js` (PRD §14, §17.2). Version 7 is required for `pointToPolygonDistance`, which measures to a polygon's edge rather than its centroid.

## 8. Functional Requirements

PRD §17.3:

- **FR-SEARCH-001** — Distance between spatial objects. `geo/spatial.js: distanceBetween`, dispatching by reference geometry (point → `turf.distance`, line → `turf.pointToLineDistance`, polygon → `turf.pointToPolygonDistance`).
- **FR-SEARCH-002** — Buffer around point, line, or polygon objects, in metres or kilometres. `geo/spatial.js: buffer` / `bufferAll`.
- **FR-SEARCH-003** — Features inside a polygon. `geo/spatial.js: within`.
- **FR-SEARCH-004** — Features within a distance of a reference feature. `geo/spatial.js: withinDistance`.
- **FR-SEARCH-005** — Features farther than a distance. `geo/spatial.js: outsideDistance`.
- **FR-SEARCH-006** — Nearest N features. `geo/spatial.js: nearest`.
- **FR-SEARCH-007** — Multi-condition AND. `geo/spatial.js: evaluate`, set intersection over per-condition matches.
- **FR-SEARCH-008** — Multi-condition OR. Same entry point, set union.
- **FR-SEARCH-009** — Results rendered as a distinct layer, with the query's buffers visible. `search-results` and `search-buffers` layers, independently toggleable.
- **FR-SEARCH-010** — A single condition (relation, reference, distance, or unit) editable without rewriting the query. `PATCH /api/analysis/conditions/<index>`.
- **FR-SEARCH-011** — Target and reference features acquired by registry category from Overpass within the analysis area, or loaded from GeoJSON. `geo/registry.js` + `geo/overpass.js`.

## 9. State Model

PRD §12 baseline — `stateVersion` (server-owned monotonic counter), `map.view` / `map.observedView` (two-key viewport semantics, §12 rule 4), `markers`, `layers`, `selection`, `analysis` — plus a top-level `provenance` array (§28).

`analysis` holds the condition model of PRD §17.4 verbatim:

```json
{
  "target": "cafe",
  "operator": "AND",
  "conditions": [
    { "relation": "within_distance", "reference": "university", "distance": 2000, "unit": "m" },
    { "relation": "within_distance", "reference": "subway_station", "distance": 1000, "unit": "m" }
  ]
}
```

`relation` is one of `within`, `within_distance`, `outside_distance`, `nearest`. `distance`/`unit` apply to the two distance relations; `nearest` carries `count` instead — the only addition to §17.4, needed for FR-SEARCH-006, and the four §17.4 keys keep their meanings unchanged.

`target` and `reference` are feature-set keys: a category key from `geo/registry.js`, or the key of an uploaded GeoJSON set (`upload_<name>`).

Layer entries hold references only (`resultRef`, `resultVersion`, `featureCount`, `bbox`) — feature bodies are never inlined (§12 rule 3). Each entry adds a `key` (the feature-set name conditions refer to) and a `role` (`features` / `result` / `buffer`). The `search-results` entry also carries `summary` and a per-condition `explain` array — counts only, not geometry — to keep the result explainable (§23.3) without inflating the state file.

## 10. Data Model

Acquired and derived feature sets are stored server-side at `data/results/<id>.geojson` and served from `/api/results/<id>`. All are GeoJSON `FeatureCollection`s using the §11.1 property model (`name`, `category`, `source`, `sourceId`, `score`, `metrics`, `fetchedAt`, plus raw OSM `tags`).

OSM elements normalize as: node → `Point`; closed way → `Polygon`; open way → `LineString`; relation → `Point` at its bounds centre. Result features carry a `metrics` entry per satisfied condition (`"within_distance:university": 1430.2`) in the condition's own unit.

Distances measure from a target's representative point (its own coordinates, or its centroid for lines and areas) to the reference feature's nearest geometry.

## 11. Agent Actions

ANA operates by editing state and replying via `POST /api/agent`:

- `PATCH /api/analysis/conditions/<i>` with `{"distance": 3, "unit": "km"}` → "Change that to 3 km." touches one condition (FR-SEARCH-010)
- `POST /api/analysis/conditions` → "Also require them to be within 1 km of a subway station." (FR-SEARCH-007)
- `DELETE /api/analysis/conditions/<i>` → drop a constraint
- `PATCH /api/analysis` with `{"operator": "OR"}` or `{"target": "restaurant"}` (FR-SEARCH-008)
- `PUT /api/state` for anything else (`map.view` to move every client, `layers[].visible` to toggle)
- read `map.observedView` to know what the user is looking at (PRD §24.1), and `state.provenance` to see what was fetched
- modify app code itself on request (proposal → approval, PRD §24.3)

Every one of these bumps `stateVersion`, so connected clients re-render within one 2.5 s poll without a reload.

## 12. Error Handling

Visible in the Watch surface (`#err`), per PRD §25:

- **External API unavailable** — Overpass failures are classified from the body, never from the status code alone, because Overpass reports failure in three shapes that look different from the outside: HTTP 200 with an HTML or truncated body, HTTP 504, and HTTP 502/503. `geo/overpass.js: classify` parses the body first (so a cafe named "Timeout Coffee" is not mistaken for a timeout), inspects a JSON `remark` for an aborted run, and only then falls back to text and status heuristics.
- **Empty search result** — "no features satisfied the conditions." after a run; "no cafes found in the current view" after an acquisition.
- **Invalid GeoJSON** — not parseable, or not a `FeatureCollection`.
- **Invalid spatial condition** — unknown relation, unsupported unit, negative distance, or an unknown field, rejected with HTTP 400 by the server and by `evaluate` in the browser; `within` against a reference set with no polygons is rejected by name.
- **Unsupported geometry** — an unhandled geometry type names itself in the message.
- **Missing features** — running a query before acquiring its target or reference sets names the missing keys.
- Server: 403 for non-allowlisted proxy hosts and path traversal, 404 for unknown results and condition indices, 400 for malformed bodies.

Python worker failure, STAC search failure, and raster errors do not apply — this app runs no Python and reads no rasters (PRD §8.5).

## 13. Acceptance Criteria

Per PRD §17.7 — the app is complete when:

- target and reference features can be acquired by registry category or loaded from GeoJSON (FR-SEARCH-011),
- Turf.js-based spatial operations work (FR-SEARCH-001–FR-SEARCH-006),
- buffers are visible on the map (FR-SEARCH-002, FR-SEARCH-009),
- multi-condition AND/OR queries can be represented in state (FR-SEARCH-007, FR-SEARCH-008),
- a single condition can be edited without rewriting the entire query (FR-SEARCH-010),
- results are rendered as a distinct layer (FR-SEARCH-009),
- ANA can modify the condition model in `state.json` and results update accordingly (FR-SEARCH-007, FR-SEARCH-008, FR-SEARCH-010),
- ANA can evolve the app, e.g. add a spatial relation not covered by FR-SEARCH-001–008 (§30, item 11).

`node tools/smoke_spatial.mjs` checks FR-SEARCH-001–009 and FR-SEARCH-011 offline, cross-checking every Turf distance against an independent haversine implementation.

## 14. Evolution Examples

Demonstrates PRD §30 item 11 — the README prompt *"Which cafes are inside a 10-minute walk?"* asks for a capability this app does not have (it measures straight-line distance, not travel time). ANA proposes adding an isochrone-based relation, and on approval the new relation joins `RELATIONS` in `geo/spatial.js`, becomes selectable in every condition row, and is usable in the running app on the next reload.

Other evolutions in the same shape:

- "Find cafes that share a block with a park." → ANA proposes a `touches` relation wrapping `turf.booleanTouches`.
- "Rank the results instead of just filtering them." → ANA proposes a scoring pass, which is the step `ana-geo-site` generalizes.

## 15. Next Evolution

`ana-geo-site` — "Where is the best location?": hard constraints plus weighted soft criteria over the same acquired features, turning a pass/fail filter into a ranked score.
