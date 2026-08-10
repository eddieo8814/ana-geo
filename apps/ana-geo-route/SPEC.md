# ANA Geo App Specification

## 1. Purpose

Introduce graph and network GIS to the ANA Geo series: the first app whose analysis does not run in the browser but in a Python worker (PRD §8.5) driving OSMnx and NetworkX over a real OpenStreetMap road network.

## 2. Core Geographic Question

**How are places connected?**

## 3. User Stories

- As a user, I click the map twice to set an origin and a destination, and get a route drawn on the road network.
- As a user, I switch between driving, walking and cycling and see the route and the summary change.
- As a user, I ask for the shortest route or the fastest one and can see both numbers side by side.
- As a user, I load a category of destinations (hospitals, cafes…) and learn which one I can reach fastest — by network cost, not by straight-line distance.
- As a user, I see the area I can reach in 5, 10 and 20 minutes, clearly labelled as an approximation.
- As a user, when my request is too big to compute, I am told the requested area and the cap instead of receiving a quietly clipped answer.
- As a user, I ask ANA in plain language ("Use walking instead.") and the analysis re-runs on every connected device.

## 4. Watch Surface

Header (with live Python worker status) + analysis panel (left) + map (primary context) + status bar (center, zoom, route summary, busy indicator) — layout per PRD §10.2.

The panel shows origin/destination, mode, optimisation objective, route summary, candidate ranking, isochrone bands, the loaded network (area, node/edge counts, cache hit, speed model) and the analysis bounds. Errors render in the Watch surface (PRD §25): transient ones in the message line, and the last worker failure as a persistent card carrying its code, message and — for an area-cap rejection — the requested area against the cap.

## 5. Converse Surface

Bottom chat bar wired per PRD §8.3: `POST /api/chat` → server inbox → `relay.js` (separate process) long-polls `/api/inbox-wait` and pushes messages to the ANA session; ANA replies via `POST /api/agent`, rendered in the feed.

**Python worker contract (PRD §8.5).** `server.js` spawns one short-lived process per request — `.venv/bin/python` when the local venv exists, otherwise `python3` — writes `{op, params}` to stdin and reads `{ok, result, error}` from stdout, with a 60 s timeout; stderr is treated as logs only. PRD §8.1 suggests one file per op (`tools/<op>.py`); this app ships a single `tools/worker.py` with an op table (`route`, `nearest`, `isochrone`, plus `capabilities`/`echo`/`boom`/`sleep` for probes and tests) because all three ops share the same network-acquisition path. The wire contract is unchanged. Spawn failure, non-zero exit, unparseable stdout and timeout are all normalised to the error code `python_worker_failure` and propagated as HTTP 502; worker-reported failures keep their own codes and return 422.

## 6. Data Sources

- OpenStreetMap road networks via the Overpass API, downloaded by OSMnx inside the Python worker (direct HTTPS, restricted to the same allowlist — PRD §8.4)
- OpenStreetMap POIs via Overpass through the server proxy, for candidate destinations (FR-ROUTE-008)
- OpenStreetMap raster tiles (basemap; browser-direct, exempt per PRD §8.4)

`ALLOWED_HOSTS = ['overpass-api.de']` is declared once in `server.js` and passed to every worker call as `params.allowedHosts`, where the worker re-checks it against `osmnx.settings.overpass_url` before any download. One constant, two enforcement points.

## 7. Dependencies

- Node.js >= 20 LTS (global `fetch`) — no npm dependencies
- Python >= 3.10 with `requirements.txt`: `osmnx>=2.0`, `networkx>=3.0`, `geopandas>=1.0`
- Leaflet 1.9.4, vendored at `vendor/leaflet/`

## 8. Functional Requirements

PRD §19.4: FR-ROUTE-001 (origin), FR-ROUTE-002 (destination), FR-ROUTE-003 (drive/walk/bike), FR-ROUTE-004 (shortest distance), FR-ROUTE-005 (shortest time), FR-ROUTE-006 (GeoJSON `LineString` geometry), FR-ROUTE-007 (distance/time/mode summary), FR-ROUTE-008 (nearest destination by network cost), FR-ROUTE-009 (5/10/20-minute isochrones), FR-ROUTE-010 (bounded, cached network acquisition).

## 9. State Model

PRD §12 baseline (`stateVersion`, `map.view` / `map.observedView`, `markers`, `layers`, `selection`) plus an `analysis` object owning the routing question:

```json
{ "mode": "drive", "optimize": "time", "origin": null, "destination": null,
  "areaCapKm2": 100, "paddingKm": 2, "isochroneMinutes": [5, 10, 20],
  "candidateCategory": "hospital", "candidateRadiusKm": 2.5,
  "route": null, "ranking": null, "isochrone": null, "network": null, "lastError": null }
```

Every field here is a routing assumption ANA can edit (FR-ROUTE-003, FR-ROUTE-010). `route`, `ranking` and `isochrone` hold summaries only — the geometry lives behind `resultRef` (§12 rule 3), which keeps the state file a few kilobytes with three result layers loaded.

## 10. Data Model

Results are `FeatureCollection`s at `data/results/<id>.geojson`, served from `/api/results/<id>`, using the §11.1 common property model:

- `route` — one `LineString` feature; `properties.metrics` carries `distanceMeters`, `travelTimeSeconds`, `optimizedFor`.
- `isochrone` — one `Polygon` per band; properties carry `minutes`, `nodeCount`, `areaKm2`, `approximate: true` and `method`.
- `candidates` — the fetched POIs; after a ranking run the server folds `rank` and the network costs back into each feature so the map can label them.

Road networks are cached as GraphML at `data/cache/<network_type>_<speed model version>_<rounded bbox>.graphml` (FR-ROUTE-010).

## 11. Agent Actions

- `PATCH /api/analysis` — incremental edits (§24.2): mode, optimisation objective, origin/destination, `areaCapKm2`, `paddingKm`, `isochroneMinutes`, candidate category and radius.
- `POST /api/route` / `/api/nearest` / `/api/isochrone` — run an analysis; the server writes the result layer and the state summary.
- `POST /api/worker` — the raw §8.5 envelope passthrough, for probing the worker directly.
- `GET /api/worker/status` — Python version and installed dependency versions.
- `POST /api/layers`, `PATCH /api/layers/<id>` — register a layer, toggle visibility.
- `PUT /api/state`, `POST /api/agent`, `POST /api/provenance` — as in the sibling apps.
- Read `map.observedView` to know what the user is looking at (§24.1); modify app code on request (proposal → approval, §24.3).

## 12. Error Handling

Visible in the Watch surface, and persisted to `analysis.lastError` so a failure survives a page refresh:

| Condition | Code | HTTP |
| --- | --- | --- |
| Padded bbox over the area cap | `area_cap_exceeded` (with requested area, cap, dimensions) | 422 |
| No path between the points | `no_route` | 422 |
| Origin and destination snap to one intersection | `degenerate_route` | 422 |
| No road network in the area | `empty_network` | 422 |
| Bad mode / missing point / bad `rankBy` | `bad_params` | 422 |
| No candidate destinations loaded, or none routable | `no_candidates` | 400 / 422 |
| Worker spawn failure, non-zero exit, bad stdout, 60 s timeout | `python_worker_failure` | 502 |
| osmnx/networkx not installed | `missing_dependency` | 502 |
| osmnx pointed at a non-allowlisted host | `host_not_allowlisted` | 502 |
| Unhandled worker exception | `worker_exception` (stack trace attached as a log) | 502 |

Overpass failures during candidate acquisition are classified client-side (timeout, rate limit, unavailable, HTML error page served as HTTP 200) and reported with their kind. Empty candidate results are stated, not shown as an empty map.

## 13. Acceptance Criteria

Per PRD §19.7 — the app is complete when:

- OSM road networks can be loaded within the bounded analysis area, cached by (bbox, network type), and an over-cap request is refused with its numbers rather than truncated (FR-ROUTE-010),
- route origin and destination are selectable by map click and editable by ANA (FR-ROUTE-001, FR-ROUTE-002),
- driving, walking and cycling modes are selectable (FR-ROUTE-003),
- shortest-distance routes can be calculated, and shortest-time routes where edge data supports it — both are computed and reported together (FR-ROUTE-004, FR-ROUTE-005),
- route geometry is displayed as a GeoJSON `LineString` (FR-ROUTE-006),
- distance, time and mode summaries are shown, with the provenance of the travel-time estimate (FR-ROUTE-007),
- candidate destinations can be ranked by network cost, with unreachable candidates reported rather than dropped (FR-ROUTE-008),
- isochrones for 5, 10 and 20 minutes can be generated and are labelled approximate (FR-ROUTE-009),
- ANA can modify network assumptions — mode, bounds, cost objective — in `state.json` (FR-ROUTE-003, FR-ROUTE-010),
- the Python worker contract holds: a normal op, an unknown op, a crash and a timeout all return well-formed envelopes, and failures reach the Watch surface (§30 item 12, §8.5, §25),
- ANA can evolve the app, e.g. add an "avoid this road" constraint in code (§30 item 11).

Verified by `tools/smoke_worker.py` (66 offline checks: bbox and area cap, hull geometry, both routing objectives, ranking, isochrone reach, envelope handling) and `tools/smoke_envelope.js` (8 checks of the §8.5 round trip through the real worker process).

## 14. Evolution Examples

- **"Avoid this road."** → ANA proposes an edge filter in `tools/worker.py`: a `avoidEdges` param carrying OSM way ids, removed from the graph copy before `shortest_path`, plus a map click that adds the clicked way to `analysis.avoid`. Approved change is live on the next request — the worker is spawned per call, so no restart is needed (§30 item 11).
- **"Raise the area cap to 300 km²."** → no code change at all: `PATCH /api/analysis {"areaCapKm2": 300}`, which is why the cap is a state field rather than a constant.
- **"Show the isochrone as the actual reachable streets, not a hull."** → ANA proposes replacing the convex hull with a buffer of the reachable edges via GeoPandas, upgrading FR-ROUTE-009 from approximate to edge-accurate.

## 15. Next Evolution

`ana-geo-satellite` — *"What does it look like from above, and when?"* Moves from vector networks to Earth observation: STAC search over Sentinel-2, scene footprints, cloud-cover filtering and time selection.
