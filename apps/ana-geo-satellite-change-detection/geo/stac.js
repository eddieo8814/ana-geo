// ana-geo-satellite-change-detection — this app's own STAC client (FR-CD-012).
//
// FR-CD-012 requires the app to discover its before/after scenes through its
// own STAC search, implementing the FR-SAT-001…009 capabilities in its own
// code. Nothing here is imported from `ana-geo-satellite` (§9).
//
// Provider is fixed for v1 (PRD §20.2): Earth Search, collection
// `sentinel-2-l2a`, no account/token/key, public https COG assets. Every
// request leaves the browser through `/api/proxy` (§8.4).
//
// Loadable both in the browser (`window.GeoStac`) and in Node (`require`).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GeoStac = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const ENDPOINT = 'https://earth-search.aws.element84.com/v1/search';
  const COLLECTION = 'sentinel-2-l2a'; // FR-SAT-004 equivalent

  // NDVI needs exactly these two, both 10 m on sentinel-2-l2a:
  //   red = B04 (665 nm), nir = B08 (842 nm).
  const NDVI_BANDS = { red: 'B04', nir: 'B08' };

  const DEFAULT_LIMIT = 40; // scenes per search — enough for a year of revisits

  // Post-baseline-04.00 L2A products carry BOA_ADD_OFFSET = -1000, published in
  // the asset's `raster:bands` as scale 1e-4 / offset -0.1. Older products have
  // no offset. NDVI is invariant to scale but not to offset, so whatever the
  // item declares is carried through to the worker verbatim; these are only the
  // fallbacks for items that declare nothing.
  const DEFAULT_SCALE = 0.0001;
  const DEFAULT_OFFSET = 0;

  // FR-SAT-003/005/006 equivalents: AOI + date range + collection + cloud cover.
  function buildSearchBody(opts) {
    const bbox = opts.bbox; // [west, south, east, north]
    if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error('bbox must be [west, south, east, north]');
    const body = {
      collections: [opts.collection || COLLECTION],
      bbox: bbox.map(Number),
      limit: Math.min(Number(opts.limit || DEFAULT_LIMIT), 100),
      // newest first, so "the image from six months earlier" is a scroll away
      sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    };
    const datetime = toInterval(opts.datetime);
    if (datetime) body.datetime = datetime;
    const cloud = Number(opts.maxCloudCover);
    if (Number.isFinite(cloud)) body.query = { 'eo:cloud_cover': { lte: cloud } };
    return body;
  }

  // "2026-01-01/2026-06-30" → RFC3339 interval. STAC wants full timestamps;
  // a bare date silently drops the last day on some servers.
  function toInterval(datetime) {
    if (!datetime) return null;
    const [rawStart, rawEnd] = String(datetime).split('/');
    if (!rawStart || !rawEnd) return String(datetime);
    const start = /T/.test(rawStart) ? rawStart : `${rawStart}T00:00:00Z`;
    const end = /T/.test(rawEnd) ? rawEnd : `${rawEnd}T23:59:59Z`;
    return `${start}/${end}`;
  }

  // A 200 is not proof of success — the proxy and the catalog both answer with
  // JSON error documents, and an upstream outage answers with HTML (§25).
  function parseResponse(text, status) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`STAC search failed (HTTP ${status}): response was not JSON — ${String(text).slice(0, 160)}`);
    }
    if (status >= 400 || json.code || json.description) {
      const detail = json.description || json.detail || json.error || json.message || `HTTP ${status}`;
      throw new Error(`STAC search failed: ${detail}`);
    }
    if (!Array.isArray(json.features)) throw new Error('STAC search failed: response has no feature list');
    return json;
  }

  // MGRS tile of an item. v1 aligns before/after by requiring one tile
  // (FR-CD-003), so this value is what the UI and the worker both gate on.
  function gridCodeOf(item) {
    const p = (item && item.properties) || {};
    if (p['grid:code']) return String(p['grid:code']);
    if (p['mgrs:utm_zone'] && p['mgrs:latitude_band'] && p['mgrs:grid_square']) {
      return `MGRS-${p['mgrs:utm_zone']}-${p['mgrs:latitude_band']}-${p['mgrs:grid_square']}`;
    }
    // Last resort: Earth Search ids look like S2A_52SCG_20260701_0_L2A.
    const m = /^S2[A-D]_(\d{1,2})([A-Z])([A-Z]{2})_/.exec(String(item && item.id || ''));
    return m ? `MGRS-${m[1]}-${m[2]}-${m[3]}` : null;
  }

  // Earth Search publishes `grid:code` as 'MGRS-52SCF' while the `mgrs:*`
  // fallback above composes 'MGRS-52-S-CF'. Both name the same tile, so the
  // same-tile check (FR-CD-003) compares letters and digits only — matching
  // what the Python worker does before it opens anything.
  function normalizeGridCode(code) {
    return code ? String(code).toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
  }

  function sameTile(a, b) {
    const x = normalizeGridCode(a), y = normalizeGridCode(b);
    return !!(x && y && x === y);
  }

  // Has BOA_ADD_OFFSET already been baked into the pixel values?
  //
  // Sentinel-2 processing baseline 04.00+ introduced BOA_ADD_OFFSET = -1000,
  // which `raster:bands` reports as `offset: -0.1` alongside `scale: 1e-4`.
  // Earth Search's `sentinel-2-l2a` collection *harmonizes* its COGs so that
  // every scene reads on one scale regardless of baseline, and says so with
  // `earthsearch:boa_offset_applied: true` — while still publishing the -0.1 in
  // `raster:bands`. Applying that offset a second time is not a rounding
  // detail: on a 2024-10-28 Daejeon scene it drove 72% of red reflectances
  // below zero, which is physically impossible, and NDVI then ran away on the
  // near-zero denominators (the worker's `_ndvi` guard exists for exactly this).
  // So the declared offset is honoured only when the item does *not* claim it
  // is already applied.
  function boaOffsetApplied(item) {
    const p = (item && item.properties) || {};
    return p['earthsearch:boa_offset_applied'] === true || p['boa_offset_applied'] === true;
  }

  function assetRecord(item, band) {
    const asset = ((item && item.assets) || {})[band];
    if (!asset || !asset.href) return null;
    const rb = (asset['raster:bands'] || asset.bands || [])[0] || {};
    const declaredOffset = Number(rb.offset != null ? rb.offset : DEFAULT_OFFSET);
    return {
      href: asset.href,
      scale: Number(rb.scale != null ? rb.scale : DEFAULT_SCALE),
      offset: boaOffsetApplied(item) ? 0 : declaredOffset,
      offsetSource: boaOffsetApplied(item)
        ? 'already applied to pixels (earthsearch:boa_offset_applied)'
        : (rb.offset != null ? 'raster:bands' : 'default'),
      band: NDVI_BANDS[band] || band,
    };
  }

  /**
   * Trim a STAC item down to what state.json and the worker actually need.
   * A raw sentinel-2-l2a item is ~15 KB of assets; two of those inlined in
   * state would fight the §12 "keep state small" rule for no benefit.
   */
  function normalizeItem(item) {
    const p = item.properties || {};
    const scene = {
      id: item.id,
      collection: item.collection || COLLECTION,
      datetime: p.datetime || p.start_datetime || null,
      platform: p.platform || p.constellation || null,
      cloudCover: p['eo:cloud_cover'] != null ? Number(p['eo:cloud_cover']) : null,
      gridCode: gridCodeOf(item),
      bbox: item.bbox || null,
      assetKeys: Object.keys(item.assets || {}).sort(), // FR-SAT-008 "available assets"
      assets: {},
    };
    for (const band of Object.keys(NDVI_BANDS)) {
      const rec = assetRecord(item, band);
      if (rec) scene.assets[band] = rec;
    }
    return scene;
  }

  function hasNdviBands(scene) {
    return !!(scene && scene.assets && scene.assets.red && scene.assets.nir);
  }

  // FR-SAT-007 equivalent — scene footprints as a GeoJSON layer. The full item
  // geometry is kept (not the bbox): the reprojected footprint is a
  // quadrilateral and looks wrong as a rectangle.
  function footprintCollection(items) {
    return {
      type: 'FeatureCollection',
      features: items.map((item) => {
        const scene = normalizeItem(item);
        return {
          type: 'Feature',
          id: scene.id,
          geometry: item.geometry || bboxPolygon(item.bbox),
          properties: {
            name: scene.id,
            category: 'scene-footprint',
            source: 'earth-search',
            sourceId: scene.id,
            score: null,
            metrics: { cloudCover: scene.cloudCover },
            datetime: scene.datetime,
            platform: scene.platform,
            cloudCover: scene.cloudCover,
            gridCode: scene.gridCode,
            bbox: scene.bbox,
            collection: scene.collection,
            assetKeys: scene.assetKeys,
            // The red/nir hrefs travel with the footprint rather than with
            // state.json: picking a scene then needs no second catalog call,
            // and state keeps only the pair that was actually chosen (§12).
            assets: scene.assets,
            hasNdviBands: hasNdviBands(scene),
            fetchedAt: null,
          },
        };
      }),
    };
  }

  // Inverse of footprintCollection: the scene record the worker expects,
  // rebuilt from a footprint feature (FR-CD-001/002 selection).
  function sceneFromFeature(feature) {
    const p = (feature && feature.properties) || {};
    return {
      id: feature.id || p.sourceId,
      collection: p.collection || COLLECTION,
      datetime: p.datetime || null,
      platform: p.platform || null,
      cloudCover: p.cloudCover != null ? Number(p.cloudCover) : null,
      gridCode: p.gridCode || null,
      bbox: p.bbox || null,
      assetKeys: p.assetKeys || [],
      assets: p.assets || {},
    };
  }

  function bboxPolygon(bbox) {
    if (!Array.isArray(bbox) || bbox.length < 4) return null;
    const [w, s, e, n] = bbox;
    return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
  }

  function isoDate(d) { return new Date(d).toISOString().slice(0, 10); }

  return {
    ENDPOINT, COLLECTION, NDVI_BANDS, DEFAULT_LIMIT,
    buildSearchBody, toInterval, parseResponse, gridCodeOf, normalizeGridCode, sameTile,
    boaOffsetApplied, assetRecord,
    normalizeItem, hasNdviBands, footprintCollection, sceneFromFeature, bboxPolygon, isoDate,
  };
});
