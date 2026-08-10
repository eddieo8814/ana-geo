#!/usr/bin/env node
// ana-geo-site server — ANA Geo shared runtime contracts (PRD §8.2–8.4) plus
// the site-decision API: candidates (FR-SITE-001), hard constraints
// (FR-SITE-002), soft criteria and weights (FR-SITE-003–005).
// Node >= 20 (global fetch), zero npm dependencies.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const rules = require('./geo/rules.js');
const registry = require('./geo/registry.js');

const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'state.json');
const RESULTS_DIR = path.join(ROOT, 'data', 'results');
const PORT = Number(process.env.PORT || 8804);

// §8.4 — per-app external host allowlist. ana-geo-site acquires reference
// features from Overpass only; everything else is refused at this single point.
const ALLOWED_HOSTS = ['overpass-api.de'];

const PROVENANCE_LIMIT = 50;        // §28 — keep the state file small (§12)
const CANDIDATE_INDEX_LIMIT = 100;  // §12 — beyond this, the panel reads the ref
const RESULT_INLINE_LIMIT = 25;     // §12 — beyond this, results move behind a ref
const CANDIDATE_ID_PREFIX = 'site-';

// Node's fetch sends no User-Agent, and Overpass answers such requests with
// HTTP 406. Identifying the client is also what the OSM usage policy asks for.
const USER_AGENT = 'ana-geo-site/0.1.0 (ANA Geo; +https://github.com/tykimos/agent-native-agent)';

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

function emptySite() {
  return {
    candidates: { ref: '/api/results/site-candidates', version: 0, count: 0, bbox: [], list: [], indexOmitted: false },
    constraints: [],
    criteria: [],
    weights: { sum: 0, valid: false, error: 'no soft criteria defined — add at least one (FR-SITE-003).' },
    results: null,
  };
}

function ensureSite(state) {
  if (!state.analysis) state.analysis = {};
  if (!state.analysis.site) state.analysis.site = emptySite();
  const site = state.analysis.site;
  if (!Array.isArray(site.constraints)) site.constraints = [];
  if (!Array.isArray(site.criteria)) site.criteria = [];
  if (!site.candidates) site.candidates = emptySite().candidates;
  return site;
}

// FR-SITE-005 — recomputed after every criterion edit, so what state says about
// the weights is always what a run would decide.
function refreshWeights(site) {
  site.weights = rules.validateWeights(site.criteria);
}

// ---------- candidates (FR-SITE-001) ----------

function candidateFile() {
  return path.join(RESULTS_DIR, 'site-candidates.geojson');
}

function readCandidates() {
  const file = candidateFile();
  if (!fs.existsSync(file)) return { type: 'FeatureCollection', features: [] };
  try {
    const gj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (gj && gj.type === 'FeatureCollection' && Array.isArray(gj.features)) return gj;
  } catch { /* a damaged file is replaced rather than crashing the server */ }
  return { type: 'FeatureCollection', features: [] };
}

function writeCandidates(fc) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = candidateFile();
  fs.writeFileSync(file + '.tmp', JSON.stringify(fc));
  fs.renameSync(file + '.tmp', file);
}

// site-a … site-z, then site-27 onwards.
function nextCandidateId(taken) {
  for (let i = 0; i < 26; i += 1) {
    const id = `${CANDIDATE_ID_PREFIX}${String.fromCharCode(97 + i)}`;
    if (!taken.has(id)) return id;
  }
  let n = 27;
  while (taken.has(`${CANDIDATE_ID_PREFIX}${n}`)) n += 1;
  return `${CANDIDATE_ID_PREFIX}${n}`;
}

const CANDIDATE_GEOMETRIES = ['Point', 'MultiPoint', 'Polygon', 'MultiPolygon'];

// FR-SITE-001 — a candidate is a point or a polygon. Anything else is refused
// here rather than failing later inside a distance calculation (§25).
function normalizeCandidate(input, taken) {
  const feature = input && input.type === 'Feature' ? input
    : (Number.isFinite(input && input.lon) && Number.isFinite(input && input.lat)
      ? { type: 'Feature', geometry: { type: 'Point', coordinates: [input.lon, input.lat] }, properties: {} }
      : null);
  if (!feature) return { error: 'a candidate needs either a GeoJSON Feature or {lon, lat}' };
  const g = feature.geometry;
  if (!g || !CANDIDATE_GEOMETRIES.includes(g.type)) {
    return { error: `unsupported geometry: candidates are points or polygons (got ${g ? g.type : 'none'}) — FR-SITE-001` };
  }
  if (!Array.isArray(g.coordinates) || !g.coordinates.length) {
    return { error: 'invalid GeoJSON: geometry has no coordinates' };
  }
  const props = feature.properties || {};
  const requested = feature.id != null ? String(feature.id) : (props.candidateId ? String(props.candidateId) : null);
  const id = requested && !taken.has(requested) ? requested : nextCandidateId(taken);
  taken.add(id);
  return {
    feature: {
      type: 'Feature',
      id,
      geometry: g,
      properties: {
        label: props.label || props.name || id,
        name: props.name || null,
        category: 'candidate',
        source: props.source || 'user',
        sourceId: props.sourceId || null,
        score: null,
        metrics: {},
        fetchedAt: new Date().toISOString(),
        ...(props.tags ? { tags: props.tags } : {}),
      },
    },
  };
}

function walkCoords(coords, fn) {
  if (typeof coords[0] === 'number') return fn(coords);
  for (const c of coords) walkCoords(c, fn);
  return undefined;
}

function bboxOf(fc) {
  let w = Infinity; let s = Infinity; let e = -Infinity; let n = -Infinity;
  for (const f of fc.features || []) {
    if (!f.geometry || !f.geometry.coordinates) continue;
    walkCoords(f.geometry.coordinates, ([lon, lat]) => {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    });
  }
  return Number.isFinite(w) ? [w, s, e, n] : [];
}

// The state entry holds candidate *metadata* only — never the geometry, which
// stays behind `ref` per §12 rule 3.
function syncCandidateState(site, fc) {
  const count = fc.features.length;
  const prev = site.candidates || {};
  site.candidates = {
    ref: '/api/results/site-candidates',
    version: (prev.version || 0) + 1,
    count,
    bbox: bboxOf(fc),
    indexOmitted: count > CANDIDATE_INDEX_LIMIT,
    list: count > CANDIDATE_INDEX_LIMIT ? [] : fc.features.map((f) => ({
      id: String(f.id),
      label: (f.properties && f.properties.label) || String(f.id),
      geometryType: f.geometry.type,
    })),
  };
}

// A candidate change invalidates the previous ranking: leaving stale scores on
// screen beside a new candidate is worse than showing none.
function invalidateResults(site, reason) {
  if (site.results) site.results = { ...site.results, stale: true, staleReason: reason };
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
  return fs.createReadStream(abs).pipe(res);
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
    // has already decompressed. Forwarding it truncates the response — Overpass
    // gzips, so this silently cut every large result short. Measure instead.
    const buf = Buffer.from(await upstream.arrayBuffer());
    h['content-length'] = String(buf.length);
    res.writeHead(upstream.status, h);
    return res.end(buf);
  } catch (e) {
    return sendJson(res, 502, { error: 'upstream failure', detail: String(e) });
  }
}

// ---------- rule collections (FR-SITE-002 … FR-SITE-005) ----------

// One handler for constraints and criteria: they differ only in their validator
// and in whether a change re-derives the weight sum.
function ruleRoutes(kindName, listOf, validate) {
  return {
    async create(body) {
      return mutateState((state) => {
        const site = ensureSite(state);
        const list = listOf(site);
        const bad = validate(body, null);
        if (bad) return { error: bad };
        const complete = rules.completeRule(body, list, kindName);
        if (list.some((r) => r.id === complete.id)) return { error: `${kindName} "${complete.id}" already exists` };
        if (complete.kind === 'distance' && !registry.has(complete.featureClass) && !String(complete.featureClass).startsWith('upload_')) {
          return { error: `unknown feature class "${complete.featureClass}" — see geo/registry.js, or load a GeoJSON file to define one` };
        }
        list.push(complete);
        refreshWeights(site);
        invalidateResults(site, `${kindName} added`);
        return null;
      });
    },
    async patch(ref, patch) {
      return mutateState((state) => {
        const site = ensureSite(state);
        const list = listOf(site);
        const i = rules.indexOfRule(list, ref);
        if (i < 0) return { error: `no ${kindName} "${ref}"` };
        const bad = validate(patch, list[i]);
        if (bad) return { error: bad };
        Object.assign(list[i], patch);
        list[i].metric = rules.deriveMetric(list[i]);
        refreshWeights(site);
        invalidateResults(site, `${kindName} "${list[i].id}" changed`);
        return null;
      });
    },
    async remove(ref) {
      return mutateState((state) => {
        const site = ensureSite(state);
        const list = listOf(site);
        const i = rules.indexOfRule(list, ref);
        if (i < 0) return { error: `no ${kindName} "${ref}"` };
        list.splice(i, 1);
        refreshWeights(site);
        invalidateResults(site, `${kindName} removed`);
        return null;
      });
    },
  };
}

const constraintRoutes = ruleRoutes('constraint', (s) => s.constraints, rules.validateConstraint);
const criterionRoutes = ruleRoutes('criterion', (s) => s.criteria, rules.validateCriterion);

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
      return sendJson(res, 200, { stateVersion: writeState(next) });
    }
    if (p === '/api/version') {
      return sendJson(res, 200, { stateVersion: readState().stateVersion || 0 });
    }
    if (p === '/api/analysis' && req.method === 'GET') {
      return sendJson(res, 200, readState().analysis || null);
    }

    // ---- candidates (FR-SITE-001) ----
    if (p === '/api/analysis/candidates' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': MIME['.geojson'] });
      return res.end(JSON.stringify(readCandidates()));
    }
    if (p === '/api/analysis/candidates' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const fc = readCandidates();
      const taken = new Set(fc.features.map((f) => String(f.id)));
      const incoming = body && body.type === 'FeatureCollection' ? body.features : [body];
      if (!Array.isArray(incoming) || !incoming.length) {
        return sendJson(res, 400, { error: 'nothing to add' });
      }
      const added = [];
      const replace = url.searchParams.get('mode') === 'replace';
      const base = replace ? [] : fc.features;
      const takenIds = replace ? new Set() : taken;
      for (const item of incoming) {
        const out = normalizeCandidate(item, takenIds);
        if (out.error) return sendJson(res, 400, { error: out.error });
        added.push(out.feature);
      }
      const next = { type: 'FeatureCollection', features: [...base, ...added] };
      writeCandidates(next);
      const st = mutateState((state) => {
        const site = ensureSite(state);
        syncCandidateState(site, next);
        invalidateResults(site, 'candidates changed');
        return null;
      });
      return sendJson(res, 200, { ...st, added: added.map((f) => f.id), count: next.features.length });
    }
    if (p.startsWith('/api/analysis/candidates/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.slice('/api/analysis/candidates/'.length));
      const fc = readCandidates();
      const kept = fc.features.filter((f) => String(f.id) !== id);
      if (kept.length === fc.features.length) return sendJson(res, 404, { error: `no candidate "${id}"` });
      const next = { type: 'FeatureCollection', features: kept };
      writeCandidates(next);
      const st = mutateState((state) => {
        const site = ensureSite(state);
        syncCandidateState(site, next);
        invalidateResults(site, 'candidate removed');
        return null;
      });
      return sendJson(res, 200, { ...st, count: kept.length });
    }
    if (p === '/api/analysis/candidates' && req.method === 'DELETE') {
      const next = { type: 'FeatureCollection', features: [] };
      writeCandidates(next);
      const st = mutateState((state) => {
        const site = ensureSite(state);
        syncCandidateState(site, next);
        site.results = null;
        return null;
      });
      return sendJson(res, 200, { ...st, count: 0 });
    }

    // ---- soft criteria: the FR-SITE-005 auto-fix, checked before the id route ----
    if (p === '/api/analysis/criteria/normalize' && req.method === 'POST') {
      const out = mutateState((state) => {
        const site = ensureSite(state);
        if (!site.criteria.length) return { error: 'no criteria to normalize' };
        site.criteria = rules.normalizeWeights(site.criteria);
        refreshWeights(site);
        invalidateResults(site, 'weights normalized');
        return null;
      });
      if (out.error) return sendJson(res, 400, out);
      return sendJson(res, 200, out);
    }

    // ---- constraints (FR-SITE-002) and criteria (FR-SITE-003/004) ----
    for (const [prefix, routes] of [
      ['/api/analysis/constraints', constraintRoutes],
      ['/api/analysis/criteria', criterionRoutes],
    ]) {
      if (p !== prefix && !p.startsWith(`${prefix}/`)) continue;
      const ref = p === prefix ? null : decodeURIComponent(p.slice(prefix.length + 1));
      if (req.method === 'GET' && ref === null) {
        const site = ensureSite(readState());
        return sendJson(res, 200, prefix.endsWith('criteria') ? site.criteria : site.constraints);
      }
      let out;
      if (req.method === 'POST' && ref === null) out = await routes.create(JSON.parse(await readBody(req)));
      else if (req.method === 'PATCH' && ref !== null) out = await routes.patch(ref, JSON.parse(await readBody(req)));
      else if (req.method === 'DELETE' && ref !== null) out = await routes.remove(ref);
      else return sendJson(res, 405, { error: 'method not allowed' });
      if (out.error) return sendJson(res, /^no /.test(out.error) ? 404 : 400, out);
      return sendJson(res, 200, out);
    }

    // ---- the §18.4 result set (FR-SITE-008 … FR-SITE-010) ----
    if (p === '/api/analysis/results' && req.method === 'PUT') {
      const doc = JSON.parse(await readBody(req));
      if (!doc || !Array.isArray(doc.results)) {
        return sendJson(res, 400, { error: 'expected a result document with a results array' });
      }
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const file = path.join(RESULTS_DIR, 'site-results.json');
      fs.writeFileSync(file + '.tmp', JSON.stringify(doc));
      fs.renameSync(file + '.tmp', file);
      const out = mutateState((state) => {
        const site = ensureSite(state);
        const inline = doc.results.length <= RESULT_INLINE_LIMIT;
        site.results = {
          ref: '/api/analysis/results',
          version: ((site.results && site.results.version) || 0) + 1,
          generatedAt: doc.generatedAt,
          candidateCount: doc.candidateCount,
          eligibleCount: doc.eligibleCount,
          truncated: !!doc.truncated,
          warnings: doc.warnings || [],
          summary: doc.summary || null,
          stale: false,
          inline,
          // §12 rule 3 in spirit: a large result set is referenced, not inlined.
          ranked: inline ? doc.results : [],
          omittedReason: inline ? null
            : `${doc.results.length} candidates exceed the ${RESULT_INLINE_LIMIT}-candidate inline limit — read ${'/api/analysis/results'}`,
        };
        return null;
      });
      return sendJson(res, 200, out);
    }
    if (p === '/api/analysis/results' && req.method === 'GET') {
      const file = path.join(RESULTS_DIR, 'site-results.json');
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'no results yet — run the ranking' });
      res.writeHead(200, { 'content-type': MIME['.json'] });
      return fs.createReadStream(file).pipe(res);
    }

    // §28 / §24.4 — provenance for every external acquisition.
    if (p === '/api/provenance' && req.method === 'POST') {
      const record = JSON.parse(await readBody(req));
      const out = mutateState((s) => {
        if (!Array.isArray(s.provenance)) s.provenance = [];
        s.provenance.push({ timestamp: new Date().toISOString(), ...record });
        if (s.provenance.length > PROVENANCE_LIMIT) s.provenance = s.provenance.slice(-PROVENANCE_LIMIT);
        return null;
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
      return undefined;
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
      const id = p.slice('/api/results/'.length).replace(/[^a-zA-Z0-9_-]/g, '');
      const file = path.join(RESULTS_DIR, `${id}.geojson`);
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'no such result' });
      res.writeHead(200, { 'content-type': MIME['.geojson'] });
      return fs.createReadStream(file).pipe(res);
    }
    if (p.startsWith('/api/results/') && req.method === 'PUT') {
      const id = p.slice('/api/results/'.length).replace(/[^a-zA-Z0-9_-]/g, '');
      // Candidates are owned by the candidate endpoints, which keep the
      // collection and the state index in step; a raw PUT would desynchronize them.
      if (id === 'site-candidates') {
        return sendJson(res, 409, { error: 'use /api/analysis/candidates to change the candidate set' });
      }
      const geojson = JSON.parse(await readBody(req)); // validates JSON (§25: invalid GeoJSON is a visible error)
      if (geojson.type !== 'FeatureCollection') return sendJson(res, 400, { error: 'expected FeatureCollection' });
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const file = path.join(RESULTS_DIR, `${id}.geojson`);
      fs.writeFileSync(file + '.tmp', JSON.stringify(geojson));
      fs.renameSync(file + '.tmp', file);
      return sendJson(res, 200, { id, featureCount: (geojson.features || []).length });
    }
    if (p === '/api/proxy') {
      return handleProxy(req, res, url);
    }
    if (req.method === 'GET') return serveStatic(res, p);
    return sendJson(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return sendJson(res, 500, { error: 'internal', detail: String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`ana-geo-site → http://localhost:${PORT}  (state: ${path.basename(STATE_FILE)})`);
});
