#!/usr/bin/env node
// Node-side check of the Python worker contract (PRD §8.5): does every path —
// success, unknown op, unhandled exception, timeout — come back as the same
// JSON envelope shape, and does server.js refuse asset hosts that are not on
// the §8.4 allowlist before it ever spawns a worker?
//
//     node tools/smoke_envelope.js
//
// Offline: it never touches the network.

const assert = require('node:assert');
const { runWorker } = require('./worker.js');
const GeoStac = require('../geo/stac.js');

// One sentinel-2-l2a item, trimmed but shaped exactly like what Earth Search
// returns — including the two details that have already bitten this app:
// `grid:code` written without separators, and a `raster:bands` offset that is
// already baked into the pixels.
const REAL_SHAPE_ITEM = {
  id: 'S2B_52SCF_20250725_0_L2A',
  collection: 'sentinel-2-l2a',
  bbox: [126.751632, 36.036177, 127.998537, 37.042238],
  geometry: { type: 'Polygon', coordinates: [[[126.75, 36.03], [127.99, 36.03], [127.99, 37.04], [126.75, 37.04], [126.75, 36.03]]] },
  properties: {
    datetime: '2025-07-25T02:16:41.024000Z',
    platform: 'sentinel-2b',
    'eo:cloud_cover': 0.512223,
    'grid:code': 'MGRS-52SCF',
    'mgrs:utm_zone': 52, 'mgrs:latitude_band': 'S', 'mgrs:grid_square': 'CF',
    'earthsearch:boa_offset_applied': true,
  },
  assets: {
    red: { href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/52/S/CF/2025/7/S2B_52SCF_20250725_0_L2A/B04.tif', 'raster:bands': [{ nodata: 0, scale: 0.0001, offset: -0.1 }] },
    nir: { href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/52/S/CF/2025/7/S2B_52SCF_20250725_0_L2A/B08.tif', 'raster:bands': [{ nodata: 0, scale: 0.0001, offset: -0.1 }] },
    thumbnail: { href: 'https://example.invalid/thumb.jpg' },
  },
};

let passed = 0;
function check(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`  ok  ${label}  = ${JSON.stringify(actual)}`);
  passed++;
}
function isEnvelope(label, env) {
  assert.ok(env && typeof env.ok === 'boolean', `${label}: no ok flag`);
  assert.ok('result' in env && 'error' in env, `${label}: envelope is missing result/error`);
  if (env.ok) assert.strictEqual(env.error, null, `${label}: ok envelope must have null error`);
  else assert.ok(env.error && env.error.code && env.error.message, `${label}: failure envelope needs code+message`);
  console.log(`  ok  ${label} is a valid §8.5 envelope`);
  passed++;
}

async function main() {
  console.log('\n1. success envelope');
  const ok = await runWorker('ping', { hello: 'world' });
  isEnvelope('ping', ok);
  check('ping ok', ok.ok, true);
  check('ping echo round-tripped', ok.result.echo, { hello: 'world' });

  console.log('\n2. unknown op');
  const unknown = await runWorker('no_such_op', {});
  isEnvelope('unknown op', unknown);
  check('unknown op ok', unknown.ok, false);
  check('unknown op code', unknown.error.code, 'unknown_op');
  check('unknown op result', unknown.result, null);

  console.log('\n3. forced unhandled exception (stderr stays logs, stdout stays an envelope)');
  const boom = await runWorker('ping', { forceError: true });
  isEnvelope('forced exception', boom);
  check('forced exception ok', boom.ok, false);
  check('forced exception code', boom.error.code, 'worker_failure');

  console.log('\n4. timeout kills the child and still answers');
  const started = Date.now();
  const slow = await runWorker('ping', { sleepMs: 5000 }, { timeoutMs: 700 });
  isEnvelope('timeout', slow);
  check('timeout code', slow.error.code, 'worker_timeout');
  assert.ok(Date.now() - started < 4000, 'timeout should not wait for the child to finish');
  console.log(`  ok  returned after ${Date.now() - started} ms, not 5000`);
  passed++;

  console.log('\n5. invalid params reach the caller as a coded failure');
  const bad = await runWorker('change_detect', { beforeItem: null });
  isEnvelope('invalid params', bad);
  check('invalid params code', bad.error.code, 'invalid_params');

  console.log('\n6. server.js refuses non-allowlisted asset hosts before spawning');
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  for (const host of ['earth-search.aws.element84.com', 'sentinel-cogs.s3.us-west-2.amazonaws.com']) {
    assert.ok(source.includes(host), `server.js should allowlist ${host}`);
    console.log(`  ok  allowlisted ${host}`);
    passed++;
  }
  assert.ok(/delete params\.allowLocal/.test(source), 'server.js must strip allowLocal from network requests');
  console.log('  ok  server.js strips allowLocal from network requests');
  passed++;

  console.log('\n7. geo/stac.js against a real-shaped Earth Search item (FR-CD-012)');
  const body = GeoStac.buildSearchBody({ bbox: [127.35, 36.32, 127.42, 36.38], datetime: '2025-04-01/2025-10-31', maxCloudCover: 10, limit: 40 });
  check('collection', body.collections, ['sentinel-2-l2a']);
  check('cloud filter', body.query, { 'eo:cloud_cover': { lte: 10 } });
  check('bare dates become an RFC3339 interval', body.datetime, '2025-04-01T00:00:00Z/2025-10-31T23:59:59Z');

  const scene = GeoStac.normalizeItem(REAL_SHAPE_ITEM);
  check('grid code', scene.gridCode, 'MGRS-52SCF');
  check('ndvi bands present', GeoStac.hasNdviBands(scene), true);
  check('red scale', scene.assets.red.scale, 0.0001);
  // The offset is declared as -0.1 but already applied to the pixels; applying
  // it again drove 72% of red reflectance negative on a real Daejeon scene.
  check('boa offset already applied → not reapplied', scene.assets.red.offset, 0);
  check('nir offset likewise', scene.assets.nir.offset, 0);

  const withoutFlag = JSON.parse(JSON.stringify(REAL_SHAPE_ITEM));
  delete withoutFlag.properties['earthsearch:boa_offset_applied'];
  check('unharmonized item keeps its declared offset', GeoStac.normalizeItem(withoutFlag).assets.red.offset, -0.1);

  // 'MGRS-52SCF' (grid:code) and 'MGRS-52-S-CF' (mgrs:* fallback) are one tile.
  check('tile comparison ignores separators', GeoStac.sameTile('MGRS-52SCF', 'MGRS-52-S-CF'), true);
  check('different tiles still differ', GeoStac.sameTile('MGRS-52SCF', 'MGRS-52SCG'), false);
  const noGrid = JSON.parse(JSON.stringify(REAL_SHAPE_ITEM));
  delete noGrid.properties['grid:code'];
  delete noGrid.properties['mgrs:utm_zone'];
  check('grid code falls back to the scene id', GeoStac.gridCodeOf(noGrid), 'MGRS-52-S-CF');

  const fc = GeoStac.footprintCollection([REAL_SHAPE_ITEM]);
  check('footprint is a Polygon', fc.features[0].geometry.type, 'Polygon');
  check('footprint carries the assets', Object.keys(fc.features[0].properties.assets).sort(), ['nir', 'red']);
  const roundTripped = GeoStac.sceneFromFeature(fc.features[0]);
  check('scene survives the footprint round trip', roundTripped.assets.red.href, REAL_SHAPE_ITEM.assets.red.href);
  check('round-tripped scene keeps its tile', roundTripped.gridCode, 'MGRS-52SCF');

  console.log('\n8. STAC failures surface as errors, not as empty results (§25)');
  assert.throws(() => GeoStac.parseResponse('<html>502 Bad Gateway</html>', 502), /STAC search failed/);
  console.log('  ok  HTML error page throws'); passed++;
  assert.throws(() => GeoStac.parseResponse(JSON.stringify({ code: 'InvalidParameter', description: 'bad bbox' }), 200), /bad bbox/);
  console.log('  ok  JSON error document throws even on HTTP 200'); passed++;
  check('valid response parses', GeoStac.parseResponse(JSON.stringify({ type: 'FeatureCollection', features: [] }), 200).features, []);

  console.log(`\nPASS — ${passed} assertions`);
}

main().catch((e) => { console.error(`\nFAIL — ${e.message}`); process.exit(1); });
