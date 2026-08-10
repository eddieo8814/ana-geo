// ana-geo-search client — feature acquisition, Turf spatial search, and the
// editable condition model (PRD §8.2, §12, §17).
/* global L, GeoRegistry, GeoOverpass, GeoSpatial, GeoLayers */

const RESULT_CAP = GeoSpatial.RESULT_CAP; // 2,000 (PRD §26.1)
const RESULT_LAYER = 'search-results';
const BUFFER_LAYER = 'search-buffers';

let state = null;
let map;
const leafletLayers = new Map(); // layer id -> { layer, resultVersion }
const featureCache = new Map();  // key -> FeatureCollection (bodies live behind resultRef, §12 rule 3)
let lastAppliedView = '';
let renderedAnalysis = '';
let feedSince = 0;
let saving = Promise.resolve();

const $ = (id) => document.getElementById(id);
const err = (m) => { $('err').textContent = m || ''; }; // §25 — errors on the Watch surface
const notice = (m) => { $('notice').textContent = m || ''; };

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

// FR-SEARCH-010 — one field of one condition, written on its own. The rest of
// the query (and the rest of the state file) is never rewritten.
async function patchCondition(index, patch) {
  const r = await fetch(`/api/analysis/conditions/${index}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  const body = await r.json();
  if (!r.ok) return err(body.error || `condition update failed (${r.status})`);
  state.analysis = body.analysis;
  state.stateVersion = body.stateVersion;
  err('');
  renderQuery();
}

async function patchAnalysis(patch) {
  const r = await fetch('/api/analysis', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  const body = await r.json();
  if (!r.ok) return err(body.error || `query update failed (${r.status})`);
  state.analysis = body.analysis;
  state.stateVersion = body.stateVersion;
  err('');
  renderQuery();
}

async function conditionsRequest(method, index, body) {
  const path = index === null ? '/api/analysis/conditions' : `/api/analysis/conditions/${index}`;
  const r = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await r.json();
  if (!r.ok) return err(out.error || `request failed (${r.status})`);
  state.analysis = out.analysis;
  state.stateVersion = out.stateVersion;
  err('');
  renderQuery();
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

// ---------- layers ----------

function layerEntry(id) {
  return state.layers.find((l) => l.id === id) || null;
}

function upsertLayer(entry) {
  const existing = layerEntry(entry.id);
  if (existing) Object.assign(existing, entry, { resultVersion: (existing.resultVersion || 0) + 1 });
  else state.layers.push({ visible: true, resultVersion: 1, ...entry });
}

// Feature sets are addressed by key: a registry category, or an uploaded set.
function resolve(key) {
  return featureCache.get(key) || null;
}

function availableKeys() {
  const keys = new Set(GeoRegistry.keys());
  for (const l of state.layers) if (l.key) keys.add(l.key);
  return [...keys];
}

function acquiredKeys() {
  return state.layers.filter((l) => l.role === 'features' && l.key).map((l) => l.key);
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

// ---------- FR-SEARCH-011: acquisition ----------

async function acquire(categoryKey) {
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  err('');
  notice(`fetching ${GeoRegistry.label(categoryKey)} from Overpass…`);

  const res = await GeoOverpass.fetchCategory(categoryKey, bbox, { cap: RESULT_CAP });
  if (!res.ok) { // §25 — external API unavailable / non-JSON / timeout, all visible
    notice('');
    return err(`Overpass: ${res.message}`);
  }
  const count = res.collection.features.length;
  if (!count) {
    notice('');
    return err(`no ${GeoRegistry.label(categoryKey)} found in the current view — pan or zoom out and try again.`);
  }

  const id = `features-${categoryKey}`;
  await putResult(id, res.collection);
  featureCache.set(categoryKey, res.collection);
  await saveState(() => {
    upsertLayer({
      id, type: 'geojson', label: GeoRegistry.label(categoryKey), key: categoryKey, role: 'features',
      category: categoryKey, source: 'overpass', visible: true, featureCount: count,
      resultRef: `/api/results/${id}`, bbox: bboxOf(res.collection),
    });
  });
  await recordProvenance({ // §24.4, §28
    operation: 'overpass-search', source: 'openstreetmap', category: categoryKey,
    query: res.query, bbox, resultCount: count,
  });
  notice(res.truncated ? `${categoryKey}: capped at ${RESULT_CAP} features (§26.1)` : '');
  await renderLayers();
  renderQuery();
}

// ---------- FR-SEARCH-001…008: run the query ----------

async function runSearch() {
  err('');
  const analysis = state.analysis;
  if (!analysis || !analysis.target) return err('no target category selected.');

  const needed = [analysis.target, ...(analysis.conditions || []).map((c) => c.reference)];
  const missing = [...new Set(needed)].filter((k) => !resolve(k));
  if (missing.length) {
    return err(`acquire features first: ${missing.join(', ')} (use the Features panel or load GeoJSON).`);
  }

  let result;
  let buffers;
  try {
    result = GeoSpatial.evaluate(analysis, resolve, { cap: RESULT_CAP });
    buffers = GeoSpatial.conditionBuffers(analysis, resolve); // FR-SEARCH-002/009
  } catch (e) {
    return err(String(e.message || e)); // invalid condition / unsupported geometry (§25)
  }

  const resultFc = { type: 'FeatureCollection', features: result.features };
  try {
    await putResult(RESULT_LAYER, resultFc);
    await putResult(BUFFER_LAYER, buffers);
  } catch (e) {
    return err(String(e.message || e));
  }

  featureCache.set(RESULT_LAYER, resultFc);
  featureCache.set(BUFFER_LAYER, buffers);

  await saveState(() => {
    upsertLayer({
      id: RESULT_LAYER, type: 'geojson', label: 'Search results', key: RESULT_LAYER, role: 'result',
      category: analysis.target, source: 'analysis', visible: true,
      featureCount: result.features.length, resultRef: `/api/results/${RESULT_LAYER}`,
      bbox: bboxOf(resultFc), truncated: result.truncated,
      summary: result.summary,
      explain: result.breakdown.map((b) => ({ label: b.label, matchCount: b.matchCount, referenceCount: b.referenceCount })),
    });
    upsertLayer({
      id: BUFFER_LAYER, type: 'geojson', label: 'Condition buffers', key: BUFFER_LAYER, role: 'buffer',
      source: 'analysis', visible: buffers.features.length > 0,
      featureCount: buffers.features.length, resultRef: `/api/results/${BUFFER_LAYER}`,
      bbox: bboxOf(buffers),
    });
  });

  if (!result.features.length) err('no features satisfied the conditions.'); // §25 — empty result
  else if (result.truncated) notice(`results capped at ${RESULT_CAP} features (§26.1)`);

  await renderLayers();
  renderStatus();
  renderExplain();
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
        const layer = GeoLayers.build(gj, roleStyle(entry));
        leafletLayers.set(entry.id, { layer, resultVersion: entry.resultVersion });
      } catch (e) { err(`failed to load layer ${entry.id}: ${e}`); continue; }
    }
    const cur = leafletLayers.get(entry.id);
    if (entry.visible && !map.hasLayer(cur.layer)) map.addLayer(cur.layer);
    if (!entry.visible && map.hasLayer(cur.layer)) map.removeLayer(cur.layer);
    panel.appendChild(layerRow(entry));
  }
  // drop Leaflet layers whose state entry disappeared
  for (const [id, rec] of leafletLayers) {
    if (!state.layers.some((l) => l.id === id)) { map.removeLayer(rec.layer); leafletLayers.delete(id); }
  }
  // results draw above buffers and acquired features
  const res = leafletLayers.get(RESULT_LAYER);
  if (res && map.hasLayer(res.layer)) res.layer.bringToFront();
}

function roleStyle(entry) {
  if (entry.role === 'result') return 'result';
  if (entry.role === 'buffer') return 'buffer';
  if (state.analysis && (state.analysis.conditions || []).some((c) => c.reference === entry.key)) return 'reference';
  return 'target';
}

function layerRow(entry) {
  const row = document.createElement('div');
  row.className = 'layer-row';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = GeoLayers.STYLES[roleStyle(entry)].color;
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = !!entry.visible;
  cb.addEventListener('change', () => { // discrete action → immediate write (§8.2-5)
    saveState((s) => { s.layers.find((l) => l.id === entry.id).visible = cb.checked; }).then(renderLayers);
  });
  const span = document.createElement('span'); span.textContent = entry.label || entry.id;
  const cnt = document.createElement('span'); cnt.className = 'count'; cnt.textContent = entry.featureCount ?? '';
  row.append(cb, dot, span, cnt);
  row.style.cursor = 'pointer';
  row.addEventListener('click', (e) => { if (e.target !== cb) cb.click(); }); // 행 전체가 터치 타깃 (>=44px 가이드)
  return row;
}

function option(value, label, selected) {
  const o = document.createElement('option');
  o.value = value; o.textContent = label; o.selected = selected;
  return o;
}

function renderQuery() {
  const a = state.analysis || { target: null, operator: 'AND', conditions: [] };
  renderedAnalysis = JSON.stringify(a);

  const target = $('q-target');
  target.innerHTML = '';
  const keys = availableKeys();
  if (a.target && !keys.includes(a.target)) keys.push(a.target);
  for (const k of keys) target.appendChild(option(k, `${GeoRegistry.label(k)}${resolve(k) ? '' : ' (not acquired)'}`, k === a.target));

  $('q-operator').value = a.operator === 'OR' ? 'OR' : 'AND';

  const box = $('conditions');
  box.innerHTML = '';
  (a.conditions || []).forEach((c, i) => box.appendChild(conditionRow(c, i, keys)));
  if (!(a.conditions || []).length) {
    const p = document.createElement('div');
    p.className = 'hint';
    p.textContent = 'No conditions — every acquired target feature matches.';
    box.appendChild(p);
  }
  renderStatus();
}

// One editable condition (FR-SEARCH-010): each control PATCHes its own field.
function conditionRow(c, i, keys) {
  const div = document.createElement('div');
  div.className = 'cond';

  const l1 = document.createElement('div'); l1.className = 'line';
  const rel = document.createElement('select');
  for (const r of GeoSpatial.RELATIONS) rel.appendChild(option(r, r.replace(/_/g, ' '), r === c.relation));
  rel.addEventListener('change', () => patchCondition(i, { relation: rel.value }));
  const ref = document.createElement('select');
  const refKeys = keys.includes(c.reference) ? keys : [...keys, c.reference];
  for (const k of refKeys) ref.appendChild(option(k, GeoRegistry.label(k), k === c.reference));
  ref.addEventListener('change', () => patchCondition(i, { reference: ref.value }));
  const drop = document.createElement('button');
  drop.className = 'drop'; drop.textContent = '×'; drop.title = 'remove condition';
  drop.addEventListener('click', () => conditionsRequest('DELETE', i));
  l1.append(rel, ref, drop);
  div.appendChild(l1);

  if (c.relation === 'within_distance' || c.relation === 'outside_distance') {
    const l2 = document.createElement('div'); l2.className = 'line';
    const dist = document.createElement('input');
    dist.type = 'number'; dist.min = '0'; dist.step = 'any'; dist.value = c.distance ?? '';
    dist.addEventListener('change', () => patchCondition(i, { distance: Number(dist.value) }));
    const unit = document.createElement('select');
    for (const u of ['m', 'km']) unit.appendChild(option(u, u, u === c.unit));
    unit.addEventListener('change', () => patchCondition(i, { unit: unit.value }));
    l2.append(dist, unit);
    div.appendChild(l2);
  }
  if (c.relation === 'nearest') {
    const l2 = document.createElement('div'); l2.className = 'line';
    const n = document.createElement('input');
    n.type = 'number'; n.min = '1'; n.step = '1'; n.value = c.count ?? 5;
    n.addEventListener('change', () => patchCondition(i, { count: Number(n.value) }));
    const lab = document.createElement('span'); lab.className = 'fixed'; lab.textContent = 'nearest';
    l2.append(n, lab);
    div.appendChild(l2);
  }
  return div;
}

function renderExplain() {
  const entry = layerEntry(RESULT_LAYER);
  const box = $('explain');
  box.innerHTML = '';
  if (!entry) return;
  const head = document.createElement('div');
  head.textContent = `${entry.featureCount} result(s) — ${entry.summary || ''}`;
  box.appendChild(head);
  for (const e of entry.explain || []) { // §23.3 — why these results
    const d = document.createElement('div');
    d.textContent = `· ${e.label}: ${e.matchCount} match(es) against ${e.referenceCount} reference(s)`;
    box.appendChild(d);
  }
}

function renderStatus() {
  const c = map.getCenter();
  $('s-center').textContent = `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`;
  $('s-zoom').textContent = map.getZoom();
  const entry = layerEntry(RESULT_LAYER);
  $('s-count').textContent = entry ? `${entry.featureCount}${entry.truncated ? '+' : ''}` : '–';
  $('s-query').textContent = GeoSpatial.summarize(state.analysis); // §23.2 — always visible
}

function renderAll() {
  applyView();
  renderQuery();
  renderExplain();
  renderLayers();
  renderStatus();
}

// ---------- events ----------

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// Continuous gesture → 300 ms trailing write of observedView only (§8.2-5, §12 rule 4).
const writeObservedView = debounce(() => {
  const c = map.getCenter();
  saveState((s) => { s.map.observedView = { center: [c.lat, c.lng], zoom: map.getZoom() }; });
}, 300);

function setupEvents() {
  map.on('move zoom', renderStatus);
  map.on('moveend zoomend', writeObservedView);

  const acq = $('acq-category');
  for (const k of GeoRegistry.keys()) acq.appendChild(option(k, GeoRegistry.label(k), k === 'cafe'));
  $('acq-btn').addEventListener('click', () => acquire(acq.value));

  $('q-target').addEventListener('change', () => patchAnalysis({ target: $('q-target').value }));
  $('q-operator').addEventListener('change', () => patchAnalysis({ operator: $('q-operator').value }));
  $('add-cond').addEventListener('click', () => conditionsRequest('POST', null, {
    relation: 'within_distance', reference: acquiredKeys().find((k) => k !== state.analysis.target) || 'university',
    distance: 1000, unit: 'm',
  }));
  $('run').addEventListener('click', runSearch);

  $('geofile').addEventListener('change', async (ev) => { // FR-SEARCH-011 — GeoJSON path
    const file = ev.target.files[0];
    if (!file) return;
    err('');
    let gj;
    try { gj = JSON.parse(await file.text()); } catch { return err('invalid GeoJSON: not parseable JSON'); }
    if (gj.type !== 'FeatureCollection') return err('invalid GeoJSON: expected a FeatureCollection');
    const key = `upload_${file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_')}`;
    const id = `features-${key}`;
    try { await putResult(id, gj); } catch (e) { return err(String(e.message || e)); }
    featureCache.set(key, gj);
    await saveState(() => {
      upsertLayer({
        id, type: 'geojson', label: file.name, key, role: 'features', source: 'user-upload',
        visible: true, featureCount: (gj.features || []).length,
        resultRef: `/api/results/${id}`, bbox: bboxOf(gj),
      });
    });
    await renderLayers();
    renderQuery();
    const b = L.geoJSON(gj).getBounds();
    if (b.isValid()) map.fitBounds(b);
    ev.target.value = '';
  });

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
      await renderLayers();
      if (JSON.stringify(state.analysis) !== renderedAnalysis) renderQuery(); // ANA edited the query
      renderExplain();
      renderStatus();
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
  renderAll();
  setupEvents();
  setInterval(poll, 2500);
})();
