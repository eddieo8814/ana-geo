# ANA Geo App Specification

## 1. Purpose

The stage where spatial filtering becomes decision support: candidate locations are measured against reference features, gated by hard pass/fail constraints, scored on weighted soft criteria, ranked, and made to explain themselves.

## 2. Core Geographic Question

**Which candidate is best?**

## 3. User Stories

- As a user, I drop candidate points on the map, or load a GeoJSON file of parcels, and see them listed.
- As a user, I acquire universities, major roads and residential areas for the area I am looking at.
- As a user, I say "Residential areas within 1 km should be rejected entirely." and the candidates that fail disappear from the ranking while still showing me why.
- As a user, I say "Road access is the most important factor — raise its weight to 50%." and the ranking reorders.
- As a user, I am told when my weights do not sum to 1.0, and I decide whether to fix them by hand or normalize.
- As a user, I click the winner and read "This site ranked #1 because: …".
- As a user, I ask for a capability the app lacks and ANA proposes a code change I can approve.

## 4. Watch Surface

Header + left panel (candidates, reference features, hard constraints, soft criteria with weights, ranking) + map (primary context) + status bar — layout per PRD §10.2. The status bar always shows the candidate count, the eligible count, the current leader and the active rule summary (PRD §23.2). The score breakdown for the selected candidate sits under the Rank button, and repeats in the candidate's map popup (PRD §23.3). Errors render in the Watch surface (PRD §25), not only the console.

Map colours encode the decision: gold = rank #1, green = ranked, dashed red = rejected by a hard constraint, grey = not yet scored, orange = a reference class a hard constraint depends on, blue = other reference classes. Each candidate carries a permanent tooltip with its rank and score.

The weight sum is always on screen next to the criteria, red when it is not 1.0.

## 5. Converse Surface

Bottom chat bar wired per PRD §8.3: `POST /api/chat` → server inbox → `relay.js` (separate process) long-polls `/api/inbox-wait` and pushes messages to the ANA session; ANA replies via `POST /api/agent`, rendered in the feed.

## 6. Data Sources

- OpenStreetMap via the Overpass API (`overpass-api.de`), reached only through the server proxy (PRD §8.4); the browser never calls it directly. Acquisition is scoped to the current map view and to the feature classes in `geo/registry.js`.
- User-provided GeoJSON, on two separate paths: **candidates** (points or polygons) and **reference features**, where an uploaded file replaces an OSM class outright. This is the route for authoritative land-use, cadastral or infrastructure data, and PRD §18.6 keeps such sources optional rather than required.
- OpenStreetMap raster tiles (basemap; browser-direct, exempt per PRD §8.4).

Every acquisition appends a provenance record (`operation`, `timestamp`, `source`, `featureClass`, `query`, `bbox`, `resultCount`) to `state.provenance` per PRD §24.4 and §28.

Two acquisition decisions are load-bearing and are recorded in `geo/registry.js`:

- **`road` is restricted to `highway~"^(motorway|trunk|primary|secondary)$"`.** Unfiltered `highway=*` returns residential streets, service roads and driveways; on a small Daejeon window that is more than ten times the §26.1 result cap, so the acquisition truncates and "distance to a road" silently becomes "distance to whichever roads happened to fit". Measured on the window `[127.360, 36.340, 127.420, 36.390]`, the four trunk grades return 548 ways.
- **`residential` is `landuse=residential`, and its coverage is sparse and uneven.** The class carries a `caution` string that the UI shows next to any hard constraint using it, and this SPEC repeats it: a pass/fail decision must not rest on this metric alone without authoritative land-use data.

## 7. Dependencies

- Node.js >= 20 LTS (global `fetch`) — no npm dependencies, no Python
- Leaflet 1.9.4, vendored at `vendor/leaflet/`
- Turf.js 7, vendored at `vendor/turf/turf.min.js` (PRD §14). Version 7.3+ is required for `pointToPolygonDistance`, which measures to a polygon's edge rather than its centroid.

Both libraries are copied into this app; nothing is imported from another app (PRD §9).

## 8. Functional Requirements

PRD §18.3:

- **FR-SITE-001** — Candidate locations as points or polygons. Map click (`POST /api/analysis/candidates` with `{lon, lat}`) or GeoJSON upload; `server.js: normalizeCandidate` refuses any other geometry by name.
- **FR-SITE-002** — Hard pass/fail rules, defined and edited in the constraint panel. `geo/rules.js: validateConstraint`, evaluated by `geo/scoring.js: compare` against the candidate's metrics.
- **FR-SITE-003** — Scoring criteria, defined and edited in the criteria panel. `geo/rules.js: validateCriterion`.
- **FR-SITE-004** — Each criterion carries a `weight`, editable as a percentage in the UI and as a fraction in state.
- **FR-SITE-005** — Weights are validated to sum to 1.0. `geo/rules.js: validateWeights`, recomputed by the server after every criterion edit and enforced by `evaluate`, which refuses to run.
- **FR-SITE-006** — Raw metrics per candidate, computed with Turf.js: nearest distance from the candidate to each referenced feature class, plus `area` for polygon candidates. `geo/scoring.js: pointToFeatureMeters`, dispatching on the reference geometry (point → `turf.distance`, way line → `turf.pointToLineDistance`, area → `turf.pointToPolygonDistance`).
- **FR-SITE-007** — Normalization to 0–100 against each criterion's `best`/`worst` bounds, clamped outside them. `geo/scoring.js: normalize`.
- **FR-SITE-008** — Final weighted score, Σ weight × normalized score. `geo/scoring.js: evaluate`.
- **FR-SITE-009** — Candidates ranked by score; only eligible candidates take a rank, and ties break on `candidateId` so a rerun over unchanged state produces the same order.
- **FR-SITE-010** — Per-candidate score breakdown: `criteriaScores`, `contributions` (score × weight = contribution, with the raw metric), and an `explanation` in the PRD §23.3 form. `geo/scoring.js: explain` / `explanationText`.

## 9. State Model

PRD §12 baseline — `stateVersion` (server-owned monotonic counter), `map.view` / `map.observedView` (two-key viewport semantics, §12 rule 4), `markers`, `layers`, `selection`, `analysis` — plus a top-level `provenance` array (§28).

`analysis.site` holds the decision model:

```json
{
  "candidates": { "ref": "/api/results/site-candidates", "version": 4, "count": 3, "bbox": [], "list": [], "indexOmitted": false },
  "constraints": [
    { "id": "residential", "kind": "distance", "featureClass": "residential", "metric": "residentialDistance",
      "operator": ">=", "value": 1000, "unit": "m", "enabled": true }
  ],
  "criteria": [
    { "id": "road", "label": "Road accessibility", "kind": "distance", "featureClass": "road",
      "metric": "roadDistance", "unit": "m", "best": 0, "worst": 2000, "weight": 0.4 }
  ],
  "weights": { "sum": 1, "valid": true, "error": null },
  "results": { "ref": "/api/analysis/results", "version": 2, "inline": true, "stale": false, "ranked": [] }
}
```

- **Candidate geometry is never in state** (§12 rule 3): `candidates.ref` points at the collection, and `list` holds identifiers and labels only — dropped entirely past 100 candidates (`indexOmitted`).
- **`metric` is derived, never supplied.** `geo/rules.js: deriveMetric` names it from the rule, so no rule can point at a metric the calculation stage does not produce.
- **A criterion's direction is read off its bounds.** `best` scores 100 and `worst` scores 0, so "closer is better" (`best < worst`) and "farther is better" cannot disagree with a separate direction field.
- **`weights` is recomputed server-side after every criterion edit** and mirrors what a run would decide. Edits that break the sum are accepted — you must be able to pass through an invalid intermediate state while retyping three weights — but the *run* refuses (FR-SITE-005).
- **`results` holds the §18.4 model.** Up to 25 candidates it is inlined as `ranked`; beyond that `inline` is false and the panel reads `ref`, keeping the state file small enough for the polling contract (§8.2) and for ANA to edit. Any candidate or rule change sets `stale`, because stale scores beside a changed rule are worse than none.

Layer entries hold references only (`resultRef`, `resultVersion`, `featureCount`, `bbox`), plus a `key` (the feature class) and `role`.

## 10. Data Model

The result document is PRD §18.4, with the additions FR-SITE-009 and FR-SITE-010 require:

```json
{
  "candidateId": "site-a",
  "eligible": true,
  "score": 55.2,
  "metrics": { "universityDistance": 600, "roadDistance": 2400, "residentialDistance": 2400 },
  "criteriaScores": { "university": 80, "road": 20, "residential": 76 },

  "rank": 1,
  "label": "SITE-A",
  "geometryType": "Point",
  "representativePoint": [127.351704, 36.374],
  "nearestReferences": { "universityDistance": "node/uni-1" },
  "constraintChecks": [{ "constraintId": "residential", "pass": true, "message": "…" }],
  "contributions": [{ "criterionId": "university", "score": 80, "weight": 0.4, "contribution": 32, "raw": 600, "unit": "m" }],
  "explanation": { "headline": "This site ranked #1 because:", "lines": ["University proximity: 80"], "detail": ["…"] }
}
```

The document wrapping them adds `generatedAt`, `candidateCount`, `eligibleCount`, `truncated`, `weights`, `warnings` and `summary`.

**Units.** Metrics are canonical: metres for distances, square metres for areas, so the `metrics` object needs no unit lookup to be read. Constraint thresholds and criterion bounds carry their own `unit` (`m`/`km`, or `m2`/`km2`/`ha`) and are converted before comparison.

**Approximations, stated once and enforced everywhere.** A polygon candidate is reduced to its centroid before any distance is measured — a 2 km-wide parcel whose centre is 1 km from a road reports 1 km even though its edge touches the road. Reference features keep their full geometry, so distances are measured to a road's centre line and to a residential area's edge. OSM relations become a single point at their bounding-box centre; their member geometry is not stitched. A closed way stays a `LineString` when its class expects a line, because a ring road turned into a polygon would report 0 m for every candidate inside the loop.

Acquired and derived feature sets live at `data/results/<id>.geojson`, served from `/api/results/<id>`, using the §11.1 property model.

## 11. Agent Actions

ANA operates by editing state and replying via `POST /api/agent`:

- `PATCH /api/analysis/criteria/road` with `{"weight": 0.5}` → "Road access is the most important factor." (FR-SITE-004)
- `PATCH /api/analysis/constraints/residential` with `{"value": 1000}` → "Residential areas within 1 km should be rejected entirely." (FR-SITE-002)
- `POST /api/analysis/criteria` → "Add distance to a substation as a new criterion." (FR-SITE-003)
- `POST /api/analysis/criteria/normalize` → the FR-SITE-005 fix, only when asked for
- `POST /api/analysis/constraints` with `{"kind": "area", "operator": ">=", "value": 20000, "unit": "m2"}` → "Rank only the candidates larger than 20,000 square metres."
- `POST`/`DELETE /api/analysis/candidates` → add or drop a candidate (FR-SITE-001)
- `PUT /api/analysis/results` → store a fresh ranking
- `PUT /api/state` for anything else (`map.view` to move every client, `layers[].visible` to toggle)
- read `map.observedView` to know what the user is looking at (PRD §24.1), and `state.provenance` to see what was fetched
- modify app code itself on request (proposal → approval, PRD §24.3)

Rules are addressable by id or by index, so "raise the road weight" needs no array arithmetic. Every one of these bumps `stateVersion`, so connected clients re-render within one 2.5 s poll without a reload.

## 12. Error Handling

Visible in the Watch surface (`#err`, `#weight-err`, the caution boxes), per PRD §25:

- **External API unavailable** — Overpass failures are classified from the body, never from the status code alone, because Overpass reports failure in three shapes that look different from the outside: HTTP 200 with an HTML or truncated body, HTTP 504, and HTTP 502/503. `geo/overpass.js: classify` parses the body first (so a road named "Timeout Boulevard" is not mistaken for a timeout), inspects a JSON `remark` for an aborted run, and only then falls back to text and status heuristics.
- **Empty search result** — "no Major road found in the current view" after an acquisition; "no candidate passed every hard constraint" after a run.
- **Invalid GeoJSON** — not parseable, not a Feature/FeatureCollection, or empty.
- **Unsupported geometry** — a candidate that is not a point or polygon is refused by name at the API boundary and again in `representativePoint`; an unhandled reference geometry names itself.
- **Invalid spatial condition** — unknown operator, a unit that does not belong to the rule's kind, a negative threshold, `best === worst`, or an unknown field, rejected with HTTP 400 by `server.js` and by `evaluate` in the browser.
- **Unbalanced weights** — FR-SITE-005: an explicit error stating the actual sum, with a separate Normalize action. Never an automatic rescale, because rescaling changes the ranking.
- **Missing reference features** — running with a rule whose class was never acquired names the class, rather than leaving the metric absent: "no residential areas acquired" and "no residential areas nearby" must never look the same.
- **Truncated acquisition** — a reference set that hits the 2,000-feature cap says so, because the metric would then measure to a partial set.
- **Sparse-data caution** — a hard constraint on `residential` (or another cautioned class) shows the class's warning beside the constraint and in the run's `warnings`.
- Server: 403 for non-allowlisted proxy hosts and path traversal, 404 for unknown results and rule references, 409 for a raw write to the candidate collection, 400 for malformed bodies.

Python worker failure, STAC search failure, and raster errors do not apply — this app runs no Python and reads no rasters (PRD §8.5).

## 13. Acceptance Criteria

Per PRD §18.7 — the app is complete when:

- candidates can be defined as points or polygons (FR-SITE-001),
- hard constraints and soft criteria are defined separately (FR-SITE-002, FR-SITE-003),
- criterion weights are editable and validated to sum to 1.0 (FR-SITE-004, FR-SITE-005),
- raw metrics are calculated and normalized to the 0–100 scale (FR-SITE-006, FR-SITE-007),
- final weighted scores are calculated and candidates are ranked (FR-SITE-008, FR-SITE-009),
- the score breakdown is visible per candidate (FR-SITE-010),
- ANA can alter constraints, criteria, and weights in `state.json` and the ranking updates (FR-SITE-002–FR-SITE-005),
- ANA can evolve the app, e.g. add a new criterion type in code (§30, item 11 — see section 14).

`node tools/smoke_scoring.mjs` checks FR-SITE-001–FR-SITE-010 offline, with no server and no network. Its fixture — three candidates, one university point, one major-road line and one residential polygon, all placed at exact distances on one parallel — is cross-checked against an independent haversine implementation before any score is asserted, and every expected score is hand-calculated in a comment beside the assertion. It also verifies that the hard constraint (not the score) is what removes a candidate, that changing only the weights flips the winner, and that an unbalanced weight sum is refused rather than silently normalized.

## 14. Evolution Examples

Demonstrates PRD §30 item 11 — the README prompt *"Rank them by drive time to the nearest hospital instead of straight-line distance."* asks for a capability this app does not have: every metric is a straight-line distance, and nothing here knows that roads connect. ANA proposes adding a travel-time metric kind backed by a routing service; on approval it joins `KINDS` in `geo/rules.js`, gains a branch in `geo/scoring.js`, becomes selectable in every criterion row, and is usable in the running app on the next reload.

Other evolutions in the same shape:

- "Score them relative to each other, not against fixed bounds." → ANA proposes a `scale: "relative"` criterion mode that min-max normalizes across the eligible candidates instead of using `best`/`worst`.
- "Add slope as a criterion." → ANA proposes a DEM-backed metric kind, which is where `ana-geo-satellite` becomes a dependency.

## 15. Next Evolution

`ana-geo-route` — "How do I get there?": the network layer this app cannot reason about. Site scoring measures straight-line distance to a road; routing measures travel along it, which turns "850 m from a major road" into "4 minutes from the interchange".
