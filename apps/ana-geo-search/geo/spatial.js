// Turf.js spatial engine (FR-SEARCH-001 … FR-SEARCH-008).
//
// Runs in the browser against vendor/turf/turf.min.js, and in Node against the
// same bundle (it is UMD), which is what tools/smoke_spatial.mjs exercises.
//
// Convention: a *target* feature is reduced to one representative point, while
// a *reference* feature keeps its geometry — so "within 2 km of a university"
// measures to the campus edge (turf.pointToPolygonDistance), not to its centre.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../vendor/turf/turf.min.js'));
  } else {
    root.GeoSpatial = factory(root.turf);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (turf) {
  const RESULT_CAP = 2000; // PRD §26.1

  const UNITS = { m: 'meters', km: 'kilometers' };

  function unitName(unit) {
    const u = UNITS[unit];
    if (!u) throw new Error(`unsupported unit: ${unit} (use "m" or "km")`);
    return u;
  }

  function toKm(distance, unit) {
    const d = Number(distance);
    if (!Number.isFinite(d) || d < 0) throw new Error(`invalid distance: ${distance}`);
    return unit === 'km' ? d : d / 1000;
  }

  function featuresOf(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input;
    if (input.type === 'FeatureCollection') return input.features || [];
    if (input.type === 'Feature') return [input];
    return [];
  }

  // ---------- geometry helpers ----------

  function representativePoint(feature) {
    const g = feature && feature.geometry;
    if (!g) throw new Error('feature has no geometry');
    if (g.type === 'Point') return turf.point(g.coordinates);
    if (g.type === 'MultiPoint') return turf.point(g.coordinates[0]);
    return turf.centroid(feature);
  }

  // Shortest distance in km from a point to any geometry type (FR-SEARCH-001).
  function pointToFeatureKm(point, feature) {
    const g = feature.geometry;
    if (!g) throw new Error(`unsupported geometry: null`);
    switch (g.type) {
      case 'Point':
        return turf.distance(point, turf.point(g.coordinates), { units: 'kilometers' });
      case 'MultiPoint':
        return Math.min(...g.coordinates.map((c) => turf.distance(point, turf.point(c), { units: 'kilometers' })));
      case 'LineString':
      case 'MultiLineString':
        return turf.pointToLineDistance(point, feature, { units: 'kilometers' });
      case 'Polygon':
      case 'MultiPolygon': {
        // turf 7 returns a signed distance: negative when the point is inside.
        const d = turf.pointToPolygonDistance(point, feature, { units: 'kilometers' });
        return Math.max(0, d);
      }
      case 'GeometryCollection':
        return Math.min(...g.geometries.map((geom) => pointToFeatureKm(point, { type: 'Feature', geometry: geom, properties: {} })));
      default:
        throw new Error(`unsupported geometry: ${g.type}`);
    }
  }

  // Distance from a target feature to the closest of a reference set, in km.
  function nearestReferenceKm(targetFeature, references) {
    const pt = representativePoint(targetFeature);
    let best = Infinity;
    let bestRef = null;
    for (const ref of references) {
      if (!ref || !ref.geometry) continue;
      const d = pointToFeatureKm(pt, ref);
      if (d < best) { best = d; bestRef = ref; }
    }
    return { km: best, reference: bestRef };
  }

  // ---------- primitive operations ----------

  // FR-SEARCH-001 — distance between two spatial objects, in the given unit.
  function distanceBetween(a, b, unit) {
    const km = pointToFeatureKm(representativePoint(a), b);
    return unit === 'km' ? km : km * 1000;
  }

  // FR-SEARCH-002 — buffer around a point, line, or polygon.
  function buffer(feature, distance, unit) {
    const out = turf.buffer(feature, Number(distance), { units: unitName(unit) });
    return out || null;
  }

  function bufferAll(features, distance, unit, props) {
    const out = [];
    for (const f of featuresOf(features)) {
      const b = buffer(f, distance, unit);
      if (!b) continue;
      b.properties = { ...(b.properties || {}), ...(props || {}), bufferOf: f.id || null };
      out.push(b);
    }
    return { type: 'FeatureCollection', features: out };
  }

  // FR-SEARCH-003 — features inside a polygon.
  function within(targets, polygons) {
    const polys = featuresOf(polygons).filter(
      (p) => p.geometry && (p.geometry.type === 'Polygon' || p.geometry.type === 'MultiPolygon'),
    );
    if (!polys.length) throw new Error('"within" needs at least one polygon reference feature');
    const hits = [];
    for (const t of featuresOf(targets)) {
      const pt = representativePoint(t);
      if (polys.some((p) => turf.booleanPointInPolygon(pt, p))) hits.push(t);
    }
    return hits;
  }

  // FR-SEARCH-004 — features within a distance of any reference feature.
  function withinDistance(targets, references, distance, unit) {
    const limitKm = toKm(distance, unit);
    const refs = featuresOf(references);
    if (!refs.length) throw new Error('"within_distance" needs at least one reference feature');
    const hits = [];
    for (const t of featuresOf(targets)) {
      const { km } = nearestReferenceKm(t, refs);
      if (km <= limitKm) hits.push({ feature: t, km });
    }
    return hits;
  }

  // FR-SEARCH-005 — features farther than a distance from every reference feature.
  function outsideDistance(targets, references, distance, unit) {
    const limitKm = toKm(distance, unit);
    const refs = featuresOf(references);
    if (!refs.length) throw new Error('"outside_distance" needs at least one reference feature');
    const hits = [];
    for (const t of featuresOf(targets)) {
      const { km } = nearestReferenceKm(t, refs);
      if (km > limitKm) hits.push({ feature: t, km });
    }
    return hits;
  }

  // FR-SEARCH-006 — the N features closest to the reference set.
  function nearest(targets, references, n) {
    const refs = featuresOf(references);
    if (!refs.length) throw new Error('"nearest" needs at least one reference feature');
    const count = Math.max(1, Number(n) || 1);
    return featuresOf(targets)
      .map((t) => ({ feature: t, km: nearestReferenceKm(t, refs).km }))
      .filter((r) => Number.isFinite(r.km))
      .sort((a, b) => a.km - b.km)
      .slice(0, count);
  }

  // ---------- condition model evaluation (§17.4, FR-SEARCH-007/008) ----------

  const RELATIONS = ['within', 'within_distance', 'outside_distance', 'nearest'];

  function conditionLabel(c) {
    if (c.relation === 'within') return `within ${c.reference}`;
    if (c.relation === 'nearest') return `${c.count || 5} nearest to ${c.reference}`;
    const verb = c.relation === 'outside_distance' ? 'farther than' : 'within';
    return `${verb} ${c.distance} ${c.unit} of ${c.reference}`;
  }

  function summarize(analysis) {
    if (!analysis || !analysis.target) return 'no query';
    const conds = analysis.conditions || [];
    if (!conds.length) return `${analysis.target} (no conditions)`;
    const join = ` ${analysis.operator === 'OR' ? 'OR' : 'AND'} `;
    return `${analysis.target}: ${conds.map(conditionLabel).join(join)}`;
  }

  function keyOf(feature, index) {
    return feature.id != null ? String(feature.id) : `#${index}`;
  }

  // `resolve(key)` returns the FeatureCollection acquired for a category key or
  // layer id. Returns matched features plus a per-condition breakdown (§23.3).
  function evaluate(analysis, resolve, options) {
    const opts = options || {};
    const cap = opts.cap || RESULT_CAP;
    if (!analysis || !analysis.target) throw new Error('analysis has no target');

    const targets = featuresOf(resolve(analysis.target));
    if (!targets.length) throw new Error(`no features acquired for target "${analysis.target}"`);

    const conditions = analysis.conditions || [];
    const operator = analysis.operator === 'OR' ? 'OR' : 'AND';
    const index = new Map();
    const keyByFeature = new Map();
    targets.forEach((f, i) => {
      const k = keyOf(f, i);
      index.set(k, f);
      keyByFeature.set(f, k);
    });

    const breakdown = [];
    const distances = new Map(); // target key -> { conditionIndex: km }

    if (!conditions.length) {
      const features = targets.slice(0, cap);
      return { features, truncated: targets.length > cap, breakdown, operator, summary: summarize(analysis) };
    }

    const sets = conditions.map((c, ci) => {
      if (!RELATIONS.includes(c.relation)) {
        throw new Error(`invalid spatial condition: unknown relation "${c.relation}"`);
      }
      const refs = featuresOf(resolve(c.reference));
      if (!refs.length) throw new Error(`no features acquired for reference "${c.reference}"`);

      let matched;
      if (c.relation === 'within') {
        matched = within(targets, refs).map((f) => ({ feature: f, km: 0 }));
      } else if (c.relation === 'within_distance') {
        matched = withinDistance(targets, refs, c.distance, c.unit);
      } else if (c.relation === 'outside_distance') {
        matched = outsideDistance(targets, refs, c.distance, c.unit);
      } else {
        matched = nearest(targets, refs, c.count);
      }

      const keys = new Set();
      matched.forEach((m) => {
        const k = keyByFeature.get(m.feature);
        if (k === undefined) return;
        keys.add(k);
        if (!distances.has(k)) distances.set(k, {});
        distances.get(k)[ci] = m.km;
      });
      breakdown.push({ condition: c, label: conditionLabel(c), matchCount: keys.size, referenceCount: refs.length });
      return keys;
    });

    let combined = sets[0];
    for (let i = 1; i < sets.length; i += 1) {
      const next = new Set();
      if (operator === 'OR') {
        sets[i].forEach((k) => next.add(k));
        combined.forEach((k) => next.add(k));
      } else {
        combined.forEach((k) => { if (sets[i].has(k)) next.add(k); });
      }
      combined = next;
    }

    const features = [];
    let truncated = false;
    for (const k of combined) {
      if (features.length >= cap) { truncated = true; break; }
      const f = index.get(k);
      if (!f) continue;
      const metrics = {};
      const perCond = distances.get(k) || {};
      conditions.forEach((c, ci) => {
        if (perCond[ci] === undefined) return;
        const km = perCond[ci];
        metrics[`${c.relation}:${c.reference}`] = c.unit === 'km' ? round(km, 3) : round(km * 1000, 1);
      });
      features.push({ ...f, properties: { ...f.properties, metrics } });
    }

    return { features, truncated, breakdown, operator, summary: summarize(analysis) };
  }

  function round(n, digits) {
    const p = 10 ** digits;
    return Math.round(n * p) / p;
  }

  // Buffers for every distance-based condition, so the query geometry is
  // visible on the map (FR-SEARCH-002, FR-SEARCH-009).
  function conditionBuffers(analysis, resolve) {
    const out = [];
    for (const c of (analysis && analysis.conditions) || []) {
      if (c.relation !== 'within_distance' && c.relation !== 'outside_distance') continue;
      const refs = featuresOf(resolve(c.reference));
      if (!refs.length) continue;
      const fc = bufferAll(refs, c.distance, c.unit, {
        relation: c.relation,
        reference: c.reference,
        distance: c.distance,
        unit: c.unit,
      });
      out.push(...fc.features);
    }
    return { type: 'FeatureCollection', features: out };
  }

  return {
    RESULT_CAP,
    RELATIONS,
    toKm,
    representativePoint,
    pointToFeatureKm,
    nearestReferenceKm,
    distanceBetween,
    buffer,
    bufferAll,
    within,
    withinDistance,
    outsideDistance,
    nearest,
    evaluate,
    conditionBuffers,
    conditionLabel,
    summarize,
  };
});
