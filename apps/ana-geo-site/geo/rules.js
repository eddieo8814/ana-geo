// Rule vocabulary and validation for hard constraints (FR-SITE-002) and soft
// criteria (FR-SITE-003, FR-SITE-004).
//
// This file carries no Turf dependency on purpose: `server.js` validates every
// incoming rule with exactly the code the browser and the scoring engine use,
// without loading a map-sized bundle into the Node process. A rule that the
// server accepted can therefore never be a rule the engine refuses to read.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./registry.js'));
  } else {
    root.GeoRules = factory(root.GeoRegistry);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (registry) {
  const OPERATORS = ['>=', '<=', '>', '<'];
  const KINDS = ['distance', 'area'];

  // Canonical units: metres and square metres (see geo/scoring.js).
  const DISTANCE_UNITS = { m: 1, km: 1000 };
  const AREA_UNITS = { m2: 1, km2: 1e6, ha: 1e4 };

  const CONSTRAINT_FIELDS = ['id', 'kind', 'featureClass', 'metric', 'operator', 'value', 'unit', 'enabled', 'label'];
  const CRITERION_FIELDS = ['id', 'kind', 'featureClass', 'metric', 'unit', 'best', 'worst', 'weight', 'label'];

  function unitsFor(kind) {
    return kind === 'area' ? AREA_UNITS : DISTANCE_UNITS;
  }

  function defaultUnit(kind) {
    return kind === 'area' ? 'm2' : 'm';
  }

  // The metric a rule reads is derived, never supplied, so a rule can never
  // name a metric that the calculation stage does not produce.
  function deriveMetric(rule) {
    if (rule.kind === 'area') return 'area';
    return registry.metricKey(rule.featureClass);
  }

  function unknownField(patch, allowed, what) {
    for (const k of Object.keys(patch)) {
      if (!allowed.includes(k)) return `unknown ${what} field: ${k}`;
    }
    return null;
  }

  function checkKindAndClass(merged, what) {
    if (!KINDS.includes(merged.kind)) return `invalid ${what}: kind must be one of ${KINDS.join(', ')}`;
    if (merged.kind === 'distance') {
      if (typeof merged.featureClass !== 'string' || !merged.featureClass) {
        return `invalid ${what}: a distance rule needs a featureClass`;
      }
    }
    return null;
  }

  function checkUnit(merged, what) {
    const table = unitsFor(merged.kind);
    if (!table[merged.unit]) {
      return `invalid ${what}: unit "${merged.unit}" is not valid for a ${merged.kind} rule (use ${Object.keys(table).join(', ')})`;
    }
    return null;
  }

  function isNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  // `patch` may be a whole rule (on create) or a subset (on edit); `current` is
  // the existing rule when editing. Validation always runs against the merged
  // result, so changing a unit alone cannot leave the rule inconsistent.
  function validateConstraint(patch, current) {
    const bad = unknownField(patch, CONSTRAINT_FIELDS, 'constraint');
    if (bad) return bad;
    const merged = { kind: 'distance', enabled: true, ...(current || {}), ...patch };
    merged.unit = merged.unit || defaultUnit(merged.kind);
    return checkKindAndClass(merged, 'constraint')
      || checkUnit(merged, 'constraint')
      || (!OPERATORS.includes(merged.operator)
        ? `invalid constraint: unknown operator "${merged.operator}" (use ${OPERATORS.join(', ')})` : null)
      || (!isNumber(merged.value) ? 'invalid constraint: value must be a finite number' : null)
      || (merged.value < 0 ? 'invalid constraint: value must not be negative' : null)
      || (typeof merged.enabled !== 'boolean' ? 'invalid constraint: enabled must be a boolean' : null)
      || null;
  }

  function validateCriterion(patch, current) {
    const bad = unknownField(patch, CRITERION_FIELDS, 'criterion');
    if (bad) return bad;
    const merged = { kind: 'distance', ...(current || {}), ...patch };
    merged.unit = merged.unit || defaultUnit(merged.kind);
    return checkKindAndClass(merged, 'criterion')
      || checkUnit(merged, 'criterion')
      || (!isNumber(merged.best) ? 'invalid criterion: best must be a finite number' : null)
      || (!isNumber(merged.worst) ? 'invalid criterion: worst must be a finite number' : null)
      || (merged.best === merged.worst
        ? 'invalid criterion: best and worst must differ — they define the 0–100 scale (FR-SITE-007)' : null)
      || (!isNumber(merged.weight) ? 'invalid criterion: weight must be a finite number' : null)
      || (merged.weight < 0 ? 'invalid criterion: weight must not be negative' : null)
      || null;
  }

  // Fill in the fields the caller left out, so state always holds complete
  // rules: `metric` derived, `unit` defaulted, `id` unique within its list.
  function completeRule(rule, existing, prefix) {
    const out = { ...rule };
    out.kind = out.kind || 'distance';
    out.unit = out.unit || defaultUnit(out.kind);
    out.metric = deriveMetric(out);
    if (!out.id) {
      const base = out.kind === 'area' ? 'area' : out.featureClass;
      let id = base;
      let n = 2;
      const taken = new Set((existing || []).map((r) => r.id));
      while (taken.has(id)) { id = `${base}-${n}`; n += 1; }
      out.id = id;
    }
    if (prefix === 'constraint' && typeof out.enabled !== 'boolean') out.enabled = true;
    return out;
  }

  // ---------- FR-SITE-005: weight validation ----------
  //
  // Lives here rather than in the scoring engine because `server.js` recomputes
  // it after every criterion edit, so `analysis.site.weights` in state always
  // agrees with what a run would decide.

  const WEIGHT_TOLERANCE = 1e-6;

  function round(n, digits) {
    const p = 10 ** digits;
    return Math.round(n * p) / p;
  }

  function validateWeights(criteria) {
    const list = criteria || [];
    if (!list.length) {
      return { sum: 0, valid: false, error: 'no soft criteria defined — add at least one (FR-SITE-003).' };
    }
    let sum = 0;
    for (const c of list) {
      if (!isNumber(c.weight) || c.weight < 0) {
        return { sum: null, valid: false, error: `criterion "${c.id}" has an invalid weight: ${c.weight} (weights are non-negative numbers).` };
      }
      sum += c.weight;
    }
    sum = round(sum, 9);
    const valid = Math.abs(sum - 1) <= WEIGHT_TOLERANCE;
    return {
      sum,
      valid,
      error: valid ? null
        : `criterion weights must sum to 1.0 — they sum to ${round(sum, 4)} (FR-SITE-005). `
          + 'Adjust a weight, or use "Normalize" to scale them all.',
    };
  }

  // The auto-fix offered beside the error, never applied silently: rescaling
  // weights changes the ranking, so it stays an explicit user (or ANA) action.
  function normalizeWeights(criteria) {
    const list = criteria || [];
    if (!list.length) return [];
    const sum = list.reduce((a, c) => a + (Number(c.weight) > 0 ? Number(c.weight) : 0), 0);
    if (!(sum > 0)) {
      const even = round(1 / list.length, 6);
      return list.map((c, i) => ({ ...c, weight: i === list.length - 1 ? round(1 - even * (list.length - 1), 9) : even }));
    }
    const scaled = list.map((c) => ({ ...c, weight: round((Number(c.weight) || 0) / sum, 6) }));
    // Absorb the rounding residue into the largest weight so the sum is exactly 1.
    const drift = round(1 - scaled.reduce((a, c) => a + c.weight, 0), 9);
    if (drift !== 0) {
      let big = 0;
      scaled.forEach((c, i) => { if (c.weight > scaled[big].weight) big = i; });
      scaled[big] = { ...scaled[big], weight: round(scaled[big].weight + drift, 9) };
    }
    return scaled;
  }

  // Rules are addressed by id in conversation ("raise the road weight") and by
  // index in the UI; both resolve here.
  function indexOfRule(list, ref) {
    const arr = list || [];
    if (/^\d+$/.test(String(ref))) {
      const i = Number(ref);
      return i >= 0 && i < arr.length ? i : -1;
    }
    return arr.findIndex((r) => r.id === ref);
  }

  return {
    OPERATORS,
    KINDS,
    DISTANCE_UNITS,
    AREA_UNITS,
    CONSTRAINT_FIELDS,
    CRITERION_FIELDS,
    WEIGHT_TOLERANCE,
    unitsFor,
    defaultUnit,
    deriveMetric,
    validateConstraint,
    validateCriterion,
    validateWeights,
    normalizeWeights,
    completeRule,
    indexOfRule,
  };
});
