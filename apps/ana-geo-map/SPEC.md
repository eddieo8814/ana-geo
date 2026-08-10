# ANA Geo App Specification

## 1. Purpose

The smallest Agent-Native GIS application: an interactive map the user operates by watching and by conversing with ANA, which lives inside the runtime and can evolve the app.

## 2. Core Geographic Question

**Where is it?**

## 3. User Stories

- As a user, I pan/zoom a map and always see where I am (center, zoom).
- As a user, I click the map to drop markers that survive a refresh and appear on my other devices.
- As a user, I load a GeoJSON file and see it on the map, fitted to bounds.
- As a user, I ask ANA in plain language ("Move the map to Daejeon.") and the map obeys on every connected device.
- As a user, I ask for a capability the app lacks and ANA proposes a code change I can approve.

## 4. Watch Surface

Header + layer panel (left) + map (primary context) + status bar (center coordinates, zoom) — layout per PRD §10.2. Errors render in the Watch surface (PRD §25), not only the console.

## 5. Converse Surface

Bottom chat bar wired per PRD §8.3: `POST /api/chat` → server inbox → `relay.js` (separate process) long-polls `/api/inbox-wait` and pushes messages to the ANA session; ANA replies via `POST /api/agent`, rendered in the feed.

## 6. Data Sources

- OpenStreetMap raster tiles (basemap; browser-direct, exempt per PRD §8.4)
- User-provided GeoJSON files

No external API calls; the proxy allowlist is empty.

## 7. Dependencies

- Node.js >= 20 LTS (global `fetch`) — no npm dependencies
- Leaflet 1.9.4, vendored at `vendor/leaflet/`

## 8. Functional Requirements

PRD §15.2: FR-MAP-001 (map render), FR-MAP-002 (pan/zoom), FR-MAP-003 (center display), FR-MAP-004 (zoom display), FR-MAP-005 (click → marker), FR-MAP-006 (markers in `state.json`), FR-MAP-007 (GeoJSON load/display), FR-MAP-008 (base/marker/GeoJSON layer management), FR-MAP-009 (fit bounds).

## 9. State Model

PRD §12 baseline: `stateVersion` (server-owned monotonic counter), `map.view` / `map.observedView` (two-key viewport semantics, §12 rule 4), `markers`, `layers` (reference-only entries — `resultRef`, `resultVersion`, `featureCount`, `bbox`; feature bodies never inlined, §12 rule 3), `selection`, `analysis`.

## 10. Data Model

Uploaded GeoJSON is stored server-side at `data/results/<id>.geojson`, served from `/api/results/<id>`, and must be a `FeatureCollection` (PRD §11.1).

## 11. Agent Actions

ANA operates by editing `state.json` through `PUT /api/state` (or directly on disk — the server bumps `stateVersion` on the next write) and replying via `POST /api/agent`:

- set `map.view` → all clients move (e.g. "Move the map to Daejeon.")
- add/remove entries in `markers` → markers change everywhere
- add a layer entry + `PUT /api/results/<id>` → new GeoJSON appears
- toggle `layers[].visible`
- read `map.observedView` to know what the user is looking at (PRD §24.1)
- modify app code itself on request (proposal → approval, PRD §24.3)

## 12. Error Handling

Visible in the Watch surface (`#err`): invalid GeoJSON (not JSON / not a FeatureCollection), state save failure, layer fetch failure, sync loss. Server: 403 non-allowlisted proxy hosts and path traversal, 404 unknown results, 400 malformed bodies.

## 13. Acceptance Criteria

Per PRD §15.4 — the app is complete when:

- the map loads without error (FR-MAP-001),
- pan and zoom work (FR-MAP-002),
- the current center coordinates and zoom level are visible (FR-MAP-003, FR-MAP-004),
- clicking the map creates a marker (FR-MAP-005),
- markers survive page refresh via `state.json` (FR-MAP-006),
- GeoJSON can be displayed and fit to bounds on request (FR-MAP-007, FR-MAP-009),
- base, marker, and GeoJSON layers can be managed independently (FR-MAP-008),
- ANA can alter map-related state in `state.json` and the map reflects the change without a reload (FR-MAP-002–FR-MAP-008),
- ANA can evolve the app through a proposed code change per §30 item 11.

## 14. Evolution Examples

- "Add a distance measure tool." → ANA proposes a new `geo/measure.js` + UI hook; approved change is live on next reload.
- "Show my markers as a heat cluster." → ANA proposes vendoring a cluster plugin and wiring it to the marker layer.

## 15. Next Evolution

`ana-geo-explorer` — "What is there?": Overpass-based POI discovery over the same runtime.
