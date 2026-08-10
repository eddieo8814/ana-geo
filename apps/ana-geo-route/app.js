// ana-geo-route client — Watch surface + state sync (PRD §8.2, §12, §19).
//
// The browser never computes a route: it collects origin, destination and mode,
// posts them to the server, and renders what the Python worker returned
// (§19.2). Every worker failure — including the FR-ROUTE-010 area cap — lands
// on this surface with its numbers attached (§25).
/* global L, GeoRegistry, GeoOverpass, GeoStyles */

let state = null;
let map, endpointGroup;
const geoLayers = new Map(); // layer id -> { layer, resultVersion }
let lastAppliedView = '';
let feedSince = 0;
let clickTarget = 'origin'; // which endpoint the next map click sets
let busyCount = 0;

const $ = (id) => document.getElementById(id);
const err = (m) => { $('err').textContent = m || ''; }; // §25 — errors on the Watch surface

// ---------- server I/O ----------

async function fetchState() {
  const r = await fetch('/api/state');
  return r.json();
}

async function refresh() {
  state = await fetchState();
  await renderAll();
}

async function patchAnalysis(patch) {
  const r = await fetch('/api/analysis', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    err(body.error || `analysis update failed (${r.status})`);
    return false;
  }
  await refresh();
  return true;
}

function setBusy(label) {
  busyCount += label ? 1 : -1;
  if (busyCount < 0) busyCount = 0;
  const el = $('s-busy');
  el.className = busyCount ? 'busy' : '';
  el.textContent = busyCount ? `${label || 'working'}…` : '';
  syncButtons();
}

// One place decides which actions are available, so a finished request cannot
// re-enable "rank candidates" before any candidates exist.
function syncButtons() {
  const busy = busyCount > 0;
  const hasCandidates = !!(state && state.layers.some((l) => l.id === 'candidates'));
  $('go-route').disabled = busy;
  $('go-isochrone').disabled = busy;
  $('go-candidates').disabled = busy;
  $('go-nearest').disabled = busy || !hasCandidates;
}

// A worker call can take seconds (an uncached network download dominates), so
// the button state and the status bar say so rather than looking frozen.
async function callServer(path, body, label) {
  setBusy(label);
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let envelope = null;
    try { envelope = await r.json(); } catch { envelope = null; }
    if (!envelope) { err(`${label} failed (HTTP ${r.status})`); return null; }
    if (envelope.ok === false || envelope.error) {
      const e = envelope.error || {};
      err(`${e.code || 'error'}: ${e.message || 'request failed'}`);
      await refresh(); // the failure is in state.analysis.lastError too
      return null;
    }
    err('');
    await refresh();
    return envelope.result;
  } catch (e) {
    err(`${label} failed: ${e}`);
    return null;
  } finally {
    setBusy(null);
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

const fmtLatLng = (p) => (p ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : '–');
const fmtKm = (m) => (m == null ? '–' : m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const fmtMin = (s) => (s == null ? '–' : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);

function renderEndpoints() {
  endpointGroup.clearLayers();
  const a = state.analysis || {};
  for (const [kind, label] of [['origin', 'Origin'], ['destination', 'Destination']]) {
    const p = a[kind];
    if (!p) continue;
    GeoStyles.endpointMarker(kind, [p.lat, p.lng], L)
      .bindTooltip(label, { direction: 'top' })
      .addTo(endpointGroup);
  }
  $('v-origin').textContent = fmtLatLng(a.origin);
  $('v-dest').textContent = fmtLatLng(a.destination);
}

function buildLayer(entry, gj) {
  if (entry.category === 'isochrone') {
    const minutes = (state.analysis.isochrone && state.analysis.isochrone.minutes) || [];
    // Largest band first so the 5-minute polygon stays visible on top of the
    // 20-minute one that contains it.
    const features = (gj.features || [])
      .filter((f) => f.geometry)
      .sort((a, b) => (b.properties.minutes || 0) - (a.properties.minutes || 0));
    return L.geoJSON({ type: 'FeatureCollection', features }, {
      style: (f) => GeoStyles.isochroneStyle(f, minutes),
      onEachFeature: (f, layer) => {
        const p = f.properties;
        layer.bindTooltip(`${p.minutes} min (approximate) — ${p.nodeCount} intersections`, { sticky: true });
      },
    });
  }
  if (entry.category === 'candidates') {
    return L.geoJSON(gj, {
      pointToLayer: (f, latlng) => GeoStyles.candidateMarker(f, latlng, L),
      style: GeoStyles.candidateStyle, // areal candidates (hospitals, campuses) arrive as polygons
      onEachFeature: (f, layer) => {
        const p = f.properties || {};
        const m = p.metrics || {};
        const cost = m.travelTimeSeconds != null
          ? ` — ${fmtMin(m.travelTimeSeconds)} / ${fmtKm(m.distanceMeters)}`
          : ' — not ranked yet';
        layer.bindTooltip(`${p.rank ? `#${p.rank} ` : ''}${p.name || f.id}${cost}`, { sticky: true });
      },
    });
  }
  return L.geoJSON(gj, {
    style: GeoStyles.routeStyle,
    onEachFeature: (f, layer) => {
      const m = (f.properties && f.properties.metrics) || {};
      layer.bindTooltip(`${fmtKm(m.distanceMeters)} · ${fmtMin(m.travelTimeSeconds)}`, { sticky: true });
    },
  });
}

async function renderLayers() {
  const panel = $('layers');
  panel.innerHTML = '';
  if (!state.layers.length) {
    panel.innerHTML = '<div class="note">No result layers yet.</div>';
  }

  for (const entry of state.layers) {
    const known = geoLayers.get(entry.id);
    if (!known || known.resultVersion !== entry.resultVersion) {
      try {
        const r = await fetch(entry.resultRef); // feature bodies live behind resultRef (§12 rule 3)
        if (!r.ok) throw new Error(`${r.status}`);
        const gj = await r.json();
        if (known) map.removeLayer(known.layer);
        geoLayers.set(entry.id, { layer: buildLayer(entry, gj), resultVersion: entry.resultVersion });
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
  const row = document.createElement('div');
  row.className = 'layer-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!entry.visible;
  // Discrete action → immediate write (§8.2-5); visibility never bumps resultVersion.
  cb.addEventListener('change', async () => {
    await fetch(`/api/layers/${entry.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visible: cb.checked }),
    });
    await refresh();
  });
  const span = document.createElement('span');
  span.textContent = entry.label || entry.id;
  const cnt = document.createElement('span');
  cnt.className = 'count';
  cnt.textContent = entry.featureCount ?? '';
  row.append(cb, span, cnt);
  return row;
}

function card(html, cls) {
  return `<div class="card${cls ? ' ' + cls : ''}">${html}</div>`;
}

function renderRouteSummary() {
  const r = state.analysis && state.analysis.route;
  const box = $('route-summary');
  if (!r) { box.innerHTML = ''; $('s-route').textContent = '–'; return; }
  // FR-ROUTE-007 — distance, time and mode; both objectives side by side so a
  // "fastest" route that is longer than the "shortest" one is self-explaining.
  const alt = r.alternatives;
  box.innerHTML = card(`
    <div class="row"><label>Distance</label><span class="val">${fmtKm(r.distanceMeters)}</span></div>
    <div class="row"><label>Time</label><span class="val">${fmtMin(r.travelTimeSeconds)}</span></div>
    <div class="row"><label>Mode</label><span class="val">${r.mode}</span></div>
    <div class="row"><label>Optimized</label><span class="val">${r.optimizedFor === 'time' ? 'fastest' : 'shortest'}</span></div>
    ${alt ? `<div class="hint">fastest ${fmtKm(alt.time.distanceMeters)} / ${fmtMin(alt.time.travelTimeSeconds)} ·
      shortest ${fmtKm(alt.distance.distanceMeters)} / ${fmtMin(alt.distance.travelTimeSeconds)}</div>` : ''}
    ${r.snapMeters ? `<div class="hint">snapped ${Math.round(r.snapMeters.origin)} m / ${Math.round(r.snapMeters.destination ?? 0)} m to the nearest intersection</div>` : ''}
  `);
  $('s-route').textContent = `${fmtKm(r.distanceMeters)} · ${fmtMin(r.travelTimeSeconds)} · ${r.mode}`;
}

function renderRanking() {
  const box = $('ranking');
  const rk = state.analysis && state.analysis.ranking;
  if (!rk) { box.innerHTML = ''; return; }
  const items = rk.top.map((c) => `<li>${c.name || c.id}
      <span class="cost">— ${fmtMin(c.travelTimeSeconds)} / ${fmtKm(c.distanceMeters)}</span></li>`).join('');
  box.innerHTML = card(`
    <div class="hint">Ranked by network ${rk.rankedBy === 'time' ? 'travel time' : 'distance'} —
      ${rk.candidatesConsidered} of ${rk.candidatesAvailable} candidates${rk.unreachable ? `, ${rk.unreachable} unreachable` : ''}.</div>
    <ol class="ranking">${items}</ol>
    ${rk.truncated ? `<div class="hint">Only the first ${rk.candidatesConsidered} candidates were routed — narrow the radius to rank the rest.</div>` : ''}
  `);
}

function renderIsochrone() {
  const box = $('isochrone-summary');
  const iso = state.analysis && state.analysis.isochrone;
  if (!iso) { box.innerHTML = ''; return; }
  const bands = iso.bands.map((b, i) => `
    <div class="row">
      <label><span class="swatch" style="background:${GeoStyles.COLORS.isochrone[i % 3]}"></span>${b.minutes} min</label>
      <span class="val">${b.degenerate ? 'too few nodes' : `${b.areaKm2} km²`}</span>
    </div>`).join('');
  box.innerHTML = card(`${bands}
    <div class="hint">Approximate (${iso.method}): the convex hull of reachable intersections over-covers gaps in the network.</div>`);
}

function renderNetwork() {
  const n = state.analysis && state.analysis.network;
  const box = $('network');
  if (!n) { box.innerHTML = '<div class="note">No network loaded yet.</div>'; return; }
  // Where the travel times came from is part of the answer, not a footnote:
  // driving times are imputed per road type, walking and cycling times assume
  // one speed for the whole network.
  const sp = n.speedEstimates || {};
  const speedNote = sp.model === 'uniform-speed'
    ? `Times assume a constant ${sp.speedKph} km/h — OSM maxspeed describes motor traffic, not a ${n.networkType} traveller.`
    : sp.edgesTotal
      ? `${sp.edgesWithMaxspeed} of ${sp.edgesTotal} edges carry an OSM maxspeed tag; the rest use the mean speed of their road type, so times are estimates.`
      : '';
  box.innerHTML = card(`
    <div class="row"><label>Area</label><span class="val">${n.areaKm2} km²</span></div>
    <div class="row"><label>Graph</label><span class="val">${n.nodes} nodes / ${n.edges} edges</span></div>
    <div class="row"><label>Source</label><span class="val">${n.cached ? 'cache' : 'Overpass'} (${n.elapsedSeconds}s)</span></div>
    ${speedNote ? `<div class="hint">${speedNote}</div>` : ''}
  `);
}

// §25 — a worker failure stays on the Watch surface across a refresh.
function renderLastError() {
  const box = $('lasterror');
  const e = state.analysis && state.analysis.lastError;
  if (!e) { box.innerHTML = ''; return; }
  const d = e.details || {};
  let extra = '';
  if (e.code === 'area_cap_exceeded') {
    extra = `<div class="hint">requested ${d.requestedAreaKm2} km² (${d.widthKm} × ${d.heightKm} km), cap ${d.capKm2} km².
      Raise the cap above, move the points closer, or split the analysis.</div>`;
  } else if (d.log) {
    extra = `<div class="hint">worker log: ${String(d.log).split('\n').slice(-1)[0]}</div>`;
  }
  box.innerHTML = card(`<div class="code">${e.code}</div><div>${e.message}</div>
    ${extra}<div class="hint">${e.op} · ${new Date(e.at).toLocaleTimeString()}</div>`, 'error');
}

function renderControls() {
  const a = state.analysis || {};
  const set = (id, value) => {
    const el = $(id);
    if (document.activeElement !== el && String(el.value) !== String(value)) el.value = value;
  };
  set('mode', a.mode || 'drive');
  set('optimize', a.optimize || 'time');
  set('minutes', (a.isochroneMinutes || [5, 10, 20]).join(','));
  set('areacap', a.areaCapKm2 ?? 100);
  set('radius', a.candidateRadiusKm ?? 2.5);
  set('category', a.candidateCategory || 'hospital');
  const candidates = state.layers.find((l) => l.id === 'candidates');
  $('v-candidates').textContent = `${candidates ? candidates.featureCount : 0} loaded`;
  syncButtons();
}

function updateStatus() {
  const c = map.getCenter();
  $('s-center').textContent = `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`;
  $('s-zoom').textContent = map.getZoom();
}

async function renderAll() {
  applyView();
  renderEndpoints();
  renderControls();
  renderRouteSummary();
  renderRanking();
  renderIsochrone();
  renderNetwork();
  renderLastError();
  updateStatus();
  await renderLayers();
}

// ---------- actions ----------

function bboxAround(point, km) {
  const dlat = km / 111.32;
  const dlng = km / (111.32 * Math.max(Math.cos((point.lat * Math.PI) / 180), 0.01));
  return [point.lng - dlng, point.lat - dlat, point.lng + dlng, point.lat + dlat];
}

// FR-ROUTE-008 — candidates come from a registry-key category fetch, exactly as
// in FR-EXP-002/008, through the server proxy (§8.4).
async function fetchCandidates() {
  const a = state.analysis || {};
  if (!a.origin) return err('Set an origin first — click the map.');
  const category = $('category').value;
  const radius = Number($('radius').value) || 2.5;
  setBusy('fetching candidates');
  try {
    const bbox = bboxAround(a.origin, radius);
    const res = await GeoOverpass.fetchCategory(category, bbox, { cap: 200 });
    if (!res.ok) return err(`Overpass ${res.kind}: ${res.message}`);
    if (!res.collection.features.length) {
      return err(`No ${GeoRegistry.label(category)} found within ${radius} km — widen the radius or pick another category.`);
    }
    await fetch('/api/results/candidates', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(res.collection),
    });
    await fetch('/api/layers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'candidates', label: `Candidates — ${GeoRegistry.label(category)} (${res.collection.features.length})`,
        category: 'candidates', source: 'overpass',
        featureCount: res.collection.features.length, visible: true,
      }),
    });
    // §28 / §24.4 — record what was fetched, from where.
    await fetch('/api/provenance', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'overpass-search', source: 'openstreetmap', category,
        query: res.query, resultCount: res.collection.features.length, bbox,
      }),
    });
    await patchAnalysis({ candidateCategory: category, candidateRadiusKm: radius });
    err('');
  } catch (e) {
    err(`candidate fetch failed: ${e}`);
  } finally {
    setBusy(null);
  }
}

function parseMinutes(text) {
  return String(text).split(/[,\s]+/).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n > 0);
}

function setupEvents() {
  // moveend/zoomend matter as well as move/zoom: a zoom animation (which is
  // what an ANA-set view triggers) fires no `move`, so the status bar would
  // keep showing the pre-animation center and zoom.
  map.on('move zoom moveend zoomend', updateStatus);
  // Continuous gesture → 300 ms trailing write of observedView only (§8.2-5, §12 rule 4).
  let t;
  map.on('moveend zoomend', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const c = map.getCenter();
      const next = await fetchState();
      next.map.observedView = { center: [c.lat, c.lng], zoom: map.getZoom() };
      await fetch('/api/state', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next),
      });
    }, 300);
  });

  // FR-ROUTE-001 / FR-ROUTE-002 — discrete action, immediate write.
  map.on('click', async (e) => {
    const point = { lat: e.latlng.lat, lng: e.latlng.lng };
    await patchAnalysis({ [clickTarget]: point });
    if (clickTarget === 'origin') setClickTarget('destination'); // natural second click
  });

  $('pick-origin').addEventListener('click', () => setClickTarget('origin'));
  $('pick-dest').addEventListener('click', () => setClickTarget('destination'));

  $('mode').addEventListener('change', () => patchAnalysis({ mode: $('mode').value }));       // FR-ROUTE-003
  $('optimize').addEventListener('change', () => patchAnalysis({ optimize: $('optimize').value }));
  $('areacap').addEventListener('change', () => patchAnalysis({ areaCapKm2: Number($('areacap').value) }));
  $('radius').addEventListener('change', () => patchAnalysis({ candidateRadiusKm: Number($('radius').value) }));
  $('category').addEventListener('change', () => patchAnalysis({ candidateCategory: $('category').value }));
  $('minutes').addEventListener('change', () => {
    const minutes = parseMinutes($('minutes').value);
    if (!minutes.length) return err('Minutes must be a list of positive numbers, e.g. 5,10,20');
    patchAnalysis({ isochroneMinutes: minutes });
  });

  $('go-route').addEventListener('click', async () => {
    const a = state.analysis || {};
    if (!a.origin || !a.destination) return err('Set both an origin and a destination by clicking the map.');
    const result = await callServer('/api/route', {}, 'routing');
    if (result) fitTo('route');
  });

  $('clear-points').addEventListener('click', () => patchAnalysis({ origin: null, destination: null }));
  $('go-candidates').addEventListener('click', fetchCandidates);
  $('go-nearest').addEventListener('click', async () => {
    const result = await callServer('/api/nearest', { rankBy: $('optimize').value === 'distance' ? 'distance' : 'time' }, 'ranking candidates');
    if (result) fitTo('route');
  });
  $('go-isochrone').addEventListener('click', async () => {
    const minutes = parseMinutes($('minutes').value);
    const result = await callServer('/api/isochrone', { minutes }, 'building isochrone');
    if (result) fitTo('isochrone');
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

function setClickTarget(target) {
  clickTarget = target;
  $('pick-origin').classList.toggle('active', target === 'origin');
  $('pick-dest').classList.toggle('active', target === 'destination');
}

function fitTo(layerId) {
  const rec = geoLayers.get(layerId);
  if (!rec) return;
  const b = rec.layer.getBounds();
  if (b.isValid()) map.fitBounds(b, { padding: [30, 30] });
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
    if (stateVersion !== state.stateVersion) await refresh();
  } catch (e) { err(`sync lost: ${e}`); }
}

// ---------- boot ----------

async function showWorkerStatus() {
  try {
    const r = await fetch('/api/worker/status');
    const body = await r.json();
    if (!body.ok) {
      $('workerinfo').textContent = `worker: ${body.error.code}`;
      err(`Python worker unavailable — ${body.error.message}`);
      return;
    }
    const deps = body.result.dependencies;
    $('workerinfo').textContent = `worker: python ${body.result.python}, osmnx ${deps.osmnx}`;
    if (String(deps.osmnx).startsWith('MISSING')) {
      err('osmnx is not installed — run: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt');
    }
  } catch (e) {
    $('workerinfo').textContent = 'worker: unreachable';
  }
}

(async function main() {
  state = await fetchState();
  map = L.map('map');
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  endpointGroup = L.layerGroup().addTo(map);

  const cat = $('category');
  for (const key of GeoRegistry.keys()) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = GeoRegistry.label(key);
    cat.appendChild(opt);
  }

  await renderAll();
  setupEvents();
  showWorkerStatus();
  setInterval(poll, 2500);
})();
