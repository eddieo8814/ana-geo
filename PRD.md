# ANA Geo — Product Requirements Document (PRD)

**Document:** `PRD.md`  
**Project:** ANA Geo  
**Status:** Draft v1.2 — review round 2 Top 10 fixes applied (see `PRD-REVIEW.md`)  
**Target Repository Structure:** `ana-geo/apps/*`

---

# 1. Product Overview

## 1.1 Product Name

**ANA Geo**

ANA Geo is an Agent-Native GIS application family built on ANA (Agent-Native Agent).

The product starts as a minimal interactive map and progressively gains geospatial capabilities through a sequence of independently runnable applications.

The core progression is:

```text
ana-geo-map
    ↓
ana-geo-explorer
    ↓
ana-geo-search
    ├── ana-geo-site
    └── ana-geo-route
    ↓
ana-geo-satellite
    ↓
ana-geo-satellite-change-detection
```

Each application is a complete ANA example that can be run independently, while also demonstrating the evolution of GIS capability.

---

# 2. Product Vision

ANA Geo demonstrates a new interaction model for GIS:

> The user does not merely use a fixed GIS application.  
> The user observes the spatial state, converses with ANA, and evolves the GIS application itself.

Traditional GIS software follows this model:

```text
Developer builds GIS functions
        ↓
User selects existing functions
        ↓
GIS executes
```

ANA Geo follows this model:

```text
User observes a geographic situation
        ↓
User expresses intent
        ↓
ANA interprets the intent
        ↓
ANA uses or adds GIS capabilities
        ↓
Application state / logic / UI evolves
        ↓
User immediately continues using the evolved application
```

The core product principle is:

> **Use = Build**

---

# 3. Product Principles

ANA Geo must preserve the core principles of ANA.

## 3.1 Watch + Converse

The user must be able to:

- observe the map,
- observe current data,
- observe analysis results,
- observe current application state,
- converse with ANA within the same operating context.

The map is the primary **Watch surface**.

The ANA conversation is the primary **Converse surface**.

---

## 3.2 Agent as Runtime

ANA is not only a chatbot layered on top of the GIS.

ANA must be able to:

- read the current map state,
- read analysis conditions,
- modify application state,
- invoke external data sources,
- invoke GIS processing tools,
- modify application behavior when requested,
- evolve the application without requiring a conventional development/deployment cycle.

---

## 3.3 Own Your Harness

Each ANA Geo application should be:

- self-hostable,
- understandable from source,
- runnable locally,
- based primarily on open standards and open data,
- minimally dependent on proprietary SaaS,
- easy to modify by a coding agent.

---

# 4. Product Goals

## 4.1 Primary Goals

1. Provide a progressive reference implementation of Agent-Native GIS.
2. Demonstrate the evolution from map visualization to spatial intelligence.
3. Keep each app independently runnable.
4. Use external open data and open-source GIS libraries wherever possible.
5. Maintain a common state and GeoJSON-oriented data model across apps.
6. Make differences between app stages easy to understand by code comparison.
7. Enable ANA to change GIS behavior through conversation.
8. Keep early stages simple enough to run with minimal dependencies.
9. Introduce Python GIS processing only when browser-side GIS is no longer sufficient.

---

# 5. Non-Goals

The first version of ANA Geo is not intended to be:

- a replacement for QGIS or ArcGIS,
- a complete desktop GIS,
- a production-grade geospatial database platform,
- a global routing service,
- a commercial basemap provider,
- a full remote-sensing processing platform,
- a real-time disaster command system,
- a generic LLM GIS chatbot.

ANA Geo is primarily a **reference implementation of Agent-Native GIS evolution**.

---

# 6. Application Family

The project shall contain the following applications.

```text
ana-geo/
├── PRD.md
├── README.md
└── apps/
    ├── ana-geo-map/
    ├── ana-geo-explorer/
    ├── ana-geo-search/
    ├── ana-geo-site/
    ├── ana-geo-route/
    ├── ana-geo-satellite/
    └── ana-geo-satellite-change-detection/
```

---

# 7. Capability Progression

Each application answers a progressively more sophisticated geographic question.

| App | Core Question | Capability |
|---|---|---|
| `ana-geo-map` | Where is it? | Map / Vector visualization |
| `ana-geo-explorer` | What is there? | External geographic discovery |
| `ana-geo-search` | What satisfies these spatial conditions? | Spatial query |
| `ana-geo-site` | Which candidate is best? | Multi-criteria decision analysis |
| `ana-geo-route` | How are places connected? | Network analysis |
| `ana-geo-satellite` | What did this place look like at a given time? | Earth observation discovery |
| `ana-geo-satellite-change-detection` | What changed over time? | Temporal raster analysis |

---

# 8. Shared Technical Architecture

## 8.1 Common Runtime

Each application should preserve a consistent ANA runtime.

Recommended baseline:

```text
index.html
app.js
server.js
state.json
```

Additional GIS functionality should be organized under:

```text
geo/
tools/
data/
```

Recommended structure:

```text
ana-geo-xxx/
├── README.md
├── SPEC.md
├── index.html
├── app.js
├── server.js
├── state.json
├── geo/
│   ├── map.js
│   ├── layers.js
│   ├── geometry.js
│   └── styles.js
├── data/
└── tools/
```

---

## 8.2 State Synchronization Contract

Every app shall implement the same state-change propagation contract:

1. The state file carries a top-level `stateVersion` — a monotonic counter, distinct from the semantic `app.version`. Every state change, whether made by the user or by ANA, increments it by 1.
2. Clients poll the server at roughly 2.5-second intervals, compare `stateVersion`, and refetch state when it changes. All devices connected to the same app converge automatically.
3. User actions are persisted on the server, never only in `localStorage`.
4. Server-sent events may be added for lower latency, but polling always runs in parallel (tunnels commonly buffer `text/event-stream`).
5. Continuous gestures (pan, zoom) are written with a 300 ms trailing debounce on `moveend`/`zoomend` (acceptable range 250–500 ms). Discrete actions (layer toggle, feature selection, marker creation) are written immediately. Without this split, a pan gesture inflates `stateVersion` dozens of times per second.
6. Any change to a layer's `resultVersion` (§12) also increments `stateVersion` — otherwise polling clients cannot detect that a result set changed even though the state file did not.

---

## 8.3 Converse Surface Wiring

The Converse Surface is a wired part of the runtime, not just a layout region. `server.js` owns these responsibilities in every app:

- static serving of the dashboard,
- read/write API for the state JSON,
- chat inbox and feed API,
- an agent response endpoint (`POST /api/agent` or equivalent) through which ANA always replies, so responses render as rich cards (including proposal/approval cards),
- result data endpoints (`/api/results/<id>`) serving the feature bodies referenced from state (§12),
- the external data proxy (§8.4).

Inbound path: the dashboard posts chat input to the server-side inbox, and an **inbound relay** long-polls that inbox and pushes each message into the ANA session. Delivery is automatic from both ends — the user never copies text into another tool, and the agent session receives messages as push events. The mechanical polling belongs to the relay component, not to the agent.

This is an intentional simplification of the ANA base (the `fakechat` / `realtime-mirror` channel building blocks are not adopted); the chat bridge API above is the replacement, and any app deviating from it must document its alternative wiring in `SPEC.md`.

---

## 8.4 External Data Proxy

All external data requests (Overpass, STAC search, asset downloads, and any other third-party API) are issued through `server.js` proxy endpoints against a per-app host allowlist. The browser never calls third-party APIs directly; only basemap tile requests are exempt. This makes §27.2–§27.3 enforceable at a single point and concentrates throttling, caching, and provenance recording (§28) in one place.

The proxy must forward HTTP `Range` request headers and `206 Partial Content` responses unchanged — raster window reads depend on range requests, and a proxy that strips them silently degrades partial reads into full-scene downloads (§26.2). Python workers reach external hosts under the same per-app allowlist (through the proxy, or by direct HTTPS restricted to allowlisted hosts); their range reads must remain partial reads.

---

## 8.5 Python Worker Contract

Apps that use Python (route, change detection) share one worker contract:

- `server.js` spawns `python3 tools/<op>.py`; the request is JSON on stdin, the response is JSON on stdout,
- request envelope `{ "op": string, "params": object }`; response envelope `{ "ok": boolean, "result": object | null, "error": { "code": string, "message": string } | null }`,
- a default timeout applies (recommended: 60 s); on failure the error envelope is propagated to the Watch surface (§25),
- stderr is treated as logs only, never parsed as data.

No long-lived worker process or port management is required, which keeps §9 independence and §27.4 intact. This contract addresses process lifecycle only — the Python runtime itself remains an installation prerequisite declared per §30.

---

# 9. Independence Requirement

Every application must be independently runnable.

Example:

```bash
cd apps/ana-geo-map
node server.js
```

and:

```bash
cd apps/ana-geo-satellite
node server.js
```

must work without depending on another app directory at runtime.

Apps may share conceptual conventions, but must not require importing code from a preceding app.

This allows:

- independent learning,
- easy comparison,
- standalone demos,
- easy cloning,
- agent-driven modification.

---

# 10. Common Frontend Requirements

## 10.1 Map Library

Default map library:

**Leaflet**

Every application shall support the following baseline map capabilities, each implemented in its own code (§9):

- pan,
- zoom,
- base tiles,
- markers,
- GeoJSON,
- vector layers,
- fit bounds,
- click events,
- layer visibility.

---

## 10.2 Shared Layout

Recommended layout:

```text
┌─────────────────────────────────────────────────────────┐
│ Header                                                  │
├─────────────────┬───────────────────────────────────────┤
│ Context /       │                                       │
│ Results /       │                 MAP                   │
│ Analysis Panel  │                                       │
│                 │                                       │
├─────────────────┴───────────────────────────────────────┤
│ Status / Coordinates / Result Summary                   │
└─────────────────────────────────────────────────────────┘

                    ANA Converse Surface
```

The map must remain the primary visual context.

---

# 11. Common Spatial Data Model

## 11.1 Vector Standard

All vector data should be normalized into **GeoJSON** wherever possible.

Baseline format:

```json
{
  "type": "FeatureCollection",
  "features": []
}
```

Each feature should use a common property model when applicable.

```json
{
  "type": "Feature",
  "id": "feature-001",
  "geometry": {},
  "properties": {
    "name": "Example",
    "category": "cafe",
    "source": "osm",
    "sourceId": "node/12345",
    "score": null,
    "metrics": {},
    "fetchedAt": "2026-08-10T00:00:00Z"
  }
}
```

---

# 12. Common State Model

All apps should retain a human-readable JSON state.

Example baseline:

```json
{
  "app": {
    "name": "ana-geo-map",
    "version": "0.1.0"
  },
  "stateVersion": 12,
  "map": {
    "view": { "center": [36.3504, 127.3845], "zoom": 13 },
    "observedView": null,
    "baseLayer": "osm"
  },
  "markers": [],
  "layers": [
    {
      "id": "poi-cafe",
      "type": "geojson",
      "label": "Cafe",
      "category": "cafe",
      "source": "overpass",
      "visible": true,
      "featureCount": 1843,
      "resultRef": "/api/results/poi-cafe",
      "resultVersion": 17,
      "bbox": []
    }
  ],
  "selection": null,
  "analysis": null
}
```

Rules:

1. `stateVersion` is the synchronization counter defined in §8.2. It is not the semantic `app.version`.
2. All apps represent layers with the element schema shown above.
3. **Feature bodies are never inlined into state.** A layer entry holds references only (`resultRef`, `resultVersion`, `featureCount`, `bbox`); the feature GeoJSON is served from the result endpoints (§8.3), and clients refetch it only when `resultVersion` changes. Inlining a 2,000-feature result makes the state file megabytes large, which breaks both the polling contract (§8.2) and the requirement below.
4. **The viewport uses two keys with different sync semantics.** `map.view` is set by ANA (or loaded state) and is applied by every client — this is what makes "Move the map to Daejeon." work on all devices. `map.observedView` records a client's own current viewport for ANA inspection (§24.1) and is **never applied** by other clients. A device panning its own map therefore never drags another device's screen.

State must be simple enough for a coding agent to inspect and modify — including incremental edits such as "change 2 km to 3 km" (§24.2), which must never require rewriting a megabyte file.

---

# 13. Shared External Data Strategy

The project should prefer open and directly accessible data sources.

Initial priority:

1. OpenStreetMap
2. Overpass API
3. STAC-compatible catalogs
4. Sentinel-2
5. NASA POWER where needed
6. Open DEM sources where needed

Commercial APIs should not be required for the default examples.

---

# 14. Shared Dependency Strategy

Dependencies should be introduced gradually.

## Browser-first dependencies

Use for early apps:

- Leaflet
- Turf.js

## Python dependencies

Introduce only when necessary:

- GeoPandas
- NetworkX
- OSMnx
- Rasterio
- NumPy

Optional advanced dependencies:

- OpenCV
- scikit-image
- PyTorch

---

# 15. App 1 — `ana-geo-map`

## 15.1 Purpose

Provide the smallest Agent-Native GIS application.

Core question:

> **Where is it?**

The app should allow the user to observe and manipulate a geographic map through ANA.

---

## 15.2 Required Features

### FR-MAP-001 — Map Rendering

The app shall render an interactive web map.

### FR-MAP-002 — Pan and Zoom

The user shall be able to pan and zoom.

### FR-MAP-003 — Coordinate Display

The app shall display the current map center.

### FR-MAP-004 — Zoom State

The app shall display the current zoom level.

### FR-MAP-005 — Map Click Marker

The user shall be able to click the map to create a marker.

### FR-MAP-006 — Marker State

Markers shall be stored in `state.json`.

### FR-MAP-007 — GeoJSON Layer

The app shall be able to load and display GeoJSON.

### FR-MAP-008 — Layer Management

The app shall support:

- base map,
- marker layer,
- GeoJSON layer.

### FR-MAP-009 — Fit Bounds

The map shall automatically fit to a loaded GeoJSON layer when requested.

---

## 15.3 ANA Interaction Examples

```text
"Move the map to Daejeon."
"Zoom in."
"Put a marker here."
"Remove all markers."
"Show this GeoJSON."
```

---

## 15.4 Acceptance Criteria

The app is complete when:

- the map loads without error (FR-MAP-001),
- pan and zoom work (FR-MAP-002),
- the current center coordinates and zoom level are visible (FR-MAP-003, FR-MAP-004),
- clicking the map creates a marker (FR-MAP-005),
- markers survive page refresh via `state.json` (FR-MAP-006),
- GeoJSON can be displayed and fit to bounds on request (FR-MAP-007, FR-MAP-009),
- base, marker, and GeoJSON layers can be managed independently (FR-MAP-008),
- ANA can alter map-related state in `state.json` and the map reflects the change without a reload (FR-MAP-002–FR-MAP-008),
- ANA can evolve the app through a proposed code change per §30 item 11.

---

# 16. App 2 — `ana-geo-explorer`

## 16.1 Purpose

Extend the map with real-world geographic discovery.

Core question:

> **What is there?**

---

## 16.2 External Data

Default:

- OpenStreetMap
- Overpass API

---

## 16.3 Initial POI Presets

The first version should support at least:

- cafe
- restaurant
- hospital
- pharmacy
- school
- university
- park
- parking
- charging station
- bus station

---

## 16.4 Required Features

### FR-EXP-001 — Viewport Search

Search within the current visible map bounds.

### FR-EXP-002 — Category Search

Search OSM objects by category.

### FR-EXP-003 — Result Layer

Display results as a dedicated map layer.

### FR-EXP-004 — Result Count

Display the number of discovered objects.

### FR-EXP-005 — Object Detail

Clicking an object shall display:

- name,
- category,
- coordinates,
- OSM tags,
- source ID.

### FR-EXP-006 — Multiple Layers

Multiple POI categories may be visible simultaneously.

### FR-EXP-007 — Layer Toggle

Each category layer may be shown or hidden.

### FR-EXP-008 — POI Preset Catalog

The app shall define a single canonical category registry that maps every preset in §16.3 to its OSM tag filter. All category references — in queries, state, and examples — use registry keys.

---

## 16.5 ANA Interaction Examples

```text
"Find cafes around here."
"Show schools too."
"Hide cafes."
"Show only hospitals."
"Find parks in the visible area."
```

---

## 16.6 Acceptance Criteria

The app is complete when:

- OSM data can be retrieved through Overpass (FR-EXP-001, FR-EXP-002),
- at least ten POI types are supported by the category registry (FR-EXP-008),
- search respects the current viewport (FR-EXP-001),
- results are displayed as GeoJSON-compatible layers with a visible result count (FR-EXP-003, FR-EXP-004),
- result details are inspectable (FR-EXP-005),
- multiple category layers can be shown simultaneously and toggled (FR-EXP-006, FR-EXP-007),
- ANA can change the active categories in `state.json` and the map reflects the change without a reload (FR-EXP-002, FR-EXP-007),
- ANA can evolve the app, e.g. add a new POI category preset to the registry in code (§30, item 11).

---

# 17. App 3 — `ana-geo-search`

## 17.1 Purpose

Add spatial predicates and condition-based discovery.

Core question:

> **What satisfies these spatial conditions?**

This is the first stage that performs explicit GIS analysis.

---

## 17.2 Additional Library

Default:

- Turf.js

---

## 17.3 Required Spatial Operations

### FR-SEARCH-001 — Distance

Calculate distance between spatial objects.

### FR-SEARCH-002 — Buffer

Create buffers around point, line, or polygon objects.

Supported units:

- meters,
- kilometers.

### FR-SEARCH-003 — Within

Find features inside a polygon.

### FR-SEARCH-004 — Within Distance

Find features within a specified distance from a reference feature.

### FR-SEARCH-005 — Outside Distance

Find features farther than a specified distance.

### FR-SEARCH-006 — Nearest

Find nearest N features.

### FR-SEARCH-007 — Multi-condition AND

Support multiple simultaneous spatial constraints.

### FR-SEARCH-008 — Multi-condition OR

Support optional alternative spatial conditions.

### FR-SEARCH-009 — Result Layer

Query results shall be rendered as a distinct map layer, and buffers used by the query shall be visible.

### FR-SEARCH-010 — Incremental Condition Editing

A single condition (relation, reference, distance, or unit) shall be editable without rewriting the entire query.

### FR-SEARCH-011 — Feature Acquisition

Target and reference features shall be acquired by category from Overpass within the analysis area, using the same registry keys as FR-EXP-008, or loaded from GeoJSON.

---

## 17.4 Condition Model

Recommended structure:

```json
{
  "target": "cafe",
  "operator": "AND",
  "conditions": [
    {
      "relation": "within_distance",
      "reference": "university",
      "distance": 2000,
      "unit": "m"
    },
    {
      "relation": "within_distance",
      "reference": "subway_station",
      "distance": 1000,
      "unit": "m"
    }
  ]
}
```

---

## 17.5 Required Query Types

The following user intents must be representable:

```text
B inside A
B within N km of A
B farther than N km from A
Nearest B to A
C satisfying both A and B conditions
```

---

## 17.6 ANA Interaction Examples

```text
"Find cafes within 2 km of universities."
"Change that to 3 km."
"Also require them to be within 1 km of a subway station."
"Exclude places within 500 m of hospitals."
"Show the five nearest results."
```

---

## 17.7 Acceptance Criteria

The app is complete when:

- target and reference features can be acquired by registry category or loaded from GeoJSON (FR-SEARCH-011),
- Turf.js-based spatial operations work (FR-SEARCH-001–FR-SEARCH-006),
- buffers are visible on the map (FR-SEARCH-002, FR-SEARCH-009),
- multi-condition AND/OR queries can be represented in state (FR-SEARCH-007, FR-SEARCH-008),
- a single condition can be edited without rewriting the entire query (FR-SEARCH-010),
- results are rendered as a distinct layer (FR-SEARCH-009),
- ANA can modify the condition model in `state.json` and results update accordingly (FR-SEARCH-007, FR-SEARCH-008, FR-SEARCH-010),
- ANA can evolve the app, e.g. add a spatial relation not covered by FR-SEARCH-001–008 (§30, item 11).

---

# 18. App 4 — `ana-geo-site`

## 18.1 Purpose

Evolve spatial filtering into decision support.

Core question:

> **Which candidate is best?**

---

## 18.2 Core Concepts

The application must distinguish:

### Hard Constraint

Pass / fail.

Examples:

```text
Distance from residential area >= 1 km
Slope <= 10 degrees
Area >= 10,000 m²
```

### Soft Criterion

Produces a score.

Examples:

```text
Road accessibility
Distance to power infrastructure
Solar irradiance
Distance to commercial districts
```

---

## 18.3 Required Features

### FR-SITE-001 — Candidate Definition

Candidate locations may be points or polygons.

### FR-SITE-002 — Constraint Definition

Users can define hard pass/fail rules.

### FR-SITE-003 — Criterion Definition

Users can define scoring criteria.

### FR-SITE-004 — Weight Definition

Each criterion shall have a weight.

### FR-SITE-005 — Weight Validation

Criterion weights should sum to 1.0 or 100%.

### FR-SITE-006 — Metric Calculation

Each candidate shall produce raw metric values, including spatial distance metrics computed with Turf.js (e.g., distance to roads, power infrastructure, residential areas).

### FR-SITE-007 — Normalization

Raw values shall be normalized to a common scoring scale.

Recommended:

```text
0–100
```

### FR-SITE-008 — Weighted Score

The system shall calculate a final weighted score.

### FR-SITE-009 — Ranking

Candidates shall be ranked.

### FR-SITE-010 — Explanation

Each candidate shall expose score breakdown.

---

## 18.4 Candidate Result Model

```json
{
  "candidateId": "site-a",
  "eligible": true,
  "score": 92,
  "metrics": {
    "roadDistance": 850,
    "powerDistance": 1200,
    "residentialDistance": 1800
  },
  "criteriaScores": {
    "road": 88,
    "power": 96,
    "residential": 91
  }
}
```

---

## 18.5 ANA Interaction Examples

```text
"Power line proximity is the most important factor."
"Increase its weight to 50%."
"Residential areas within 1 km should be rejected entirely."
"Add solar irradiance as a new criterion."
"Rank only the candidates larger than 20,000 square meters."
```

---

## 18.6 Optional External Data

Future expansion may include:

- NASA POWER,
- DEM,
- land use data,
- cadastral data,
- public infrastructure data.

These are not mandatory for the first implementation.

---

## 18.7 Acceptance Criteria

The app is complete when:

- candidates can be defined as points or polygons (FR-SITE-001),
- hard constraints and soft criteria are defined separately (FR-SITE-002, FR-SITE-003),
- criterion weights are editable and validated to sum to 1.0 (FR-SITE-004, FR-SITE-005),
- raw metrics are calculated and normalized to the 0–100 scale (FR-SITE-006, FR-SITE-007),
- final weighted scores are calculated and candidates are ranked (FR-SITE-008, FR-SITE-009),
- the score breakdown is visible per candidate (FR-SITE-010),
- ANA can alter constraints, criteria, and weights in `state.json` and the ranking updates (FR-SITE-002–FR-SITE-005),
- ANA can evolve the app, e.g. add a new criterion type in code (§30, item 11).

---

# 19. App 5 — `ana-geo-route`

## 19.1 Purpose

Introduce graph and network GIS.

Core question:

> **How are places connected?**

---

## 19.2 Recommended Architecture

```text
ANA / Node
    ↓
JSON request
    ↓
Python worker
    ↓
OSMnx / NetworkX
    ↓
GeoJSON result
    ↓
Leaflet
```

---

## 19.3 Required Python Dependencies

Initial:

```text
osmnx
networkx
geopandas
```

---

## 19.4 Required Features

### FR-ROUTE-001 — Origin

Set route origin.

### FR-ROUTE-002 — Destination

Set route destination.

### FR-ROUTE-003 — Travel Mode

Initial modes:

- driving,
- walking,
- cycling.

### FR-ROUTE-004 — Shortest Distance

Calculate distance-minimizing path.

### FR-ROUTE-005 — Shortest Time

Calculate time-minimizing path where edge data supports it.

### FR-ROUTE-006 — Route Geometry

Return route geometry as GeoJSON `LineString`.

### FR-ROUTE-007 — Route Summary

Return:

- total distance,
- estimated travel time,
- travel mode.

### FR-ROUTE-008 — Nearest Destination

Rank candidate destinations by network distance or travel time. Candidate destinations are provided by a registry-key category fetch (as in FR-EXP-002 / FR-EXP-008) or loaded from GeoJSON.

### FR-ROUTE-009 — Isochrone

Generate approximate reachable regions for:

- 5 minutes,
- 10 minutes,
- 20 minutes.

### FR-ROUTE-010 — Network Acquisition

Load the OSM road network for the analysis area. The area is bounded by the bbox of origin, destination, and analysis targets plus 2 km padding, capped at roughly 100 km², and cached by (bbox, network_type). The current viewport is never used as the network bound.

If the padded bbox exceeds the area cap, the request is **rejected with a visible error** stating the cap and the requested area (§25) — never silently truncated, so an over-cap request cannot be mistaken for a road disconnection. ANA may propose raising the cap or splitting the analysis as an evolution (§30, item 11).

---

## 19.5 Route Result Contract

```json
{
  "route": {
    "mode": "drive",
    "distanceMeters": 4380,
    "travelTimeSeconds": 720,
    "geometry": {
      "type": "LineString",
      "coordinates": []
    }
  }
}
```

---

## 19.6 ANA Interaction Examples

```text
"Find the fastest route."
"Use walking instead."
"Avoid this road."
"Which hospital can I reach fastest?"
"Show the area reachable within 10 minutes."
```

---

## 19.7 Acceptance Criteria

The app is complete when:

- OSM road networks can be loaded within the bounded analysis area (FR-ROUTE-010),
- route origin and destination are selectable (FR-ROUTE-001, FR-ROUTE-002),
- driving, walking, and cycling modes are selectable (FR-ROUTE-003),
- shortest-distance routes can be calculated, and shortest-time routes where edge data supports it (FR-ROUTE-004, FR-ROUTE-005),
- route geometry is displayed as GeoJSON (FR-ROUTE-006),
- distance, time, and mode summaries are shown (FR-ROUTE-007),
- candidate destinations can be ranked by network cost (FR-ROUTE-008),
- isochrones for 5, 10, and 20 minutes can be generated (FR-ROUTE-009),
- ANA can modify network assumptions (mode, bounds, cost) in `state.json` (FR-ROUTE-003, FR-ROUTE-010),
- ANA can evolve the app, e.g. add an "avoid this road" constraint in code (§30, item 11).

---

# 20. App 6 — `ana-geo-satellite`

## 20.1 Purpose

Extend ANA Geo into Earth Observation.

Core question:

> **What did this place look like at a given time?**

---

## 20.2 Initial Data Strategy

Default:

- STAC
- Sentinel-2 L2A

Default provider, fixed for v1:

```text
Earth Search — https://earth-search.aws.element84.com/v1
Collection: sentinel-2-l2a
```

The provider must allow **both catalog search and asset retrieval** without an account, token, or API key. Asset access must use public `https://` URLs — requester-pays `s3://` assets are not acceptable defaults. The COG-only `sentinel-2-c1-l2a` collection may be adopted instead where its newer processing baseline is preferred.

---

## 20.3 Required Features

### FR-SAT-001 — AOI from Viewport

Use current map bounds as Area of Interest.

### FR-SAT-002 — AOI from Polygon

Use a drawn or loaded polygon as AOI.

### FR-SAT-003 — Date Range

Specify start and end dates.

### FR-SAT-004 — Collection

Initial collection:

```text
Sentinel-2 L2A
```

### FR-SAT-005 — Cloud Cover

Filter by maximum cloud cover.

### FR-SAT-006 — STAC Search

Query scenes using:

- AOI,
- date range,
- collection,
- cloud cover.

### FR-SAT-007 — Scene Footprints

Display scene footprints on the map.

### FR-SAT-008 — Scene Metadata

Show:

- datetime,
- platform,
- cloud cover,
- scene ID,
- collection,
- available assets.

### FR-SAT-009 — Scene Selection

Allow the user or ANA to select one scene as the active scene.

### FR-SAT-010 — Active Scene Preview

The app shall render the active scene's `thumbnail` asset as an image overlay placed on the scene's bbox. The reprojected scene footprint is a quadrilateral while `L.imageOverlay` accepts a rectangle, so corner misalignment of up to a few kilometers is expected and acceptable at this fidelity.

This provides scene-level visual context, not analysis-grade imagery. Full-resolution band rendering is out of scope for v1 and is handled as an evolution request (§20.5).

---

## 20.4 Search Model

```json
{
  "satelliteSearch": {
    "collection": "sentinel-2-l2a",
    "bbox": [],
    "datetime": "2026-07-01/2026-07-31",
    "maxCloudCover": 10
  }
}
```

---

## 20.5 ANA Interaction Examples

```text
"Find Sentinel-2 images for Daejeon from July."
"Only show images with less than 10% cloud."
"Sort by lowest cloud cover."
"Add Sentinel-1 support."
"Also find an image from the same month last year."
"Show this scene at full resolution."
```

The last two examples are **application evolution requests**: full-resolution COG rendering requires a new vendored browser library and is introduced through the ANA proposal/approval flow, not shipped in v1.

---

## 20.6 Acceptance Criteria

The app is complete when:

- AOI can be defined from the viewport or a polygon (FR-SAT-001, FR-SAT-002),
- STAC search works against the default provider (FR-SAT-003, FR-SAT-004, FR-SAT-006),
- Sentinel-2 scenes can be listed and one selected as the active scene (FR-SAT-009),
- cloud filtering works (FR-SAT-005),
- footprints appear on the map (FR-SAT-007),
- scene metadata is inspectable (FR-SAT-008),
- the active scene is visible on the map as a thumbnail-fidelity image overlay (FR-SAT-010),
- ANA can alter default search behavior in `state.json` (FR-SAT-003–FR-SAT-006),
- ANA can evolve the app, e.g. add Sentinel-1 support or full-resolution rendering (§30, item 11).

---

# 21. App 7 — `ana-geo-satellite-change-detection`

## 21.1 Purpose

Introduce temporal Earth Observation analysis.

Core question:

> **What changed over time?**

---

## 21.2 Recommended Processing Architecture

Raster processing runs in a Python worker using the shared worker contract of §8.5 — the same spawn/JSON-envelope mechanism as `ana-geo-route`.

```text
Scene A
    \
     → Raster alignment → Index / Difference → Threshold
    /
Scene B
                              ↓
                         Change raster
                              ↓
                           Polygonize
                              ↓
                            GeoJSON
                              ↓
                            Leaflet
```

---

## 21.3 Required Python Dependencies

Initial:

```text
rasterio
numpy
```

Optional later:

```text
opencv-python
scikit-image
torch
```

---

## 21.4 V1 Analysis Method

The first version must not require deep learning.

Initial methods:

1. NDVI difference
2. simple band difference

Preferred first implementation:

**NDVI difference**

---

## 21.5 Required Features

### FR-CD-001 — Before Scene

Select scene A.

### FR-CD-002 — After Scene

Select scene B.

### FR-CD-003 — Spatial Alignment

Scenes must be aligned to a compatible:

- CRS,
- resolution,
- extent,
- pixel grid.

### FR-CD-004 — Index Calculation

Calculate NDVI where bands are available.

### FR-CD-005 — Difference Calculation

Calculate:

```text
after - before
```

### FR-CD-006 — Threshold

Allow configurable change threshold.

### FR-CD-007 — Change Raster

Generate a raster classification of detected change.

### FR-CD-008 — Changed Area

Calculate total changed area.

### FR-CD-009 — Polygonize

Convert significant changed regions to vector polygons.

### FR-CD-010 — Map Visualization

Render change regions as GeoJSON-compatible map layers.

### FR-CD-011 — Region Ranking

Rank significant changed regions by area.

### FR-CD-012 — Scene Acquisition

The app shall discover and select its before/after scenes through its own STAC search, implementing the same search capabilities as FR-SAT-001–FR-SAT-009 in its own code (§9).

---

## 21.6 Result Model

```json
{
  "changeDetection": {
    "method": "ndvi-difference",
    "beforeScene": "scene-a",
    "afterScene": "scene-b",
    "threshold": 0.2,
    "changedAreaSqKm": 12.8,
    "regions": [
      {
        "id": "change-001",
        "areaSqKm": 3.8
      }
    ]
  }
}
```

---

## 21.7 ANA Interaction Examples

```text
"Compare this image with the one from six months ago."
"Increase the threshold."
"Only show the three largest changed areas."
"I care about vegetation loss, not vegetation growth."
"I want to detect building changes instead."
```

The final example is explicitly an **application evolution request**.

ANA may evolve the analysis pipeline from:

```text
NDVI Difference
```

to:

```text
Building Detection
    ↓
Before Segmentation
After Segmentation
    ↓
Vector Difference
```

Building-scale change detection generally exceeds Sentinel-2's 10 m resolution — this evolution typically also introduces a higher-resolution imagery source, and is therefore an evolution path only, never a v1 acceptance criterion.

---

## 21.8 Acceptance Criteria

The app is complete when:

- before and after scenes can be selected (FR-CD-001, FR-CD-002),
- raster alignment succeeds (FR-CD-003),
- NDVI can be calculated (FR-CD-004),
- the difference raster can be generated (FR-CD-005),
- the change threshold is adjustable (FR-CD-006),
- a change raster and total changed area are produced (FR-CD-007, FR-CD-008),
- changed regions can be polygonized and ranked by area (FR-CD-009, FR-CD-011),
- results appear on the common Leaflet map (FR-CD-010),
- ANA can alter analysis parameters in `state.json` (FR-CD-004, FR-CD-006),
- before and after scenes can be discovered via the app's own STAC search (FR-CD-012),
- ANA can evolve the analysis pipeline within Sentinel-2's capabilities, e.g. switch to NDBI/NDWI difference or direction-filtered change (§30, item 11).

---

# 22. Capability Matrix

Legend: **✓** = the app implements this capability in its own code (per §9, never imported from a preceding app), and every ✓ must be backed by at least one FR in that app's section. Blank = out of scope for that app.

| Capability | Map | Explorer | Search | Site | Route | Satellite | Change Detection |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Leaflet map | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Marker | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GeoJSON | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| OSM |  | ✓ | ✓ |  | ✓ |  |  |
| Overpass |  | ✓ | ✓ |  | ✓ |  |  |
| POI discovery |  | ✓ | ✓ |  | ✓ |  |  |
| Spatial distance |  |  | ✓ | ✓ |  |  |  |
| Buffer |  |  | ✓ |  |  |  |  |
| Multi-condition query |  |  | ✓ | ✓ |  |  |  |
| Hard constraints |  |  |  | ✓ |  |  |  |
| Scoring |  |  |  | ✓ |  |  |  |
| Ranking |  |  |  | ✓ | ✓ |  | ✓ |
| Network graph |  |  |  |  | ✓ |  |  |
| Routing |  |  |  |  | ✓ |  |  |
| Isochrone |  |  |  |  | ✓ |  |  |
| STAC |  |  |  |  |  | ✓ | ✓ |
| Sentinel-2 |  |  |  |  |  | ✓ | ✓ |
| Imagery preview |  |  |  |  |  | ✓ |  |
| Raster |  |  |  |  |  |  | ✓ |
| Temporal analysis |  |  |  |  |  |  | ✓ |

Backing FRs per row (every ✓ maps to at least one FR):

- **Leaflet map / Marker / GeoJSON** — all apps, per §10.1 (each app implements the baseline in its own code)
- **OSM / Overpass** — Explorer FR-EXP-001–002 · Search FR-SEARCH-011 · Route FR-ROUTE-010 (OSMnx queries Overpass internally)
- **POI discovery** — Explorer FR-EXP-002/008 · Search FR-SEARCH-011 · Route FR-ROUTE-008
- **Spatial distance** — Search FR-SEARCH-001 · Site FR-SITE-006
- **Buffer** — Search FR-SEARCH-002
- **Multi-condition query** — Search FR-SEARCH-007/008 · Site FR-SITE-002/003
- **Hard constraints / Scoring** — Site FR-SITE-002 / FR-SITE-006–008
- **Ranking** — Site FR-SITE-009 · Route FR-ROUTE-008 · Change Detection FR-CD-011
- **Network graph / Routing / Isochrone** — Route FR-ROUTE-010 / FR-ROUTE-004–006 / FR-ROUTE-009
- **STAC / Sentinel-2** — Satellite FR-SAT-004/006 · Change Detection FR-CD-012
- **Imagery preview** — Satellite FR-SAT-010
- **Raster / Temporal analysis** — Change Detection FR-CD-003–007 / FR-CD-005

Note: the Site column has no external-data ✓ by design — §18.6 keeps external data optional, and candidates/reference features come from loaded GeoJSON or prior apps' exported results.

---

# 23. UX Requirements

## 23.1 Map-First Experience

The user should not feel that they are using a chat application with a map attached.

The user should feel they are using a live geographic application with ANA present inside the runtime.

---

## 23.2 Visible State

Important analysis context should always be visible.

Examples:

- active POI categories,
- spatial conditions,
- current site criteria,
- route mode,
- satellite date range,
- change detection threshold.

---

## 23.3 Explainable Results

The application should expose not only results but why those results occurred.

Examples:

```text
This site ranked #1 because:
- road accessibility: 88
- power proximity: 96
- residential separation: 91
```

or:

```text
12 regions exceeded NDVI change threshold 0.20.
```

---

# 24. ANA Behavior Requirements

## 24.1 State Awareness

ANA must be able to inspect:

- current viewport,
- selected feature,
- visible layers,
- active query,
- current analysis,
- current result set.

---

## 24.2 Incremental Modification

Small user requests should produce small changes.

Example:

```text
"Change 2 km to 3 km."
```

should modify the relevant distance only.

---

## 24.3 Capability Evolution

When a requested function does not exist, ANA may propose adding it.

Example:

```text
User:
"Can you also calculate walking time?"

ANA:
Proposes adding a routing capability.
```

The app should preserve the ANA proposal / approval / apply pattern where available.

---

## 24.4 Transparent External Data Use

When external data is used, the application should record:

- source,
- query,
- fetch time,
- relevant source identifier.

---

# 25. Error Handling

All apps must provide understandable failure states.

Required categories:

- external API unavailable,
- invalid GeoJSON,
- empty search result,
- unsupported geometry,
- invalid spatial condition,
- Python worker failure,
- STAC search failure,
- raster asset unavailable,
- incompatible raster data.

Errors should be visible in the Watch surface, not only in developer console logs.

---

# 26. Performance Requirements

## 26.1 Early Apps

`map`, `explorer`, and `search` should remain usable on a normal laptop browser.

Avoid attempting to render extremely large feature sets.

Recommended initial result cap:

```text
500–2,000 features
```

depending on geometry complexity.

---

## 26.2 Server-side / Python Processing

Heavy processing should move to a worker when necessary.

Examples:

- road graph processing,
- large routing networks,
- raster reprojection,
- raster difference,
- polygonization.

---

# 27. Security Requirements

1. User-provided external URLs must not be executed blindly.
2. Server-side proxy endpoints must restrict arbitrary request forwarding.
3. External API endpoints should be allowlisted where practical.
4. Python workers must receive structured input rather than raw shell commands.
5. Generated paths must remain inside the application workspace.
6. Secrets must not be stored in client-side source.
7. Default examples should prefer services not requiring API keys.

---

# 28. Logging and Provenance

Each external operation should optionally record provenance.

Recommended record:

```json
{
  "operation": "overpass-search",
  "timestamp": "2026-08-10T00:00:00Z",
  "source": "openstreetmap",
  "query": "...",
  "resultCount": 42
}
```

For analysis:

```json
{
  "operation": "change-detection",
  "beforeScene": "...",
  "afterScene": "...",
  "method": "ndvi-difference",
  "threshold": 0.2
}
```

---

# 29. Development Phases

## Phase 1 — Vector GIS Foundation

Implement:

```text
ana-geo-map
ana-geo-explorer
ana-geo-search
```

Goal:

> Demonstrate the progression from visualization to geographic discovery to spatial reasoning.

---

## Phase 2 — Decision and Network GIS

Implement:

```text
ana-geo-site
ana-geo-route
```

Goal:

> Demonstrate decision support and graph-based spatial reasoning.

---

## Phase 3 — Earth Observation

Implement:

```text
ana-geo-satellite
ana-geo-satellite-change-detection
```

Goal:

> Demonstrate spatiotemporal observation and raster analysis.

---

# 30. Definition of Done for Each App

Every app must include:

```text
README.md
SPEC.md
index.html
app.js
server.js
state.json
```

and, when needed:

```text
geo/
tools/
data/
requirements.txt   (required whenever the app uses Python)
```

Every app is done only when:

1. it runs independently,
2. it has one clear geographic question,
3. the Watch surface visibly represents current state,
4. ANA can modify relevant state or behavior,
5. external data source use is documented,
6. results use a predictable data model,
7. errors are visible,
8. acceptance criteria in `SPEC.md` pass,
9. README contains example prompts,
10. README explains the next evolution step,
11. at least one README example prompt requests a capability the app does not have, and ANA proposes a code change that, once approved, is usable in the running app without a restart,
12. the app implements the shared contracts of §8 that apply to it — state synchronization (§8.2), Converse wiring (§8.3), external data proxy (§8.4), and the Python worker contract (§8.5) where Python is used,
13. runtime prerequisites are pinned: Node.js >= 20 LTS (global `fetch` is a precondition of §8.4), and, where Python is used, a `requirements.txt` installable with `pip install -r` plus a minimum Python version stated in the README — §32's prose "dependencies" section does not substitute for the manifest.

---

# 31. Required `SPEC.md` Template

Every app shall use the same specification format.

```markdown
# ANA Geo App Specification

## 1. Purpose
## 2. Core Geographic Question
## 3. User Stories
## 4. Watch Surface
## 5. Converse Surface
## 6. Data Sources
## 7. Dependencies
## 8. Functional Requirements
## 9. State Model
## 10. Data Model
## 11. Agent Actions
## 12. Error Handling
## 13. Acceptance Criteria
## 14. Evolution Examples
## 15. Next Evolution
```

Rules:

1. Every item in section 13 (Acceptance Criteria) must cite the FR IDs of section 8 (Functional Requirements). A criterion without a citation, or an FR without a criterion, is a spec defect. Criteria that verify cross-app contracts may cite the governing §30 DoD item instead of an FR (e.g., evolution criteria cite §30 item 11).
2. Section 14 (Evolution Examples) documents the evolution demonstrated for §30 item 11.
3. `PRD.md` is the canonical source for FRs and acceptance criteria; each app's `SPEC.md` restates them for that app and must not diverge.

---

# 32. Required `README.md` Content per App

Each README should contain:

1. app name,
2. one-sentence description,
3. screenshot,
4. core geographic question,
5. how to run,
6. dependencies,
7. external data sources,
8. example prompts,
9. current capabilities,
10. limitations,
11. next evolution.

Example:

```text
Current:
ana-geo-explorer

Question:
"What is there?"

Limitation:
Can discover objects, but cannot evaluate spatial relationships.

Next:
ana-geo-search

New capability:
Spatial predicates and multi-condition geographic search.
```

---

# 33. Recommended Demo Scenario

A consistent location should be used across examples so that users can compare stages.

Recommended default:

```text
Daejeon, Republic of Korea
```

Example progression:

### Map

```text
"Move to Daejeon."
```

### Explorer

```text
"Find universities and cafes."
```

### Search

```text
"Find cafes within 2 km of a university."
```

### Site

```text
"Rank candidate locations using university proximity, roads, and residential separation."
```

### Route

```text
"Find the fastest route from this candidate to the nearest major road or station."
```

### Satellite

```text
"Find a low-cloud Sentinel-2 image for this area."
```

### Change Detection

```text
"Compare it with an image from six months earlier."
```

This makes the seven applications feel like one evolving ANA Geo story.

---

# 34. Future Applications

The architecture should allow future applications such as:

```text
ana-geo-weather
ana-geo-disaster
ana-geo-mobility
ana-geo-osint
ana-geo-maritime
ana-geo-airspace
ana-geo-energy
ana-geo-urban
```

These should reuse the same conceptual capability layers:

```text
Vector
    ↓
Spatial
    ↓
Decision
    ↓
Network
    ↓
Earth Observation
    ↓
Temporal
```

---

# 35. Product Success Criteria

ANA Geo is successful when a user can clearly understand the following progression without needing an explanation of the source code:

```text
Map:
I can see geography.

Explorer:
I can discover what exists.

Search:
I can ask spatial questions.

Site:
I can make geographic decisions.

Route:
I can reason about connectivity.

Satellite:
I can observe the Earth at a point in time.

Change Detection:
I can reason about geographic change over time.
```

The final success criterion is:

> A user can start with a simple map and, through conversation with ANA, understand how the application can progressively evolve into a specialized geospatial agent.

---

# 36. Final Product Positioning

ANA Geo should be presented as:

> **Agent-Native GIS**

Not:

> GIS with a chatbot.

The distinguishing characteristic is not natural-language GIS commands alone.

The distinguishing characteristic is:

> **The agent exists inside the application runtime and can evolve the GIS itself while the user is operating it.**

