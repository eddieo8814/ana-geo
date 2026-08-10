# ANA Geo App Specification

## 1. Purpose

Extend ANA Geo into Earth Observation: search a public STAC catalog for Sentinel-2 scenes over an area and a time window, inspect what the satellite recorded, and place one scene's preview on the map — all operated by watching and by conversing with ANA, which lives inside the runtime and can evolve the app.

## 2. Core Geographic Question

**What did this place look like at a given time?**

## 3. User Stories

- As a user, I take the current viewport as my area of interest and search for imagery over it.
- As a user, I draw a rectangle on the map (shift-drag, or two clicks) when the viewport is not the area I mean.
- As a user, I narrow a search by date range and by maximum cloud cover, and see how many scenes came back.
- As a user, I see every matching scene's footprint on the map and its datetime, platform, cloud cover, scene ID, collection and asset list in a panel.
- As a user, I pick one scene and see its preview image laid over the map, so I know what the satellite actually saw.
- As a user, I ask ANA in plain language ("Only show images with less than 10% cloud.") and the search re-runs on every connected device.
- As a user, I ask for a capability the app lacks ("Show this scene at full resolution.") and ANA proposes a code change I can approve.

## 4. Watch Surface

Header + search/results panel (left) + map (primary context) + status bar (center, zoom, scene count, last-search summary) — layout per PRD §10.2. The panel holds AOI controls, date range, collection, cloud-cover slider, the scene list, and the active scene's metadata. Errors render in the Watch surface (PRD §25), not only the console: red for failures, amber for empty results and mode hints, green for a successful search.

## 5. Converse Surface

Bottom chat bar wired per PRD §8.3: `POST /api/chat` → server inbox → `relay.js` (separate process) long-polls `/api/inbox-wait` and pushes messages to the ANA session; ANA replies via `POST /api/agent`, rendered in the feed.

## 6. Data Sources

- **Earth Search — `https://earth-search.aws.element84.com/v1`**, collection `sentinel-2-l2a` (PRD §20.2, fixed for v1). `sentinel-2-c1-l2a` is selectable as the newer COG-only processing baseline, which §20.2 explicitly permits.
- **Sentinel-2 L2A assets** on `sentinel-cogs.s3.us-west-2.amazonaws.com` — public `https://`, no account, token or requester-pays `s3://`.
- OpenStreetMap raster tiles (basemap; browser-direct, exempt per PRD §8.4).

Both external hosts are on the `server.js` allowlist and every request to them goes through `/api/proxy` (§8.4). The browser never calls either host directly. **Two hosts are required, not one:** the catalog answers on `earth-search.aws.element84.com`, but the asset hrefs it returns — including `thumbnail` — point at the `sentinel-cogs` bucket, so allowlisting only the catalog host would make every scene preview fail with 403.

## 7. Dependencies

- Node.js >= 20 LTS (global `fetch`) — no npm dependencies
- Leaflet 1.9.4, vendored at `vendor/leaflet/`

No Python is used, so no `requirements.txt` is required (PRD §30 item 13).

## 8. Functional Requirements

PRD §20.3: FR-SAT-001 (AOI from viewport), FR-SAT-002 (AOI from a drawn or loaded polygon), FR-SAT-003 (date range), FR-SAT-004 (collection), FR-SAT-005 (max cloud cover), FR-SAT-006 (STAC search over AOI + date range + collection + cloud), FR-SAT-007 (scene footprints on the map), FR-SAT-008 (scene metadata: datetime, platform, cloud cover, scene ID, collection, available assets), FR-SAT-009 (active scene selection by user or ANA), FR-SAT-010 (active scene `thumbnail` rendered as an image overlay on the scene bbox).

## 9. State Model

PRD §12 baseline plus the §20.4 search model:

```json
{
  "satelliteSearch": {
    "collection": "sentinel-2-l2a",
    "bbox": [127.2, 36.24, 127.56, 36.46],
    "datetime": "2026-06-01/2026-08-11",
    "maxCloudCover": 20,
    "limit": 50,
    "aoiSource": "viewport",
    "requestId": 0
  },
  "scenes": [],
  "selection": { "activeSceneId": null, "thumbnailVisible": true },
  "analysis": { "lastSearch": null }
}
```

- `stateVersion` is the server-owned monotonic counter (§8.2-1); `map.view` / `map.observedView` keep the two-key viewport semantics of §12 rule 4.
- `satelliteSearch` is exactly the §20.4 model. `limit`, `aoiSource` and `requestId` are additive runtime fields: `aoiSource` records where the bbox came from (`viewport`, `drawn`, `polygon:<filename>`), and bumping `requestId` is how ANA makes connected clients re-run the search.
- `scenes` is a **geometry-free** index (`id`, `datetime`, `platform`, `cloudCover`, `collection`, `assetCount`) — feature bodies stay behind `resultRef` per §12 rule 3. **The array order is the panel's display order**, so ANA re-sorts the scene list by rewriting this array.
- `layers` holds one reference-only entry, `scene-footprints`, whose `resultVersion` bump is what tells polling clients the result set changed (§8.2-6).
- `analysis.lastSearch` records provenance for the last external operation (§28): timestamp, provider, endpoint, the exact request body, HTTP status, matched/returned counts and a human-readable message.

## 10. Data Model

Scene footprints are normalized to GeoJSON (§11.1) and stored server-side at `data/results/scene-footprints.geojson`, served from `/api/results/scene-footprints`. Each feature carries the STAC item geometry and the §11.1 common property model (`name`, `category`, `source`, `sourceId`, `score`, `metrics`, `fetchedAt`) plus the FR-SAT-008 scene metadata: `sceneId`, `collection`, `datetime`, `platform`, `instruments`, `cloudCover`, `gsd`, `assetKeys`, `sceneBbox`, `thumbnailHref`, `thumbnailType`.

Two deliberate reductions:

1. **The date range is stored as `YYYY-MM-DD/YYYY-MM-DD` and widened at query time.** §20.4 fixes that human-editable form so ANA can change a month in one edit, but Earth Search rejects bare dates with `400 BadRequest — "datetime value is invalid, does not match RFC3339 format"`. `geo/stac.js` widens the range to `…T00:00:00Z/…T23:59:59Z` when building the request.
2. **A loaded AOI polygon is reduced to its bounding box.** §20.4 fixes `bbox` as the search parameter, so a polygon narrower than its bbox will return scenes that touch the bbox but not the polygon.

## 11. Agent Actions

ANA operates by editing `state.json` through `PUT /api/state` (or directly on disk — the server bumps `stateVersion` on the next write) and replying via `POST /api/agent`:

- edit `satelliteSearch.datetime`, `collection`, `maxCloudCover`, `bbox`, `limit` → the controls update on every client (FR-SAT-003–FR-SAT-006),
- increment `satelliteSearch.requestId` → connected clients re-run the STAC search,
- reorder `scenes` → the panel list re-sorts (e.g. "Sort by lowest cloud cover."),
- set `selection.activeSceneId` → the scene becomes active everywhere; set `selection.thumbnailVisible` → the preview overlay toggles (FR-SAT-009, FR-SAT-010),
- toggle `layers[].visible` on `scene-footprints` (FR-SAT-007),
- `GET /api/results/scene-footprints` to read full scene metadata, and `analysis.lastSearch` to see what the last query asked and what came back,
- read `map.observedView` to know what the user is looking at (PRD §24.1),
- set `map.view` → all clients move,
- modify app code itself on request (proposal → approval, PRD §24.3).

## 12. Error Handling

Per PRD §25, visible in the Watch surface (`#err`):

- **STAC search failure** — the HTTP status and the parsed body are **both** checked, because neither is sufficient alone: an unknown collection returns `200` with an empty `FeatureCollection`, while a malformed `datetime` returns `400` with `{code, description}`. The message names which one failed.
- **External API unavailable** — a proxy/network failure is reported as "STAC provider unreachable through the proxy"; the proxy's own 403 (host not allowlisted) and 502 (upstream failure) surface with their status.
- **Empty search result** — "No scenes found — no scenes matched this AOI, date range and cloud limit."
- **Invalid spatial condition** — missing AOI ("set a bbox from the viewport or by drawing a rectangle"), start date after end date, malformed date.
- **Invalid GeoJSON** — a loaded AOI file that is not parseable JSON or has no coordinates.
- **Raster asset unavailable** — a scene with no `thumbnail` asset disables the overlay toggle with a note; an image that fails to load reports "thumbnail asset unavailable for `<scene id>`".

Server: 403 for non-allowlisted proxy hosts, 400 for non-`https:` targets, 403 for path traversal, 404 for unknown results, 400 for malformed bodies.

## 13. Acceptance Criteria

Per PRD §20.6 — the app is complete when:

- AOI can be defined from the viewport or a polygon (FR-SAT-001, FR-SAT-002),
- STAC search works against the default provider (FR-SAT-003, FR-SAT-004, FR-SAT-006),
- Sentinel-2 scenes can be listed and one selected as the active scene (FR-SAT-009),
- cloud filtering works (FR-SAT-005),
- footprints appear on the map (FR-SAT-007),
- scene metadata is inspectable (FR-SAT-008),
- the active scene is visible on the map as a thumbnail-fidelity image overlay (FR-SAT-010),
- ANA can alter default search behavior in `state.json` (FR-SAT-003–FR-SAT-006),
- ANA can evolve the app, e.g. add Sentinel-1 support or full-resolution rendering (§30 item 11).

### Note on FR-SAT-010 fidelity

The STAC item geometry is a reprojected quadrilateral while `L.imageOverlay` accepts only an axis-aligned rectangle, so the `thumbnail` is placed on `item.bbox`. Corner misalignment of up to a few kilometres is expected and accepted at this fidelity (PRD §20.3). Measured on `S2C_52SCF_20260804_0_L2A`: bbox corners sit **1.1–2.6 km** from the nearest footprint vertex. The thumbnail itself is 343×343 px over a ~111 km scene — about **325 m per pixel**. This is scene-level visual context, not analysis-grade imagery.

## 14. Evolution Examples

- **"Show this scene at full resolution."** → ANA proposes vendoring a browser COG reader (e.g. `geotiff.js`) and adding a tile source that range-reads the `visual` or `red`/`green`/`blue` COG assets through the existing `/api/proxy` (which already forwards `Range` and passes `206` through). Approved change is live on next reload. This is the §20.5 evolution request and satisfies §30 item 11.
- **"Add Sentinel-1 support."** → ANA proposes adding `sentinel-1-grd` to the collection list and a GRD-specific metadata renderer (no `eo:cloud_cover`, different asset keys).
- **"Also find an image from the same month last year."** → ANA proposes a second search slot and a paired scene list.

## 15. Next Evolution

`ana-geo-satellite-change-detection` — *"What changed over time?"* Two scenes instead of one, raster alignment and index differencing in a Python worker (PRD §8.5, §21), turning scene browsing into temporal analysis.
