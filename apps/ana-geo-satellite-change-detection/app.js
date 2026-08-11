// ana-geo-satellite-change-detection client — Watch surface, STAC discovery,
// change-detection run, state sync (PRD §8.2, §12, §21).
/* global L, GeoStac, GeoChange */

let state = null;
let map;
const geoLayers = new Map(); // layer id -> { layer, key }
let sceneFeatures = [];      // footprints of the last search, for the panel list
let lastAppliedView = '';
let feedSince = 0;
let saving = Promise.resolve();
let searching = false;
let running = false;
let handledSearchId = 0;     // last ANA-issued STAC search this client executed
let handledDetectId = 0;     // last ANA-issued analysis run this client executed

// A ranked list is a summary, not a result set: state keeps the top slice and
// the full ranking stays in the GeoJSON behind resultRef (§12 rule 3).
const STATE_REGION_CAP = 50;

const SCENES_LAYER = 'stac-scenes';
const CHANGE_LAYER = 'change-regions';

const $ = (id) => document.getElementById(id);
const err = (m) => { $('err').textContent = m || ''; $('err').className = ''; };        // §25
const warn = (m) => { $('err').textContent = m || ''; $('err').className = m ? 'warn' : ''; };

// ---------- 선택 컨텍스트 칩 — frontend 요소 선택 시 등록 (§24.1) ----------
// 장면(before/after)이나 변화 영역을 고르면 칩으로 쌓이고, 전송 시 메시지에
// [선택 컨텍스트]로 첨부되며 state.selection에도 구조화되어 저장돼
// ANA가 정확한 대상을 읽을 수 있다.
const chips = new Map(); // key -> { label, ref }

function addChip(key, label, ref) { chips.set(key, { label, ref }); renderChips(); }

function renderChips() {
  const box = $('chips');
  box.innerHTML = '';
  for (const [key, c] of chips) {
    const el = document.createElement('div');
    el.className = 'chip';
    const span = document.createElement('span'); span.textContent = c.label;
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕';
    x.setAttribute('aria-label', `${c.label} 칩 제거`);
    x.addEventListener('click', () => { chips.delete(key); renderChips(); });
    el.append(span, x);
    box.appendChild(el);
  }
}

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

async function putResult(id, featureCollection) {
  const r = await fetch(`/api/results/${id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(featureCollection),
  });
  if (!r.ok) throw new Error(`result upload failed for ${id} (${r.status})`);
  return r.json();
}

function layerEntry(id, patch) {
  const prev = state.layers.find((l) => l.id === id);
  return {
    id, type: 'geojson', visible: true, source: 'earth-search',
    resultRef: `/api/results/${id}`,
    resultVersion: (prev ? prev.resultVersion : 0) + 1, // bump ⇒ stateVersion bump (§8.2-6)
    ...patch,
  };
}

function currentBbox() {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]; // [w,s,e,n], GeoJSON order
}

// ---------- STAC scene search (FR-CD-012) ----------

async function searchScenes() {
  if (searching) return;
  searching = true;
  $('searchbtn').disabled = true;
  $('searchbtn').textContent = 'Searching Earth Search…';
  err('');

  try {
    const bbox = currentBbox(); // AOI from the viewport
    const body = GeoStac.buildSearchBody({
      bbox,
      collection: state.sceneSearch.collection,
      datetime: state.sceneSearch.datetime,
      maxCloudCover: state.sceneSearch.maxCloudCover,
      limit: state.sceneSearch.limit,
    });
    const res = await fetch(`/api/proxy?url=${encodeURIComponent(GeoStac.ENDPOINT)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await res.text();

    // The proxy answers JSON for its own failures (§8.4 allowlist, upstream error).
    if ([400, 403, 502].includes(res.status)) {
      let detail = text;
      try { const j = JSON.parse(text); detail = j.detail || j.error || text; } catch { /* keep raw */ }
      throw new Error(`STAC search failed — external data unavailable: ${detail}`);
    }
    const json = GeoStac.parseResponse(text, res.status); // §25 stac_search_failure
    const fetchedAt = new Date().toISOString();
    const fc = GeoStac.footprintCollection(json.features);
    for (const f of fc.features) f.properties.fetchedAt = fetchedAt; // §24.4 provenance

    await putResult(SCENES_LAYER, fc);
    const usable = fc.features.filter((f) => f.properties.hasNdviBands).length;
    const notes = [];
    if (!fc.features.length) notes.push('no scenes match this AOI, date range and cloud filter — widen the dates or raise the cloud limit');
    else if (usable < fc.features.length) notes.push(`${fc.features.length - usable} scene(s) lack red/nir assets and cannot be used for NDVI`);

    await saveState((s) => {
      s.layers = s.layers.filter((l) => l.id !== SCENES_LAYER).concat(layerEntry(SCENES_LAYER, {
        label: 'Scene footprints', category: 'scene-footprint',
        featureCount: fc.features.length, bbox,
      }));
      s.sceneSearch.bbox = bbox;
      s.sceneSearch.lastRunAt = fetchedAt;
      s.sceneSearch.resultCount = fc.features.length;
      s.sceneSearch.note = notes.join('; ') || null;
    });

    await renderLayers();
    renderScenes();
    updateStatus();
    if (notes.length) warn(notes.join('; ')); // §25 — visible on the Watch surface
  } catch (e) {
    err(String(e.message || e));
  } finally {
    searching = false;
    $('searchbtn').disabled = false;
    $('searchbtn').textContent = 'Search scenes in view';
  }
}

// ---------- before / after selection (FR-CD-001, FR-CD-002, FR-CD-003) ----------

function pickScene(featureId, role) {
  addChip(`scene:${role}:${featureId}`, `🛰 ${role}: ${String(featureId).slice(0, 24)}`, { type: 'scene', role, id: featureId }); // 선택 → 칩 (§24.1)
  const feature = sceneFeatures.find((f) => f.id === featureId);
  if (!feature) return err(`scene ${featureId} is not in the current search result`);
  const scene = GeoStac.sceneFromFeature(feature);

  if (!GeoStac.hasNdviBands(scene)) {
    return err(`scene ${scene.id} has no red/nir assets — NDVI cannot be computed from it`);
  }
  // FR-CD-003 gate, stated before the worker runs: v1 aligns two scenes by
  // requiring the same MGRS tile, which already share CRS, resolution, extent
  // and pixel grid. A cross-tile pair would need reprojection (out of v1 scope).
  const other = role === 'before' ? state.scenes.after : state.scenes.before;
  if (other && other.gridCode && scene.gridCode && !GeoStac.sameTile(other.gridCode, scene.gridCode)) {
    return err(
      `tile mismatch: the ${role === 'before' ? 'after' : 'before'} scene is on ${other.gridCode}, ` +
      `this one is on ${scene.gridCode}. v1 needs a same-tile pair — pick another scene or clear the slot.`
    );
  }
  err('');
  saveState((s) => { s.scenes[role] = scene; }).then(() => { renderSlots(); renderScenes(); renderLayers(); });
}

function clearScene(role) {
  saveState((s) => { s.scenes[role] = null; }).then(() => { renderSlots(); renderScenes(); renderLayers(); });
}

// ---------- change detection run (FR-CD-004 … FR-CD-011) ----------

async function runDetection() {
  if (running) return;
  const { before, after } = state.scenes;
  if (!before || !after) return err('select both a before and an after scene first');

  running = true;
  $('runbtn').disabled = true;
  $('runbtn').textContent = 'Running NDVI difference…';
  err('');

  try {
    const bbox = currentBbox(); // the AOI is what you are looking at
    const d = state.detection;
    const res = await fetch('/api/analysis/change-detect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        beforeItem: before, afterItem: after, bboxLatLng: bbox,
        threshold: d.threshold, direction: d.direction, minRegionSqM: d.minRegionSqM,
      }),
    });
    const envelope = await res.json(); // §8.5 envelope, success or failure
    if (!envelope.ok) {
      const e = envelope.error || {};
      throw new Error(`${e.code || 'worker_failure'}: ${e.message || 'unknown worker error'}`);
    }

    const { changeDetection, raster, geojson, notes } = envelope.result;
    const ranAt = new Date().toISOString();
    for (const f of geojson.features) f.properties.fetchedAt = ranAt;
    await putResult(CHANGE_LAYER, geojson);

    const stored = changeDetection.regions.slice(0, STATE_REGION_CAP);
    const allNotes = (notes || []).slice();
    if (changeDetection.regions.length > stored.length) {
      allNotes.push(`ranking truncated in state to the top ${STATE_REGION_CAP}; all ${changeDetection.regions.length} regions remain in the layer`);
    }

    await saveState((s) => {
      s.layers = s.layers.filter((l) => l.id !== CHANGE_LAYER).concat(layerEntry(CHANGE_LAYER, {
        label: 'Change regions', category: 'ndvi-change', source: 'change-detection',
        featureCount: geojson.features.length, bbox,
      }));
      // §21.6 result model lives at state.analysis.changeDetection.
      s.analysis = {
        changeDetection: { ...changeDetection, regions: stored },
        raster,
        aoiBbox: bbox,
        ranAt,
        elapsedMs: envelope.elapsedMs || null,
        notes: allNotes,
      };
      s.detection.lastRunAt = ranAt;
      s.detection.note = allNotes.join('; ') || null;
    });

    await renderLayers();
    renderResult();
    updateStatus();
    if (allNotes.length) warn(allNotes.join('; '));
  } catch (e) {
    err(String(e.message || e));
  } finally {
    running = false;
    $('runbtn').disabled = false;
    $('runbtn').textContent = 'Run change detection';
  }
}

// ---------- rendering ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function applyView() {
  const v = state.map.view;
  if (!v) return;
  const key = JSON.stringify(v);
  if (key === lastAppliedView) return; // only ANA-set view moves the camera (§12 rule 4)
  lastAppliedView = key;
  map.setView(v.center, v.zoom);
}

function renderControls() {
  const s = state.sceneSearch;
  const [from, to] = String(s.datetime || '/').split('/');
  $('f-from').value = (from || '').slice(0, 10);
  $('f-to').value = (to || '').slice(0, 10);
  $('f-cloud').value = s.maxCloudCover ?? '';

  const d = state.detection;
  const th = $('f-threshold');
  th.min = GeoChange.THRESHOLD.min; th.max = GeoChange.THRESHOLD.max; th.step = GeoChange.THRESHOLD.step;
  th.value = d.threshold;
  $('f-threshold-val').textContent = Number(d.threshold).toFixed(2);

  const dir = $('f-direction');
  if (!dir.options.length) {
    for (const o of GeoChange.DIRECTIONS) {
      const opt = document.createElement('option');
      opt.value = o.key; opt.textContent = o.label; opt.title = o.hint;
      dir.appendChild(opt);
    }
  }
  dir.value = d.direction;
  $('f-minarea').value = d.minRegionSqM;
  $('f-limit').value = d.regionLimit ?? '';
  $('search-note').textContent = s.lastRunAt
    ? `${s.resultCount} scene(s), searched ${s.lastRunAt.slice(0, 19).replace('T', ' ')} UTC`
    : 'Pan the map to the area of interest, then search.';
}

function renderSlots() {
  const box = $('slots');
  box.innerHTML = '';
  for (const role of ['before', 'after']) {
    const scene = state.scenes[role];
    const div = document.createElement('div');
    div.className = `slot ${role}${scene ? ' filled' : ''}`;
    if (!scene) {
      div.innerHTML = `<div class="role">${role}</div><div class="hint">not selected</div>`;
    } else {
      div.innerHTML =
        `<div class="role">${role}</div>` +
        `<div class="sid">${escapeHtml(scene.id)}</div>` +
        `<div class="meta hint">${escapeHtml((scene.datetime || '').slice(0, 10))} · cloud ${scene.cloudCover != null ? Number(scene.cloudCover).toFixed(1) : '?'}% · ${escapeHtml(scene.gridCode || 'tile ?')}</div>`;
      const btn = document.createElement('button');
      btn.textContent = 'Clear'; btn.style.cssText = 'margin-top:4px;padding:2px 8px;font-size:12px';
      btn.addEventListener('click', () => clearScene(role));
      div.appendChild(btn);
    }
    box.appendChild(div);
  }
}

// Scene list — FR-SAT-008 equivalent metadata (datetime, platform, cloud, id,
// collection, available assets), reachable per FR-CD-012.
function renderScenes() {
  const box = $('scenes');
  box.innerHTML = '';
  if (!sceneFeatures.length) {
    box.innerHTML = '<div class="hint">No scenes yet — search first.</div>';
    return;
  }
  const beforeId = state.scenes.before && state.scenes.before.id;
  const afterId = state.scenes.after && state.scenes.after.id;
  for (const f of sceneFeatures) {
    const p = f.properties || {};
    const div = document.createElement('div');
    const role = f.id === beforeId ? 'before' : f.id === afterId ? 'after' : '';
    div.className = `scene ${role}${p.hasNdviBands ? '' : ' disabled'}`;
    div.innerHTML =
      `<div class="sid">${escapeHtml(f.id)}</div>` +
      `<div class="meta">` +
        `<span>${escapeHtml((p.datetime || '').slice(0, 16).replace('T', ' '))}</span>` +
        `<span>cloud ${p.cloudCover != null ? Number(p.cloudCover).toFixed(1) : '?'}%</span>` +
        `<span>${escapeHtml(p.platform || '')}</span>` +
        `<span>${escapeHtml(p.gridCode || '')}</span>` +
        `<span>${(p.assetKeys || []).length} assets</span>` +
      `</div>`;
    const pick = document.createElement('div');
    pick.className = 'pick';
    for (const r of ['before', 'after']) {
      const b = document.createElement('button');
      b.textContent = `Set ${r}`;
      b.disabled = !p.hasNdviBands;
      b.addEventListener('click', (ev) => { ev.stopPropagation(); pickScene(f.id, r); });
      pick.appendChild(b);
    }
    div.appendChild(pick);
    div.addEventListener('click', () => selectScene(f));
    box.appendChild(div);
  }
}

function renderResult() {
  const a = state.analysis;
  const cd = a && a.changeDetection;
  $('explain').textContent = cd ? GeoChange.explain(cd) : 'No analysis yet.'; // §23.3
  $('summary').innerHTML = cd
    ? GeoChange.summaryLines(cd, a.raster).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')
    : '';

  const box = $('regions');
  box.innerHTML = '';
  if (!cd) return;
  const shown = GeoChange.visibleRegions(cd.regions, state.detection.regionLimit); // FR-CD-011
  if (!shown.length) {
    box.innerHTML = '<div class="hint">No region passed the threshold and minimum-area filter.</div>';
    return;
  }
  for (const r of shown) {
    const row = document.createElement('div');
    row.className = 'region-row';
    row.innerHTML =
      `<span class="rank">#${r.rank}</span>` +
      `<span class="dot" style="background:${GeoChange.colorFor(r, cd.direction)}"></span>` +
      `<span>${escapeHtml(r.id)}</span>` +
      `<span class="area">${GeoChange.fmtArea(r.areaSqKm)}</span>`;
    row.title = `mean NDVI difference ${r.meanDiff}`;
    row.addEventListener('click', () => { zoomToRegion(r.id); addChip(`region:${r.id}`, `🌱 ${r.id} (${r.areaSqKm} km²)`, { type: 'region', id: r.id, areaSqKm: r.areaSqKm }); });
    box.appendChild(row);
  }
}

function zoomToRegion(id) {
  const rec = geoLayers.get(CHANGE_LAYER);
  if (!rec) return;
  rec.layer.eachLayer((l) => {
    if (l.feature && l.feature.id === id) { map.fitBounds(l.getBounds(), { maxZoom: 15 }); l.openPopup(); }
  });
}

function buildScenesLayer(gj) {
  const beforeId = state.scenes.before && state.scenes.before.id;
  const afterId = state.scenes.after && state.scenes.after.id;
  return L.geoJSON(gj, {
    style: (f) => {
      const role = f.id === beforeId ? 'before' : f.id === afterId ? 'after' : '';
      return {
        color: role === 'before' ? '#a78bfa' : role === 'after' ? '#38bdf8' : '#64748b',
        weight: role ? 3 : 1,
        fillOpacity: role ? 0.08 : 0.02,
        dashArray: role ? null : '4 4',
      };
    },
    onEachFeature: (f, layer) => {
      const p = f.properties || {};
      layer.bindPopup(
        `<b>${escapeHtml(f.id)}</b><br>${escapeHtml((p.datetime || '').slice(0, 19).replace('T', ' '))}<br>` +
        `cloud ${p.cloudCover ?? '?'}% · ${escapeHtml(p.gridCode || '')}`
      );
      layer.on('click', () => selectScene(f));
    },
  });
}

function buildChangeLayer(gj) {
  const cd = (state.analysis || {}).changeDetection || {};
  const limit = Number(state.detection.regionLimit);
  const keep = Number.isFinite(limit) && limit > 0 ? limit : Infinity;
  const filtered = { type: 'FeatureCollection', features: gj.features.filter((f) => (f.properties.rank || 0) <= keep) };
  return L.geoJSON(filtered, {
    style: (f) => ({ color: GeoChange.colorFor(f.properties, cd.direction), weight: 2, fillOpacity: 0.35 }),
    onEachFeature: (f, layer) => {
      const p = f.properties || {};
      layer.bindPopup(
        `<b>#${p.rank} ${escapeHtml(f.id)}</b><br>${GeoChange.fmtArea(p.areaSqKm)}<br>` +
        `mean NDVI Δ ${p.metrics ? p.metrics.meanNdviDiff : '?'} (${escapeHtml(p.direction || '')})`
      );
      layer.on('click', () => selectRegion(f));
    },
  });
}

// Feature bodies live behind resultRef and are refetched only when
// resultVersion changes (§12 rule 3). The change layer additionally rebuilds
// when regionLimit changes, since that is a display filter over the same body.
async function renderLayers() {
  const panel = $('layers');
  panel.innerHTML = '';
  if (!state.layers.length) panel.innerHTML = '<div class="hint">No layers yet.</div>';

  for (const entry of state.layers) {
    const key = entry.id === CHANGE_LAYER
      ? `${entry.resultVersion}:${state.detection.regionLimit ?? 'all'}:${JSON.stringify((state.analysis || {}).ranAt || '')}`
      : `${entry.resultVersion}:${(state.scenes.before || {}).id || ''}:${(state.scenes.after || {}).id || ''}`;
    if (!geoLayers.has(entry.id) || geoLayers.get(entry.id).key !== key) {
      try {
        const r = await fetch(entry.resultRef);
        if (!r.ok) throw new Error(`${r.status}`);
        const gj = await r.json();
        if (geoLayers.has(entry.id)) map.removeLayer(geoLayers.get(entry.id).layer);
        const layer = entry.id === CHANGE_LAYER ? buildChangeLayer(gj) : buildScenesLayer(gj);
        geoLayers.set(entry.id, { layer, key });
        if (entry.id === SCENES_LAYER) sceneFeatures = gj.features || [];
      } catch (e) { err(`failed to load layer ${entry.id}: ${e}`); continue; }
    }
    const rec = geoLayers.get(entry.id);
    if (entry.visible && !map.hasLayer(rec.layer)) map.addLayer(rec.layer);
    if (!entry.visible && map.hasLayer(rec.layer)) map.removeLayer(rec.layer);
    panel.appendChild(layerRow(entry));
  }
  for (const [id, rec] of geoLayers) {
    if (!state.layers.some((l) => l.id === id)) { map.removeLayer(rec.layer); geoLayers.delete(id); }
  }
}

function layerRow(entry) {
  const row = document.createElement('div');
  row.className = 'layer-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = !!entry.visible;
  // discrete action → immediate write (§8.2-5)
  cb.addEventListener('change', () => {
    saveState((s) => { s.layers.find((l) => l.id === entry.id).visible = cb.checked; })
      .then(renderLayers).then(updateStatus);
  });
  const span = document.createElement('span'); span.textContent = entry.label || entry.id;
  const cnt = document.createElement('span'); cnt.className = 'count'; cnt.textContent = entry.featureCount ?? '';
  row.append(cb, span, cnt);
  row.style.cursor = 'pointer';
  row.addEventListener('click', (e) => { if (e.target !== cb) cb.click(); }); // 행 전체가 터치 타깃 (>=44px 가이드)
  return row;
}

// ---------- selection (§24.1 — ANA can see what the user inspects) ----------

function selectScene(f) {
  const p = f.properties || {};
  saveState((s) => {
    s.selection = {
      kind: 'scene', id: f.id, datetime: p.datetime, platform: p.platform,
      cloudCover: p.cloudCover, gridCode: p.gridCode, collection: p.collection,
      assetKeys: p.assetKeys, source: 'earth-search', fetchedAt: p.fetchedAt,
    };
  });
}

function selectRegion(f) {
  const p = f.properties || {};
  saveState((s) => {
    s.selection = {
      kind: 'change-region', id: f.id, rank: p.rank, areaSqKm: p.areaSqKm,
      direction: p.direction, metrics: p.metrics, source: 'change-detection', fetchedAt: p.fetchedAt,
    };
  });
}

// ---------- status (§23.2 — analysis context always visible) ----------

function updateStatus() {
  const c = map.getCenter();
  $('s-center').textContent = `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`;
  $('s-zoom').textContent = map.getZoom();
  $('s-threshold').textContent = Number(state.detection.threshold).toFixed(2);
  const cd = (state.analysis || {}).changeDetection;
  $('s-area').textContent = cd ? GeoChange.fmtArea(cd.changedAreaSqKm) : '–';
  const before = state.scenes.before, after = state.scenes.after;
  $('s-note').textContent = before && after
    ? `${(before.datetime || '').slice(0, 10)} → ${(after.datetime || '').slice(0, 10)} · ${before.gridCode || ''}`
    : 'select a before/after pair';
}

function renderAll() {
  applyView();
  renderControls();
  renderSlots();
  renderResult();
  renderLayers().then(() => { renderScenes(); updateStatus(); });
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

  const dates = () => `${$('f-from').value || '2026-01-01'}/${$('f-to').value || GeoStac.isoDate(Date.now())}`;
  $('f-from').addEventListener('change', () => saveState((s) => { s.sceneSearch.datetime = dates(); }));
  $('f-to').addEventListener('change', () => saveState((s) => { s.sceneSearch.datetime = dates(); }));
  $('f-cloud').addEventListener('change', () => saveState((s) => { s.sceneSearch.maxCloudCover = Number($('f-cloud').value); }));

  // FR-CD-006 — the slider reads live, but only the released value is written.
  $('f-threshold').addEventListener('input', () => { $('f-threshold-val').textContent = Number($('f-threshold').value).toFixed(2); });
  $('f-threshold').addEventListener('change', () => {
    saveState((s) => { s.detection.threshold = Number($('f-threshold').value); }).then(updateStatus);
  });
  $('f-direction').addEventListener('change', () => saveState((s) => { s.detection.direction = $('f-direction').value; }));
  $('f-minarea').addEventListener('change', () => saveState((s) => { s.detection.minRegionSqM = Number($('f-minarea').value) || 0; }));
  $('f-limit').addEventListener('change', () => {
    const v = $('f-limit').value.trim();
    saveState((s) => { s.detection.regionLimit = v === '' ? null : Math.max(1, Number(v)); })
      .then(() => { renderResult(); return renderLayers(); });
  });

  $('searchbtn').addEventListener('click', searchScenes);
  $('runbtn').addEventListener('click', runDetection);

  $('chatform').addEventListener('submit', async (e) => {
    e.preventDefault();
    let text = $('chatinput').value.trim();
    if (!text) return;
    $('chatinput').value = '';
    if (chips.size) {
      // 칩을 메시지에 첨부 + state.selection에 병합 저장 (§24.1)
      const list = [...chips.values()];
      await writeSelectionChips(list);
      text += `
[선택 컨텍스트: ${list.map((c) => c.label).join(', ')}]`;
      chips.clear(); renderChips();
    }
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!r.ok) err('failed to send message');
  });
}

// ---------- polling loop (§8.2-2) ----------

function renderFeedItem(item) {
  const div = document.createElement('div');
  div.className = item.kind === 'activity' ? 'msg activity' : `msg ${item.role}`;
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
      // ANA drives the two long operations by bumping a requestId, so
      // "Compare this with the image from six months ago." and "Increase the
      // threshold." both take effect without a reload.
      const sid = Number(state.sceneSearch.requestId || 0);
      if (sid > handledSearchId) { handledSearchId = sid; searchScenes(); }
      const did = Number(state.detection.requestId || 0);
      if (did > handledDetectId) { handledDetectId = did; runDetection(); }
    }
  } catch (e) { err(`sync lost: ${e}`); }
}

// ---------- boot ----------

(async function main() {
  state = await fetchState();
  handledSearchId = Number(state.sceneSearch.requestId || 0); // a stale id must not fire on load
  handledDetectId = Number(state.detection.requestId || 0);
  map = L.map('map');
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  renderAll();
  setupEvents();
  setInterval(poll, 2500);
})();


// ---------- 선택 컨텍스트 칩 — frontend 요소 선택 시 등록 (§24.1) ----------
const chips = new Map(); // key -> { label, ref }

function addChip(key, label, ref) { chips.set(key, { label, ref }); renderChips(); }

function renderChips() {
  const box = document.getElementById('chips');
  if (!box) return;
  box.innerHTML = '';
  for (const [key, c] of chips) {
    const el = document.createElement('div');
    el.className = 'chip';
    const span = document.createElement('span'); span.textContent = c.label;
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕';
    x.setAttribute('aria-label', `${c.label} 칩 제거`);
    x.addEventListener('click', () => { chips.delete(key); renderChips(); });
    el.append(span, x);
    box.appendChild(el);
  }
}

// 칩을 state.selection에 병합 저장 — 기존 selection 필드(activeScene 등)는 보존 (§24.1)
async function writeSelectionChips(list) {
  try {
    const r = await fetch('/api/state');
    const s = await r.json();
    const prev = s.selection && typeof s.selection === 'object' ? s.selection : {};
    s.selection = { ...prev, chips: list.map((c) => c.ref), at: new Date().toISOString() };
    await fetch('/api/state', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) });
  } catch { /* 저장 실패해도 메시지 첨부는 진행 */ }
}

// ---------- 사이드바 크기 조절 (기기별 UI 선호 — localStorage) ----------
function initResizer() {
  const rz = document.getElementById('resizer'), conv = document.getElementById('converse');
  if (!rz || !conv) return;
  const saved = Number(localStorage.getItem('ana.converse.width'));
  if (saved >= 260 && saved <= 560) conv.style.width = `${saved}px`;
  let drag = null;
  rz.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, w: conv.offsetWidth };
    rz.setPointerCapture(e.pointerId);
    rz.classList.add('active');
  });
  rz.addEventListener('pointermove', (e) => {
    if (!drag) return;
    conv.style.width = `${Math.min(560, Math.max(260, drag.w - (e.clientX - drag.x)))}px`;
    if (typeof map !== 'undefined' && map && map.invalidateSize) map.invalidateSize();
  });
  rz.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    rz.classList.remove('active');
    localStorage.setItem('ana.converse.width', conv.offsetWidth);
  });
}
initResizer();
