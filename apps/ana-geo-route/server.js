#!/usr/bin/env node
// ana-geo-route server — ANA Geo shared runtime contracts (PRD §8.2–8.5)
// plus the routing API backed by the Python worker (§19, tools/worker.py).
// Node >= 20 (global fetch), zero npm dependencies.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { runWorker, pythonBin } = require('./tools/worker_client.js');

const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'state.json');
const RESULTS_DIR = path.join(ROOT, 'data', 'results');
const PORT = Number(process.env.PORT || 8805);

// §8.4 — per-app external host allowlist. The browser reaches Overpass only
// through /api/proxy; the Python worker reaches it over direct HTTPS (allowed
// for workers by §8.4), so this same list is handed to every worker call as
// `params.allowedHosts` and re-checked there against osmnx's endpoint. One
// constant, two enforcement points.
const ALLOWED_HOSTS = ['overpass-api.de'];

const PROVENANCE_LIMIT = 50; // §28 — keep the state file small (§12)
const RANKING_LIMIT = 25;    // §12 — state holds a summary, never the full result body
const CANDIDATE_LIMIT = 60;  // routing cost guard; truncation is reported, never silent

// Node's fetch sends no User-Agent, and Overpass answers such requests with
// HTTP 406. Identifying the client is also what the OSM usage policy asks for.
const USER_AGENT = 'ana-geo-route/0.1.0 (ANA Geo; +https://github.com/tykimos/agent-native-agent)';

// Worker failures that mean "the runtime is broken" rather than "the request was
// wrong" — these become 502 so a Python install problem is never mistaken for a
// bad route request (§25).
const INFRASTRUCTURE_CODES = new Set([
  'python_worker_failure',
  'missing_dependency',
  'osmnx_api_mismatch',
  'host_not_allowlisted',
  'worker_exception',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// ---------- state (§8.2, §12) ----------

function readState() {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function writeState(next) {
  const cur = readState();
  // stateVersion is owned by the server: monotonic, bumped on every change (§8.2-1).
  next.stateVersion = (cur.stateVersion || 0) + 1;
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, STATE_FILE); // atomic replace
  return next.stateVersion;
}

// Read-modify-write for the incremental edits of §24.2: the caller touches one
// field and the rest of the file is left untouched.
function mutateState(fn) {
  const state = readState();
  const out = fn(state);
  if (out && out.error) return out;
  return { stateVersion: writeState(state), analysis: state.analysis };
}

function ensureAnalysis(state) {
  if (!state.analysis) state.analysis = {};
  const a = state.analysis;
  if (!a.mode) a.mode = 'drive';
  if (!a.optimize) a.optimize = 'time';
  if (a.areaCapKm2 == null) a.areaCapKm2 = 100;
  if (a.paddingKm == null) a.paddingKm = 2;
  if (!Array.isArray(a.isochroneMinutes)) a.isochroneMinutes = [5, 10, 20];
  return a;
}

// A layer entry is references only — the feature bodies stay behind resultRef
// (§12 rule 3). Bumping resultVersion is what tells polling clients to refetch
// (§8.2-6); writeState bumps stateVersion in the same operation.
function upsertLayer(state, entry) {
  if (!Array.isArray(state.layers)) state.layers = [];
  const existing = state.layers.find((l) => l.id === entry.id);
  const next = {
    type: 'geojson',
    source: 'python-worker',
    visible: true,
    ...entry,
    resultRef: `/api/results/${entry.id}`,
    resultVersion: ((existing && existing.resultVersion) || 0) + 1,
  };
  if (existing) Object.assign(existing, next);
  else state.layers.push(next);
  return next;
}

// ---------- results (§8.3, §11.1) ----------

function resultPath(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  return { id: safe, file: path.join(RESULTS_DIR, `${safe}.geojson`) };
}

function writeResult(id, collection) {
  const { file } = resultPath(id);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(collection));
  fs.renameSync(file + '.tmp', file);
  return collection;
}

function readResult(id) {
  const { file } = resultPath(id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function bboxOf(collection) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (coords) => {
    if (typeof coords[0] === 'number') {
      w = Math.min(w, coords[0]); e = Math.max(e, coords[0]);
      s = Math.min(s, coords[1]); n = Math.max(n, coords[1]);
      return;
    }
    for (const c of coords) walk(c);
  };
  for (const f of collection.features || []) if (f.geometry) walk(f.geometry.coordinates);
  return Number.isFinite(w) ? [w, s, e, n] : [];
}

// A candidate is a routable point (FR-ROUTE-008). Areal features (hospitals,
// campuses) arrive as polygons, so a representative point is derived rather
// than refusing the feature.
function representativePoint(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Point') return geometry.coordinates;
  const flat = [];
  const walk = (c) => { if (typeof c[0] === 'number') flat.push(c); else c.forEach(walk); };
  walk(geometry.coordinates);
  if (!flat.length) return null;
  const sum = flat.reduce((acc, c) => [acc[0] + c[0], acc[1] + c[1]], [0, 0]);
  return [sum[0] / flat.length, sum[1] / flat.length];
}

function candidatesFromCollection(collection) {
  const out = [];
  for (const f of collection.features || []) {
    const pt = representativePoint(f.geometry);
    if (!pt) continue;
    out.push({
      id: String(f.id || `cand-${out.length}`),
      name: (f.properties && f.properties.name) || null,
      category: (f.properties && f.properties.category) || null,
      lat: pt[1],
      lng: pt[0],
    });
  }
  return out;
}

// ---------- converse surface (§8.3) ----------

const inbox = [];        // user -> agent queue, drained by the inbound relay
const inboxWaiters = []; // pending long-poll responses
const feed = [];         // agent -> dashboard messages
let feedSeq = 0;

function pushInbox(msg) {
  inbox.push(msg);
  while (inboxWaiters.length) drainInboxTo(inboxWaiters.shift());
}

function drainInboxTo(res) {
  const batch = inbox.splice(0, inbox.length);
  sendJson(res, 200, { messages: batch });
}

// ---------- helpers ----------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.normalize(path.join(ROOT, rel));
  if (!abs.startsWith(ROOT + path.sep) && abs !== path.join(ROOT, 'index.html')) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return sendJson(res, 404, { error: 'not found' });
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
}

// §8.4 — allowlist proxy; forwards Range and passes 206 through unchanged.
// Upstream status and body are relayed verbatim so the client can tell an
// Overpass 504/502 apart from a 200 carrying an HTML error page (§25).
async function handleProxy(req, res, url) {
  const target = url.searchParams.get('url');
  let parsed;
  try { parsed = new URL(target); } catch { return sendJson(res, 400, { error: 'bad url' }); }
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return sendJson(res, 403, { error: `host not allowlisted: ${parsed.hostname}` });
  }
  const headers = { 'user-agent': USER_AGENT };
  if (req.headers.range) headers.range = req.headers.range;
  if (req.headers.accept) headers.accept = req.headers.accept;
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  try {
    const isPost = req.method === 'POST';
    const upstream = await fetch(parsed, {
      method: isPost ? 'POST' : 'GET',
      headers,
      body: isPost ? await readBody(req) : undefined,
    });
    const h = { 'content-type': upstream.headers.get('content-type') || 'application/octet-stream' };
    for (const k of ['content-range', 'accept-ranges']) {
      const v = upstream.headers.get(k);
      if (v) h[k] = v;
    }
    // The upstream content-length describes the *compressed* body, which fetch
    // has already decompressed. Forwarding it truncates the response.
    const buf = Buffer.from(await upstream.arrayBuffer());
    h['content-length'] = String(buf.length);
    res.writeHead(upstream.status, h);
    res.end(buf);
  } catch (e) {
    sendJson(res, 502, { error: 'upstream failure', detail: String(e) });
  }
}

// ---------- routing API (§19, §8.5) ----------

// Request body wins; state.analysis supplies the standing defaults ANA edits.
function workerParams(state, body) {
  const a = ensureAnalysis(state);
  const point = (v, fallback) => {
    if (Array.isArray(v)) return [Number(v[0]), Number(v[1])];
    if (v && typeof v === 'object') return [Number(v.lat), Number(v.lng)];
    if (fallback && typeof fallback === 'object') return [Number(fallback.lat), Number(fallback.lng)];
    return null;
  };
  return {
    origin: point(body.origin, a.origin),
    destination: point(body.destination, a.destination),
    mode: body.mode || a.mode,
    optimize: body.optimize || a.optimize,
    areaCapKm2: Number(body.areaCapKm2 ?? a.areaCapKm2),
    paddingKm: Number(body.paddingKm ?? a.paddingKm),
    allowedHosts: ALLOWED_HOSTS, // §8.4 — the worker enforces the same list
  };
}

function statusFor(envelope) {
  return INFRASTRUCTURE_CODES.has(envelope.error.code) ? 502 : 422;
}

// §25 / §30 item 7 — a failure is written into state so it stays visible on the
// Watch surface across a refresh, not just in the response that triggered it.
function recordFailure(op, envelope) {
  const stateVersion = mutateState((s) => {
    ensureAnalysis(s).lastError = {
      op,
      code: envelope.error.code,
      message: envelope.error.message,
      details: envelope.error.details || null,
      at: new Date().toISOString(),
    };
  }).stateVersion;
  return stateVersion;
}

function clearFailure(analysis) {
  analysis.lastError = null;
}

async function handleRoute(res, body) {
  const params = workerParams(readState(), body);
  if (!params.origin || !params.destination) {
    return sendJson(res, 400, {
      ok: false,
      result: null,
      error: { code: 'bad_params', message: 'origin and destination are required (FR-ROUTE-001, FR-ROUTE-002)' },
    });
  }
  const envelope = await runWorker('route', params);
  if (!envelope.ok) {
    return sendJson(res, statusFor(envelope), { ...envelope, stateVersion: recordFailure('route', envelope) });
  }

  const r = envelope.result;
  const feature = {
    type: 'Feature',
    id: 'route',
    geometry: r.route.geometry,
    properties: {
      name: `${r.route.mode} route`,
      category: 'route',
      source: 'osm',
      sourceId: null,
      score: null,
      metrics: {
        distanceMeters: r.route.distanceMeters,
        travelTimeSeconds: r.route.travelTimeSeconds,
        optimizedFor: r.route.optimizedFor,
      },
      fetchedAt: new Date().toISOString(),
    },
  };
  const collection = { type: 'FeatureCollection', features: [feature] };
  writeResult('route', collection);

  const out = mutateState((s) => {
    const a = ensureAnalysis(s);
    a.mode = params.mode;
    a.optimize = params.optimize;
    a.origin = { lat: params.origin[0], lng: params.origin[1] };
    a.destination = { lat: params.destination[0], lng: params.destination[1] };
    // Summary only — the geometry lives behind resultRef (§12 rule 3).
    a.route = {
      mode: r.route.mode,
      distanceMeters: r.route.distanceMeters,
      travelTimeSeconds: r.route.travelTimeSeconds,
      optimizedFor: r.route.optimizedFor,
      alternatives: {
        distance: {
          distanceMeters: r.alternatives.distance.distanceMeters,
          travelTimeSeconds: r.alternatives.distance.travelTimeSeconds,
        },
        time: {
          distanceMeters: r.alternatives.time.distanceMeters,
          travelTimeSeconds: r.alternatives.time.travelTimeSeconds,
        },
      },
      snapMeters: r.snapMeters,
      computedAt: new Date().toISOString(),
    };
    a.network = r.network;
    clearFailure(a);
    upsertLayer(s, {
      id: 'route',
      label: `Route (${r.route.mode}, ${r.route.optimizedFor === 'time' ? 'fastest' : 'shortest'})`,
      category: 'route',
      featureCount: 1,
      bbox: bboxOf(collection),
    });
  });
  return sendJson(res, 200, { ...envelope, stateVersion: out.stateVersion });
}

async function handleNearest(res, body) {
  const state = readState();
  const params = workerParams(state, body);
  if (!params.origin) {
    return sendJson(res, 400, {
      ok: false, result: null,
      error: { code: 'bad_params', message: 'origin is required (FR-ROUTE-001)' },
    });
  }

  // Candidates come inline, or from a stored result layer the client filled
  // from a registry-key category fetch / a GeoJSON upload (FR-ROUTE-008).
  let candidates = Array.isArray(body.candidates) ? body.candidates : null;
  const sourceId = body.candidatesRef || 'candidates';
  if (!candidates) {
    const stored = readResult(sourceId);
    if (!stored) {
      return sendJson(res, 400, {
        ok: false, result: null,
        error: {
          code: 'no_candidates',
          message: `No candidate destinations loaded — fetch a category or upload GeoJSON first (result "${sourceId}" is empty).`,
        },
      });
    }
    candidates = candidatesFromCollection(stored);
  }
  const total = candidates.length;
  const truncated = total > CANDIDATE_LIMIT;
  if (truncated) candidates = candidates.slice(0, CANDIDATE_LIMIT);
  if (!candidates.length) {
    return sendJson(res, 422, {
      ok: false, result: null,
      error: { code: 'no_candidates', message: 'The candidate layer contains no routable features.' },
    });
  }

  const envelope = await runWorker('nearest', {
    ...params,
    candidates,
    rankBy: body.rankBy || (params.optimize === 'distance' ? 'distance' : 'time'),
    limit: body.limit || null,
  });
  if (!envelope.ok) {
    return sendJson(res, statusFor(envelope), { ...envelope, stateVersion: recordFailure('nearest', envelope) });
  }

  const r = envelope.result;
  // Truncation is reported, never silent — the same rule the area cap follows.
  r.candidatesConsidered = candidates.length;
  r.candidatesAvailable = total;
  r.truncated = truncated;

  if (r.route) {
    writeResult('route', {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature', id: 'route', geometry: r.route.geometry,
        properties: {
          name: `${r.route.mode} route to ${r.ranking[0] ? (r.ranking[0].name || r.ranking[0].id) : 'nearest'}`,
          category: 'route', source: 'osm', sourceId: null, score: null,
          metrics: { distanceMeters: r.route.distanceMeters, travelTimeSeconds: r.route.travelTimeSeconds, optimizedFor: r.route.optimizedFor },
          fetchedAt: new Date().toISOString(),
        },
      }],
    });
  }

  // Fold the network costs back into the candidate features so the map can
  // label them by rank, not only the side panel.
  const stored = readResult(sourceId);
  let candidateBbox = [];
  if (stored) {
    const byId = new Map(r.ranking.map((c) => [c.id, c]));
    for (const f of stored.features || []) {
      const hit = byId.get(String(f.id));
      f.properties = f.properties || {};
      f.properties.rank = hit ? hit.rank : null;
      f.properties.metrics = {
        ...(f.properties.metrics || {}),
        distanceMeters: hit ? hit.distanceMeters : null,
        travelTimeSeconds: hit ? hit.travelTimeSeconds : null,
      };
    }
    writeResult(sourceId, stored);
    candidateBbox = bboxOf(stored);
  }

  const out = mutateState((s) => {
    const a = ensureAnalysis(s);
    a.mode = params.mode;
    a.origin = { lat: params.origin[0], lng: params.origin[1] };
    a.ranking = {
      rankedBy: r.rankedBy,
      candidatesConsidered: r.candidatesConsidered,
      candidatesAvailable: r.candidatesAvailable,
      truncated: r.truncated,
      unreachable: r.unreachable.length,
      // A bounded summary; the full feature bodies stay behind resultRef (§12).
      top: r.ranking.slice(0, RANKING_LIMIT).map((c) => ({
        rank: c.rank, id: c.id, name: c.name,
        distanceMeters: c.distanceMeters, travelTimeSeconds: c.travelTimeSeconds,
      })),
      computedAt: new Date().toISOString(),
    };
    a.network = r.network;
    clearFailure(a);
    if (r.route) {
      a.route = {
        mode: r.route.mode, distanceMeters: r.route.distanceMeters,
        travelTimeSeconds: r.route.travelTimeSeconds, optimizedFor: r.route.optimizedFor,
        computedAt: new Date().toISOString(),
      };
      upsertLayer(s, {
        id: 'route', label: `Route to nearest (${r.route.mode})`, category: 'route',
        featureCount: 1, bbox: bboxOf(readResult('route')),
      });
    }
    if (stored) {
      upsertLayer(s, {
        id: sourceId, label: `Candidates (${(stored.features || []).length})`,
        category: 'candidates', source: 'overpass',
        featureCount: (stored.features || []).length, bbox: candidateBbox,
      });
    }
  });
  return sendJson(res, 200, { ...envelope, stateVersion: out.stateVersion });
}

async function handleIsochrone(res, body) {
  const state = readState();
  const params = workerParams(state, body);
  if (!params.origin) {
    return sendJson(res, 400, {
      ok: false, result: null,
      error: { code: 'bad_params', message: 'origin is required (FR-ROUTE-001)' },
    });
  }
  const minutes = Array.isArray(body.minutes) && body.minutes.length
    ? body.minutes
    : ensureAnalysis(state).isochroneMinutes;

  const envelope = await runWorker('isochrone', { ...params, minutes });
  if (!envelope.ok) {
    return sendJson(res, statusFor(envelope), { ...envelope, stateVersion: recordFailure('isochrone', envelope) });
  }

  const r = envelope.result;
  const collection = r.isochrone;
  // Keep the worker's own properties (minutes, approximate, method, note) and
  // add the §11.1 common property model around them.
  for (const f of collection.features) {
    const props = f.properties;
    f.properties = {
      ...props,
      name: `${props.minutes} min (${props.mode})`,
      category: 'isochrone',
      source: 'osm',
      sourceId: null,
      score: null,
      metrics: { minutes: props.minutes, nodeCount: props.nodeCount, areaKm2: props.areaKm2 || null },
      fetchedAt: new Date().toISOString(),
    };
  }
  writeResult('isochrone', collection);

  const out = mutateState((s) => {
    const a = ensureAnalysis(s);
    a.mode = params.mode;
    a.origin = { lat: params.origin[0], lng: params.origin[1] };
    a.isochroneMinutes = r.minutes;
    a.isochrone = {
      minutes: r.minutes,
      mode: r.mode,
      approximate: true,          // FR-ROUTE-009 — never presented as exact
      method: r.method,
      bands: r.summary,
      computedAt: new Date().toISOString(),
    };
    a.network = r.network;
    clearFailure(a);
    upsertLayer(s, {
      id: 'isochrone',
      label: `Isochrone ${r.minutes.join('/')} min (${r.mode}, approximate)`,
      category: 'isochrone',
      featureCount: collection.features.length,
      bbox: bboxOf(collection),
    });
  });
  return sendJson(res, 200, { ...envelope, stateVersion: out.stateVersion });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    if (p === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, readState());
    }
    if (p === '/api/state' && req.method === 'PUT') {
      const next = JSON.parse(await readBody(req));
      const v = writeState(next);
      return sendJson(res, 200, { stateVersion: v });
    }
    if (p === '/api/version') {
      return sendJson(res, 200, { stateVersion: readState().stateVersion || 0 });
    }

    // §24.2 — incremental edits: "use walking instead", "raise the cap to 200".
    if (p === '/api/analysis' && req.method === 'GET') {
      return sendJson(res, 200, readState().analysis || null);
    }
    if (p === '/api/analysis' && req.method === 'PATCH') {
      const patch = JSON.parse(await readBody(req));
      const allowed = ['mode', 'optimize', 'origin', 'destination', 'areaCapKm2', 'paddingKm', 'isochroneMinutes', 'candidateCategory', 'candidateRadiusKm', 'lastError'];
      for (const k of Object.keys(patch)) {
        if (!allowed.includes(k)) return sendJson(res, 400, { error: `unknown analysis field: ${k}` });
      }
      if (patch.mode !== undefined && !['drive', 'walk', 'bike'].includes(patch.mode)) {
        return sendJson(res, 400, { error: 'mode must be drive, walk or bike (FR-ROUTE-003)' });
      }
      if (patch.optimize !== undefined && !['time', 'distance'].includes(patch.optimize)) {
        return sendJson(res, 400, { error: 'optimize must be "time" or "distance"' });
      }
      if (patch.areaCapKm2 !== undefined && !(Number(patch.areaCapKm2) > 0)) {
        return sendJson(res, 400, { error: 'areaCapKm2 must be a positive number' });
      }
      const out = mutateState((s) => { Object.assign(ensureAnalysis(s), patch); });
      return sendJson(res, 200, out);
    }

    // Layer registration and visibility (FR-MAP-008 lineage, §12).
    // POST bumps resultVersion — the body behind resultRef has changed.
    // PATCH only flips `visible`, so a toggle never forces every client to
    // refetch a result it already holds (§8.2-6).
    if (p === '/api/layers' && req.method === 'POST') {
      const entry = JSON.parse(await readBody(req));
      if (!entry.id) return sendJson(res, 400, { error: 'layer id required' });
      const { id } = resultPath(entry.id);
      let created = null;
      const out = mutateState((s) => { created = upsertLayer(s, { ...entry, id }); });
      return sendJson(res, 200, { stateVersion: out.stateVersion, layer: created });
    }
    if (p.startsWith('/api/layers/') && req.method === 'PATCH') {
      const { id } = resultPath(p.slice('/api/layers/'.length));
      const patch = JSON.parse(await readBody(req));
      const out = mutateState((s) => {
        const layer = (s.layers || []).find((l) => l.id === id);
        if (!layer) return { error: `no such layer: ${id}` };
        if (patch.visible !== undefined) layer.visible = !!patch.visible;
        if (patch.label !== undefined) layer.label = String(patch.label);
      });
      if (out.error) return sendJson(res, 404, out);
      return sendJson(res, 200, { stateVersion: out.stateVersion });
    }

    if (p === '/api/route' && req.method === 'POST') {
      return handleRoute(res, JSON.parse((await readBody(req)) || '{}'));
    }
    if (p === '/api/nearest' && req.method === 'POST') {
      return handleNearest(res, JSON.parse((await readBody(req)) || '{}'));
    }
    if (p === '/api/isochrone' && req.method === 'POST') {
      return handleIsochrone(res, JSON.parse((await readBody(req)) || '{}'));
    }

    // Raw §8.5 passthrough — how ANA (and tools/smoke_envelope.js) exercise the
    // worker directly, including the deliberate failure ops.
    if (p === '/api/worker' && req.method === 'POST') {
      const { op, params, timeoutMs } = JSON.parse((await readBody(req)) || '{}');
      if (!op) return sendJson(res, 400, { error: 'op required' });
      const envelope = await runWorker(op, { allowedHosts: ALLOWED_HOSTS, ...(params || {}) }, { timeoutMs });
      return sendJson(res, envelope.ok ? 200 : statusFor(envelope), envelope);
    }
    if (p === '/api/worker/status' && req.method === 'GET') {
      const envelope = await runWorker('capabilities', {}, { timeoutMs: 20000 });
      return sendJson(res, envelope.ok ? 200 : statusFor(envelope), { python: pythonBin(), ...envelope });
    }

    // §28 / §24.4 — provenance for every external acquisition.
    if (p === '/api/provenance' && req.method === 'POST') {
      const record = JSON.parse(await readBody(req));
      const out = mutateState((s) => {
        if (!Array.isArray(s.provenance)) s.provenance = [];
        s.provenance.push({ timestamp: new Date().toISOString(), ...record });
        if (s.provenance.length > PROVENANCE_LIMIT) s.provenance = s.provenance.slice(-PROVENANCE_LIMIT);
      });
      return sendJson(res, 200, { stateVersion: out.stateVersion });
    }

    if (p === '/api/chat' && req.method === 'POST') {
      const { text } = JSON.parse(await readBody(req));
      if (!text) return sendJson(res, 400, { error: 'text required' });
      const msg = { id: `m-${Date.now()}-${inbox.length}`, text, at: new Date().toISOString() };
      pushInbox(msg);
      feed.push({ seq: ++feedSeq, role: 'user', text, at: msg.at });
      return sendJson(res, 200, { id: msg.id });
    }
    if (p === '/api/inbox-wait' && req.method === 'GET') {
      if (inbox.length) return drainInboxTo(res);
      inboxWaiters.push(res);
      setTimeout(() => {
        const i = inboxWaiters.indexOf(res);
        if (i >= 0) { inboxWaiters.splice(i, 1); sendJson(res, 200, { messages: [] }); }
      }, 25000);
      return;
    }
    if (p === '/api/agent' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      feed.push({ seq: ++feedSeq, role: 'agent', at: new Date().toISOString(), ...body });
      return sendJson(res, 200, { seq: feedSeq });
    }
    if (p === '/api/feed') {
      const since = Number(url.searchParams.get('since') || 0);
      return sendJson(res, 200, {
        stateVersion: readState().stateVersion || 0,
        items: feed.filter((f) => f.seq > since),
      });
    }

    if (p.startsWith('/api/results/') && req.method === 'GET') {
      const { file } = resultPath(p.slice('/api/results/'.length));
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'no such result' });
      res.writeHead(200, { 'content-type': MIME['.geojson'] });
      return fs.createReadStream(file).pipe(res);
    }
    if (p.startsWith('/api/results/') && req.method === 'PUT') {
      const { id } = resultPath(p.slice('/api/results/'.length));
      const geojson = JSON.parse(await readBody(req)); // validates JSON (§25: invalid GeoJSON is a visible error)
      if (geojson.type !== 'FeatureCollection') return sendJson(res, 400, { error: 'expected FeatureCollection' });
      writeResult(id, geojson);
      return sendJson(res, 200, { id, featureCount: (geojson.features || []).length, bbox: bboxOf(geojson) });
    }
    if (p === '/api/proxy') {
      return handleProxy(req, res, url);
    }
    if (req.method === 'GET') return serveStatic(res, p);
    return sendJson(res, 405, { error: 'method not allowed' });
  } catch (e) {
    sendJson(res, 500, { error: 'internal', detail: String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`ana-geo-route → http://localhost:${PORT}  (state: ${path.basename(STATE_FILE)}, python: ${pythonBin()})`);
});
