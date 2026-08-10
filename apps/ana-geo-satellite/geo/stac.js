// STAC query construction and response normalization (PRD §20.2, §20.4, §20.6).
// Browser global: GeoStac. No imports from other apps (§9).

(function (global) {
  'use strict';

  // §20.2 — default provider, fixed for v1. Search and asset retrieval are both
  // keyless; asset hrefs are public https:// (never requester-pays s3://).
  const ENDPOINT = 'https://earth-search.aws.element84.com/v1';

  // §20.2 permits the newer COG-only baseline as an alternative collection.
  const COLLECTIONS = [
    { id: 'sentinel-2-l2a', label: 'Sentinel-2 L2A' },
    { id: 'sentinel-2-c1-l2a', label: 'Sentinel-2 C1 L2A (COG-only baseline)' },
  ];

  const RESULT_LIMIT = 50; // §26.1 — footprints are cheap, but keep the panel readable.

  // The §20.4 search model stores `datetime` in the human-editable "YYYY-MM-DD/YYYY-MM-DD"
  // form so ANA can rewrite it in one edit. Earth Search rejects that form with
  // 400 BadRequest ("does not match RFC3339 format"), so bare dates are widened to
  // full-day RFC3339 instants here — start at 00:00:00Z, end at 23:59:59Z inclusive.
  function toRfc3339Range(datetime) {
    const raw = String(datetime || '').trim();
    const parts = raw.split('/');
    if (parts.length !== 2) throw new Error(`invalid date range "${raw}" — expected "start/end"`);
    const widen = (v, end) => {
      const s = v.trim();
      if (!s || s === '..') return '..'; // open-ended per STAC
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T${end ? '23:59:59Z' : '00:00:00Z'}`;
      if (/T/.test(s)) return s;         // already an instant — pass through
      throw new Error(`invalid date "${s}" — expected YYYY-MM-DD`);
    };
    const start = widen(parts[0], false);
    const end = widen(parts[1], true);
    if (start === '..' && end === '..') throw new Error('date range cannot be fully open');
    return `${start}/${end}`;
  }

  // Build the POST /search body from the §20.4 search model.
  function buildSearchBody(search) {
    const bbox = search.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((n) => typeof n !== 'number' || !isFinite(n))) {
      throw new Error('AOI missing — set a bbox from the viewport or by drawing a rectangle');
    }
    const body = {
      collections: [search.collection],
      bbox,
      datetime: toRfc3339Range(search.datetime),
      limit: Number(search.limit) || RESULT_LIMIT,
    };
    const cloud = Number(search.maxCloudCover);
    if (isFinite(cloud) && cloud < 100) body.query = { 'eo:cloud_cover': { lt: cloud } };
    return body;
  }

  function searchUrl() {
    return `/api/proxy?url=${encodeURIComponent(`${ENDPOINT}/search`)}`; // §8.4 — never browser-direct
  }

  // Asset hrefs live on a different host than the catalog (sentinel-cogs.s3...),
  // so both hosts are allowlisted server-side; the browser still only talks to the proxy.
  function assetUrl(href) {
    return `/api/proxy?url=${encodeURIComponent(href)}`;
  }

  // §25 — a STAC failure is not detectable from the HTTP status alone: an unknown
  // collection returns 200 with an empty FeatureCollection, while a malformed
  // datetime returns 400 with {code, description}. Both the status and the parsed
  // body are checked, and the caller is told which one failed.
  function interpretResponse(status, text) {
    let body = null;
    let parseError = null;
    try { body = JSON.parse(text); } catch (e) { parseError = e; }

    if (status < 200 || status >= 300) {
      // `error` covers the proxy's own refusals (403 host not allowlisted, 502 upstream).
      const detail = body && (body.description || body.detail || body.message || body.error || body.code);
      return { ok: false, error: `STAC search failed — HTTP ${status}${detail ? `: ${detail}` : ''}` };
    }
    if (parseError) return { ok: false, error: `STAC search returned a non-JSON body (HTTP ${status})` };
    if (body && (body.code || body.description) && !body.features) {
      return { ok: false, error: `STAC search rejected: ${body.code || ''} ${body.description || ''}`.trim() };
    }
    if (!body || body.type !== 'FeatureCollection' || !Array.isArray(body.features)) {
      return { ok: false, error: 'STAC search returned an unexpected payload (no FeatureCollection)' };
    }
    return { ok: true, body };
  }

  // Scene footprints as a GeoJSON FeatureCollection (§11.1) — this is the layer body
  // behind resultRef, so it also carries the per-scene metadata the panel shows (FR-SAT-008).
  function toFootprints(itemCollection, fetchedAt) {
    const features = itemCollection.features.map((item) => {
      const p = item.properties || {};
      const assets = item.assets || {};
      const thumb = assets.thumbnail || null;
      return {
        type: 'Feature',
        id: item.id,
        geometry: item.geometry,
        properties: {
          name: item.id,
          category: 'scene-footprint',
          source: 'stac',
          sourceId: `${item.collection}/${item.id}`,
          score: null,
          metrics: { cloudCover: numberOrNull(p['eo:cloud_cover']) },
          fetchedAt,
          // FR-SAT-008 — scene metadata
          sceneId: item.id,
          collection: item.collection,
          datetime: p.datetime || p.start_datetime || null,
          platform: p.platform || null,
          instruments: p.instruments || null,
          cloudCover: numberOrNull(p['eo:cloud_cover']),
          gsd: numberOrNull(p.gsd),
          assetKeys: Object.keys(assets).sort(),
          // FR-SAT-010 — the preview overlay is placed on item.bbox, not on the
          // footprint quadrilateral (see app.js).
          sceneBbox: item.bbox || null,
          thumbnailHref: thumb ? thumb.href : null,
          thumbnailType: thumb ? thumb.type : null,
        },
      };
    });
    return { type: 'FeatureCollection', features };
  }

  // Geometry-free scene index for state.json (§12 rule 3 — feature bodies stay
  // behind resultRef). Ordering this array is how ANA reorders the scene list.
  function toSceneIndex(footprints) {
    return footprints.features.map((f) => ({
      id: f.properties.sceneId,
      datetime: f.properties.datetime,
      platform: f.properties.platform,
      cloudCover: f.properties.cloudCover,
      collection: f.properties.collection,
      assetCount: f.properties.assetKeys.length,
    }));
  }

  function numberOrNull(v) {
    const n = Number(v);
    return isFinite(n) ? n : null;
  }

  function boundsOf(footprints) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const f of footprints.features) {
      const bb = f.properties.sceneBbox;
      if (!bb || bb.length < 4) continue;
      w = Math.min(w, bb[0]); s = Math.min(s, bb[1]); e = Math.max(e, bb[2]); n = Math.max(n, bb[3]);
    }
    return isFinite(w) ? [w, s, e, n] : [];
  }

  global.GeoStac = {
    ENDPOINT, COLLECTIONS, RESULT_LIMIT,
    toRfc3339Range, buildSearchBody, searchUrl, assetUrl,
    interpretResponse, toFootprints, toSceneIndex, boundsOf,
  };
})(typeof window !== 'undefined' ? window : globalThis);
