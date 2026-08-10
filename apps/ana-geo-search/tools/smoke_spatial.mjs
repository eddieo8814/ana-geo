// Offline verification of the spatial engine (FR-SEARCH-001…008) and of the
// Overpass failure classifier (§25). Runs without a server and without network:
//
//   node tools/smoke_spatial.mjs
//
// Fixture: one university and three cafes placed at exact great-circle
// distances (0.5 km, 1.8 km, 2.5 km) east of it, plus one subway station.
// Every Turf result is cross-checked against an independent haversine
// implementation in this file, so a wrong unit or a wrong earth radius fails.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const spatial = require('../geo/spatial.js');
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

const point = (id, coords, category) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: coords },
  properties: { name: id, category, source: 'fixture', sourceId: id, score: null, metrics: {} },
});

const ORIGIN = [127.3450, 36.3740]; // Daejeon (PRD §33)
const UNI = point('node/uni-1', ORIGIN, 'university');
const CAFE_A = point('node/cafe-a', destination(ORIGIN, 0.5, 90), 'cafe');
const CAFE_B = point('node/cafe-b', destination(ORIGIN, 1.8, 90), 'cafe');
const CAFE_C = point('node/cafe-c', destination(ORIGIN, 2.5, 90), 'cafe');
// 0.05 km from cafe A, 1.25 km from cafe B — only cafe A is "near a subway".
const SUBWAY = point('node/sub-1', destination(ORIGIN, 0.55, 90), 'subway_station');

const fc = (features) => ({ type: 'FeatureCollection', features });
const CAFES = fc([CAFE_A, CAFE_B, CAFE_C]);
const UNIS = fc([UNI]);
const SUBWAYS = fc([SUBWAY]);

// A square campus polygon ~0.3 km around the university, for the
// pointToPolygonDistance path (FR-SEARCH-001 against areal references).
const CAMPUS = {
  type: 'Feature',
  id: 'way/campus-1',
  geometry: {
    type: 'Polygon',
    coordinates: [[
      destination(ORIGIN, 0.3, 315), destination(ORIGIN, 0.3, 45),
      destination(ORIGIN, 0.3, 135), destination(ORIGIN, 0.3, 225),
      destination(ORIGIN, 0.3, 315),
    ]],
  },
  properties: { name: 'campus', category: 'university', source: 'fixture', sourceId: 'way/campus-1', metrics: {} },
};

const sets = { cafe: CAFES, university: UNIS, subway_station: SUBWAYS, campus: fc([CAMPUS]) };
const resolve = (k) => sets[k] || null;

// ---------- harness ----------

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const ids = (features) => features.map((f) => f.id).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b.slice().sort());
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log('\n[FR-SEARCH-001] distance — Turf vs. independent haversine');
for (const [name, f] of [['cafe-a', CAFE_A], ['cafe-b', CAFE_B], ['cafe-c', CAFE_C]]) {
  const turfKm = spatial.distanceBetween(f, UNI, 'km');
  const refKm = haversine(f.geometry.coordinates, ORIGIN);
  check(`${name}: ${turfKm.toFixed(6)} km ≈ ${refKm.toFixed(6)} km`, close(turfKm, refKm, 1e-6), `Δ=${Math.abs(turfKm - refKm)}`);
}
check('unit conversion m == km*1000', close(spatial.distanceBetween(CAFE_A, UNI, 'm'), spatial.distanceBetween(CAFE_A, UNI, 'km') * 1000, 1e-6));
{
  // point-to-polygon: cafe A is 0.5 km from the centre, campus edge is 0.3 km out
  const d = spatial.distanceBetween(CAFE_A, CAMPUS, 'km');
  check(`point→polygon distance is edge distance (${d.toFixed(4)} km < 0.5 km)`, d > 0 && d < 0.5, `got ${d}`);
  const inside = spatial.distanceBetween(point('x', ORIGIN, 'cafe'), CAMPUS, 'km');
  check('point inside polygon clamps to 0', close(inside, 0, 1e-9), `got ${inside}`);
}

console.log('\n[FR-SEARCH-002] buffer');
{
  const b = spatial.buffer(UNI, 2, 'km');
  check('buffer(2 km) returns a polygon', !!b && /Polygon/.test(b.geometry.type));
  const bm = spatial.buffer(UNI, 2000, 'm');
  check('buffer(2000 m) returns a polygon', !!bm && /Polygon/.test(bm.geometry.type));
  // A 2 km buffer must contain exactly the cafes that within_distance accepts.
  const inBuffer = ids(spatial.within(CAFES, fc([b])).map((f) => f));
  const inRadius = ids(spatial.withinDistance(CAFES, UNIS, 2, 'km').map((m) => m.feature));
  check('buffer membership matches within_distance', same(inBuffer, inRadius), `${inBuffer} vs ${inRadius}`);
  let threw = false;
  try { spatial.buffer(UNI, 1, 'miles'); } catch { threw = true; }
  check('unsupported unit is rejected (§25)', threw);
}

console.log('\n[FR-SEARCH-003] within polygon');
{
  const big = spatial.buffer(UNI, 2, 'km');
  const hits = ids(spatial.within(CAFES, fc([big])));
  check('cafes inside a 2 km polygon = a, b', same(hits, ['node/cafe-a', 'node/cafe-b']), String(hits));
  let threw = false;
  try { spatial.within(CAFES, UNIS); } catch { threw = true; }
  check('within with no polygon reference is an error (§25)', threw);
}

console.log('\n[FR-SEARCH-004] within_distance');
{
  const at2km = ids(spatial.withinDistance(CAFES, UNIS, 2000, 'm').map((m) => m.feature));
  check('within 2000 m of university = a, b', same(at2km, ['node/cafe-a', 'node/cafe-b']), String(at2km));
  const at3km = ids(spatial.withinDistance(CAFES, UNIS, 3, 'km').map((m) => m.feature));
  check('"change that to 3 km" = a, b, c', same(at3km, ['node/cafe-a', 'node/cafe-b', 'node/cafe-c']), String(at3km));
  const measured = spatial.withinDistance(CAFES, UNIS, 3, 'km').map((m) => m.km);
  const expected = [CAFE_A, CAFE_B, CAFE_C].map((f) => haversine(f.geometry.coordinates, ORIGIN));
  check('reported distances match haversine', measured.every((d, i) => close(d, expected[i], 1e-6)), `${measured} vs ${expected}`);
}

console.log('\n[FR-SEARCH-005] outside_distance');
{
  const out = ids(spatial.outsideDistance(CAFES, UNIS, 2000, 'm').map((m) => m.feature));
  check('farther than 2000 m = c', same(out, ['node/cafe-c']), String(out));
  const all = ids(spatial.withinDistance(CAFES, UNIS, 2000, 'm').map((m) => m.feature)).concat(out).sort();
  check('within + outside partition the target set', same(all, ['node/cafe-a', 'node/cafe-b', 'node/cafe-c']), String(all));
}

console.log('\n[FR-SEARCH-006] nearest N');
{
  const n2 = spatial.nearest(CAFES, UNIS, 2).map((m) => m.feature.id);
  check('two nearest = a, b (in order)', JSON.stringify(n2) === JSON.stringify(['node/cafe-a', 'node/cafe-b']), String(n2));
  const n5 = spatial.nearest(CAFES, UNIS, 5).map((m) => m.feature.id);
  check('nearest 5 of 3 returns 3', n5.length === 3, String(n5));
}

console.log('\n[FR-SEARCH-007/008] multi-condition AND / OR (§17.4 model)');
{
  const andQuery = {
    target: 'cafe',
    operator: 'AND',
    conditions: [
      { relation: 'within_distance', reference: 'university', distance: 2000, unit: 'm' },
      { relation: 'within_distance', reference: 'subway_station', distance: 1000, unit: 'm' },
    ],
  };
  const andRes = spatial.evaluate(andQuery, resolve);
  check('AND: cafe near university AND subway = a', same(ids(andRes.features), ['node/cafe-a']), String(ids(andRes.features)));
  check('AND breakdown has one entry per condition', andRes.breakdown.length === 2);

  const orRes = spatial.evaluate({ ...andQuery, operator: 'OR' }, resolve);
  check('OR: same conditions = a, b', same(ids(orRes.features), ['node/cafe-a', 'node/cafe-b']), String(ids(orRes.features)));

  // "Change that to 3 km." — one field of one condition (FR-SEARCH-010).
  const edited = JSON.parse(JSON.stringify(andQuery));
  edited.conditions[0].distance = 3;
  edited.conditions[0].unit = 'km';
  const editedRes = spatial.evaluate({ ...edited, operator: 'OR' }, resolve);
  check('edited condition changes the result set', same(ids(editedRes.features), ['node/cafe-a', 'node/cafe-b', 'node/cafe-c']), String(ids(editedRes.features)));

  const exclusion = spatial.evaluate({
    target: 'cafe', operator: 'AND',
    conditions: [
      { relation: 'within_distance', reference: 'university', distance: 3, unit: 'km' },
      { relation: 'outside_distance', reference: 'subway_station', distance: 500, unit: 'm' },
    ],
  }, resolve);
  check('AND with an exclusion drops cafe a', same(ids(exclusion.features), ['node/cafe-b', 'node/cafe-c']), String(ids(exclusion.features)));

  const withNearest = spatial.evaluate({
    target: 'cafe', operator: 'AND',
    conditions: [
      { relation: 'within_distance', reference: 'university', distance: 3, unit: 'km' },
      { relation: 'nearest', reference: 'university', count: 2 },
    ],
  }, resolve);
  check('AND with nearest 2 = a, b', same(ids(withNearest.features), ['node/cafe-a', 'node/cafe-b']), String(ids(withNearest.features)));

  check('results carry per-condition metrics (§23.3)', Object.keys(andRes.features[0].properties.metrics).length === 2,
    JSON.stringify(andRes.features[0].properties.metrics));
  check('summary reads back the query', andRes.summary === 'cafe: within 2000 m of university AND within 1000 m of subway_station', andRes.summary);

  let threw = '';
  try { spatial.evaluate({ target: 'cafe', operator: 'AND', conditions: [{ relation: 'touches', reference: 'university' }] }, resolve); }
  catch (e) { threw = e.message; }
  check('unknown relation is rejected (§25)', /invalid spatial condition/.test(threw), threw);

  let threw2 = '';
  try { spatial.evaluate({ target: 'hospital', operator: 'AND', conditions: [] }, resolve); }
  catch (e) { threw2 = e.message; }
  check('missing target features is an error (§25)', /no features acquired/.test(threw2), threw2);
}

console.log('\n[FR-SEARCH-009] condition buffers are produced for the map');
{
  const bufs = spatial.conditionBuffers({
    target: 'cafe', operator: 'AND',
    conditions: [
      { relation: 'within_distance', reference: 'university', distance: 2000, unit: 'm' },
      { relation: 'nearest', reference: 'university', count: 2 },
    ],
  }, resolve);
  check('one buffer per distance condition (nearest contributes none)', bufs.features.length === 1, String(bufs.features.length));
  check('buffer carries its condition for the popup', bufs.features[0].properties.distance === 2000 && bufs.features[0].properties.unit === 'm');
}

console.log('\n[§26.1] result cap');
{
  const many = fc(Array.from({ length: 30 }, (_, i) => point(`node/c-${i}`, destination(ORIGIN, 0.1 + i * 0.01, 90), 'cafe')));
  const capped = spatial.evaluate(
    { target: 'cafe', operator: 'AND', conditions: [{ relation: 'within_distance', reference: 'university', distance: 5, unit: 'km' }] },
    (k) => (k === 'cafe' ? many : sets[k]),
    { cap: 10 },
  );
  check('cap limits the result set and flags truncation', capped.features.length === 10 && capped.truncated === true);
}

console.log('\n[FR-SEARCH-011] registry + Overpass query building');
{
  check('registry has the §16.3 presets plus subway_station', registry.keys().length >= 11, String(registry.keys().length));
  for (const k of ['cafe', 'university', 'subway_station', 'hospital', 'park', 'bus_station']) {
    check(`registry key "${k}" defined`, registry.has(k));
  }
  const q = overpass.buildQuery('cafe', [127.3, 36.3, 127.4, 36.4], 2000);
  check('query is bbox-scoped Overpass QL with a cap', /\[out:json\]/.test(q) && /node\["amenity"="cafe"\]\(36\.3/.test(q) && /out geom 2000;/.test(q), q);
  let threw = false;
  try { overpass.buildQuery('not_a_category', [0, 0, 1, 1], 10); } catch { threw = true; }
  check('unknown category is rejected', threw);
}

console.log('\n[§25] Overpass failure classification — status code alone is never enough');
{
  const html = '<!DOCTYPE html><html><body><p>Error: runtime error: Query timed out</p></body></html>';
  const c1 = overpass.classify(200, 'text/html', html);
  check('HTTP 200 + HTML error body is a failure', c1.ok === false && c1.kind === 'timeout', JSON.stringify(c1));
  const c1b = overpass.classify(200, 'text/html', '<html><body>Gateway page</body></html>');
  check('HTTP 200 + non-JSON body is a failure', c1b.ok === false && c1b.kind === 'non_json', JSON.stringify(c1b));
  const c2 = overpass.classify(504, 'text/plain', 'gateway time-out');
  check('HTTP 504 is a timeout failure', c2.ok === false && c2.kind === 'timeout', JSON.stringify(c2));
  const c3 = overpass.classify(502, 'text/html', '<html>502 Bad Gateway</html>');
  check('HTTP 502 is an availability failure', c3.ok === false && c3.kind === 'unavailable', JSON.stringify(c3));
  const c4 = overpass.classify(200, 'application/json', JSON.stringify({ elements: [] }));
  check('HTTP 200 + valid JSON is a success', c4.ok === true, JSON.stringify(c4));
  const c5 = overpass.classify(200, 'application/json', '{"version":0.6}');
  check('JSON without elements is a failure', c5.ok === false && c5.kind === 'non_json', JSON.stringify(c5));

  // Observed live on overpass-api.de: HTTP 200 whose JSON body is cut off
  // mid-string. It must not be mistaken for an empty but valid result.
  const truncated = '{"version":0.6,"elements":[{"type":"node","id":1,"tags":{"name":"Caf';
  const c6 = overpass.classify(200, 'application/json', truncated);
  check('HTTP 200 + truncated JSON is a failure', c6.ok === false && c6.kind === 'non_json', JSON.stringify(c6));

  // Overpass reports an aborted run inside an HTTP 200 JSON body.
  const c7 = overpass.classify(200, 'application/json', JSON.stringify({ elements: [], remark: 'runtime error: Query timed out in "query" at line 3' }));
  check('HTTP 200 + JSON "remark" error is a failure', c7.ok === false && c7.kind === 'timeout', JSON.stringify(c7));

  // A valid result must never be rejected because its data mentions "timeout".
  const c8 = overpass.classify(200, 'application/json', JSON.stringify({
    elements: [{ type: 'node', id: 1, lat: 36.37, lon: 127.34, tags: { amenity: 'cafe', name: 'Timeout Coffee' } }],
  }));
  check('valid JSON containing the word "timeout" still succeeds', c8.ok === true, JSON.stringify(c8));
}

console.log('\n[FR-SEARCH-011] OSM → GeoJSON normalization (§11.1)');
{
  const osm = {
    elements: [
      { type: 'node', id: 1, lat: 36.374, lon: 127.345, tags: { amenity: 'cafe', name: 'A' } },
      {
        type: 'way', id: 2, tags: { amenity: 'university', name: 'U' },
        geometry: [{ lat: 36.37, lon: 127.34 }, { lat: 36.37, lon: 127.35 }, { lat: 36.38, lon: 127.35 }, { lat: 36.37, lon: 127.34 }],
      },
      { type: 'relation', id: 3, tags: { amenity: 'university' }, bounds: { minlat: 36.3, minlon: 127.3, maxlat: 36.4, maxlon: 127.4 } },
    ],
  };
  const { collection } = overpass.toGeoJSON(osm, 'university', 2000);
  check('node → Point', collection.features[0].geometry.type === 'Point');
  check('closed areal way → Polygon', collection.features[1].geometry.type === 'Polygon', collection.features[1].geometry.type);
  check('relation → bounds centre Point', collection.features[2].geometry.type === 'Point');
  check('properties follow §11.1', ['name', 'category', 'source', 'sourceId', 'fetchedAt'].every((k) => k in collection.features[0].properties));
  const capped = overpass.toGeoJSON(osm, 'university', 2);
  check('cap truncates the collection', capped.collection.features.length === 2 && capped.truncated === true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
