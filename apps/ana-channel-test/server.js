#!/usr/bin/env node
// ana-channel-test server — 채널 왕복 진단 전용 앱 (PRD §8.2–8.3 계약 + 진단 API).
// Node >= 20, npm 의존성 0.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'state.json');
const PORT = Number(process.env.PORT || 8808);
const FAKECHAT_PORT = Number(process.env.FAKECHAT_PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// ---------- state (§8.2) ----------
function readState() { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
function writeState(next) {
  const cur = readState();
  next.stateVersion = (cur.stateVersion || 0) + 1;
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, STATE_FILE);
  return next.stateVersion;
}

// ---------- converse (§8.3) + 진단 계측 ----------
const inbox = [];
const inboxWaiters = [];
const feed = [];
let feedSeq = 0;
const diag = { lastWaitAt: 0, lastDrainAt: 0, lastChatAt: 0, lastAgentAt: 0 };

function pushInbox(msg) {
  inbox.push(msg);
  while (inboxWaiters.length) drainInboxTo(inboxWaiters.shift());
}
function drainInboxTo(res) {
  diag.lastDrainAt = Date.now();
  const batch = inbox.splice(0, inbox.length);
  sendJson(res, 200, { messages: batch });
}

// ---------- helpers ----------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.normalize(path.join(ROOT, rel));
  if (!abs.startsWith(ROOT + path.sep) && abs !== path.join(ROOT, 'index.html')) return sendJson(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return sendJson(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
}
const exec = (cmd, args) => new Promise((r) => execFile(cmd, args, { timeout: 3000 }, (e, out) => r(e ? '' : out.trim())));

// ---------- 진단: fakechat(:8787) 상태 + 고아 판별 ----------
async function fakechatStatus() {
  let listening = false;
  try {
    const r = await fetch(`http://127.0.0.1:${FAKECHAT_PORT}/`, { signal: AbortSignal.timeout(800) });
    listening = r.status < 500;
  } catch { }
  let orphan = null, pid = null, ppid = null;
  const pids = (await exec('lsof', ['-ti', `:${FAKECHAT_PORT}`, '-sTCP:LISTEN'])).split('\n').filter(Boolean);
  if (pids.length) {
    pid = pids[0];
    ppid = (await exec('ps', ['-o', 'ppid=', '-p', pid])).trim();
    orphan = ppid === '1'; // 부모가 launchd = 이전 세션이 남긴 고아
  }
  return { listening, pid, ppid, orphan };
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    if (p === '/api/state' && req.method === 'GET') return sendJson(res, 200, readState());
    if (p === '/api/state' && req.method === 'PUT') {
      const v = writeState(JSON.parse(await readBody(req)));
      return sendJson(res, 200, { stateVersion: v });
    }
    if (p === '/api/version') return sendJson(res, 200, { stateVersion: readState().stateVersion || 0 });

    if (p === '/api/chat' && req.method === 'POST') {
      const { text } = JSON.parse(await readBody(req));
      if (!text) return sendJson(res, 400, { error: 'text required' });
      diag.lastChatAt = Date.now();
      const msg = { id: `m-${Date.now()}-${inbox.length}`, text, at: new Date().toISOString() };
      pushInbox(msg);
      feed.push({ seq: ++feedSeq, role: 'user', text, at: msg.at });
      return sendJson(res, 200, { id: msg.id });
    }
    if (p === '/api/inbox-wait' && req.method === 'GET') {
      diag.lastWaitAt = Date.now();
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
      diag.lastAgentAt = Date.now();
      feed.push({ seq: ++feedSeq, role: 'agent', at: new Date().toISOString(), ...body });
      return sendJson(res, 200, { seq: feedSeq });
    }
    if (p === '/api/feed') {
      const since = Number(url.searchParams.get('since') || 0);
      return sendJson(res, 200, { stateVersion: readState().stateVersion || 0, items: feed.filter((f) => f.seq > since) });
    }

    if (p === '/api/health') {
      const now = Date.now();
      // 브리지 활성 = 최근 35초 안에 inbox-wait 롱폴이 있었다 (25초 창 + 여유)
      const bridgeActive = diag.lastWaitAt > 0 && now - diag.lastWaitAt < 35000;
      return sendJson(res, 200, {
        server: true,
        stateVersion: readState().stateVersion || 0,
        bridge: { active: bridgeActive, waitingNow: inboxWaiters.length > 0, lastWaitAgoMs: diag.lastWaitAt ? now - diag.lastWaitAt : null },
        fakechat: await fakechatStatus(),
        brain: { lastAgentAgoMs: diag.lastAgentAt ? now - diag.lastAgentAt : null },
        pendingInbox: inbox.length,
      });
    }

    if (req.method === 'GET') return serveStatic(res, p);
    return sendJson(res, 405, { error: 'method not allowed' });
  } catch (e) {
    sendJson(res, 500, { error: 'internal', detail: String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`ana-channel-test → http://localhost:${PORT}`);
});
