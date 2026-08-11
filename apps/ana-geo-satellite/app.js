// ana-geo-satellite client — Watch surface, STAC scene discovery, state sync
// (PRD §8.2, §11.1, §12, §20).
/* global L, GeoStac, GeoAoi */

const FOOTPRINT_LAYER_ID = 'scene-footprints';

let state = null;
let map;
let aoiRect = null;              // AOI rectangle drawn on the map
let drawer = null;               // GeoAoi rectangle controller
let footprintLayer = null;       // Leaflet layer for FR-SAT-007
let footprintVersion = -1;       // resultVersion currently rendered
let sceneProps = new Map();      // sceneId -> footprint feature properties (FR-SAT-008)
let thumbOverlay = null;         // FR-SAT-010 image overlay
let thumbKey = '';               // sceneId + visibility currently overlaid
let lastAppliedView = '';
let feedSince = 0;
let saving = Promise.resolve();
let searching = false;
let handledRequestId = 0;        // last ANA-issued search request this client executed

const $ = (id) => document.getElementById(id);
const err = (m) => { $('err').textContent = m || ''; $('err').className = ''; };        // §25
const warn = (m) => { $('err').textContent = m || ''; $('err').className = m ? 'warn' : ''; };
const ok = (m) => { $('err').textContent = m || ''; $('err').className = m ? 'ok' : ''; };

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

// ---------- search controls (FR-SAT-003, FR-SAT-004, FR-SAT-005) ----------

function renderControls() {
  const s = state.satelliteSearch;

  const [start, end] = String(s.datetime || '/').split('/');
  $('date-start').value = (start || '').slice(0, 10);
  $('date-end').value = (end || '').slice(0, 10);

  const sel = $('collection');
  if (!sel.options.length) {
    for (const c of GeoStac.COLLECTIONS) sel.add(new Option(c.label, c.id));
  }
  sel.value = s.collection;

  $('cloud').value = String(s.maxCloudCover ?? 100);
  $('cloud-label').textContent = `< ${s.maxCloudCover ?? 100}%`;

  renderAoi();
}

// ---------- AOI (FR-SAT-001, FR-SAT-002) ----------

function renderAoi() {
  const bbox = state.satelliteSearch.bbox;
  const bounds = GeoAoi.boundsFromBbox(bbox);
  $('bbox').textContent = bounds
    ? `bbox ${bbox.join(', ')}  (${state.satelliteSearch.aoiSource || 'unknown'})`
    : 'bbox — (no AOI set)';
  if (!bounds) {
    if (aoiRect) { map.removeLayer(aoiRect); aoiRect = null; }
    return;
  }
  if (aoiRect) aoiRect.setBounds(bounds);
  else aoiRect = L.rectangle(bounds, GeoAoi.AOI_STYLE).addTo(map);
}

function setAoi(bbox, source) {
  // Discrete action → immediate write (§8.2-5).
  return saveState((s) => {
    s.satelliteSearch.bbox = bbox;
    s.satelliteSearch.aoiSource = source;
  }).then(renderAoi);
}

// ---------- STAC search (FR-SAT-006) ----------

async function runSearch() {
  if (searching) return;
  const s = state.satelliteSearch;

  let body;
  try {
    body = GeoStac.buildSearchBody(s);
  } catch (e) {
    return err(String(e.message || e)); // §25 — invalid spatial condition / bad date range
  }

  searching = true;
  $('search').disabled = true;
  $('searching').textContent = 'searching…';
  err('');

  const startedAt = new Date().toISOString();
  let status = 0;
  let text = '';
  try {
    const r = await fetch(GeoStac.searchUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    status = r.status;
    text = await r.text();
  } catch (e) {
    searching = false; $('search').disabled = false; $('searching').textContent = '';
    return err(`STAC provider unreachable through the proxy: ${e}`); // §25 external API unavailable
  }

  // §25 — status and body are both checked: Earth Search answers an unknown
  // collection with 200 + an empty FeatureCollection, and a malformed datetime
  // with 400 + {code, description}.
  const verdict = GeoStac.interpretResponse(status, text);
  searching = false;
  $('search').disabled = false;
  $('searching').textContent = '';

  if (!verdict.ok) {
    await recordSearch(startedAt, body, { status, matched: null, returned: null, message: verdict.error });
    return err(verdict.error);
  }

  const items = verdict.body;
  const fetchedAt = new Date().toISOString();
  const footprints = GeoStac.toFootprints(items, fetchedAt);
  const scenes = GeoStac.toSceneIndex(footprints);
  const matched = items.numberMatched ?? (items.context && items.context.matched) ?? scenes.length;

  // Feature bodies go behind resultRef, never into state (§12 rule 3).
  const up = await fetch(`/api/results/${FOOTPRINT_LAYER_ID}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(footprints),
  });
  if (!up.ok) return err(`failed to store footprints (${up.status})`);

  const bbox = GeoStac.boundsOf(footprints);
  const message = scenes.length
    ? `${scenes.length} scene(s) returned${matched > scenes.length ? ` of ${matched} matched` : ''}`
    : 'no scenes matched this AOI, date range and cloud limit';

  await saveState((st) => {
    st.scenes = scenes;
    const prev = st.layers.find((l) => l.id === FOOTPRINT_LAYER_ID);
    const entry = {
      id: FOOTPRINT_LAYER_ID,
      type: 'geojson',
      label: 'Scene footprints',
      category: 'scene-footprint',
      source: 'stac',
      visible: prev ? prev.visible : true,
      featureCount: scenes.length,
      resultRef: `/api/results/${FOOTPRINT_LAYER_ID}`,
      // A resultVersion bump is what tells polling clients the result set changed (§8.2-6).
      resultVersion: prev ? (prev.resultVersion || 0) + 1 : 1,
      bbox,
    };
    if (prev) Object.assign(prev, entry); else st.layers.push(entry);

    // Selection survives a re-search only if the scene is still in the result set.
    if (st.selection && st.selection.activeSceneId && !scenes.some((x) => x.id === st.selection.activeSceneId)) {
      st.selection.activeSceneId = null;
    }
    st.analysis = st.analysis || {};
    st.analysis.lastSearch = provenance(startedAt, body, { status, matched, returned: scenes.length, message });
  });

  await renderFootprints();
  renderScenes();
  await renderThumbnail();
  updateStatus();

  if (!scenes.length) warn(`No scenes found — ${message}.`); // §25 empty search result
  else ok(message);
}

// §28 — provenance for each external operation.
function provenance(at, body, outcome) {
  return {
    at,
    provider: 'earth-search',
    endpoint: `${GeoStac.ENDPOINT}/search`,
    request: body,
    status: outcome.status,
    matched: outcome.matched,
    returned: outcome.returned,
    message: outcome.message,
  };
}

function recordSearch(at, body, outcome) {
  return saveState((st) => {
    st.analysis = st.analysis || {};
    st.analysis.lastSearch = provenance(at, body, outcome);
  });
}

// ---------- footprints (FR-SAT-007) ----------

async function renderFootprints() {
  const entry = state.layers.find((l) => l.id === FOOTPRINT_LAYER_ID);
  if (!entry) {
    if (footprintLayer) { map.removeLayer(footprintLayer); footprintLayer = null; }
    footprintVersion = -1; sceneProps = new Map();
    return;
  }
  if (footprintVersion !== entry.resultVersion) {
    try {
      const r = await fetch(entry.resultRef); // refetched only when resultVersion changes (§12 rule 3)
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const gj = await r.json();
      if (footprintLayer) map.removeLayer(footprintLayer);
      sceneProps = new Map(gj.features.map((f) => [f.properties.sceneId, f.properties]));
      footprintLayer = L.geoJSON(gj, {
        style: footprintStyle,
        onEachFeature: (f, layer) => layer.on('click', () => selectScene(f.properties.sceneId, true)), // FR-SAT-009
      });
      footprintVersion = entry.resultVersion;
    } catch (e) {
      return err(`failed to load scene footprints: ${e}`);
    }
  }
  if (entry.visible && !map.hasLayer(footprintLayer)) map.addLayer(footprintLayer);
  if (!entry.visible && map.hasLayer(footprintLayer)) map.removeLayer(footprintLayer);
  $('show-footprints').checked = !!entry.visible;
  if (footprintLayer) footprintLayer.setStyle(footprintStyle);
}

function footprintStyle(feature) {
  const active = feature && state.selection && feature.properties.sceneId === state.selection.activeSceneId;
  return active
    ? { color: '#38bdf8', weight: 3, fillOpacity: 0.10 }
    : { color: '#7dd3fc', weight: 1, fillOpacity: 0.03 };
}

// ---------- scene list (FR-SAT-008) ----------

function renderScenes() {
  const list = $('scenes');
  list.innerHTML = '';
  const scenes = state.scenes || [];
  $('scene-count').textContent = String(scenes.length);
  $('scenes-empty').style.display = scenes.length ? 'none' : '';
  if (!scenes.length && state.analysis && state.analysis.lastSearch) {
    $('scenes-empty').textContent = state.analysis.lastSearch.message || 'No scenes.';
  }

  const activeId = state.selection && state.selection.activeSceneId;
  // state.scenes carries the display order, so ANA can re-sort the panel by
  // rewriting the array (e.g. "Sort by lowest cloud cover.", §20.5).
  for (const sc of scenes) {
    const div = document.createElement('div');
    div.className = `scene${sc.id === activeId ? ' active' : ''}`;
    const top = document.createElement('div');
    top.className = 'top';
    const when = document.createElement('span');
    when.textContent = `${(sc.datetime || '').slice(0, 10)} · ${sc.platform || 'unknown'}`;
    const cloud = document.createElement('span');
    cloud.className = 'cloud';
    cloud.textContent = sc.cloudCover == null ? 'cloud –' : `cloud ${sc.cloudCover.toFixed(1)}%`;
    top.append(when, cloud);
    const id = document.createElement('div');
    id.className = 'id';
    id.textContent = sc.id;
    div.append(top, id);
    div.addEventListener('click', () => selectScene(sc.id, true)); // FR-SAT-009
    list.appendChild(div);
  }
  renderDetail();
}

function renderDetail() {
  const box = $('detail');
  box.innerHTML = '';
  const activeId = state.selection && state.selection.activeSceneId;
  if (!activeId) {
    box.className = 'hint';
    box.textContent = 'Select a scene from the list or click a footprint on the map.';
    return;
  }
  box.className = '';
  const p = sceneProps.get(activeId);
  const idx = (state.scenes || []).find((s) => s.id === activeId) || {};
  const dl = document.createElement('dl');
  const add = (k, v) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v == null || v === '' ? '–' : String(v);
    dl.append(dt, dd);
  };
  add('scene id', activeId);
  add('collection', (p && p.collection) || idx.collection);
  add('datetime', (p && p.datetime) || idx.datetime);
  add('platform', (p && p.platform) || idx.platform);
  const cc = p ? p.cloudCover : idx.cloudCover;
  add('cloud cover', cc == null ? null : `${cc.toFixed(2)}%`);
  add('assets', p ? `${p.assetKeys.length}: ${p.assetKeys.join(', ')}` : `${idx.assetCount || 0}`);
  box.appendChild(dl);

  const row = document.createElement('div');
  row.className = 'row';
  row.style.marginTop = '8px';

  // FR-SAT-010 — thumbnail overlay toggle.
  const lbl = document.createElement('label');
  lbl.className = 'hint';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!(state.selection && state.selection.thumbnailVisible);
  cb.disabled = !(p && p.thumbnailHref);
  cb.addEventListener('change', () => {
    saveState((s) => { s.selection.thumbnailVisible = cb.checked; }).then(renderThumbnail);
  });
  lbl.append(cb, document.createTextNode(' Show thumbnail overlay'));

  const zoom = document.createElement('button');
  zoom.textContent = 'Zoom to scene';
  zoom.addEventListener('click', () => {
    const b = p && GeoAoi.boundsFromBbox(p.sceneBbox);
    if (b) map.fitBounds(b);
  });
  row.append(lbl, zoom);
  box.appendChild(row);

  if (!(p && p.thumbnailHref)) {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = 'This scene has no `thumbnail` asset — no preview available.'; // §25 raster asset unavailable
    box.appendChild(note);
  } else {
    const note = document.createElement('div');
    note.className = 'hint';
    note.style.marginTop = '4px';
    note.textContent = 'Preview is a ~343 px scene thumbnail (~320 m/px) placed on the scene bbox — scene-level context, not analysis-grade imagery.';
    box.appendChild(note);
  }
}

function selectScene(sceneId, fromUser) {
  addChip(`scene:${sceneId}`, `🛰 ${String(sceneId).slice(0, 24)}`, { type: 'scene', id: sceneId }); // 선택 → 칩 (§24.1)
  saveState((s) => {
    s.selection = s.selection || {};
    s.selection.activeSceneId = sceneId;
  }).then(async () => {
    renderScenes();
    if (footprintLayer) footprintLayer.setStyle(footprintStyle);
    await renderThumbnail();
    // Only a click on this device moves this device's camera; ANA moves every
    // client through map.view instead (§12 rule 4).
    if (fromUser) {
      const p = sceneProps.get(sceneId);
      const b = p && GeoAoi.boundsFromBbox(p.sceneBbox);
      if (b) map.fitBounds(b);
    }
  });
}

// ---------- active scene preview (FR-SAT-010) ----------

// The STAC item geometry is a reprojected quadrilateral, but L.imageOverlay only
// accepts an axis-aligned rectangle. The thumbnail is therefore placed on
// item.bbox, and corner misalignment of up to a few kilometres is expected and
// accepted at this fidelity (PRD §20.3 FR-SAT-010).
async function renderThumbnail() {
  const sel = state.selection || {};
  const p = sel.activeSceneId ? sceneProps.get(sel.activeSceneId) : null;
  const wanted = p && p.thumbnailHref && sel.thumbnailVisible ? `${sel.activeSceneId}` : '';
  if (wanted === thumbKey) return;
  if (thumbOverlay) { map.removeLayer(thumbOverlay); thumbOverlay = null; }
  thumbKey = wanted;
  if (!wanted) return;

  const bounds = GeoAoi.boundsFromBbox(p.sceneBbox);
  if (!bounds) return err(`scene ${sel.activeSceneId} has no bbox — cannot place the preview`);
  thumbOverlay = L.imageOverlay(GeoStac.assetUrl(p.thumbnailHref), bounds, {
    opacity: 0.9,
    interactive: false,
    alt: `Sentinel-2 thumbnail for ${sel.activeSceneId}`,
  });
  thumbOverlay.on('error', () => err(`thumbnail asset unavailable for ${sel.activeSceneId}`)); // §25
  thumbOverlay.addTo(map);
  thumbOverlay.bringToFront();
  if (footprintLayer && map.hasLayer(footprintLayer)) footprintLayer.bringToFront();
}

// ---------- view / status ----------

function applyView() {
  const v = state.map.view;
  if (!v) return;
  const key = JSON.stringify(v);
  if (key === lastAppliedView) return; // only ANA-set view moves the camera (§12 rule 4)
  lastAppliedView = key;
  map.setView(v.center, v.zoom);
}

function updateStatus() {
  const c = map.getCenter();
  $('s-center').textContent = `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`;
  $('s-zoom').textContent = map.getZoom();
  $('s-scenes').textContent = String((state.scenes || []).length);
  const last = state.analysis && state.analysis.lastSearch;
  $('s-note').textContent = last ? `last search ${last.at.slice(0, 19)}Z — ${last.message}` : '';
}

async function renderAll() {
  applyView();
  renderControls();
  await renderFootprints();
  renderScenes();
  await renderThumbnail();
  updateStatus();
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

  // FR-SAT-001 — AOI from the current viewport.
  $('aoi-viewport').addEventListener('click', () => {
    setAoi(GeoAoi.bboxFromBounds(map.getBounds()), 'viewport');
  });

  // FR-SAT-002 — AOI from a drawn rectangle (two-click mode; shift-drag always works).
  $('aoi-draw').addEventListener('click', () => {
    const on = drawer.toggleClickMode();
    $('aoi-draw').classList.toggle('on', on);
    if (on) warn('Click two opposite corners on the map to set the AOI.');
    else err('');
  });

  // FR-SAT-002 — AOI from a loaded polygon (reduced to its bbox, see SPEC §10).
  $('aoi-file').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    err('');
    let gj;
    try { gj = JSON.parse(await file.text()); } catch { ev.target.value = ''; return err('invalid GeoJSON: not parseable JSON'); }
    const bbox = GeoAoi.bboxFromGeoJSON(gj);
    ev.target.value = '';
    if (!bbox) return err('invalid GeoJSON: no coordinates found');
    await setAoi(bbox, `polygon:${file.name}`);
    const b = GeoAoi.boundsFromBbox(bbox);
    if (b) map.fitBounds(b);
  });

  // FR-SAT-003 — date range.
  const onDate = () => {
    const a = $('date-start').value, b = $('date-end').value;
    if (!a || !b) return err('both start and end dates are required');
    if (a > b) return err('invalid date range: start is after end');
    err('');
    saveState((s) => { s.satelliteSearch.datetime = `${a}/${b}`; });
  };
  $('date-start').addEventListener('change', onDate);
  $('date-end').addEventListener('change', onDate);

  // FR-SAT-004 — collection.
  $('collection').addEventListener('change', () => {
    saveState((s) => { s.satelliteSearch.collection = $('collection').value; });
  });

  // FR-SAT-005 — cloud cover limit.
  const showCloud = () => { $('cloud-label').textContent = `< ${$('cloud').value}%`; };
  $('cloud').addEventListener('input', showCloud);
  $('cloud').addEventListener('change', () => {
    showCloud(); // a programmatic change fires only `change`, so the label is refreshed here too
    saveState((s) => { s.satelliteSearch.maxCloudCover = Number($('cloud').value); });
  });

  $('search').addEventListener('click', runSearch); // FR-SAT-006

  // FR-SAT-007 — footprint layer visibility.
  $('show-footprints').addEventListener('change', () => {
    saveState((s) => {
      const e = s.layers.find((l) => l.id === FOOTPRINT_LAYER_ID);
      if (e) e.visible = $('show-footprints').checked;
    }).then(renderFootprints);
  });

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
      await renderAll();
      // ANA triggers a search by bumping requestId in state.json (§24.2).
      const rid = state.satelliteSearch.requestId || 0;
      if (rid > handledRequestId) { handledRequestId = rid; runSearch(); }
    }
  } catch (e) { err(`sync lost: ${e}`); }
}

// ---------- boot ----------

(async function main() {
  state = await fetchState();
  handledRequestId = state.satelliteSearch.requestId || 0;
  map = L.map('map');
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  drawer = GeoAoi.createDrawer(map, (bbox) => {
    $('aoi-draw').classList.remove('on');
    err('');
    setAoi(bbox, 'drawn');
  });
  await renderAll();
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
