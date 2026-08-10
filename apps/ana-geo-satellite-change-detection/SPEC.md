# ANA Geo App Specification

## 1. Purpose

Introduce temporal Earth Observation analysis: the user discovers Sentinel-2 scenes through the app's own STAC search, picks a before/after pair over one MGRS tile, sets an NDVI change threshold, and gets ranked change polygons on the map — while ANA, living inside the runtime, can change the pair, the threshold, the change direction and the ranking, or evolve the analysis method itself.

## 2. Core Geographic Question

**What changed over time?**

## 3. User Stories

- As a user, I search Sentinel-2 scenes over the area I am looking at, filtered by date range and cloud cover.
- As a user, I pick one scene as "before" and another as "after", and I am stopped immediately if they are not on the same tile.
- As a user, I move a threshold slider and re-run the analysis to see fewer or more changed regions.
- As a user, I see the total changed area and a ranking of changed regions by area, and clicking a rank zooms the map to that region.
- As a user, I say "I care about vegetation loss, not vegetation growth." and the result only keeps the losses.
- As a user, I ask ANA to compare with an image from six months earlier and the analysis re-runs without me touching the panel.
- As a user, I ask for a capability the app lacks and ANA proposes a code change I can approve.

## 4. Watch Surface

Header + left panel (STAC search fields → before/after pair → analysis parameters → result explanation, summary table and ranked region list → layer list) + map (primary context) + status bar (center, zoom, active threshold, total changed area, the selected pair and its tile) — layout per PRD §10.2. The active threshold and the scene pair are always on screen (PRD §23.2), and the result opens with a plain-language explanation in the PRD §23.3 form: *"131 regions exceeded NDVI change threshold 0.25."*

STAC failures, worker failures, tile mismatches, empty results, cloud-obscured AOIs and truncation all render in the Watch surface (PRD §25), not only the console.

## 5. Converse Surface

Bottom chat bar wired per PRD §8.3: `POST /api/chat` → server inbox → `relay.js` (separate process) long-polls `/api/inbox-wait` and pushes messages to the ANA session; ANA replies via `POST /api/agent`, rendered in the feed.

## 6. Data Sources

- **Earth Search STAC API** (`https://earth-search.aws.element84.com/v1/search`), collection `sentinel-2-l2a` — scene discovery (PRD §20.2). No account, token or API key.
- **Sentinel-2 L2A COG assets** on `https://sentinel-cogs.s3.us-west-2.amazonaws.com` — the `red` (B04) and `nir` (B08) 10 m bands, read as HTTP range requests, never downloaded whole.
- OpenStreetMap raster tiles (basemap; browser-direct, exempt per PRD §8.4).

Both external hosts are on one allowlist, `ALLOWED_HOSTS = ['earth-search.aws.element84.com', 'sentinel-cogs.s3.us-west-2.amazonaws.com']` in `server.js` (PRD §8.4). The browser never calls either directly, and the Python worker's asset hrefs are checked against the same list *before* the worker is spawned. Every external operation is appended to `data/provenance.log` (PRD §28).

Copernicus Sentinel data, processed by ESA and redistributed by Element 84 / AWS Open Data.

## 7. Dependencies

- Node.js >= 20 LTS (global `fetch`) — no npm dependencies
- Leaflet 1.9.4, vendored at `vendor/leaflet/`
- **Python >= 3.10** with `requirements.txt` (`rasterio`, `numpy`), installed into `.venv/` (PRD §30 item 13)

No STAC client library and no GeoJSON conversion library: the catalog client is hand-written in `geo/stac.js`, and polygonization is `rasterio.features.shapes`.

## 8. Functional Requirements

PRD §21.5:

- **FR-CD-001 — Before Scene.** Any searched scene can be set as scene A; stored in `state.scenes.before`.
- **FR-CD-002 — After Scene.** Any searched scene can be set as scene B; stored in `state.scenes.after`.
- **FR-CD-003 — Spatial Alignment.** Two gates. The client refuses a pair whose MGRS tiles differ, and the worker re-checks the tile and then verifies that both scenes' CRS, resolution, pixel-grid origin and extent actually coincide before reading anything. v1 aligns by *requiring* a same-tile pair rather than by resampling — see §10.
- **FR-CD-004 — Index Calculation.** NDVI = (B08 − B04) / (B08 + B04) at 10 m, computed on the AOI window of both scenes.
- **FR-CD-005 — Difference Calculation.** `diff = NDVI(after) − NDVI(before)`.
- **FR-CD-006 — Threshold.** `state.detection.threshold` (default 0.20, slider 0.05–0.80) is the NDVI-difference magnitude that counts as change.
- **FR-CD-007 — Change Raster.** The threshold classifies the difference into a boolean change raster, filtered by `state.detection.direction` (`both` / `loss` / `gain`).
- **FR-CD-008 — Changed Area.** Total changed area = changed pixel count × pixel area, computed in the scene's UTM CRS, reported as `changedAreaSqKm`.
- **FR-CD-009 — Polygonize.** `rasterio.features.shapes` (4-connectivity) vectorizes the change raster; regions below `minRegionSqM` are dropped as speckle, and polygons are reprojected to lon/lat for the map.
- **FR-CD-010 — Map Visualization.** Change regions render as a GeoJSON layer, coloured by direction, served from `/api/results/change-regions`.
- **FR-CD-011 — Region Ranking.** Regions are ranked by area, largest first; `state.detection.regionLimit` restricts how many are listed and drawn.
- **FR-CD-012 — Scene Acquisition.** The app discovers its scenes through its own STAC search in `geo/stac.js`, implementing FR-SAT-001 (AOI from viewport), FR-SAT-003 (date range), FR-SAT-004 (collection `sentinel-2-l2a`), FR-SAT-005 (max cloud cover), FR-SAT-006 (query by AOI + dates + collection + cloud), FR-SAT-007 (footprints on the map), FR-SAT-008 (datetime, platform, cloud cover, scene ID, collection, available assets) and FR-SAT-009 (selection) in this app's own code. Nothing is imported from `ana-geo-satellite` (PRD §9).

FR-SAT-002 (AOI from a drawn polygon) is not part of FR-CD-012's list and is not implemented; the AOI is always the viewport.

## 9. State Model

PRD §12 baseline plus three app blocks:

- `stateVersion` — server-owned monotonic counter (§8.2-1). A new search or analysis bumps the affected layer's `resultVersion`, and therefore `stateVersion` (§8.2-6).
- `map.view` — set by ANA/loaded state, applied by every client; `map.observedView` — this client's own viewport, written with a 300 ms trailing debounce and never applied by other clients (§12 rule 4).
- `sceneSearch` — `collection`, `bbox` (last searched, `[w,s,e,n]`), `datetime` (`from/to`), `maxCloudCover`, `limit`, `requestId` (bump to make clients run a search), `lastRunAt`, `resultCount`, `note`.
- `scenes` — `before` and `after`, each a trimmed scene record: `id`, `collection`, `datetime`, `platform`, `cloudCover`, `gridCode`, `bbox`, `assetKeys`, and `assets.red` / `assets.nir` (`href`, `scale`, `offset`, `offsetSource`). A raw STAC item is ~15 KB of assets; only the two NDVI bands are kept.
- `detection` — `method`, `threshold`, `direction`, `minRegionSqM`, `regionLimit`, `requestId` (bump to make clients run the analysis), `lastRunAt`, `note`.
- `analysis` — `null`, or the PRD §21.6 result model at `analysis.changeDetection` plus `raster` (tile, CRS, pixel size, window, pixel counts), `aoiBbox`, `ranAt`, `elapsedMs` and `notes`.
- `layers[]` — reference-only entries (`stac-scenes`, `change-regions`): `id`, `type`, `label`, `category`, `source`, `visible`, `featureCount`, `resultRef`, `resultVersion`, `bbox`. **Feature bodies are never inlined** (§12 rule 3); the stored ranking is additionally capped at the top 50 regions, with the full set behind `resultRef`. A 131-region result leaves `state.json` around 12 KB.
- `selection` — the scene or change region the user last clicked, so ANA can see what is being inspected.

## 10. Data Model

Feature bodies live at `data/results/<id>.geojson`, served from `/api/results/<id>` as `FeatureCollection`s (PRD §11.1).

`stac-scenes` — one Feature per scene, geometry = the STAC item footprint, properties carrying the FR-SAT-008 metadata plus the red/nir asset records.

`change-regions` — one Feature per ranked region:

```json
{
  "type": "Feature",
  "id": "change-001",
  "geometry": { "type": "Polygon", "coordinates": [[[127.281539, 36.456542], "…"]] },
  "properties": {
    "name": "Change region 1",
    "category": "ndvi-change",
    "source": "sentinel-2-l2a",
    "sourceId": "S2B_52SCF_20250426_0_L2A→S2B_52SCF_20250725_0_L2A",
    "score": 0.475,
    "rank": 1,
    "areaSqKm": 0.8713,
    "metrics": { "areaSqM": 871300.0, "meanNdviDiff": 0.475, "minNdviDiff": -0.296, "maxNdviDiff": 0.7776 },
    "direction": "gain",
    "fetchedAt": "2026-08-10T16:52:36.458Z"
  }
}
```

The PRD §21.6 result model, stored at `state.analysis.changeDetection`:

```json
{
  "changeDetection": {
    "method": "ndvi-difference",
    "beforeScene": "S2B_52SCF_20250426_0_L2A",
    "afterScene": "S2B_52SCF_20250725_0_L2A",
    "threshold": 0.25,
    "direction": "both",
    "changedAreaSqKm": 9.8555,
    "regionsAreaSqKm": 6.2352,
    "regionCount": 131,
    "regions": [{ "id": "change-001", "rank": 1, "areaSqKm": 0.8713, "areaSqM": 871300.0, "meanDiff": 0.475, "minDiff": -0.296, "maxDiff": 0.7776, "direction": "gain" }]
  }
}
```

`changedAreaSqKm` counts every changed pixel, including speckle too small to become a region; `regionsAreaSqKm` sums only the ranked regions. They differ, and both are shown.

Three decisions in this model are worth stating because they are easy to get wrong:

**Areas are computed in UTM, never in degrees.** Every area comes from the shoelace formula on the polygon in the scene's own projected CRS (EPSG:326xx), where the unit is the metre. A square degree is not an area and varies with latitude.

**Alignment is by tile, not by resampling.** Two `sentinel-2-l2a` items with the same `grid:code` share CRS, resolution, extent and pixel grid exactly, so reading the same window from both yields co-registered arrays with no interpolation and no resampling error. A cross-tile pair is rejected with `incompatible_raster` rather than silently reprojected. Note that Earth Search writes `grid:code` as `MGRS-52SCF` while the `mgrs:*` property fallback composes `MGRS-52-S-CF`; the comparison ignores separators.

**BOA_ADD_OFFSET is honoured, not assumed.** Sentinel-2 processing baseline 04.00+ carries `BOA_ADD_OFFSET = -1000`, published as `offset: -0.1` alongside `scale: 1e-4` in the asset's `raster:bands`. NDVI is invariant to `scale` but **not** to `offset`, so the offset cannot be ignored — and it also must not be applied twice. Earth Search harmonizes its COGs and says so with `earthsearch:boa_offset_applied: true` while still publishing the `-0.1`. `geo/stac.js` therefore drops the declared offset exactly when the item claims it is already applied. This is not cosmetic: reapplying it to a 2025-10-28 Daejeon scene put 72% of red reflectances below zero, and NDVI then ran away on the near-zero denominators.

Result cap: **2,000 polygons** per analysis (PRD §26.1); AOI windows are capped at 16 M pixels per band. Both report truncation on the Watch surface.

## 11. Agent Actions

ANA operates by editing `state.json` through `PUT /api/state` (or directly on disk — the server bumps `stateVersion` on the next write) and replying via `POST /api/agent`:

- set `sceneSearch.datetime` / `maxCloudCover` and bump `sceneSearch.requestId` → every connected client runs a STAC search and the footprints appear **without a reload** ("Find a low-cloud image from July.")
- set `scenes.before` / `scenes.after` from the footprint layer and bump `detection.requestId` → the analysis re-runs ("Compare this with the image from six months ago.")
- set `detection.threshold` and bump `detection.requestId` → "Increase the threshold."
- set `detection.direction` to `loss` → "I care about vegetation loss, not vegetation growth."
- set `detection.regionLimit` to 3 → "Only show the three largest changed areas." (a display filter; no re-analysis)
- toggle `layers[].visible` → hide the footprints and keep the change regions
- set `map.view` → all clients move before searching
- read `map.observedView` (PRD §24.1) and `selection` to know what the user is looking at and what they clicked
- change `tools/worker.py` — e.g. add an NDBI or NDWI index — and the next run uses it (PRD §30 item 11)

## 12. Error Handling

Visible in the Watch surface (`#err`), per PRD §25:

- **STAC search failure** — proxy 403 (host not allowlisted), 400, 502 (upstream failure); an HTML error page or a JSON error document served with HTTP 200 is also treated as a failure, because a 200 is not proof of success.
- **empty search result** — "no scenes match this AOI, date range and cloud filter — widen the dates or raise the cloud limit"; scenes lacking red/nir assets are counted and reported.
- **Python worker failure** — the §8.5 envelope carries a code: `worker_failure` (unhandled exception; the traceback goes to stderr and stays there), `worker_timeout` (60 s, child killed), `worker_dependency_missing` (rasterio/numpy not installed, with the install command), `unknown_op`, `invalid_params`.
- **raster asset unavailable** — asset href missing, not https, not on the allowlist, or the COG cannot be opened or read.
- **incompatible raster data** — different MGRS tiles, or CRS / resolution / pixel-grid / extent mismatch between the four band reads, or no valid pixels for both scenes in the AOI.
- **invalid spatial condition** — AOI that does not intersect the scenes, degenerate bbox, or an AOI larger than the 16 M-pixel window cap.
- **unsupported geometry** — a bbox that is not `[west, south, east, north]`.
- **empty result** — "no pixel exceeded NDVI change threshold 0.20", or changed pixels found but no region reaching the minimum area.
- **partially unusable AOI** — when more than 20% of the window has no valid NDVI, the result says so and names both likely causes (cloud/water/shadow/scene edge, or a reflectance scaling mismatch).
- **invalid GeoJSON** — `PUT /api/results/<id>` rejects anything that is not a `FeatureCollection` (400).
- state save failure, layer fetch failure and sync loss are surfaced the same way.

Failures never arrive as an empty success: a failed run leaves the previous result untouched and puts the error code and message on screen.

## 13. Acceptance Criteria

Per PRD §21.8 — the app is complete when:

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

Verified by two offline suites plus one live run:

```bash
.venv/bin/python3 tools/smoke_synthetic.py   # 60 assertions — the raster pipeline against known areas
node tools/smoke_envelope.js                 # 37 assertions — the §8.5 envelope and geo/stac.js
```

`tools/smoke_synthetic.py` builds a UTM 52N / 10 m raster pair with three planted change patches (1200, 400 and 150 pixels) and asserts that the polygonized areas come back as 0.120, 0.040 and 0.015 km² in that rank order, that `changedAreaSqKm` is 0.176 km², that the mean NDVI differences are −0.500, +0.350 and −0.400, that raising the threshold to 0.45 leaves one region, that `direction` filtering splits 2 losses from 1 gain, and that a cross-tile pair, an AOI outside the scenes and a local asset path are each refused with their §25 code. `tools/smoke_envelope.js` checks that success, unknown op, forced exception, timeout and invalid params all come back as the same envelope shape, and locks in the tile-code normalization and the BOA-offset rule against a real-shaped Earth Search item.

Live run (2026-08-10): Daejeon farmland AOI, `S2B_52SCF_20250426` → `S2B_52SCF_20250725`, threshold 0.25 → 131 regions, 9.86 km² changed, largest region 0.87 km², 13.5 s end to end reading an 865×579 window out of two 10980×10980 band pairs.

## 14. Evolution Examples

Demonstration for PRD §30 item 11 — a README prompt asks for a capability the app does not have:

- **"Detect built-up change instead of vegetation change."** → ANA proposes adding NDBI ((SWIR − NIR) / (SWIR + NIR)) next to NDVI in `tools/worker.py`: one more band pair in `NDVI_BANDS`/`asset_of` (`swir16` is already in every item's asset list), one index function, and `state.detection.method` selecting between them. The threshold, polygonization, area and ranking code is unchanged, so the approved change is usable in the running app without a restart — the next `POST /api/analysis/change-detect` spawns the new worker.
- **"Show me where water appeared or disappeared."** → the same shape with NDWI ((GREEN − NIR) / (GREEN + NIR)) over the `green` asset.
- **"I want to detect building changes instead."** → *not* this evolution. Buildings are smaller than Sentinel-2's 10 m pixel, so this needs a higher-resolution imagery source and a segmentation pipeline (PRD §21.7). ANA should say so and propose the data-source change first, rather than pretending a new index will do it.

## 15. Next Evolution

This is the last app in the PRD §29 progression. Beyond it, PRD §34 lists the next family — `ana-geo-disaster`, `ana-geo-urban`, `ana-geo-weather` — which reuse this app's temporal raster layer with different indices, thresholds and cadences. Within this app, the honest next steps are cloud masking with the `scl` scene-classification asset (so cloud edges stop registering as change), cross-tile alignment by reprojection (lifting the same-tile restriction of FR-CD-003), and a time series rather than a pair.
