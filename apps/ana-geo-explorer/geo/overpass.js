// ana-geo-explorer — Overpass QL builder + OSM JSON → GeoJSON conversion.
// No external library: the conversion is ~40 lines because every preset in
// geo/registry.js normalizes to a Point (PRD §11.1).
//
// Loadable both in the browser (`window.GeoOverpass`) and in Node (`require`).

(function (root, factory) {
  const registry = (typeof module === 'object' && module.exports)
    ? require('./registry.js')
    : root.GeoRegistry;
  const api = factory(registry);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GeoOverpass = api;
})(typeof self !== 'undefined' ? self : this, function (registry) {
  const ENDPOINT = 'https://overpass-api.de/api/interpreter';
  const RESULT_CAP = 2000; // PRD §26.1 — recommended initial cap 500–2,000 features

  function tagFilter(tags) {
    return Object.entries(tags).map(([k, v]) => `["${k}"="${v}"]`).join('');
  }

  // One request for ALL selected categories (a merged union), so a five-box
  // search costs the public instance one query instead of five.
  // bbox is [south, west, north, east].
  function buildQuery(categoryKeys, bbox, opts) {
    const { timeout = 25, limit = RESULT_CAP } = opts || {};
    const bb = bbox.map((n) => Number(n).toFixed(6)).join(',');
    const clauses = [];
    for (const key of categoryKeys) {
      const cat = registry.get(key);
      if (!cat) throw new Error(`unknown category: ${key}`);
      const f = tagFilter(cat.tags);
      for (const el of cat.elements) clauses.push(`  ${el}${f}(${bb});`);
    }
    if (!clauses.length) throw new Error('no categories selected');
    // `out center` gives ways/relations a representative point; the trailing
    // number caps the response server-side as well as in the client.
    return `[out:json][timeout:${timeout}];\n(\n${clauses.join('\n')}\n);\nout center ${limit};`;
  }

  // Overpass returns HTTP 200 with an HTML error page when it is overloaded or
  // rate limiting, so the status code alone never decides success (PRD §25).
  // Callers pass the raw response text; this throws a readable Error instead.
  function parseResponse(text, status) {
    let osm;
    try { osm = JSON.parse(text); } catch {
      const hint = /rate_limited|too many requests|slow down/i.test(text)
        ? 'Overpass is rate limiting this IP — wait a minute and retry.'
        : /timeout|timed out/i.test(text)
          ? 'Overpass timed out on this query — zoom in or select fewer categories.'
          : 'Overpass returned a non-JSON body (public instance busy or rate limiting).';
      throw new Error(`${hint} (HTTP ${status})`);
    }
    if (!osm || !Array.isArray(osm.elements)) throw new Error('Overpass response has no elements array');
    if (osm.remark) throw new Error(`Overpass remark: ${osm.remark}`);
    return osm;
  }

  // OSM JSON → GeoJSON features (PRD §11.1 property model).
  // Returns { features, skipped } — `skipped` counts elements with no usable
  // position (unsupported geometry, §25).
  function toFeatures(osm, fetchedAt) {
    const at = fetchedAt || new Date().toISOString();
    const features = [];
    let skipped = 0;
    for (const el of osm.elements) {
      const lat = el.type === 'node' ? el.lat : el.center && el.center.lat;
      const lon = el.type === 'node' ? el.lon : el.center && el.center.lon;
      if (typeof lat !== 'number' || typeof lon !== 'number') { skipped++; continue; }
      const tags = el.tags || {};
      const category = registry.classify(tags);
      if (!category) { skipped++; continue; } // matched no registry entry
      const sourceId = `${el.type}/${el.id}`;
      features.push({
        type: 'Feature',
        id: sourceId,
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          name: tags.name || null,
          category,
          source: 'osm',
          sourceId,
          score: null,
          metrics: {},
          fetchedAt: at,
          tags,
        },
      });
    }
    return { features, skipped };
  }

  function groupByCategory(features) {
    const byCat = new Map();
    for (const f of features) {
      const k = f.properties.category;
      if (!byCat.has(k)) byCat.set(k, []);
      byCat.get(k).push(f);
    }
    return byCat;
  }

  function bboxOf(features) {
    if (!features.length) return [];
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const f of features) {
      const [lon, lat] = f.geometry.coordinates;
      if (lon < w) w = lon; if (lon > e) e = lon;
      if (lat < s) s = lat; if (lat > n) n = lat;
    }
    return [w, s, e, n];
  }

  return { ENDPOINT, RESULT_CAP, buildQuery, parseResponse, toFeatures, groupByCategory, bboxOf };
});
