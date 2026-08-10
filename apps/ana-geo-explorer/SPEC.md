# ANA Geo App Specification

## 1. Purpose

Extend the map with real-world geographic discovery: the user selects POI categories, searches the visible map bounds against OpenStreetMap through the Overpass API, and inspects the results — while ANA, living inside the runtime, can change the active categories, run a search, toggle layers, and evolve the app.

## 2. Core Geographic Question

**What is there?**

## 3. User Stories

- As a user, I tick one or more POI categories and press "Find in view" to see what exists in the area I am looking at.
- As a user, I see how many objects were found, per category and in total.
- As a user, I click a result and read its name, category, coordinates, OSM tags and source ID.
- As a user, I keep several category layers on the map at once and show/hide each one independently.
- As a user, I ask ANA "Find cafes around here." and the map fills in without me touching the panel or reloading.
- As a user, I ask for a capability the app lacks and ANA proposes a code change I can approve.

## 4. Watch Surface

Header + left panel (category checklist → "Find in view" → result-layer list with per-layer counts → selection detail) + map (primary context) + status bar (center, zoom, total visible result count, per-layer breakdown) — layout per PRD §10.2. Overpass failures, result-cap truncation, skipped geometries and empty results all render in the Watch surface (PRD §25), not only the console.

## 5. Converse Surface

Bottom chat bar wired per PRD §8.3: `POST /api/chat` → server inbox → `relay.js` (separate process) long-polls `/api/inbox-wait` and pushes messages to the ANA session; ANA replies via `POST /api/agent`, rendered in the feed.

## 6. Data Sources

- **OpenStreetMap via the Overpass API** (`https://overpass-api.de/api/interpreter`) — all POI data. Queried server-side only: the browser posts to `/api/proxy?url=…`, and `ALLOWED_HOSTS = ['overpass-api.de']` is the single enforcement point (PRD §8.4). Data © OpenStreetMap contributors, ODbL.
- OpenStreetMap raster tiles (basemap; browser-direct, exempt per PRD §8.4).

Overpass is a shared public instance with no SLA. One search issues **one** request for all selected categories (a merged union query) rather than one request per category.

## 7. Dependencies

- Node.js >= 20 LTS (global `fetch`) — no npm dependencies
- Leaflet 1.9.4, vendored at `vendor/leaflet/`
- No Python; no `requirements.txt` (PRD §30 item 13 not applicable)

OSM JSON → GeoJSON conversion is hand-written in `geo/overpass.js`; no conversion library is used.

## 8. Functional Requirements

PRD §16.4:

- **FR-EXP-001 — Viewport Search.** Search is bounded by the current Leaflet viewport (`map.getBounds()` → Overpass bbox).
- **FR-EXP-002 — Category Search.** OSM objects are searched by registry category; the active set lives in `state.search.categories`.
- **FR-EXP-003 — Result Layer.** Each category becomes its own GeoJSON map layer with its own colour.
- **FR-EXP-004 — Result Count.** Per-layer counts in the panel, total of visible layers in the status bar.
- **FR-EXP-005 — Object Detail.** Clicking a result shows name, category, coordinates, OSM tags and source ID.
- **FR-EXP-006 — Multiple Layers.** Several category layers may be visible at the same time.
- **FR-EXP-007 — Layer Toggle.** Each layer has an independent visibility checkbox, persisted as `layers[].visible`.
- **FR-EXP-008 — POI Preset Catalog.** `geo/registry.js` is the single canonical registry mapping every PRD §16.3 preset to its OSM tag filter; queries, state, feature `properties.category` and documentation all use its keys.

## 9. State Model

PRD §12 baseline plus one app block:

- `stateVersion` — server-owned monotonic counter (§8.2-1). A new search bumps each affected layer's `resultVersion`, and therefore `stateVersion` (§8.2-6).
- `map.view` — set by ANA/loaded state, applied by every client; `map.observedView` — this client's own viewport, written with a 300 ms trailing debounce and never applied by other clients (§12 rule 4).
- `search` — `categories` (active registry keys), `requestId` (bump to make clients run a viewport search), `lastRunAt`, `lastBbox` (`[w,s,e,n]`), `truncated`, `note`.
- `layers[]` — reference-only entries: `id` (`poi-<key>`), `type`, `label`, `category`, `source: "overpass"`, `visible`, `featureCount`, `resultRef`, `resultVersion`, `bbox`. **Feature bodies are never inlined** (§12 rule 3); a 2,000-feature result leaves `state.json` under ~2 KB.
- `selection` — the feature the user last clicked, so ANA can see what is being inspected.

## 10. Data Model

Feature bodies live at `data/results/poi-<key>.geojson`, served from `/api/results/poi-<key>` as a `FeatureCollection` (PRD §11.1). Every OSM element is normalized to a **Point**: nodes use `lat`/`lon`, ways and relations use the representative `center` returned by `out center`. Elements with no usable position, or matching no registry entry, are skipped and reported.

```json
{
  "type": "Feature",
  "id": "node/4696756887",
  "geometry": { "type": "Point", "coordinates": [127.3868884, 36.3484592] },
  "properties": {
    "name": "샤또브레드",
    "category": "cafe",
    "source": "osm",
    "sourceId": "node/4696756887",
    "score": null,
    "metrics": {},
    "fetchedAt": "2026-08-10T16:07:06.899Z",
    "tags": { "amenity": "cafe", "cuisine": "bread", "internet_access": "wlan" }
  }
}
```

Result cap: **2,000 features** per search across all selected categories (PRD §26.1), enforced both in the Overpass `out … 2000` clause and client-side; truncation is reported on the Watch surface.

## 11. Agent Actions

ANA operates by editing `state.json` through `PUT /api/state` (or directly on disk — the server bumps `stateVersion` on the next write) and replying via `POST /api/agent`:

- set `search.categories` and bump `search.requestId` → every connected client runs a viewport search and the new layers appear **without a reload** ("Find cafes around here.")
- toggle `layers[].visible` → "Hide cafes." / "Show only hospitals."
- remove a `layers[]` entry → the layer disappears from every client
- set `map.view` → all clients move before searching ("Find parks in Yuseong.")
- read `map.observedView` to know what the user is looking at (PRD §24.1), and `selection` to know what they clicked
- add a preset to `geo/registry.js` → a new category appears in the checklist (PRD §30 item 11)

## 12. Error Handling

Visible in the Watch surface (`#err`), per PRD §25:

- **external API unavailable** — Overpass 429 (rate limit), 504 (gateway timeout), proxy 502 (upstream failure), proxy 403 (host not allowlisted). Critically, Overpass also answers **HTTP 200 with an HTML error page** when it is busy, so the status code alone never decides success: `geo/overpass.js parseResponse()` requires the body to parse as JSON and reports a rate-limit hint when it does not.
- **empty search result** — "no objects of the selected categories in this viewport".
- **unsupported geometry** — elements with no node position and no `center` are counted and reported as skipped.
- **invalid GeoJSON** — `PUT /api/results/<id>` rejects anything that is not a `FeatureCollection` (400).
- **result truncation** — capped searches say how many features were dropped and suggest zooming in.
- state save failure, layer fetch failure and sync loss are surfaced the same way.

Not applicable to this app: Python worker failure, STAC search failure, raster asset unavailable, incompatible raster data.

## 13. Acceptance Criteria

Per PRD §16.6 — the app is complete when:

- OSM data can be retrieved through Overpass (FR-EXP-001, FR-EXP-002),
- at least ten POI types are supported by the category registry (FR-EXP-008),
- search respects the current viewport (FR-EXP-001),
- results are displayed as GeoJSON-compatible layers with a visible result count (FR-EXP-003, FR-EXP-004),
- result details are inspectable (FR-EXP-005),
- multiple category layers can be shown simultaneously and toggled (FR-EXP-006, FR-EXP-007),
- ANA can change the active categories in `state.json` and the map reflects the change without a reload (FR-EXP-002, FR-EXP-007),
- ANA can evolve the app, e.g. add a new POI category preset to the registry in code (§30, item 11).

## 14. Evolution Examples

Demonstration for PRD §30 item 11 — a README prompt asks for a capability the app does not have:

- **"Add convenience stores as a category."** → ANA proposes one new entry in `geo/registry.js` (`{ key: 'convenience', tags: { shop: 'convenience' }, … }`). Because the registry is the single source of truth (FR-EXP-008), the approved change puts a new checkbox in the panel and a new queryable category into the merged Overpass query with no other edit.
- **"Show me only the cafes that are within 300 m of a park."** → the app cannot evaluate spatial relationships; ANA proposes vendoring Turf.js and adding a predicate layer — which is the `ana-geo-search` step.

## 15. Next Evolution

`ana-geo-search` — "What is near what?": spatial predicates (distance, buffer, within, nearest) and multi-condition geographic search over the layers this app discovers.
