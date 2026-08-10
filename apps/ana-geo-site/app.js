// ana-geo-site client — candidate definition, reference acquisition, and the
// constraint/criteria model that turns them into a ranked, explained answer
// (PRD §8.2, §12, §18).
/* global L, GeoRegistry, GeoRules, GeoOverpass, GeoScoring, GeoLayers */

const RESULT_CAP = GeoScoring.RESULT_CAP; // 2,000 per reference layer (PRD §26.1)

let state = null;
let map;
let picking = false;                 // "Add by map click" mode (FR-SITE-001)
let candidates = { type: 'FeatureCollection', features: [] };
let candidateLayer = null;
let candidateVersion = -1;
let resultsById = new Map();         // candidateId -> §18.4 result object
let resultsDoc = null;
let selected = null;                 // candidateId whose breakdown is shown
const leafletLayers = new Map();     // layer id -> { layer, resultVersion }
const featureCache = new Map();      // feature class key -> FeatureCollection
let lastAppliedView = '';
let feedSince = 0;
let saving = Promise.resolve();

const $ = (id) => document.getElementById(id);
const err = (m) => { $('err').textContent = m || ''; }; // §25 — errors on the Watch surface
const notice = (m) => { $('notice').textContent = m || ''; };
const site = () => (state.analysis && state.analysis.site) || null;

// ---------- state I/O ----------

async function fetchState() {
  const r = await fetch('/api/state');
  return r.json();
}

// Serialize writes; server owns stateVersion (§8.2-1).
function saveState(mutate) {
  saving = saving.then(async () => {
    mutate(state);
    const r = await fetch('/api/state', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state),
    });
    const { stateVersion } = await r.json();
    state.stateVersion = stateVersion;
  }).catch((e) => err(`state save failed: ${e}`));
  return saving;
}

// Every rule edit is one field of one rule (§24.2): the server merges the patch
// and re-derives the weight sum, then hands back the whole analysis.
async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) { err(out.error || `${method} ${path} failed (${r.status})`); return null; }
  if (out.analysis) state.analysis = out.analysis;
  if (out.stateVersion) state.stateVersion = out.stateVersion;
  err('');
  return out;
}

async function recordProvenance(record) {
  try {
    const r = await fetch('/api/provenance', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(record),
    });
    const { stateVersion } = await r.json();
    state.stateVersion = stateVersion;
  } catch { /* provenance is best-effort; never blocks the analysis */ }
}

// ---------- candidates (FR-SITE-001) ----------

async function loadCandidates() {
  const r = await fetch('/api/analysis/candidates');
  candidates = await r.json();
  candidateVersion = site() ? site().candidates.version : 0;
  drawCandidates();
}

function drawCandidates() {
  if (candidateLayer) { map.removeLayer(candidateLayer); candidateLayer = null; }
  if (!candidates.features.length) return;
  candidateLayer = GeoLayers.buildCandidates(candidates, resultsById, selectCandidate);
  candidateLayer.addTo(map);
  candidateLayer.bringToFront();
}

async function addCandidate(payload) {
  const out = await api('POST', '/api/analysis/candidates', payload);
  if (!out) return;
  await loadCandidates();
  renderAll();
}

async function removeCandidate(id) {
  const out = await api('DELETE', `/api/analysis/candidates/${encodeURIComponent(id)}`);
  if (!out) return;
  if (selected === id) selected = null;
  resultsById.delete(id);
  await loadCandidates();
  renderAll();
}

function selectCandidate(id) {
  selected = id;
  renderCandidates();
  renderExplain();
  saveState((s) => { s.selection = { candidateId: id }; }); // discrete action → immediate write (§8.2-5)
}

// ---------- reference features ----------

function layerEntry(id) {
  return state.layers.find((l) => l.id === id) || null;
}

function upsertLayer(entry) {
  const existing = layerEntry(entry.id);
  if (existing) Object.assign(existing, entry, { resultVersion: (existing.resultVersion || 0) + 1 });
  else state.layers.push({ visible: true, resultVersion: 1, ...entry });
}

async function putResult(id, geojson) {
  const r = await fetch(`/api/results/${id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(geojson),
  });
  if (!r.ok) throw new Error(`result upload failed (${r.status})`);
  return r.json();
}

function bboxOf(geojson) {
  const layer = L.geoJSON(geojson);
  const b = layer.getBounds();
  return b.isValid() ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : [];
}

// Reference acquisition inside the current view. `road` asks Overpass for four
// highway grades only, and `residential` for landuse polygons — see
// geo/registry.js for why both are narrowed.
async function acquire(classKey) {
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  err('');
  notice(`fetching ${GeoRegistry.label(classKey)} from Overpass…`);

  const res = await GeoOverpass.fetchClass(classKey, bbox, { cap: RESULT_CAP });
  if (!res.ok) { // §25 — external API unavailable / non-JSON / timeout, all visible
    notice('');
    return err(`Overpass: ${res.message}`);
  }
  const count = res.collection.features.length;
  if (!count) {
    notice('');
    return err(`no ${GeoRegistry.label(classKey)} found in the current view — pan or zoom out and try again.`);
  }
  await storeReference(classKey, res.collection, 'overpass', GeoRegistry.label(classKey));
  await recordProvenance({ // §24.4, §28
    operation: 'overpass-search', source: 'openstreetmap', featureClass: classKey,
    query: res.query, bbox, resultCount: count,
  });
  notice(res.truncated
    ? `${classKey}: capped at ${RESULT_CAP} features (§26.1) — the metric would measure to a truncated set, so zoom in and re-acquire`
    : '');
  return undefined;
}

async function storeReference(classKey, collection, source, label) {
  const id = `ref-${classKey}`;
  await putResult(id, collection);
  featureCache.set(classKey, collection);
  await saveState(() => {
    upsertLayer({
      id, type: 'geojson', label, key: classKey, role: 'reference', category: classKey,
      source, visible: true, featureCount: collection.features.length,
      resultRef: `/api/results/${id}`, bbox: bboxOf(collection),
    });
  });
  await renderLayers();
  renderRules();
}

function classesInHardConstraints() {
  const s = site();
  if (!s) return new Set();
  return new Set((s.constraints || []).filter((c) => c.enabled !== false && c.kind !== 'area').map((c) => c.featureClass));
}

function roleOf(entry) {
  return classesInHardConstraints().has(entry.key) ? 'hard' : 'reference';
}

// ---------- FR-SITE-006 … FR-SITE-010: run the ranking ----------

async function runRanking() {
  err('');
  const s = site();
  if (!s) return err('no analysis in state.');
  if (!candidates.features.length) {
    return err('no candidates defined — click the map or load a GeoJSON file (FR-SITE-001).');
  }

  let doc;
  try {
    doc = GeoScoring.evaluate(
      { candidates, constraints: s.constraints, criteria: s.criteria },
      (key) => featureCache.get(key) || null,
    );
  } catch (e) {
    // Unbalanced weights (FR-SITE-005), a missing reference set, a broken
    // criterion scale — all reported in plain language, none silently absorbed.
    return err(String(e.message || e));
  }

  const out = await api('PUT', '/api/analysis/results', doc);
  if (!out) return undefined;

  resultsDoc = doc;
  resultsById = new Map(doc.results.map((r) => [r.candidateId, r]));
  if (!selected || !resultsById.has(selected)) {
    const top = doc.results.find((r) => r.rank === 1);
    selected = top ? top.candidateId : (doc.results[0] && doc.results[0].candidateId) || null;
  }
  drawCandidates();
  renderAll();

  if (!doc.eligibleCount) err('no candidate passed every hard constraint — relax a constraint or add candidates.');
  else if (doc.truncated) notice(`only the first ${GeoScoring.CANDIDATE_CAP} candidates were evaluated.`);
  return undefined;
}

// Reads the result set back from state after ANA (or another device) reran it.
async function syncResults() {
  const s = site();
  if (!s || !s.results) { resultsDoc = null; resultsById = new Map(); return; }
  if (s.results.inline) {
    resultsDoc = { ...s.results, results: s.results.ranked };
    resultsById = new Map((s.results.ranked || []).map((r) => [r.candidateId, r]));
    return;
  }
  try {
    const r = await fetch(s.results.ref);
    const doc = await r.json();
    resultsDoc = doc;
    resultsById = new Map((doc.results || []).map((x) => [x.candidateId, x]));
  } catch (e) { err(`failed to load results: ${e}`); }
}

// ---------- rendering ----------

function applyView() {
  const v = state.map.view;
  if (!v) return;
  const key = JSON.stringify(v);
  if (key === lastAppliedView) return; // only ANA-set view moves the camera (§12 rule 4)
  lastAppliedView = key;
  map.setView(v.center, v.zoom);
}

async function renderLayers() {
  const panel = $('layers');
  panel.innerHTML = '';
  for (const entry of state.layers) {
    const rec = leafletLayers.get(entry.id);
    if (!rec || rec.resultVersion !== entry.resultVersion) {
      try {
        const r = await fetch(entry.resultRef); // feature bodies live behind resultRef (§12 rule 3)
        if (!r.ok) throw new Error(`${r.status}`);
        const gj = await r.json();
        if (entry.key) featureCache.set(entry.key, gj);
        if (rec) map.removeLayer(rec.layer);
        const layer = GeoLayers.buildReference(gj, roleOf(entry));
        leafletLayers.set(entry.id, { layer, resultVersion: entry.resultVersion });
      } catch (e) { err(`failed to load layer ${entry.id}: ${e}`); continue; }
    }
    const cur = leafletLayers.get(entry.id);
    if (entry.visible && !map.hasLayer(cur.layer)) map.addLayer(cur.layer);
    if (!entry.visible && map.hasLayer(cur.layer)) map.removeLayer(cur.layer);
    panel.appendChild(layerRow(entry));
  }
  for (const [id, rec] of leafletLayers) { // drop layers whose state entry disappeared
    if (!state.layers.some((l) => l.id === id)) { map.removeLayer(rec.layer); leafletLayers.delete(id); }
  }
  if (candidateLayer) candidateLayer.bringToFront();
  if (!state.layers.length) {
    const d = document.createElement('div');
    d.className = 'hint';
    d.textContent = 'No reference features yet — acquire the classes your constraints and criteria use.';
    panel.appendChild(d);
  }
}

function layerRow(entry) {
  const row = document.createElement('div');
  row.className = 'layer-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = !!entry.visible;
  cb.addEventListener('change', () => {
    saveState((s) => { s.layers.find((l) => l.id === entry.id).visible = cb.checked; }).then(renderLayers);
  });
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = GeoLayers.STYLES[roleOf(entry)].color;
  const span = document.createElement('span');
  span.textContent = `${entry.label}${entry.source === 'user-upload' ? ' (uploaded)' : ''}`;
  const cnt = document.createElement('span');
  cnt.className = 'count'; cnt.textContent = entry.featureCount ?? '';
  row.append(cb, dot, span, cnt);
  return row;
}

function option(value, label, selectedValue) {
  const o = document.createElement('option');
  o.value = value; o.textContent = label; o.selected = value === selectedValue;
  return o;
}

function classOptions(current) {
  const keys = GeoRegistry.keys();
  for (const l of state.layers) if (l.key && !keys.includes(l.key)) keys.push(l.key);
  if (current && !keys.includes(current)) keys.push(current);
  return keys;
}

function renderCandidates() {
  const box = $('candidates');
  box.innerHTML = '';
  $('cand-count').textContent = candidates.features.length;
  if (!candidates.features.length) {
    const d = document.createElement('div');
    d.className = 'hint';
    d.textContent = 'No candidates. Turn on "Add by map click", or load a GeoJSON file of points or polygons.';
    box.appendChild(d);
    return;
  }
  const ordered = candidates.features.slice().sort((a, b) => {
    const ra = resultsById.get(String(a.id));
    const rb = resultsById.get(String(b.id));
    const ka = ra && ra.rank ? ra.rank : (ra && !ra.eligible ? 1e6 : 1e5);
    const kb = rb && rb.rank ? rb.rank : (rb && !rb.eligible ? 1e6 : 1e5);
    return ka - kb || String(a.id).localeCompare(String(b.id));
  });
  for (const f of ordered) {
    const id = String(f.id);
    const res = resultsById.get(id);
    const row = document.createElement('div');
    row.className = `cand${selected === id ? ' sel' : ''}${res && res.rank === 1 ? ' top' : ''}${res && !res.eligible ? ' out' : ''}`;
    row.addEventListener('click', () => selectCandidate(id));
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = res ? (res.eligible ? `#${res.rank}` : '✕') : '–';
    const label = document.createElement('span');
    label.textContent = (f.properties && f.properties.label) || id;
    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = res ? (res.eligible ? res.score : 'rejected') : '';
    const drop = document.createElement('button');
    drop.className = 'drop'; drop.textContent = '×'; drop.title = 'remove candidate';
    drop.style.flex = 'none'; drop.style.padding = '0 6px';
    drop.addEventListener('click', (ev) => { ev.stopPropagation(); removeCandidate(id); });
    row.append(rank, label, score, drop);
    box.appendChild(row);
  }
}

// One editable hard constraint (FR-SITE-002). Each control PATCHes its own
// field, so "change 1 km to 2 km" rewrites one number.
function constraintRow(c, i) {
  const div = document.createElement('div');
  div.className = 'rule';
  const patch = (body) => api('PATCH', `/api/analysis/constraints/${encodeURIComponent(c.id)}`, body).then((o) => o && renderAll());

  const l1 = document.createElement('div'); l1.className = 'line';
  const on = document.createElement('input');
  on.type = 'checkbox'; on.checked = c.enabled !== false; on.style.flex = 'none';
  on.title = 'enable / disable this constraint';
  on.addEventListener('change', () => patch({ enabled: on.checked }));
  const cls = document.createElement('select');
  if (c.kind === 'area') {
    cls.appendChild(option('area', 'Candidate area', 'area'));
    cls.disabled = true;
  } else {
    for (const k of classOptions(c.featureClass)) cls.appendChild(option(k, GeoRegistry.label(k), c.featureClass));
    cls.addEventListener('change', () => patch({ featureClass: cls.value }));
  }
  const drop = document.createElement('button');
  drop.className = 'drop'; drop.textContent = '×'; drop.title = 'remove constraint';
  drop.addEventListener('click', () => api('DELETE', `/api/analysis/constraints/${encodeURIComponent(c.id)}`).then((o) => o && renderAll()));
  l1.append(on, cls, drop);

  const l2 = document.createElement('div'); l2.className = 'line';
  const op = document.createElement('select');
  for (const o of GeoRules.OPERATORS) op.appendChild(option(o, o, c.operator));
  op.addEventListener('change', () => patch({ operator: op.value }));
  const val = document.createElement('input');
  val.type = 'number'; val.min = '0'; val.step = 'any'; val.value = c.value;
  val.addEventListener('change', () => patch({ value: Number(val.value) }));
  const unit = document.createElement('select');
  for (const u of Object.keys(GeoRules.unitsFor(c.kind))) unit.appendChild(option(u, u, c.unit));
  unit.addEventListener('change', () => patch({ unit: unit.value }));
  l2.append(op, val, unit);

  div.append(l1, l2);
  if (i === 0) div.style.marginTop = '2px';
  return div;
}

// One editable soft criterion with its weight (FR-SITE-003, FR-SITE-004).
function criterionRow(c) {
  const div = document.createElement('div');
  div.className = 'rule';
  const patch = (body) => api('PATCH', `/api/analysis/criteria/${encodeURIComponent(c.id)}`, body).then((o) => o && renderAll());

  const l1 = document.createElement('div'); l1.className = 'line';
  const label = document.createElement('input');
  label.type = 'text'; label.value = c.label || c.id;
  label.addEventListener('change', () => patch({ label: label.value }));
  const drop = document.createElement('button');
  drop.className = 'drop'; drop.textContent = '×'; drop.title = 'remove criterion';
  drop.addEventListener('click', () => api('DELETE', `/api/analysis/criteria/${encodeURIComponent(c.id)}`).then((o) => o && renderAll()));
  l1.append(label, drop);

  const l2 = document.createElement('div'); l2.className = 'line';
  const cls = document.createElement('select');
  if (c.kind === 'area') {
    cls.appendChild(option('area', 'Candidate area', 'area'));
    cls.disabled = true;
  } else {
    for (const k of classOptions(c.featureClass)) cls.appendChild(option(k, GeoRegistry.label(k), c.featureClass));
    cls.addEventListener('change', () => patch({ featureClass: cls.value }));
  }
  const unit = document.createElement('select');
  unit.style.flex = 'none';
  for (const u of Object.keys(GeoRules.unitsFor(c.kind))) unit.appendChild(option(u, u, c.unit));
  unit.addEventListener('change', () => patch({ unit: unit.value }));
  l2.append(cls, unit);

  // best scores 100, worst scores 0 — which way round they sit is the
  // criterion's direction, so it is never stated twice (FR-SITE-007).
  const l3 = document.createElement('div'); l3.className = 'line';
  const bestLbl = document.createElement('span'); bestLbl.className = 'tag'; bestLbl.textContent = '100 at';
  const best = document.createElement('input');
  best.type = 'number'; best.step = 'any'; best.value = c.best;
  best.addEventListener('change', () => patch({ best: Number(best.value) }));
  const worstLbl = document.createElement('span'); worstLbl.className = 'tag'; worstLbl.textContent = '0 at';
  const worst = document.createElement('input');
  worst.type = 'number'; worst.step = 'any'; worst.value = c.worst;
  worst.addEventListener('change', () => patch({ worst: Number(worst.value) }));
  l3.append(bestLbl, best, worstLbl, worst);

  const l4 = document.createElement('div'); l4.className = 'line';
  const wLbl = document.createElement('span'); wLbl.className = 'tag'; wLbl.textContent = 'weight %';
  const weight = document.createElement('input');
  weight.type = 'number'; weight.min = '0'; weight.step = 'any';
  weight.value = Math.round((c.weight || 0) * 1000) / 10;
  weight.addEventListener('change', () => patch({ weight: Number(weight.value) / 100 }));
  const dir = document.createElement('span');
  dir.className = 'tag';
  dir.textContent = GeoScoring.criterionDirection(c) === 'lower_is_better' ? 'closer is better' : 'farther is better';
  l4.append(wLbl, weight, dir);

  div.append(l1, l2, l3, l4);
  return div;
}

function renderRules() {
  const s = site();
  if (!s) return;
  const cbox = $('constraints');
  cbox.innerHTML = '';
  $('hc-count').textContent = `${(s.constraints || []).filter((c) => c.enabled !== false).length} active`;
  (s.constraints || []).forEach((c, i) => cbox.appendChild(constraintRow(c, i)));
  if (!(s.constraints || []).length) {
    const d = document.createElement('div');
    d.className = 'hint';
    d.textContent = 'No hard constraints — every candidate is eligible.';
    cbox.appendChild(d);
  }

  // §25 + data-quality: a hard pass/fail decision resting on a sparse OSM layer
  // is called out where the decision is made, not only in the README.
  const cautionBox = $('constraint-caution');
  cautionBox.innerHTML = '';
  for (const key of classesInHardConstraints()) {
    const text = GeoRegistry.caution(key);
    if (!text) continue;
    const d = document.createElement('div');
    d.className = 'caution';
    d.textContent = `Hard constraint on ${GeoRegistry.label(key)}: ${text}`;
    cautionBox.appendChild(d);
  }

  const kbox = $('criteria');
  kbox.innerHTML = '';
  (s.criteria || []).forEach((c) => kbox.appendChild(criterionRow(c)));
  if (!(s.criteria || []).length) {
    const d = document.createElement('div');
    d.className = 'hint';
    d.textContent = 'No criteria — add at least one to score candidates.';
    kbox.appendChild(d);
  }

  // FR-SITE-005 — the sum is always on screen, and a violation is an error with
  // an explicit fix, never an automatic rescale.
  const w = s.weights || { sum: 0, valid: false };
  $('weight-sum').textContent = (w.sum === null || w.sum === undefined) ? '–' : w.sum;
  $('weightbar').className = `weightbar ${w.valid ? 'ok' : 'bad'}`;
  $('weight-err').textContent = w.valid ? '' : (w.error || '');
  $('weight-err').style.color = w.valid ? '' : 'var(--bad)';

  const acq = $('acq-class');
  const keep = acq.value;
  acq.innerHTML = '';
  for (const k of GeoRegistry.keys()) acq.appendChild(option(k, GeoRegistry.label(k), keep || 'university'));
  const caution = GeoRegistry.caution(acq.value);
  $('acq-caution').innerHTML = '';
  if (caution) {
    const d = document.createElement('div');
    d.className = 'caution';
    d.textContent = caution;
    $('acq-caution').appendChild(d);
  }
}

// FR-SITE-010 / §23.3 — "This site ranked #1 because: …"
function renderExplain() {
  const box = $('explain');
  box.innerHTML = '';
  const s = site();
  if (s && s.results && s.results.stale) {
    const d = document.createElement('div');
    d.className = 'hint';
    d.textContent = `Ranking is out of date (${s.results.staleReason}) — run it again.`;
    box.appendChild(d);
  }
  for (const wmsg of (resultsDoc && resultsDoc.warnings) || []) {
    const d = document.createElement('div');
    d.className = 'caution';
    d.textContent = wmsg;
    box.appendChild(d);
  }
  const res = selected ? resultsById.get(selected) : null;
  if (!res) {
    const d = document.createElement('div');
    d.className = 'hint';
    d.textContent = resultsById.size ? 'Select a candidate to see its score breakdown.' : 'Run the ranking to see score breakdowns.';
    box.appendChild(d);
    return;
  }
  const head = document.createElement('div');
  head.className = 'head';
  head.textContent = res.explanation.headline;
  box.appendChild(head);
  const detail = res.explanation.detail || res.explanation.lines;
  for (const line of detail) {
    const d = document.createElement('div');
    d.className = 'line';
    d.textContent = `· ${line}`;
    box.appendChild(d);
  }
  if (res.eligible) {
    const tot = document.createElement('div');
    tot.className = 'line';
    tot.innerHTML = `<b>weighted total: ${res.score}</b>`;
    box.appendChild(tot);
  }
}

function renderStatus() {
  const c = map.getCenter();
  $('s-center').textContent = `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`;
  $('s-zoom').textContent = map.getZoom();
  $('s-cands').textContent = candidates.features.length;
  const s = site();
  $('s-eligible').textContent = resultsDoc ? `${resultsDoc.eligibleCount ?? 0}` : '–';
  const top = [...resultsById.values()].find((r) => r.rank === 1);
  $('s-top').textContent = top ? `${top.label} (${top.score})` : '–';
  $('s-summary').textContent = GeoScoring.summarize(s); // §23.2 — always visible
}

function renderAll() {
  applyView();
  renderCandidates();
  renderRules();
  renderExplain();
  renderStatus();
  renderLayers();
}

// ---------- events ----------

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// Continuous gesture → 300 ms trailing write of observedView only (§8.2-5, §12 rule 4).
const writeObservedView = debounce(() => {
  const c = map.getCenter();
  saveState((s) => { s.map.observedView = { center: [c.lat, c.lng], zoom: map.getZoom() }; });
}, 300);

async function readGeoJSONFile(file) {
  let gj;
  try { gj = JSON.parse(await file.text()); } catch { throw new Error('invalid GeoJSON: not parseable JSON'); }
  if (gj.type === 'Feature') gj = { type: 'FeatureCollection', features: [gj] };
  if (gj.type !== 'FeatureCollection') throw new Error('invalid GeoJSON: expected a Feature or FeatureCollection');
  if (!Array.isArray(gj.features) || !gj.features.length) throw new Error('invalid GeoJSON: no features');
  return gj;
}

function setupEvents() {
  map.on('move zoom', renderStatus);
  map.on('moveend zoomend', writeObservedView);

  $('pick').addEventListener('click', () => {
    picking = !picking;
    $('pick').classList.toggle('on', picking);
    map.getContainer().style.cursor = picking ? 'crosshair' : '';
  });
  map.on('click', (e) => {
    if (!picking) return;
    addCandidate({ lon: e.latlng.lng, lat: e.latlng.lat });
  });
  $('clear-cands').addEventListener('click', async () => {
    if (!candidates.features.length) return;
    const out = await api('DELETE', '/api/analysis/candidates');
    if (!out) return;
    selected = null; resultsById = new Map(); resultsDoc = null;
    await loadCandidates();
    renderAll();
  });

  // FR-SITE-001 — the upload path for candidates.
  $('candfile').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    err('');
    let gj;
    try { gj = await readGeoJSONFile(file); } catch (e) { ev.target.value = ''; return err(String(e.message || e)); }
    await addCandidate(gj);
    const b = L.geoJSON(gj).getBounds();
    if (b.isValid()) map.fitBounds(b, { padding: [30, 30] });
    ev.target.value = '';
    return undefined;
  });

  $('acq-btn').addEventListener('click', () => acquire($('acq-class').value));
  $('acq-class').addEventListener('change', renderRules);

  // The authoritative-data path: a GeoJSON file replaces the selected class, so
  // a cadastral or land-use dataset can stand in for the OSM layer.
  $('reffile').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    err('');
    const classKey = $('acq-class').value;
    let gj;
    try { gj = await readGeoJSONFile(file); } catch (e) { ev.target.value = ''; return err(String(e.message || e)); }
    for (const f of gj.features) {
      f.properties = { ...(f.properties || {}), category: classKey, source: 'user-upload' };
    }
    try {
      await storeReference(classKey, gj, 'user-upload', `${GeoRegistry.label(classKey)} — ${file.name}`);
    } catch (e) { ev.target.value = ''; return err(String(e.message || e)); }
    await recordProvenance({ operation: 'geojson-upload', source: 'user-upload', featureClass: classKey, file: file.name, resultCount: gj.features.length });
    notice(`${GeoRegistry.label(classKey)} now comes from ${file.name}.`);
    ev.target.value = '';
    return undefined;
  });

  $('add-constraint').addEventListener('click', () => api('POST', '/api/analysis/constraints', {
    kind: 'distance', featureClass: $('acq-class').value, operator: '>=', value: 1000, unit: 'm',
  }).then((o) => o && renderAll()));

  $('add-criterion').addEventListener('click', () => {
    const key = $('acq-class').value;
    return api('POST', '/api/analysis/criteria', {
      kind: 'distance', featureClass: key, label: `${GeoRegistry.label(key)} proximity`,
      unit: 'm', best: 0, worst: 3000, weight: 0,
    }).then((o) => o && renderAll());
  });

  // FR-SITE-005 — the explicit fix beside the explicit error.
  $('normalize').addEventListener('click', () => api('POST', '/api/analysis/criteria/normalize', {}).then((o) => o && renderAll()));

  $('run').addEventListener('click', runRanking);

  $('chatform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('chatinput').value.trim();
    if (!text) return;
    $('chatinput').value = '';
    const r = await fetch('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    if (!r.ok) err('failed to send message');
  });
}

// ---------- polling loop (§8.2-2) ----------

function renderFeedItem(item) {
  const div = document.createElement('div');
  div.className = `msg ${item.role}`;
  div.textContent = item.text || '';
  $('feed').appendChild(div);
  $('feed').scrollTop = $('feed').scrollHeight;
}

async function poll() {
  try {
    const r = await fetch(`/api/feed?since=${feedSince}`);
    const { stateVersion, items } = await r.json();
    for (const it of items) { renderFeedItem(it); feedSince = it.seq; }
    if (stateVersion !== state.stateVersion) {
      state = await fetchState();
      applyView();
      if (site() && site().candidates.version !== candidateVersion) await loadCandidates();
      await syncResults();
      if (state.selection && state.selection.candidateId) selected = state.selection.candidateId;
      drawCandidates();
      renderAll();
    }
  } catch (e) { err(`sync lost: ${e}`); }
}

// ---------- boot ----------

(async function main() {
  state = await fetchState();
  map = L.map('map');
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  map.setView(state.map.view.center, state.map.view.zoom);
  lastAppliedView = JSON.stringify(state.map.view);
  if (state.selection && state.selection.candidateId) selected = state.selection.candidateId;
  await syncResults();
  await loadCandidates();
  renderAll();
  setupEvents();
  setInterval(poll, 2500);
})();
