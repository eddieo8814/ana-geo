// Overpass acquisition of reference features (FR-SITE-006 input path) —
// query building, failure classification, and OSM → GeoJSON normalization
// (PRD §11.1).
//
// Every request goes through the server proxy (PRD §8.4); the browser never
// calls overpass-api.de directly.
//
// Differences from the ana-geo-search copy, both driven by geo/registry.js:
// a tag value may be a regex (the road class filters four highway grades with
// one `~` filter), and each class names the OSM element types worth asking for
// (a major road is never a node, so nodes are not requested).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./registry.js'));
  } else {
    root.GeoOverpass = factory(root.GeoRegistry);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (registry) {
  const ENDPOINT = 'https://overpass-api.de/api/interpreter';

  // ---------- query ----------

  function tagFilter(set) {
    return Object.entries(set)
      .map(([k, v]) => (v && typeof v === 'object' && v.regex ? `["${k}"~"${v.regex}"]` : `["${k}"="${v}"]`))
      .join('');
  }

  // bbox is [west, south, east, north]; Overpass wants (south,west,north,east).
  function buildQuery(classKey, bbox, limit) {
    const cls = registry.get(classKey);
    if (!cls) throw new Error(`unknown feature class: ${classKey}`);
    const [w, s, e, n] = bbox.map((x) => Number(x).toFixed(6));
    const box = `(${s},${w},${n},${e})`;
    const elements = cls.elements || ['node', 'way', 'relation'];
    const parts = [];
    for (const set of cls.tags) {
      const f = tagFilter(set);
      for (const el of elements) parts.push(`  ${el}${f}${box};`);
    }
    return `[out:json][timeout:25];\n(\n${parts.join('\n')}\n);\nout geom ${limit};`;
  }

  // ---------- failure classification (PRD §25) ----------
  //
  // Overpass reports failure in three shapes that a status-code check alone
  // cannot tell apart:
  //   1. HTTP 200 with an HTML/plain-text error body ("runtime error: Query
  //      timed out") — the request looks successful but carries no data,
  //   2. HTTP 504 — gateway timeout at the load balancer,
  //   3. HTTP 502 — backend refused / overloaded.
  // So the body is always inspected, whatever the status says.
  function classify(status, contentType, bodyText) {
    const body = String(bodyText || '');

    // A body that parses as Overpass JSON is authoritative, so it is examined
    // first: the text heuristics below must not fire on a place whose name
    // happens to contain "timeout".
    let data = null;
    try { data = JSON.parse(body); } catch { data = null; }

    if (data && Array.isArray(data.elements)) {
      // A partial or aborted run is reported inside an HTTP 200 JSON body.
      if (typeof data.remark === 'string' && /error|timed out|timeout/i.test(data.remark)) {
        const timedOut = /timed out|timeout/i.test(data.remark);
        return {
          ok: false,
          kind: timedOut ? 'timeout' : 'query_error',
          message: `Overpass: ${data.remark.slice(0, 200).trim()}`,
        };
      }
      if (status !== 200) {
        return { ok: false, kind: 'unavailable', message: `Overpass responded HTTP ${status}.` };
      }
      return { ok: true, kind: 'ok', data };
    }

    // No usable JSON. Both the body and the status matter here — status alone
    // is never enough, because Overpass serves error pages with HTTP 200 and
    // truncates long responses mid-body.
    const head = body.slice(0, 2000).toLowerCase();
    const looksHtml = /^\s*</.test(body) || /text\/html/i.test(contentType || '');

    if (/timed out|timeout/.test(head)) {
      return { ok: false, kind: 'timeout', message: 'Overpass query timed out — narrow the area or the feature class.' };
    }
    if (/too many requests|rate_?limited|slot available/.test(head)) {
      return { ok: false, kind: 'rate_limited', message: 'Overpass rate limit reached — retry in a moment.' };
    }
    if (status === 504) {
      return { ok: false, kind: 'timeout', message: 'Overpass gateway timeout (504) — narrow the area or the feature class.' };
    }
    if (status === 502 || status === 503) {
      return { ok: false, kind: 'unavailable', message: `Overpass unavailable (${status}) — the public endpoint is busy.` };
    }
    if (/runtime error|parse error|line \d+: /.test(head)) {
      return { ok: false, kind: 'query_error', message: `Overpass rejected the query: ${body.slice(0, 200).trim()}` };
    }
    if (looksHtml) {
      return { ok: false, kind: 'non_json', message: `Overpass returned an HTML page instead of JSON (HTTP ${status}).` };
    }

    if (data) { // parses, but is not an Overpass result document
      return { ok: false, kind: 'non_json', message: 'Overpass JSON has no elements array.' };
    }
    return { ok: false, kind: 'non_json', message: `Overpass returned a non-JSON body (HTTP ${status}).` };
  }

  // ---------- OSM → GeoJSON (PRD §11.1) ----------

  function ring(geometry) {
    return geometry.map((p) => [p.lon, p.lat]);
  }

  function isClosed(coords) {
    if (coords.length < 4) return false;
    const a = coords[0];
    const b = coords[coords.length - 1];
    return a[0] === b[0] && a[1] === b[1];
  }

  function toFeature(el, classKey, fetchedAt) {
    const tags = el.tags || {};
    const base = {
      type: 'Feature',
      id: `${el.type}/${el.id}`,
      properties: {
        name: tags.name || null,
        category: classKey,
        source: 'osm',
        sourceId: `${el.type}/${el.id}`,
        score: null,
        metrics: {},
        fetchedAt,
        tags,
      },
    };
    if (el.type === 'node') {
      return { ...base, geometry: { type: 'Point', coordinates: [el.lon, el.lat] } };
    }
    if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length) {
      const coords = ring(el.geometry);
      const expects = (registry.get(classKey) || {}).geometry;
      // A closed way is a polygon only when the class expects an area. Roads
      // and power lines close into loops (ring roads, service loops) without
      // enclosing anything, and turning one into a polygon would make every
      // point inside the loop report a distance of zero.
      if (expects !== 'line' && isClosed(coords)) {
        return { ...base, geometry: { type: 'Polygon', coordinates: [coords] } };
      }
      return { ...base, geometry: { type: 'LineString', coordinates: coords } };
    }
    // Relations arrive as multipolygons whose member geometry we do not stitch;
    // their bounding-box centre is a faithful enough representative point.
    if (el.bounds) {
      const lon = (el.bounds.minlon + el.bounds.maxlon) / 2;
      const lat = (el.bounds.minlat + el.bounds.maxlat) / 2;
      return { ...base, geometry: { type: 'Point', coordinates: [lon, lat] } };
    }
    if (el.center) {
      return { ...base, geometry: { type: 'Point', coordinates: [el.center.lon, el.center.lat] } };
    }
    return null;
  }

  function toGeoJSON(osmJson, classKey, cap) {
    const fetchedAt = new Date().toISOString();
    const features = [];
    let truncated = false;
    for (const el of osmJson.elements || []) {
      if (features.length >= cap) { truncated = true; break; }
      const f = toFeature(el, classKey, fetchedAt);
      if (f) features.push(f);
    }
    return { collection: { type: 'FeatureCollection', features }, truncated, fetchedAt };
  }

  // ---------- fetch through the proxy (PRD §8.4) ----------

  async function fetchClass(classKey, bbox, options) {
    const opts = options || {};
    const cap = opts.cap || 2000;
    const proxy = opts.proxyPath || '/api/proxy';
    const query = buildQuery(classKey, bbox, cap);
    const url = `${proxy}?url=${encodeURIComponent(ENDPOINT)}`;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      });
    } catch (e) {
      return { ok: false, kind: 'unreachable', message: `Overpass proxy unreachable: ${e}`, query };
    }
    const text = await res.text();
    const verdict = classify(res.status, res.headers.get('content-type'), text);
    if (!verdict.ok) return { ...verdict, query };

    const { collection, truncated, fetchedAt } = toGeoJSON(verdict.data, classKey, cap);
    return { ok: true, collection, truncated, fetchedAt, query, cap };
  }

  return { ENDPOINT, buildQuery, tagFilter, classify, toGeoJSON, toFeature, fetchClass };
});
