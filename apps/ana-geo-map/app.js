// ana-geo-map client — Watch surface + state sync (PRD §8.2, §12, §15).
/* global L */

let state = null;
let map, markerGroup;
const geoLayers = new Map(); // layer id -> Leaflet layer
let lastAppliedView = '';
let feedSince = 0;
let saving = Promise.resolve();

const $ = (id) => document.getElementById(id);
const err = (m) => { $('err').textContent = m || ''; }; // §25 — errors on the Watch surface

// ---------- 선택 컨텍스트 칩 — frontend 요소 선택 시 등록 (§24.1) ----------
// 지도의 마커/피처를 클릭하면 칩으로 쌓이고, 전송 시 메시지에 [선택 컨텍스트]로 첨부되며
// state.selection에도 구조화되어 저장돼 ANA가 정확한 대상을 읽을 수 있다.
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

// ---------- rendering ----------

function applyView() {
  const v = state.map.view;
  if (!v) return;
  const key = JSON.stringify(v);
  if (key === lastAppliedView) return; // only ANA-set view moves the camera (§12 rule 4)
  lastAppliedView = key;
  map.setView(v.center, v.zoom);
}

function renderMarkers() {
  markerGroup.clearLayers();
  for (const m of state.markers) {
    L.marker([m.lat, m.lng]).addTo(markerGroup)
      .on('click', () => addChip(`marker:${m.id}`, `📍 ${m.id}`, { type: 'marker', id: m.id, lat: m.lat, lng: m.lng }));
  }
  $('markerinfo').textContent = state.markers.length
    ? `${state.markers.length} marker(s) in state.json`
    : 'Click the map to add a marker.';
}

async function renderLayers() {
  const panel = $('layers');
  panel.innerHTML = '';
  // built-in marker layer toggle (FR-MAP-008)
  panel.appendChild(layerRow('markers', 'Markers', state.markers.length, markerGroup.getLayers().length > 0 || state.markers.length >= 0, (on) => {
    if (on) map.addLayer(markerGroup); else map.removeLayer(markerGroup);
  }, map.hasLayer(markerGroup)));

  for (const entry of state.layers) {
    if (!geoLayers.has(entry.id) || geoLayers.get(entry.id).resultVersion !== entry.resultVersion) {
      try {
        const r = await fetch(entry.resultRef); // feature bodies live behind resultRef (§12 rule 3)
        if (!r.ok) throw new Error(`${r.status}`);
        const gj = await r.json();
        if (geoLayers.has(entry.id)) map.removeLayer(geoLayers.get(entry.id).layer);
        const layer = L.geoJSON(gj, {
          style: { color: '#3182F6', weight: 2 },
          onEachFeature: (f, lyr) => lyr.on('click', () => {
            const name = (f.properties && (f.properties.name || f.properties.id)) || f.id || entry.id;
            addChip(`feature:${entry.id}:${name}`, `⬠ ${name}`, { type: 'feature', layer: entry.id, name, featureId: f.id ?? null });
          }),
        });
        geoLayers.set(entry.id, { layer, resultVersion: entry.resultVersion });
      } catch (e) { err(`failed to load layer ${entry.id}: ${e}`); continue; }
    }
    const rec = geoLayers.get(entry.id);
    if (entry.visible && !map.hasLayer(rec.layer)) map.addLayer(rec.layer);
    if (!entry.visible && map.hasLayer(rec.layer)) map.removeLayer(rec.layer);
    panel.appendChild(layerRow(entry.id, entry.label || entry.id, entry.featureCount, entry.visible, (on) => {
      saveState((s) => { s.layers.find((l) => l.id === entry.id).visible = on; }).then(renderLayers);
    }, entry.visible));
  }
  // drop Leaflet layers whose state entry disappeared
  for (const [id, rec] of geoLayers) {
    if (id !== 'markers' && !state.layers.some((l) => l.id === id)) {
      map.removeLayer(rec.layer); geoLayers.delete(id);
    }
  }
}

function layerRow(id, label, count, visible, onToggle, checked) {
  const row = document.createElement('div');
  row.className = 'layer-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = checked;
  cb.addEventListener('change', () => onToggle(cb.checked)); // discrete action → immediate write (§8.2-5)
  const span = document.createElement('span'); span.textContent = label;
  const cnt = document.createElement('span'); cnt.className = 'count'; cnt.textContent = count ?? '';
  row.append(cb, span, cnt);
  row.style.cursor = 'pointer';
  row.addEventListener('click', (e) => { if (e.target !== cb) cb.click(); }); // 행 전체가 터치 타깃 (>=44px 가이드)
  return row;
}

function renderAll() { applyView(); renderMarkers(); renderLayers(); updateStatus(); }

function updateStatus() {
  const c = map.getCenter();
  $('s-center').textContent = `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`; // FR-MAP-003
  $('s-zoom').textContent = map.getZoom();                               // FR-MAP-004
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

  map.on('click', (e) => { // FR-MAP-005/006 — discrete action, immediate write
    saveState((s) => {
      s.markers.push({ id: `marker-${Date.now()}`, lat: e.latlng.lat, lng: e.latlng.lng, createdAt: new Date().toISOString() });
    }).then(renderMarkers);
  });

  $('clearmarkers').addEventListener('click', () => {
    saveState((s) => { s.markers = []; }).then(renderMarkers);
  });

  $('geofile').addEventListener('change', async (ev) => { // FR-MAP-007/009
    const file = ev.target.files[0];
    if (!file) return;
    err('');
    let gj;
    try { gj = JSON.parse(await file.text()); } catch { return err('invalid GeoJSON: not parseable JSON'); }
    if (gj.type !== 'FeatureCollection') return err('invalid GeoJSON: expected a FeatureCollection');
    const id = `geojson-${Date.now()}`;
    const up = await fetch(`/api/results/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(gj) });
    if (!up.ok) return err(`upload failed (${up.status})`);
    const { featureCount } = await up.json();
    const layer = L.geoJSON(gj);
    const b = layer.getBounds();
    await saveState((s) => {
      s.layers.push({ id, type: 'geojson', label: file.name, source: 'user-upload', visible: true,
        featureCount, resultRef: `/api/results/${id}`, resultVersion: 1,
        bbox: b.isValid() ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : [] });
    });
    await renderLayers();
    if (b.isValid()) map.fitBounds(b); // fit on load (FR-MAP-009)
    ev.target.value = '';
  });

  $('chatform').addEventListener('submit', async (e) => {
    e.preventDefault();
    let text = $('chatinput').value.trim();
    if (!text) return;
    $('chatinput').value = '';
    if (chips.size) {
      // 칩을 메시지에 첨부 + state.selection에 구조화 저장 (§24.1 — ANA가 정확한 대상 참조)
      const list = [...chips.values()];
      await saveState((s) => { s.selection = { chips: list.map((c) => c.ref), at: new Date().toISOString() }; });
      text += `\n[선택 컨텍스트: ${list.map((c) => c.label).join(', ')}]`;
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
    }
    err('');
  } catch (e) { err(`sync lost: ${e}`); }
}

// ---------- 사이드바 크기 조절 (기기별 UI 선호 — localStorage, 공유 상태 아님) ----------

function initResizer() {
  const rz = $('resizer'), conv = $('converse');
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
    map && map.invalidateSize();
  });
  rz.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    rz.classList.remove('active');
    localStorage.setItem('ana.converse.width', conv.offsetWidth);
  });
}

// ---------- boot ----------

(async function main() {
  state = await fetchState();
  map = L.map('map');
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  markerGroup = L.layerGroup().addTo(map);
  renderAll();
  setupEvents();
  initResizer();
  setInterval(poll, 2500);
})();
