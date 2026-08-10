// Site evaluation engine (FR-SITE-005 … FR-SITE-010).
//
// Runs in the browser against vendor/turf/turf.min.js, and in Node against the
// same bundle (it is UMD), which is what tools/smoke_scoring.mjs exercises.
//
// The pipeline is deliberately one function per PRD requirement, so that each
// stage can be checked on its own:
//
//   metrics    (FR-SITE-006) — raw distances/areas per candidate, in metres
//   normalize  (FR-SITE-007) — one raw value → 0–100 against the criterion's
//                              best/worst bounds
//   score      (FR-SITE-008) — Σ weight × normalized score
//   rank       (FR-SITE-009) — eligible candidates ordered by score
//   explain    (FR-SITE-010) — the §23.3 "This site ranked #1 because" text
//
// Hard constraints (FR-SITE-002) gate the ranking: a candidate that fails one
// keeps its metrics and its score, but takes no rank.
//
// Representative points: a candidate polygon is reduced to its centroid before
// any distance is measured. Reference features keep their full geometry, so a
// distance is measured to a road's centre line and to a residential area's
// edge, not to their centres.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../vendor/turf/turf.min.js'), require('./rules.js'), require('./registry.js'));
  } else {
    root.GeoScoring = factory(root.turf, root.GeoRules, root.GeoRegistry);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (turf, rules, registry) {
  const RESULT_CAP = 2000;        // PRD §26.1 — per reference layer
  const CANDIDATE_CAP = 500;      // candidates are compared against every reference
  const WEIGHT_TOLERANCE = 1e-6;  // FR-SITE-005

  // Metrics are stored in one canonical unit per kind — metres and square
  // metres — so the §18.4 `metrics` object never needs a unit lookup to be
  // read. Constraint thresholds and criterion bounds carry their own unit and
  // are converted before they are compared. The vocabulary itself lives in
  // geo/rules.js, which server.js validates against.
  const { OPERATORS, KINDS, DISTANCE_UNITS, AREA_UNITS, unitsFor } = rules;

  function toCanonical(value, unit, kind) {
    const table = unitsFor(kind);
    const factor = table[unit];
    if (!factor) throw new Error(`unsupported unit "${unit}" for a ${kind} value (use ${Object.keys(table).join(', ')})`);
    const v = Number(value);
    if (!Number.isFinite(v)) throw new Error(`invalid ${kind} value: ${value}`);
    return v * factor;
  }

  function fromCanonical(value, unit, kind) {
    return value / unitsFor(kind)[unit];
  }

  function round(n, digits) {
    const p = 10 ** digits;
    return Math.round(n * p) / p;
  }

  function featuresOf(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input;
    if (input.type === 'FeatureCollection') return input.features || [];
    if (input.type === 'Feature') return [input];
    return [];
  }

  // ---------- geometry (FR-SITE-006) ----------

  // A polygon candidate is approximated by its centroid. This is the one
  // approximation in the metric pipeline and it is stated in the UI, the SPEC
  // and the README: a 2 km-wide parcel whose centre is 1 km from a road still
  // reports 1 km, even though its edge touches the road.
  function representativePoint(feature) {
    const g = feature && feature.geometry;
    if (!g) throw new Error('candidate has no geometry');
    if (g.type === 'Point') return turf.point(g.coordinates);
    if (g.type === 'MultiPoint') return turf.point(g.coordinates[0]);
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') return turf.centroid(feature);
    throw new Error(`unsupported candidate geometry: ${g.type} (candidates are points or polygons, FR-SITE-001)`);
  }

  // Shortest distance in metres from a point to a reference feature, dispatched
  // on the reference geometry: a way line uses pointToLineDistance, an area
  // uses pointToPolygonDistance (Turf 7.3+), a node uses plain distance.
  function pointToFeatureMeters(point, feature) {
    const g = feature && feature.geometry;
    if (!g) throw new Error('reference feature has no geometry');
    switch (g.type) {
      case 'Point':
        return turf.distance(point, turf.point(g.coordinates), { units: 'meters' });
      case 'MultiPoint':
        return Math.min(...g.coordinates.map((c) => turf.distance(point, turf.point(c), { units: 'meters' })));
      case 'LineString':
      case 'MultiLineString':
        return turf.pointToLineDistance(point, feature, { units: 'meters' });
      case 'Polygon':
      case 'MultiPolygon': {
        // Turf 7 returns a signed distance: negative when the point is inside.
        // A candidate standing inside a residential polygon is 0 m from it.
        return Math.max(0, turf.pointToPolygonDistance(point, feature, { units: 'meters' }));
      }
      case 'GeometryCollection':
        return Math.min(...g.geometries.map((geom) => pointToFeatureMeters(point, { type: 'Feature', geometry: geom, properties: {} })));
      default:
        throw new Error(`unsupported reference geometry: ${g.type}`);
    }
  }

  // Distance from a candidate to the closest feature of a reference set.
  function nearestReference(point, references) {
    let best = Infinity;
    let bestFeature = null;
    for (const ref of references) {
      if (!ref || !ref.geometry) continue;
      const d = pointToFeatureMeters(point, ref);
      if (d < best) { best = d; bestFeature = ref; }
    }
    if (!Number.isFinite(best)) return { meters: null, feature: null };
    return { meters: best, feature: bestFeature };
  }

  function candidateArea(feature) {
    const g = feature && feature.geometry;
    if (!g) return null;
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') return turf.area(feature);
    return null; // a point has no area — an area rule on it is reported, not guessed
  }

  // ---------- rules ----------

  // Every constraint and criterion names the metric it reads. The name is
  // derived from the rule rather than supplied, by the same function the server
  // used when it stored the rule, so a rule can never point at a metric that no
  // stage computes.
  function metricNameOf(rule) {
    if (rule.kind !== 'area' && !rule.featureClass) throw new Error('a distance rule needs a featureClass');
    return rules.deriveMetric(rule);
  }

  function requiredClasses(constraints, criteria) {
    const out = [];
    for (const r of [...(constraints || []), ...(criteria || [])]) {
      if (r.kind === 'area') continue;
      if (r.enabled === false) continue;
      if (r.featureClass && !out.includes(r.featureClass)) out.push(r.featureClass);
    }
    return out;
  }

  function needsArea(constraints, criteria) {
    return [...(constraints || []), ...(criteria || [])].some((r) => r.kind === 'area' && r.enabled !== false);
  }

  // FR-SITE-005 — weight validation lives in geo/rules.js so that server.js can
  // run it without loading Turf; it is re-exported here as part of the engine's
  // surface.
  const { validateWeights, normalizeWeights } = rules;

  // ---------- FR-SITE-007: normalization ----------

  function criterionDirection(criterion) {
    return Number(criterion.best) < Number(criterion.worst) ? 'lower_is_better' : 'higher_is_better';
  }

  // `best` scores 100, `worst` scores 0, values in between interpolate
  // linearly, values beyond either bound clamp. Which end is "best" is implied
  // by the bounds themselves, so a criterion cannot disagree with itself.
  function normalize(rawCanonical, criterion) {
    const kind = criterion.kind === 'area' ? 'area' : 'distance';
    const unit = criterion.unit || (kind === 'area' ? 'm2' : 'm');
    const best = toCanonical(criterion.best, unit, kind);
    const worst = toCanonical(criterion.worst, unit, kind);
    if (best === worst) {
      throw new Error(`criterion "${criterion.id}" has best === worst (${criterion.best} ${unit}) — the scale would divide by zero.`);
    }
    if (rawCanonical === null || rawCanonical === undefined || !Number.isFinite(rawCanonical)) return null;
    const t = (rawCanonical - worst) / (best - worst);
    return round(100 * Math.min(1, Math.max(0, t)), 1);
  }

  // ---------- FR-SITE-002: hard constraints ----------

  function compare(raw, operator, threshold) {
    switch (operator) {
      case '>=': return raw >= threshold;
      case '<=': return raw <= threshold;
      case '>': return raw > threshold;
      case '<': return raw < threshold;
      default: throw new Error(`invalid constraint: unknown operator "${operator}" (use ${OPERATORS.join(', ')})`);
    }
  }

  function constraintLabel(c) {
    const what = c.kind === 'area' ? 'area' : `${registry.label(c.featureClass)} distance`;
    return `${what} ${c.operator} ${c.value} ${c.unit}`;
  }

  function criterionLabel(c) {
    if (c.label) return c.label;
    if (c.kind === 'area') return 'area';
    return `${registry.label(c.featureClass)} proximity`;
  }

  // ---------- the pipeline ----------

  // `input`  = { candidates: FeatureCollection, constraints: [...], criteria: [...] }
  // `resolve(featureClass)` returns the acquired FeatureCollection for a class.
  //
  // Throws (rather than returning a partial answer) when the analysis is not
  // runnable at all: unbalanced weights, a missing reference set, a broken
  // criterion scale. Those are the §25 failure states the Watch surface shows.
  function evaluate(input, resolve, options) {
    const opts = options || {};
    const cap = opts.cap || CANDIDATE_CAP;
    const constraints = (input.constraints || []).filter((c) => c.enabled !== false);
    const criteria = input.criteria || [];
    const candidates = featuresOf(input.candidates);

    if (!candidates.length) throw new Error('no candidates defined — click the map or load a GeoJSON file (FR-SITE-001).');

    const weights = validateWeights(criteria);
    if (!weights.valid) throw new Error(weights.error); // FR-SITE-005

    // Resolve every reference set once; a missing one is an error, not a
    // silently absent metric, because "no residential areas acquired" and
    // "no residential areas nearby" must never look the same.
    const classes = requiredClasses(constraints, criteria);
    const refs = new Map();
    for (const key of classes) {
      const set = featuresOf(resolve(key));
      if (!set.length) {
        throw new Error(`no reference features acquired for "${key}" — acquire it from Overpass or load a GeoJSON file first.`);
      }
      refs.set(key, set);
    }
    const wantArea = needsArea(constraints, criteria);

    const warnings = [];
    for (const c of constraints) {
      const caution = c.kind === 'area' ? null : registry.caution(c.featureClass);
      if (caution) warnings.push(`hard constraint on "${c.featureClass}": ${caution}`);
    }

    const truncated = candidates.length > cap;
    const used = candidates.slice(0, cap);
    const results = [];

    used.forEach((feature, i) => {
      const candidateId = String(feature.id || (feature.properties && feature.properties.candidateId) || `site-${i + 1}`);
      const point = representativePoint(feature);
      const [lon, lat] = point.geometry.coordinates;

      // FR-SITE-006 — raw metrics, in metres and square metres.
      const metrics = {};
      const nearestIds = {};
      for (const key of classes) {
        const { meters, feature: nearestFeature } = nearestReference(point, refs.get(key));
        const name = registry.metricKey(key);
        metrics[name] = meters === null ? null : round(meters, 1);
        nearestIds[name] = nearestFeature ? (nearestFeature.id || null) : null;
      }
      if (wantArea) {
        const a = candidateArea(feature);
        metrics.area = a === null ? null : round(a, 1);
      }

      // FR-SITE-002 — pass/fail, evaluated on the canonical metric values.
      const constraintChecks = [];
      for (const c of constraints) {
        const kind = c.kind === 'area' ? 'area' : 'distance';
        const name = metricNameOf(c);
        const raw = metrics[name];
        const threshold = toCanonical(c.value, c.unit, kind);
        let pass;
        let message;
        if (raw === null || raw === undefined) {
          pass = false;
          message = kind === 'area'
            ? 'area is undefined for a point candidate — upload a polygon candidate to use an area constraint'
            : `metric "${name}" could not be measured`;
        } else {
          pass = compare(raw, c.operator, threshold);
          const shown = round(fromCanonical(raw, c.unit, kind), 2);
          message = pass
            ? `${name} is ${shown} ${c.unit}, which satisfies ${c.operator} ${c.value} ${c.unit}`
            : `${name} is ${shown} ${c.unit}, which fails ${c.operator} ${c.value} ${c.unit}`;
        }
        constraintChecks.push({
          constraintId: c.id, metric: name, operator: c.operator, value: c.value, unit: c.unit,
          raw: raw === null || raw === undefined ? null : round(fromCanonical(raw, c.unit, kind), 3),
          pass, message, label: constraintLabel(c),
        });
      }
      const eligible = constraintChecks.every((c) => c.pass);

      // FR-SITE-007 / FR-SITE-008 — normalize, then weight.
      const criteriaScores = {};
      const contributions = [];
      let score = 0;
      for (const c of criteria) {
        const name = metricNameOf(c);
        const raw = metrics[name];
        const s = normalize(raw, c);
        criteriaScores[c.id] = s;
        const contribution = s === null ? 0 : round(s * c.weight, 4);
        score += contribution;
        contributions.push({
          criterionId: c.id,
          label: criterionLabel(c),
          metric: name,
          raw: raw === null || raw === undefined ? null : round(fromCanonical(raw, c.unit || 'm', c.kind === 'area' ? 'area' : 'distance'), 2),
          unit: c.unit || 'm',
          direction: criterionDirection(c),
          score: s,
          weight: c.weight,
          contribution,
        });
      }

      results.push({
        // §18.4 result model
        candidateId,
        eligible,
        score: round(score, 1),
        metrics,
        criteriaScores,
        // additions required by FR-SITE-009 / FR-SITE-010
        rank: null,
        label: (feature.properties && feature.properties.label) || (feature.properties && feature.properties.name) || candidateId,
        geometryType: feature.geometry.type,
        representativePoint: [round(lon, 6), round(lat, 6)],
        nearestReferences: nearestIds,
        constraintChecks,
        contributions,
        explanation: null,
      });
    });

    // FR-SITE-009 — only eligible candidates are ranked. Ties break on
    // candidateId so that two runs over the same state produce the same order.
    const ranked = results.filter((r) => r.eligible)
      .sort((a, b) => (b.score - a.score) || a.candidateId.localeCompare(b.candidateId));
    ranked.forEach((r, i) => { r.rank = i + 1; });

    // FR-SITE-010 / §23.3
    for (const r of results) r.explanation = explain(r);

    const ordered = [...ranked, ...results.filter((r) => !r.eligible).sort((a, b) => a.candidateId.localeCompare(b.candidateId))];

    return {
      generatedAt: new Date().toISOString(),
      candidateCount: candidates.length,
      evaluatedCount: used.length,
      eligibleCount: ranked.length,
      truncated,
      weights,
      warnings,
      results: ordered,
      summary: summarize({ constraints: input.constraints, criteria }),
    };
  }

  // ---------- FR-SITE-010: explanation (§23.3) ----------

  function explain(result) {
    if (!result.eligible) {
      const failed = (result.constraintChecks || []).filter((c) => !c.pass);
      return {
        headline: `${result.label} was rejected because:`,
        lines: failed.map((c) => `${c.label}: ${c.message}`),
        eligible: false,
      };
    }
    const lines = (result.contributions || [])
      .slice()
      .sort((a, b) => b.contribution - a.contribution)
      .map((c) => `${c.label}: ${c.score}`);
    return {
      headline: `This site ranked #${result.rank} because:`,
      lines,
      detail: (result.contributions || [])
        .slice()
        .sort((a, b) => b.contribution - a.contribution)
        .map((c) => `${c.label}: ${c.score} × weight ${c.weight} = ${c.contribution} (${c.metric} ${c.raw} ${c.unit})`),
      eligible: true,
    };
  }

  // The §23.3 text form, used by the panel and by ANA's replies.
  function explanationText(result) {
    const e = result.explanation || explain(result);
    return [e.headline, ...e.lines.map((l) => `- ${l}`)].join('\n');
  }

  // ---------- always-visible summary (§23.2) ----------

  function summarize(analysis) {
    const constraints = (analysis && analysis.constraints) || [];
    const criteria = (analysis && analysis.criteria) || [];
    if (!constraints.length && !criteria.length) return 'no constraints or criteria';
    const hard = constraints.filter((c) => c.enabled !== false).map(constraintLabel).join(', ') || 'none';
    const soft = criteria.map((c) => `${criterionLabel(c)} ${Math.round((c.weight || 0) * 100)}%`).join(', ') || 'none';
    return `hard: ${hard} · soft: ${soft}`;
  }

  return {
    RESULT_CAP,
    CANDIDATE_CAP,
    WEIGHT_TOLERANCE,
    OPERATORS,
    KINDS,
    DISTANCE_UNITS,
    AREA_UNITS,
    toCanonical,
    fromCanonical,
    representativePoint,
    pointToFeatureMeters,
    nearestReference,
    candidateArea,
    metricNameOf,
    requiredClasses,
    needsArea,
    validateWeights,
    normalizeWeights,
    criterionDirection,
    criterionLabel,
    constraintLabel,
    normalize,
    compare,
    evaluate,
    explain,
    explanationText,
    summarize,
  };
});
