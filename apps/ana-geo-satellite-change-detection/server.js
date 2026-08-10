#!/usr/bin/env node
// ana-geo-satellite-change-detection server — ANA Geo shared runtime contracts
// (PRD §8.2–8.5). Node >= 20 (global fetch), zero npm dependencies.
// Self-contained per PRD §9: nothing is imported from another app.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { runWorker, DEFAULT_TIMEOUT_MS } = require('./tools/worker.js');

const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'state.json');
const RESULTS_DIR = path.join(ROOT, 'data', 'results');
const PROVENANCE_LOG = path.join(ROOT, 'data', 'provenance.log');
const PORT = Number(process.env.PORT || 8807);

// §8.4 — per-app external host allowlist. Two hosts, two roles:
//   earth-search…            STAC catalog search (FR-CD-012)
//   sentinel-cogs.s3…        the COG assets those items point at; this is the
//                            host in every `red`/`nir` href of sentinel-2-l2a.
// The browser never calls either directly, and the Python worker's /vsicurl/
// range reads are checked against the same list before it is even spawned.
const ALLOWED_HOSTS = ['earth-search.aws.element84.com', 'sentinel-cogs.s3.us-west-2.amazonaws.com'];
const USER_AGENT = 'ana-geo-satellite-change-detection/0.1 (ANA Geo; https://github.com/tykimos/ana-geo)';

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

// §28 — provenance for every external operation, best effort.
function recordProvenance(record) {
  try {
    fs.mkdirSync(path.dirname(PROVENANCE_LOG), { recursive: true });
    fs.appendFileSync(PROVENANCE_LOG, JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n');
  } catch { /* provenance is never allowed to fail a request */ }
}

// §8.4 — allowlist proxy; forwards Range and passes 206 through unchanged.
// STAC search is a POST of a JSON body, so method, content-type and body are
// forwarded. Range matters here beyond good citizenship: the worker's COG
// window reads are HTTP range requests, and a proxy that dropped them would
// turn every partial read into a full-band download (§26.2).
async function handleProxy(req, res, url) {
  const target = url.searchParams.get('url');
  let parsed;
  try { parsed = new URL(target); } catch { return sendJson(res, 400, { error: 'bad url' }); }
  if (parsed.protocol !== 'https:') return sendJson(res, 400, { error: 'https required' });
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return sendJson(res, 403, { error: `host not allowlisted: ${parsed.hostname}` });
  }
  const isPost = req.method === 'POST';
  const headers = { 'user-agent': USER_AGENT };
  if (req.headers.range) headers.range = req.headers.range;
  if (isPost) headers['content-type'] = req.headers['content-type'] || 'application/json';
  try {
    const body = isPost ? await readBody(req) : undefined;
    const upstream = await fetch(parsed, { method: isPost ? 'POST' : 'GET', headers, body });
    const h = { 'content-type': upstream.headers.get('content-type') || 'application/octet-stream' };
    // content-range / accept-ranges are forwarded so 206 partial reads survive
    // (§8.4). content-length is NOT: fetch transparently decompresses gzip, so
    // the upstream value describes the compressed body and would truncate ours.
    for (const k of ['content-range', 'accept-ranges']) {
      const v = upstream.headers.get(k);
      if (v) h[k] = v;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    h['content-length'] = String(buf.length);
    recordProvenance({ operation: 'proxy', source: parsed.hostname, url: parsed.pathname, status: upstream.status, bytes: buf.length });
    res.writeHead(upstream.status, h);
    res.end(buf);
  } catch (e) {
    sendJson(res, 502, { error: 'upstream failure', detail: String(e) });
  }
}

// ---------- change detection (§8.5, FR-CD-003…011) ----------

// The worker opens whatever href it is handed, so the allowlist is enforced
// here too — before the process is spawned, not after (§27.1, §27.2).
function checkAssetHosts(scene, label) {
  const assets = (scene && scene.assets) || {};
  for (const band of ['red', 'nir']) {
    const entry = assets[band];
    const href = typeof entry === 'string' ? entry : entry && entry.href;
    if (!href) return `${label} scene has no '${band}' asset`;
    let u;
    try { u = new URL(href); } catch { return `${label} '${band}' asset href is not a URL`; }
    if (u.protocol !== 'https:') return `${label} '${band}' asset must be https, got ${u.protocol}`;
    if (!ALLOWED_HOSTS.includes(u.hostname)) return `${label} '${band}' asset host not allowlisted: ${u.hostname}`;
  }
  return null;
}

async function handleChangeDetect(req, res) {
  const params = JSON.parse(await readBody(req));
  for (const [scene, label] of [[params.beforeItem, 'before'], [params.afterItem, 'after']]) {
    if (!scene) return sendJson(res, 400, { ok: false, result: null, error: { code: 'invalid_params', message: `${label} scene is required` } });
    const problem = checkAssetHosts(scene, label);
    if (problem) {
      return sendJson(res, 403, { ok: false, result: null, error: { code: 'raster_asset_unavailable', message: problem } });
    }
  }
  // allowLocal is never accepted from the network: only the offline synthetic
  // test may point the worker at local files.
  delete params.allowLocal;

  const startedAt = Date.now();
  const envelope = await runWorker('change_detect', params, { timeoutMs: DEFAULT_TIMEOUT_MS });
  recordProvenance({
    operation: 'change-detection',
    beforeScene: params.beforeItem && params.beforeItem.id,
    afterScene: params.afterItem && params.afterItem.id,
    method: 'ndvi-difference',
    threshold: params.threshold,
    direction: params.direction,
    ok: envelope.ok,
    errorCode: envelope.error && envelope.error.code,
    elapsedMs: Date.now() - startedAt,
  });
  // The envelope carries success/failure; HTTP 200 means "the worker answered".
  return sendJson(res, 200, { ...envelope, elapsedMs: Date.now() - startedAt });
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
    if (p === '/api/analysis/change-detect' && req.method === 'POST') {
      return handleChangeDetect(req, res);
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
  console.log(`ana-geo-satellite-change-detection → http://localhost:${PORT}  (state: ${path.basename(STATE_FILE)})`);
});
