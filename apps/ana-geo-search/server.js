#!/usr/bin/env node
// ana-geo-search server — ANA Geo shared runtime contracts (PRD §8.2–8.5)
// plus the condition-model API (§17.4, FR-SEARCH-010).
// Node >= 20 (global fetch), zero npm dependencies.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'state.json');
const RESULTS_DIR = path.join(ROOT, 'data', 'results');
const PORT = Number(process.env.PORT || 8803);

// §8.4 — per-app external host allowlist. ana-geo-search acquires features
// from Overpass only; everything else is refused at this single point.
const ALLOWED_HOSTS = ['overpass-api.de'];

const PROVENANCE_LIMIT = 50; // §28 — keep the state file small (§12)

// Node's fetch sends no User-Agent, and Overpass answers such requests with
// HTTP 406. Identifying the client is also what the OSM usage policy asks for.
const USER_AGENT = 'ana-geo-search/0.1.0 (ANA Geo; +https://github.com/tykimos/agent-native-agent)';

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

// Read-modify-write for the incremental edits of §24.2 / FR-SEARCH-010: the
// caller touches one field and the rest of the file is left untouched.
function mutateState(fn) {
  const state = readState();
  const out = fn(state);
  if (out && out.error) return out;
  return { stateVersion: writeState(state), analysis: state.analysis };
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
    // has already decompressed. Forwarding it truncates the response — Overpass
    // gzips, so this silently cut every large result short. Measure instead.
    const buf = Buffer.from(await upstream.arrayBuffer());
    h['content-length'] = String(buf.length);
    res.writeHead(upstream.status, h);
    res.end(buf);
  } catch (e) {
    sendJson(res, 502, { error: 'upstream failure', detail: String(e) });
  }
}

// ---------- condition model (§17.4) ----------

const RELATIONS = ['within', 'within_distance', 'outside_distance', 'nearest'];
const UNITS = ['m', 'km'];
const CONDITION_FIELDS = ['relation', 'reference', 'distance', 'unit', 'count'];

function validateConditionPatch(patch) {
  for (const k of Object.keys(patch)) {
    if (!CONDITION_FIELDS.includes(k)) return `unknown condition field: ${k}`;
  }
  if (patch.relation !== undefined && !RELATIONS.includes(patch.relation)) {
    return `invalid spatial condition: unknown relation "${patch.relation}"`;
  }
  if (patch.unit !== undefined && !UNITS.includes(patch.unit)) {
    return `invalid spatial condition: unit must be one of ${UNITS.join(', ')}`;
  }
  if (patch.distance !== undefined && (typeof patch.distance !== 'number' || !(patch.distance >= 0))) {
    return 'invalid spatial condition: distance must be a non-negative number';
  }
  if (patch.reference !== undefined && (typeof patch.reference !== 'string' || !patch.reference)) {
    return 'invalid spatial condition: reference must be a non-empty key';
  }
  return null;
}

function ensureAnalysis(state) {
  if (!state.analysis) state.analysis = { target: null, operator: 'AND', conditions: [] };
  if (!Array.isArray(state.analysis.conditions)) state.analysis.conditions = [];
  return state.analysis;
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

    // FR-SEARCH-010 — edit the query without rewriting it.
    // PATCH /api/analysis                  → target / operator
    // PATCH /api/analysis/conditions/<i>   → one field of one condition
    // POST  /api/analysis/conditions       → append a condition
    // DELETE /api/analysis/conditions/<i>  → drop a condition
    if (p === '/api/analysis' && req.method === 'GET') {
      return sendJson(res, 200, readState().analysis || null);
    }
    if (p === '/api/analysis' && req.method === 'PATCH') {
      const patch = JSON.parse(await readBody(req));
      for (const k of Object.keys(patch)) {
        if (!['target', 'operator', 'conditions'].includes(k)) {
          return sendJson(res, 400, { error: `unknown analysis field: ${k}` });
        }
      }
      if (patch.operator !== undefined && !['AND', 'OR'].includes(patch.operator)) {
        return sendJson(res, 400, { error: 'operator must be "AND" or "OR"' });
      }
      const out = mutateState((s) => { Object.assign(ensureAnalysis(s), patch); });
      return sendJson(res, 200, out);
    }
    if (p.startsWith('/api/analysis/conditions')) {
      const rest = p.slice('/api/analysis/conditions'.length);
      const idx = rest.startsWith('/') ? Number(rest.slice(1)) : null;

      if (req.method === 'POST' && idx === null) {
        const cond = JSON.parse(await readBody(req));
        const bad = validateConditionPatch(cond);
        if (bad) return sendJson(res, 400, { error: bad });
        if (!cond.relation || !cond.reference) {
          return sendJson(res, 400, { error: 'a condition needs at least relation and reference' });
        }
        const out = mutateState((s) => { ensureAnalysis(s).conditions.push(cond); });
        return sendJson(res, 200, out);
      }
      if (req.method === 'PATCH' && Number.isInteger(idx)) {
        const patch = JSON.parse(await readBody(req));
        const bad = validateConditionPatch(patch);
        if (bad) return sendJson(res, 400, { error: bad });
        const out = mutateState((s) => {
          const conds = ensureAnalysis(s).conditions;
          if (!conds[idx]) return { error: `no condition at index ${idx}` };
          Object.assign(conds[idx], patch);
        });
        if (out.error) return sendJson(res, 404, out);
        return sendJson(res, 200, out);
      }
      if (req.method === 'DELETE' && Number.isInteger(idx)) {
        const out = mutateState((s) => {
          const conds = ensureAnalysis(s).conditions;
          if (!conds[idx]) return { error: `no condition at index ${idx}` };
          conds.splice(idx, 1);
        });
        if (out.error) return sendJson(res, 404, out);
        return sendJson(res, 200, out);
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // §28 / §24.4 — provenance for every external acquisition.
    if (p === '/api/provenance' && req.method === 'POST') {
      const record = JSON.parse(await readBody(req));
      const out = mutateState((s) => {
        if (!Array.isArray(s.provenance)) s.provenance = [];
        s.provenance.push({ timestamp: new Date().toISOString(), ...record });
        if (s.provenance.length > PROVENANCE_LIMIT) {
          s.provenance = s.provenance.slice(-PROVENANCE_LIMIT);
        }
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
      const id = p.slice('/api/results/'.length).replace(/[^a-zA-Z0-9_-]/g, '');
      const file = path.join(RESULTS_DIR, `${id}.geojson`);
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'no such result' });
      res.writeHead(200, { 'content-type': MIME['.geojson'] });
      return fs.createReadStream(file).pipe(res);
    }
    if (p.startsWith('/api/results/') && req.method === 'PUT') {
      const id = p.slice('/api/results/'.length).replace(/[^a-zA-Z0-9_-]/g, '');
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
    sendJson(res, 500, { error: 'internal', detail: String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`ana-geo-search → http://localhost:${PORT}  (state: ${path.basename(STATE_FILE)})`);
});
