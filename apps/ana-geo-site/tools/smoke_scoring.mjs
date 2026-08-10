// Offline verification of the site-decision pipeline (FR-SITE-001 … FR-SITE-010)
// and of the rule vocabulary. Runs without a server and without network:
//
//   node tools/smoke_scoring.mjs
//
// Fixture — Daejeon (PRD §33), everything on the 36.3740 parallel so that the
// intended distances are exact and independently checkable:
//
//        residential (polygon)
//   UNI      a      b      c   |███ 3.0–4.0 km ███|
//    0km   0.6km  1.2km  2.4km |
//                              road (meridian line at 3.0 km)
//
// so the raw metrics are, in metres:
//
//   candidate | universityDistance | roadDistance | residentialDistance
//   site-a    |                600 |         2400 |                2400
//   site-b    |               1200 |         1800 |                1800
//   site-c    |               2400 |          600 |                 600
//
// Every one of those is cross-checked against an independent haversine
// implementation in this file before any score is asserted, so a wrong unit or
// a wrong earth radius fails here rather than surviving into a ranking.
//
// The scores below are then hand-calculated from that table and the criteria
// defined in `CRITERIA`; see the comment above each expectation.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scoring = require('../geo/scoring.js');
const rules = require('../geo/rules.js');
const registry = require('../geo/registry.js');
const overpass = require('../geo/overpass.js');

const R = 6371.0088; // km — Turf's earth radius
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// Independent great-circle distance (km).
function haversine([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Point at `km` from origin along `bearing` degrees.
function destination([lon, lat], km, bearing) {
  const d = km / R;
  const b = rad(bearing);
  const lat1 = rad(lat);
  const lon1 = rad(lon);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(
    Math.sin(b) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
  );
  return [deg(lon2), deg(lat2)];
}

const LAT = 36.3740;
const ORIGIN = [127.3450, LAT];
// East–west offsets are set by great-circle distance; the latitude is pinned to
// LAT so every reference is a clean meridian and the geometry stays exact.
const lonAt = (km) => destination(ORIGIN, km, 90)[0];
const at = (km) => [lonAt(km), LAT];

const candidate = (id, coords) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: coords },
  properties: { label: id.toUpperCase(), category: 'candidate', source: 'fixture', score: null, metrics: {} },
});

const CANDIDATES = {
  type: 'FeatureCollection',
  features: [candidate('site-a', at(0.6)), candidate('site-b', at(1.2)), candidate('site-c', at(2.4))],
};

// One university, as a node (FR-SITE-006 point path).
const UNIVERSITY = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature', id: 'node/uni-1',
    geometry: { type: 'Point', coordinates: ORIGIN },
    properties: { name: 'Fixture University', category: 'university', source: 'fixture' },
  }],
};

// One major road, as a way line running north–south at 3.0 km east; it spans
// the candidates' latitude, so the nearest point is the perpendicular foot
// (turf.pointToLineDistance).
const ROAD = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature', id: 'way/road-1',
    geometry: { type: 'LineString', coordinates: [[lonAt(3.0), 36.3400], [lonAt(3.0), 36.4100]] },
    properties: { name: 'Fixture-daero', category: 'road', source: 'fixture', tags: { highway: 'primary' } },
  }],
};

// One residential area, as a way polygon from 3.0 km to 4.0 km east; the
// candidates are all west of it, so the nearest point is on its west edge
// (turf.pointToPolygonDistance).
const RESIDENTIAL = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature', id: 'way/res-1',
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [lonAt(3.0), 36.3400], [lonAt(4.0), 36.3400],
        [lonAt(4.0), 36.4100], [lonAt(3.0), 36.4100], [lonAt(3.0), 36.3400],
      ]],
    },
    properties: { name: 'Fixture-dong', category: 'residential', source: 'fixture', tags: { landuse: 'residential' } },
  }],
};

const SETS = { university: UNIVERSITY, road: ROAD, residential: RESIDENTIAL };
const resolve = (k) => SETS[k] || null;

// The rules under test. Weights sum to exactly 1.0 (FR-SITE-005).
const CONSTRAINTS = [
  { id: 'residential', kind: 'distance', featureClass: 'residential', metric: 'residentialDistance', operator: '>=', value: 1000, unit: 'm', enabled: true },
];
const CRITERIA = [
  { id: 'university', label: 'University proximity', kind: 'distance', featureClass: 'university', metric: 'universityDistance', unit: 'm', best: 0, worst: 3000, weight: 0.4 },
  { id: 'road', label: 'Road accessibility', kind: 'distance', featureClass: 'road', metric: 'roadDistance', unit: 'm', best: 0, worst: 3000, weight: 0.4 },
  { id: 'residential', label: 'Residential separation', kind: 'distance', featureClass: 'residential', metric: 'residentialDistance', unit: 'm', best: 3000, worst: 500, weight: 0.2 },
];

// ---------- harness ----------

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const close = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;
const byId = (doc) => new Map(doc.results.map((r) => [r.candidateId, r]));

// ---------- FR-SITE-006: raw metrics ----------

console.log('\n[FR-SITE-006] raw metrics — Turf vs. the intended fixture geometry');
const run = scoring.evaluate({ candidates: CANDIDATES, constraints: CONSTRAINTS, criteria: CRITERIA }, resolve);
const R1 = byId(run);

// Independent check of the fixture itself: the university is a point, so its
// distance is a plain great-circle distance and haversine settles it.
for (const [id, km] of [['site-a', 0.6], ['site-b', 1.2], ['site-c', 2.4]]) {
  const coords = CANDIDATES.features.find((f) => f.id === id).geometry.coordinates;
  const ref = haversine(coords, ORIGIN) * 1000;
  check(`${id}: fixture is ${km * 1000} m from the university (haversine ${ref.toFixed(4)} m)`, close(ref, km * 1000, 0.05), `${ref}`);
  check(`${id}: universityDistance = ${km * 1000} m`, close(R1.get(id).metrics.universityDistance, km * 1000, 0.5), String(R1.get(id).metrics.universityDistance));
}

// A line reference goes through pointToLineDistance, a polygon reference
// through pointToPolygonDistance; both are measured to the geometry, not to a
// centroid, which is what these two blocks pin down.
for (const [id, m] of [['site-a', 2400], ['site-b', 1800], ['site-c', 600]]) {
  check(`${id}: roadDistance = ${m} m (point→line)`, close(R1.get(id).metrics.roadDistance, m, 0.5), String(R1.get(id).metrics.roadDistance));
  check(`${id}: residentialDistance = ${m} m (point→polygon edge)`, close(R1.get(id).metrics.residentialDistance, m, 0.5), String(R1.get(id).metrics.residentialDistance));
}
{
  // The polygon spans 3.0–4.0 km east, so its centroid sits at 3.5 km. If the
  // engine measured to centroids instead of edges, site-c would read 1100 m.
  check('polygon distance is edge distance, not centroid distance', close(R1.get('site-c').metrics.residentialDistance, 600, 0.5), String(R1.get('site-c').metrics.residentialDistance));
  const inside = scoring.pointToFeatureMeters(
    { type: 'Feature', geometry: { type: 'Point', coordinates: at(3.5) }, properties: {} },
    RESIDENTIAL.features[0],
  );
  check('a point inside the polygon is 0 m from it', close(inside, 0, 1e-6), String(inside));
}

// ---------- FR-SITE-002: hard constraints ----------

console.log('\n[FR-SITE-002] hard constraints — residentialDistance >= 1000 m');
check('site-a passes (2400 >= 1000)', R1.get('site-a').eligible === true);
check('site-b passes (1800 >= 1000)', R1.get('site-b').eligible === true);
check('site-c fails (600 < 1000)', R1.get('site-c').eligible === false);
check('exactly one candidate is rejected', run.eligibleCount === 2, String(run.eligibleCount));
check('the failing check names the metric, the value and the threshold',
  /residentialDistance is 600(\.\d+)? m, which fails >= 1000 m/.test(R1.get('site-c').constraintChecks[0].message),
  R1.get('site-c').constraintChecks[0].message);
{
  // A boundary value must pass a `>=` rule rather than fall foul of rounding.
  const edge = scoring.evaluate({
    candidates: CANDIDATES,
    constraints: [{ ...CONSTRAINTS[0], value: 600 }],
    criteria: CRITERIA,
  }, resolve);
  check('site-c passes when the threshold is exactly its distance (>=, 600 m)', byId(edge).get('site-c').eligible === true);
  const strict = scoring.evaluate({
    candidates: CANDIDATES,
    constraints: [{ ...CONSTRAINTS[0], operator: '>', value: 600 }],
    criteria: CRITERIA,
  }, resolve);
  check('and fails the same threshold under ">"', byId(strict).get('site-c').eligible === false);
}

// ---------- FR-SITE-007: normalization ----------

console.log('\n[FR-SITE-007] normalization to 0–100');
// university: best 0 m → 100, worst 3000 m → 0, so score = (3000 − raw) / 30
//   site-a 600 → 80,  site-b 1200 → 60,  site-c 2400 → 20
for (const [id, s] of [['site-a', 80], ['site-b', 60], ['site-c', 20]]) {
  check(`${id}: university score = ${s}`, close(R1.get(id).criteriaScores.university, s, 0.05), String(R1.get(id).criteriaScores.university));
}
// road: best 0 m → 100, worst 3000 m → 0, so score = (3000 − raw) / 30
//   site-a 2400 → 20,  site-b 1800 → 40,  site-c 600 → 80
for (const [id, s] of [['site-a', 20], ['site-b', 40], ['site-c', 80]]) {
  check(`${id}: road score = ${s}`, close(R1.get(id).criteriaScores.road, s, 0.05), String(R1.get(id).criteriaScores.road));
}
// residential separation runs the other way — best 3000 m → 100, worst 500 m → 0,
// so score = (raw − 500) / 25:  2400 → 76,  1800 → 52,  600 → 4
for (const [id, s] of [['site-a', 76], ['site-b', 52], ['site-c', 4]]) {
  check(`${id}: residential-separation score = ${s}`, close(R1.get(id).criteriaScores.residential, s, 0.05), String(R1.get(id).criteriaScores.residential));
}
check('direction is read off the bounds, not declared twice',
  scoring.criterionDirection(CRITERIA[0]) === 'lower_is_better' && scoring.criterionDirection(CRITERIA[2]) === 'higher_is_better');
{
  // Values beyond either bound clamp instead of leaving the 0–100 scale.
  const c = CRITERIA[0];
  check('a value worse than `worst` clamps to 0', scoring.normalize(9000, c) === 0);
  check('a value better than `best` clamps to 100', scoring.normalize(-5, c) === 100);
  check('unit conversion: 1.5 km == 1500 m on the same scale',
    scoring.normalize(scoring.toCanonical(1.5, 'km', 'distance'), c) === scoring.normalize(1500, c));
  let threw = '';
  try { scoring.normalize(100, { ...c, best: 500, worst: 500 }); } catch (e) { threw = e.message; }
  check('best === worst is rejected rather than dividing by zero (§25)', /best === worst/.test(threw), threw);
}

// ---------- FR-SITE-008 / FR-SITE-009: weighted score and ranking ----------

console.log('\n[FR-SITE-008] weighted score (0.4 university + 0.4 road + 0.2 residential)');
// site-a: 0.4×80 + 0.4×20 + 0.2×76 = 32 + 8 + 15.2 = 55.2
// site-b: 0.4×60 + 0.4×40 + 0.2×52 = 24 + 16 + 10.4 = 50.4
// site-c: 0.4×20 + 0.4×80 + 0.2× 4 =  8 + 32 +  0.8 = 40.8   (rejected, but still scored)
for (const [id, s] of [['site-a', 55.2], ['site-b', 50.4], ['site-c', 40.8]]) {
  check(`${id}: weighted score = ${s}`, close(R1.get(id).score, s, 0.05), String(R1.get(id).score));
}
check('contributions sum to the score',
  close(R1.get('site-a').contributions.reduce((a, c) => a + c.contribution, 0), 55.2, 0.05));

console.log('\n[FR-SITE-009] ranking');
check('site-a ranks #1', R1.get('site-a').rank === 1, String(R1.get('site-a').rank));
check('site-b ranks #2', R1.get('site-b').rank === 2, String(R1.get('site-b').rank));
check('the rejected candidate takes no rank', R1.get('site-c').rank === null, String(R1.get('site-c').rank));
check('eligible candidates lead the ordered result set',
  run.results.map((r) => r.candidateId).join(',') === 'site-a,site-b,site-c', run.results.map((r) => r.candidateId).join(','));
{
  // The hard constraint is what removed site-c, not its score: with the
  // constraint disabled it is ranked, and it still comes third.
  const open = scoring.evaluate({ candidates: CANDIDATES, constraints: [{ ...CONSTRAINTS[0], enabled: false }], criteria: CRITERIA }, resolve);
  check('with the constraint disabled every candidate is ranked', open.eligibleCount === 3, String(open.eligibleCount));
  check('site-c then ranks #3 with the same 40.8', byId(open).get('site-c').rank === 3 && close(byId(open).get('site-c').score, 40.8, 0.05));

  // FR-SITE-004 — the weights, not the metrics, decide the winner. Weighting
  // road accessibility at 0.8 flips the ranking to site-c.
  // site-a: 0.2×80 + 0.8×20 = 16 + 16 = 32
  // site-b: 0.2×60 + 0.8×40 = 12 + 32 = 44
  // site-c: 0.2×20 + 0.8×80 =  4 + 64 = 68
  const reweighted = scoring.evaluate({
    candidates: CANDIDATES,
    constraints: [],
    criteria: [{ ...CRITERIA[0], weight: 0.2 }, { ...CRITERIA[1], weight: 0.8 }],
  }, resolve);
  const R2 = byId(reweighted);
  check('reweighted: site-c 68, site-b 44, site-a 32',
    close(R2.get('site-c').score, 68, 0.05) && close(R2.get('site-b').score, 44, 0.05) && close(R2.get('site-a').score, 32, 0.05),
    [R2.get('site-c').score, R2.get('site-b').score, R2.get('site-a').score].join(','));
  check('reweighting flips the winner to site-c', R2.get('site-c').rank === 1, String(R2.get('site-c').rank));
}

// ---------- FR-SITE-005: weight validation ----------

console.log('\n[FR-SITE-005] weight validation');
{
  const over = CRITERIA.map((c) => ({ ...c, weight: 0.4 })); // sums to 1.2
  const v = scoring.validateWeights(over);
  check('a sum of 1.2 is invalid', v.valid === false && close(v.sum, 1.2, 1e-9), JSON.stringify(v));
  check('the error states the sum and cites FR-SITE-005', /sum to 1\.0/.test(v.error) && /1\.2/.test(v.error) && /FR-SITE-005/.test(v.error), v.error);

  let threw = '';
  try { scoring.evaluate({ candidates: CANDIDATES, constraints: CONSTRAINTS, criteria: over }, resolve); }
  catch (e) { threw = e.message; }
  check('a run with unbalanced weights is refused, not silently normalized', /sum to 1\.0/.test(threw), threw);

  const under = CRITERIA.map((c) => ({ ...c, weight: c.weight / 2 })); // sums to 0.5
  check('a sum of 0.5 is invalid too', scoring.validateWeights(under).valid === false);
  check('the exact fixture weights are valid', scoring.validateWeights(CRITERIA).valid === true);
  check('a negative weight is rejected by name',
    /invalid weight/.test(scoring.validateWeights([{ id: 'x', weight: -0.5 }]).error || ''),
    scoring.validateWeights([{ id: 'x', weight: -0.5 }]).error);
  check('an empty criteria list is invalid', scoring.validateWeights([]).valid === false);

  // The auto-fix is a separate, explicit action (FR-SITE-005).
  const fixed = scoring.normalizeWeights(over);
  check('normalize rescales to exactly 1.0', scoring.validateWeights(fixed).valid === true, String(fixed.reduce((a, c) => a + c.weight, 0)));
  check('normalize keeps the weights proportional', fixed.every((c) => close(c.weight, 1 / 3, 1e-6)), fixed.map((c) => c.weight).join(','));
  const skewed = scoring.normalizeWeights([{ id: 'a', weight: 3 }, { id: 'b', weight: 1 }]);
  check('normalize preserves a 3:1 ratio', close(skewed[0].weight, 0.75, 1e-9) && close(skewed[1].weight, 0.25, 1e-9), skewed.map((c) => c.weight).join(','));
  const ranking = scoring.evaluate({ candidates: CANDIDATES, constraints: CONSTRAINTS, criteria: scoring.normalizeWeights(over) }, resolve);
  check('a normalized set then runs', ranking.eligibleCount === 2);
}

// ---------- FR-SITE-010 / §23.3: explanation ----------

console.log('\n[FR-SITE-010] score breakdown and the §23.3 explanation');
{
  const a = R1.get('site-a');
  check('headline is "This site ranked #1 because:"', a.explanation.headline === 'This site ranked #1 because:', a.explanation.headline);
  // Ordered by contribution: university 32, residential 15.2, road 8.
  check('lines are the criterion scores, strongest contribution first',
    a.explanation.lines.join(' | ') === 'University proximity: 80 | Residential separation: 76 | Road accessibility: 20',
    a.explanation.lines.join(' | '));
  check('the text form matches §23.3',
    scoring.explanationText(a) === 'This site ranked #1 because:\n- University proximity: 80\n- Residential separation: 76\n- Road accessibility: 20',
    JSON.stringify(scoring.explanationText(a)));
  check('the detail line shows score × weight = contribution',
    /University proximity: 80 × weight 0\.4 = 32 \(universityDistance 600(\.\d+)? m\)/.test(a.explanation.detail[0]), a.explanation.detail[0]);

  const c = R1.get('site-c');
  check('a rejected candidate explains the rejection instead of a rank',
    c.explanation.headline === 'SITE-C was rejected because:' && c.explanation.lines.length === 1, JSON.stringify(c.explanation));
  check('the nearest reference feature is named for provenance',
    c.nearestReferences.residentialDistance === 'way/res-1', String(c.nearestReferences.residentialDistance));
}

// ---------- §18.4: the result model ----------

console.log('\n[§18.4] candidate result model');
{
  const a = R1.get('site-a');
  for (const k of ['candidateId', 'eligible', 'score', 'metrics', 'criteriaScores']) {
    check(`result carries "${k}"`, Object.prototype.hasOwnProperty.call(a, k));
  }
  check('metrics are keyed as in §18.4 (roadDistance, residentialDistance)',
    ['universityDistance', 'roadDistance', 'residentialDistance'].every((k) => k in a.metrics), Object.keys(a.metrics).join(','));
  check('criteriaScores are keyed by criterion id',
    ['university', 'road', 'residential'].every((k) => k in a.criteriaScores), Object.keys(a.criteriaScores).join(','));
  check('the document round-trips through JSON unchanged',
    JSON.stringify(JSON.parse(JSON.stringify(run))) === JSON.stringify(run));
  check('a data-quality caution is raised for a hard constraint on residential',
    run.warnings.some((w) => /landuse=residential/.test(w)), JSON.stringify(run.warnings));
}

// ---------- FR-SITE-001: polygon candidates and the area metric ----------

console.log('\n[FR-SITE-001] polygon candidates (centroid representative point) and area');
{
  // A square of side 0.4 km centred 1.8 km east: its centroid is the point the
  // distances are measured from, and turf.area gives roughly 160,000 m².
  const west = lonAt(1.6);
  const east = lonAt(2.0);
  const south = destination(at(1.8), 0.2, 180)[1];
  const north = destination(at(1.8), 0.2, 0)[1];
  const parcel = {
    type: 'Feature', id: 'site-d',
    geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] },
    properties: { label: 'SITE-D', category: 'candidate' },
  };
  const polyRun = scoring.evaluate({
    candidates: { type: 'FeatureCollection', features: [parcel] },
    constraints: [{ id: 'area', kind: 'area', metric: 'area', operator: '>=', value: 20000, unit: 'm2', enabled: true }],
    criteria: [{ ...CRITERIA[0], weight: 1 }],
  }, resolve);
  const d = byId(polyRun).get('site-d');
  check('a polygon candidate is measured from its centroid (1800 m to the university)',
    close(d.metrics.universityDistance, 1800, 2), String(d.metrics.universityDistance));
  check('area is computed for the polygon (≈160,000 m²)', close(d.metrics.area, 160000, 2000), String(d.metrics.area));
  check('the area constraint passes (>= 20,000 m²)', d.eligible === true);
  check('area normalizes on the same 0–100 scale as a distance',
    close(scoring.normalize(160000, { id: 'a', kind: 'area', unit: 'm2', best: 200000, worst: 0 }), 80, 0.05));

  // §18.5 — "Rank only the candidates larger than 20,000 square metres."
  const pointRun = scoring.evaluate({
    candidates: { type: 'FeatureCollection', features: [candidate('site-a', at(0.6))] },
    constraints: [{ id: 'area', kind: 'area', metric: 'area', operator: '>=', value: 20000, unit: 'm2', enabled: true }],
    criteria: [{ ...CRITERIA[0], weight: 1 }],
  }, resolve);
  const pa = byId(pointRun).get('site-a');
  check('an area rule on a point candidate is reported, not guessed',
    pa.eligible === false && /point candidate/.test(pa.constraintChecks[0].message), pa.constraintChecks[0].message);

  let threw = '';
  try {
    scoring.evaluate({
      candidates: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'x', geometry: { type: 'LineString', coordinates: [[127.3, 36.3], [127.4, 36.4]] }, properties: {} }] },
      constraints: [], criteria: [{ ...CRITERIA[0], weight: 1 }],
    }, resolve);
  } catch (e) { threw = e.message; }
  check('a line candidate is rejected as an unsupported geometry (§25)', /unsupported candidate geometry/.test(threw), threw);
}

// ---------- §25: failure states ----------

console.log('\n[§25] failure states');
{
  let threw = '';
  try { scoring.evaluate({ candidates: { type: 'FeatureCollection', features: [] }, constraints: [], criteria: CRITERIA }, resolve); }
  catch (e) { threw = e.message; }
  check('no candidates is an error naming FR-SITE-001', /no candidates defined/.test(threw), threw);

  let threw2 = '';
  try {
    scoring.evaluate({ candidates: CANDIDATES, constraints: CONSTRAINTS, criteria: CRITERIA },
      (k) => (k === 'residential' ? null : SETS[k]));
  } catch (e) { threw2 = e.message; }
  check('a missing reference set is an error, not an absent metric', /no reference features acquired for "residential"/.test(threw2), threw2);

  let threw3 = '';
  try { scoring.evaluate({ candidates: CANDIDATES, constraints: [{ ...CONSTRAINTS[0], operator: '≥' }], criteria: CRITERIA }, resolve); }
  catch (e) { threw3 = e.message; }
  check('an unknown operator is rejected by name', /unknown operator/.test(threw3), threw3);

  let threw4 = '';
  try { scoring.evaluate({ candidates: CANDIDATES, constraints: [{ ...CONSTRAINTS[0], unit: 'miles' }], criteria: CRITERIA }, resolve); }
  catch (e) { threw4 = e.message; }
  check('an unsupported unit is rejected by name', /unsupported unit "miles"/.test(threw4), threw4);
}

// ---------- rule vocabulary (geo/rules.js — what server.js validates with) ----------

console.log('\n[FR-SITE-002/003/004] rule validation shared by server.js and the browser');
{
  check('a well-formed constraint validates', rules.validateConstraint({ kind: 'distance', featureClass: 'road', operator: '<=', value: 500, unit: 'm' }, null) === null);
  check('an unknown field is rejected', /unknown constraint field/.test(rules.validateConstraint({ radius: 5 }, CONSTRAINTS[0]) || ''));
  check('a negative threshold is rejected', /must not be negative/.test(rules.validateConstraint({ value: -1 }, CONSTRAINTS[0]) || ''));
  check('a distance rule without a feature class is rejected', /needs a featureClass/.test(rules.validateConstraint({ kind: 'distance', operator: '>=', value: 1, unit: 'm' }, null) || ''));
  check('m² is not a valid unit for a distance rule', /not valid for a distance rule/.test(rules.validateConstraint({ unit: 'm2' }, CONSTRAINTS[0]) || ''));
  check('a partial patch validates against the merged rule', rules.validateConstraint({ value: 2 }, { ...CONSTRAINTS[0], unit: 'km' }) === null);
  check('best === worst is rejected at the API boundary too', /best and worst must differ/.test(rules.validateCriterion({ worst: 0 }, CRITERIA[0]) || ''));
  check('a criterion weight must be a number', /weight must be a finite number/.test(rules.validateCriterion({ weight: '0.5' }, CRITERIA[0]) || ''));

  check('metric names are derived, never supplied', rules.deriveMetric({ kind: 'distance', featureClass: 'power_line' }) === 'powerDistance');
  check('an area rule reads the "area" metric', rules.deriveMetric({ kind: 'area' }) === 'area');
  check('rules resolve by id', rules.indexOfRule(CRITERIA, 'road') === 1);
  check('rules resolve by index', rules.indexOfRule(CRITERIA, '2') === 2);
  check('an unknown rule reference resolves to -1', rules.indexOfRule(CRITERIA, 'slope') === -1);
  const completed = rules.completeRule({ kind: 'distance', featureClass: 'road', operator: '>=', value: 100 }, CONSTRAINTS, 'constraint');
  check('completeRule fills in id, unit, metric and enabled',
    completed.id === 'road' && completed.unit === 'm' && completed.metric === 'roadDistance' && completed.enabled === true,
    JSON.stringify(completed));
  const dup = rules.completeRule({ kind: 'distance', featureClass: 'residential', operator: '<=', value: 100 }, CONSTRAINTS, 'constraint');
  check('a duplicate id is suffixed rather than colliding', dup.id === 'residential-2', dup.id);
}

// ---------- reference acquisition (geo/registry.js + geo/overpass.js) ----------

console.log('\n[FR-SITE-006 input] feature class registry and Overpass query building');
{
  check('every class declares a metric, a geometry and its OSM elements',
    registry.keys().every((k) => {
      const c = registry.get(k);
      return c.metric && c.geometry && Array.isArray(c.elements) && c.elements.length;
    }));
  check('the demo classes exist', ['university', 'road', 'residential'].every((k) => registry.has(k)));
  check('residential carries a data-quality caution', /sparse/.test(registry.caution('residential') || ''));
  check('university carries none', registry.caution('university') === null);

  const roadQuery = overpass.buildQuery('road', [127.3, 36.3, 127.4, 36.4], 2000);
  check('road filters four highway grades with one regex',
    roadQuery.includes('["highway"~"^(motorway|trunk|primary|secondary)$"]'), roadQuery);
  check('road asks for ways only — a major road is never a node',
    roadQuery.includes('way["highway"') && !roadQuery.includes('node["highway"') && !roadQuery.includes('relation["highway"'), roadQuery);
  check('the query is bbox-scoped with a cap', /\[out:json\]/.test(roadQuery) && /out geom 2000;/.test(roadQuery));

  const resQuery = overpass.buildQuery('residential', [127.3, 36.3, 127.4, 36.4], 2000);
  check('residential asks for ways and relations, not nodes',
    resQuery.includes('way["landuse"="residential"]') && resQuery.includes('relation["landuse"="residential"]') && !resQuery.includes('node["landuse"'), resQuery);

  let threw = false;
  try { overpass.buildQuery('slope', [0, 0, 1, 1], 10); } catch { threw = true; }
  check('an unknown class is rejected', threw);

  // A closed way must stay a line for a line class: a ring road that became a
  // polygon would report 0 m for every candidate inside the loop.
  const loop = [{ lat: 36.37, lon: 127.34 }, { lat: 36.37, lon: 127.35 }, { lat: 36.38, lon: 127.35 }, { lat: 36.37, lon: 127.34 }];
  const asRoad = overpass.toFeature({ type: 'way', id: 9, tags: { highway: 'primary' }, geometry: loop }, 'road', 'now');
  check('a closed way in a line class stays a LineString', asRoad.geometry.type === 'LineString', asRoad.geometry.type);
  const asArea = overpass.toFeature({ type: 'way', id: 9, tags: { landuse: 'residential' }, geometry: loop }, 'residential', 'now');
  check('a closed way in an area class becomes a Polygon', asArea.geometry.type === 'Polygon', asArea.geometry.type);
  check('properties follow §11.1',
    ['name', 'category', 'source', 'sourceId', 'score', 'metrics', 'fetchedAt'].every((k) => k in asArea.properties));
}

console.log('\n[§25] Overpass failure classification — status code alone is never enough');
{
  const c1 = overpass.classify(200, 'text/html', '<html><body>runtime error: Query timed out</body></html>');
  check('HTTP 200 + HTML error body is a failure', c1.ok === false && c1.kind === 'timeout', JSON.stringify(c1));
  const c2 = overpass.classify(504, 'text/plain', 'gateway time-out');
  check('HTTP 504 is a timeout failure', c2.ok === false && c2.kind === 'timeout', JSON.stringify(c2));
  const c3 = overpass.classify(200, 'application/json', '{"version":0.6,"elements":[{"type":"way","id":1,"tags":{"name":"Timeo');
  check('HTTP 200 + truncated JSON is a failure', c3.ok === false && c3.kind === 'non_json', JSON.stringify(c3));
  const c4 = overpass.classify(200, 'application/json', JSON.stringify({ elements: [], remark: 'runtime error: Query timed out' }));
  check('HTTP 200 + a JSON "remark" error is a failure', c4.ok === false && c4.kind === 'timeout', JSON.stringify(c4));
  const c5 = overpass.classify(200, 'application/json', JSON.stringify({
    elements: [{ type: 'way', id: 1, tags: { highway: 'primary', name: 'Timeout Boulevard' } }],
  }));
  check('valid JSON containing the word "timeout" still succeeds', c5.ok === true, JSON.stringify(c5));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
