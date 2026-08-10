// ana-geo-explorer client — Watch surface, Overpass discovery, state sync
// (PRD §8.2, §11.1, §12, §16).
/* global L, GeoRegistry, GeoOverpass */

let state = null;
let map;
const geoLayers = new Map(); // layer id -> { layer, resultVersion }
let lastAppliedView = '';
let feedSince = 0;
let saving = Promise.resolve();
let searching = false;
let handledRequestId = 0; // last ANA-issued search request this client executed

const CAP = GeoOverpass.RESULT_CAP; // PRD §26.1

const $ = (id) => document.getElementById(id);
const err = (m) => { $('err').textContent = m || ''; $('err').className = ''; };        // §25
const warn = (m) => { $('err').textContent = m || ''; $('err').className = m ? 'warn' : ''; };

// ---------- state I/O ----------

async function fetchState() {
  const r = await fetch('/api/state');
  return r.json();
}

// Serialize writes; server owns stateVersion (§8.2-1).
function saveState(mutate) {
  saving = saving.then(async () => {
    mutate(state);
    const r = await fetch('/api/state', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) });
    const { stateVersion } = await r.json();
    state.stateVersion = stateVersion;
  }).catch((e) => err(`state save failed: ${e}`));
  return saving;
}

// ---------- category checklist (FR-EXP-008, FR-EXP-002) ----------

function renderCategories() {
  const box = $('cats');
  const active = new Set(state.search.categories || []);
  box.innerHTML = '';
  for (const cat of GeoRegistry.CATEGORIES) {
    const row = document.createElement('div');
    row.className = 'cat-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.id = `cat-${cat.key}`; cb.checked = active.has(cat.key);
    // discrete action → immediate write (§8.2-5)
    cb.addEventListener('change', () => {
      saveState((s) => {
        const set = new Set(s.search.categories || []);
        if (cb.checked) set.add(cat.key); else set.delete(cat.key);
        s.search.categories = GeoRegistry.keys().filter((k) => set.has(k));
      });
    });
    const sw = document.createElement('span');
    sw.className = 'swatch'; sw.style.background = cat.color;
    const label = document.createElement('label');
    label.htmlFor = cb.id; label.textContent = cat.label;
    row.append(cb, sw, label);
    box.appendChild(row);
  }
}

// ---------- Overpass search (FR-EXP-001, FR-EXP-002) ----------

function currentBbox() {
  const b = map.getBounds();
  return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
}

async function putResult(id, featureCollection) {
  const r = await fetch(`/api/results/${id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(featureCollection),
  });
  if (!r.ok) throw new Error(`result upload failed for ${id} (${r.status})`);
  return r.json();
}

async function runSearch(keys) {
  if (searching) return;
  const wanted = (keys || []).filter((k) => GeoRegistry.get(k));
  if (!wanted.length) { err('Select at least one category before searching.'); return; }

  searching = true;
  $('findbtn').disabled = true;
  $('findbtn').textContent = 'Searching Overpass…';
  err('');

  try {
    const bbox = currentBbox(); // viewport-scoped (FR-EXP-001)
    // One merged request for every selected category — five checkboxes cost the
    // public Overpass instance one query, not five.
    const query = GeoOverpass.buildQuery(wanted, bbox, { limit: CAP });
    const res = await fetch(`/api/proxy?url=${encodeURIComponent(GeoOverpass.ENDPOINT)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
    });
    const text = await res.text();

    // The proxy answers JSON for its own failures (§8.4 allowlist, upstream error).
    if (res.status === 403 || res.status === 400 || res.status === 502) {
      let detail = text;
      try { const j = JSON.parse(text); detail = j.detail || j.error || text; } catch { /* keep raw */ }
      throw new Error(`external data unavailable — ${detail}`);
    }
    if (res.status === 429) throw new Error('Overpass rate limit (429) — wait a minute and search again.');
    if (res.status === 504) throw new Error('Overpass gateway timeout (504) — zoom in or select fewer categories.');

    // A 200 is not proof of success: Overpass serves HTML error pages with a
    // 200 status when it is busy, so the body decides (§25).
    const osm = GeoOverpass.parseResponse(text, res.status);
    const fetchedAt = new Date().toISOString();
    const { features, skipped } = GeoOverpass.toFeatures(osm, fetchedAt);

    // §26.1 result cap.
    const truncated = features.length > CAP;
    const kept = truncated ? features.slice(0, CAP) : features;
    const byCat = GeoOverpass.groupByCategory(kept);

    // Feature bodies go to the result endpoints; state keeps references only
    // (§12 rule 3).
    const updates = [];
    for (const key of wanted) {
      const cat = GeoRegistry.get(key);
      const feats = byCat.get(key) || [];
      const id = `poi-${key}`;
      await putResult(id, { type: 'FeatureCollection', features: feats });
      const prev = state.layers.find((l) => l.id === id);
      updates.push({
        id,
        type: 'geojson',
        label: cat.label,
        category: key,
        source: 'overpass',
        visible: true,
        featureCount: feats.length,
        resultRef: `/api/results/${id}`,
        resultVersion: (prev ? prev.resultVersion : 0) + 1, // bump ⇒ stateVersion bump (§8.2-6)
        bbox: GeoOverpass.bboxOf(feats),
      });
    }

    const notes = [];
    if (truncated) notes.push(`capped at ${CAP} features (${features.length - CAP} dropped) — zoom in for the full set`);
    if (skipped) notes.push(`${skipped} object(s) skipped: no usable point geometry or no registry match`);
    if (!kept.length) notes.push('no objects of the selected categories in this viewport');

    await saveState((s) => {
      s.layers = s.layers.filter((l) => !updates.some((u) => u.id === l.id)).concat(updates);
      s.search.lastRunAt = fetchedAt;
      s.search.lastBbox = [bbox[1], bbox[0], bbox[3], bbox[2]]; // [w,s,e,n], GeoJSON order
      s.search.truncated = truncated;
      s.search.note = notes.join('; ') || null;
    });

    await renderLayers();
    updateStatus();
    if (notes.length) warn(notes.join('; ')); // §25 — visible on the Watch surface
  } catch (e) {
    err(String(e.message || e));
  } finally {
    searching = false;
    $('findbtn').disabled = false;
    $('findbtn').textContent = 'Find in view';
  }
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

function buildLeafletLayer(gj, color) {
  return L.geoJSON(gj, {
    pointToLayer: (f, latlng) => L.circleMarker(latlng, {
      radius: 6, color, weight: 1.5, fillColor: color, fillOpacity: 0.55,
    }),
    style: { color, weight: 2 },
    onEachFeature: (f, layer) => {
      const p = f.properties || {};
      layer.bindPopup(`<b>${escapeHtml(p.name || '(unnamed)')}</b><br>${escapeHtml(p.category || '')}`);
      layer.on('click', () => selectFeature(f)); // FR-EXP-005
    },
  });
}

// Result layers list (FR-EXP-003, FR-EXP-004, FR-EXP-006, FR-EXP-007).
async function renderLayers() {
  const panel = $('layers');
  panel.innerHTML = '';
  if (!state.layers.length) {
    panel.innerHTML = '<div style="color:var(--dim);font-size:13px">No result layers yet — pick categories and press “Find in view”.</div>';
  }

  for (const entry of state.layers) {
    if (!geoLayers.has(entry.id) || geoLayers.get(entry.id).resultVersion !== entry.resultVersion) {
      try {
        const r = await fetch(entry.resultRef); // feature bodies live behind resultRef (§12 rule 3)
        if (!r.ok) throw new Error(`${r.status}`);
        const gj = await r.json();
        if (geoLayers.has(entry.id)) map.removeLayer(geoLayers.get(entry.id).layer);
        const cat = GeoRegistry.get(entry.category);
        const layer = buildLeafletLayer(gj, cat ? cat.color : '#38bdf8');
        geoLayers.set(entry.id, { layer, resultVersion: entry.resultVersion });
      } catch (e) { err(`failed to load layer ${entry.id}: ${e}`); continue; }
    }
    const rec = geoLayers.get(entry.id);
    if (entry.visible && !map.hasLayer(rec.layer)) map.addLayer(rec.layer);
    if (!entry.visible && map.hasLayer(rec.layer)) map.removeLayer(rec.layer);
    panel.appendChild(layerRow(entry));
  }
  // drop Leaflet layers whose state entry disappeared
  for (const [id, rec] of geoLayers) {
    if (!state.layers.some((l) => l.id === id)) { map.removeLayer(rec.layer); geoLayers.delete(id); }
  }
}

function layerRow(entry) {
  const cat = GeoRegistry.get(entry.category);
  const row = document.createElement('div');
  row.className = 'layer-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = !!entry.visible;
  // discrete action → immediate write (§8.2-5)
  cb.addEventListener('change', () => {
    saveState((s) => { s.layers.find((l) => l.id === entry.id).visible = cb.checked; })
      .then(renderLayers).then(updateStatus);
  });
  const sw = document.createElement('span');
  sw.className = 'swatch'; sw.style.cssText = `width:10px;height:10px;border-radius:50%;background:${cat ? cat.color : '#38bdf8'}`;
  const span = document.createElement('span'); span.textContent = entry.label || entry.id;
  const cnt = document.createElement('span'); cnt.className = 'count'; cnt.textContent = entry.featureCount ?? '';
  row.append(cb, sw, span, cnt);
  row.style.cursor = 'pointer';
  row.addEventListener('click', (e) => { if (e.target !== cb) cb.click(); }); // 행 전체가 터치 타깃 (>=44px 가이드)
  return row;
}

// ---------- selection detail (FR-EXP-005) ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function selectFeature(f) {
  const p = f.properties || {};
  const [lon, lat] = f.geometry.coordinates;
  const sel = {
    sourceId: p.sourceId, name: p.name, category: p.category,
    source: p.source, coordinates: [lon, lat], fetchedAt: p.fetchedAt, tags: p.tags || {},
  };
  renderDetail(sel);
  saveState((s) => { s.selection = sel; }); // ANA can read what the user is inspecting
}

function renderDetail(sel) {
  const box = $('detail');
  if (!sel) { box.textContent = 'Click a result to see its OSM detail.'; return; }
  const cat = GeoRegistry.get(sel.category);
  const rows = [
    ['Category', cat ? `${cat.label} (${sel.category})` : sel.category],
    ['Latitude', Number(sel.coordinates[1]).toFixed(6)],
    ['Longitude', Number(sel.coordinates[0]).toFixed(6)],
    ['Source', sel.source || 'osm'],
    ['Source ID', sel.sourceId],
    ['Fetched', sel.fetchedAt || '–'],
  ];
  const tagRows = Object.entries(sel.tags || {})
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('');
  box.innerHTML =
    `<div class="dt-name">${escapeHtml(sel.name || '(unnamed)')}</div>` +
    `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${escapeHtml(v ?? '–')}</td></tr>`).join('')}</table>` +
    `<div class="tags"><table>${tagRows || '<tr><td>no tags</td></tr>'}</table></div>`;
}

// ---------- status ----------

function updateStatus() {
  const c = map.getCenter();
  $('s-center').textContent = `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`;
  $('s-zoom').textContent = map.getZoom();
  const visible = state.layers.filter((l) => l.visible);
  const total = visible.reduce((n, l) => n + (l.featureCount || 0), 0);
  $('s-count').textContent = total;                                        // FR-EXP-004
  $('s-note').textContent = visible.length
    ? `${visible.length} visible layer(s): ` + visible.map((l) => `${l.label} ${l.featureCount}`).join(', ')
    : '';
}

function renderAll() {
  applyView();
  renderCategories();
  renderDetail(state.selection);
  renderLayers().then(updateStatus);
}

// ---------- events ----------

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// Continuous gesture → 300 ms trailing write of observedView only (§8.2-5, §12 rule 4).
const writeObservedView = debounce(() => {
  const c = map.getCenter();
  saveState((s) => { s.map.observedView = { center: [c.lat, c.lng], zoom: map.getZoom() }; });
}, 300);

function setupEvents() {
  map.on('move zoom', updateStatus);
  map.on('moveend zoomend', writeObservedView);

  $('findbtn').addEventListener('click', () => runSearch(state.search.categories));

  $('chatform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('chatinput').value.trim();
    if (!text) return;
    $('chatinput').value = '';
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
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
      renderAll();
      // ANA runs a search by editing search.categories and bumping requestId;
      // the map then updates without a reload.
      const rid = Number(state.search.requestId || 0);
      if (rid > handledRequestId) { handledRequestId = rid; runSearch(state.search.categories); }
    }
  } catch (e) { err(`sync lost: ${e}`); }
}

// ---------- boot ----------

(async function main() {
  state = await fetchState();
  if (!state.search) state.search = { categories: [], requestId: 0 };
  handledRequestId = Number(state.search.requestId || 0); // a stale id must not fire on load
  map = L.map('map');
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  renderAll();
  setupEvents();
  setInterval(poll, 2500);
})();
