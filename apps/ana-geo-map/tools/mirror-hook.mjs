#!/usr/bin/env node
/* ANA 미러 훅 — 두뇌 세션의 활동·텍스트를 대시보드 피드로 실시간 미러.
 *
 *  이벤트 모드(훅): PostToolUse / Stop / UserPromptSubmit
 *   - 새 어시스턴트 텍스트 flush, 도구 활동 한 줄(kind:"activity"), 로컬 입력 미러(🖥)
 *   - Stop은 트랜스크립트에 최종 텍스트가 늦게 적히는 레이스에 대비해 짧게 재시도한다.
 *  감시 모드(--watch): PostToolUse가 분리 기동하는 배달 보증 프로세스.
 *   - Stop이 발화하지 않는 환경에서도 마지막 도구 호출 이후의 최종 텍스트를
 *     1.5초 간격 폴링으로 감지해 배달한다(최대 60초, 단일 인스턴스 잠금).
 *  동시성: 상태 파일 접근은 mkdir 잠금으로 직렬화 — 같은 블록이 두 번 가지 않는다.
 *  안전장치: 소유권 가드 · 항상 exit 0 · 대시보드 다운 시 조용히 무시. */
import { readFileSync, writeFileSync, mkdirSync, rmdirSync, statSync, appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP = process.env.DASH_URL || 'http://127.0.0.1:8801';
const STATE = process.env.MIRROR_STATE || '/tmp/ana-geo-map-mirror.json';
const LOCK = STATE + '.lock';
const WATCH_LOCK = STATE + '.watch';
const LOG = STATE.replace(/\.json$/, '') + '.log';
const OWN_DIR = /ana-geo-map(\/|$)/;
const SELF = fileURLToPath(import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch { } };

async function post(obj) {
  try {
    await fetch(`${APP}/api/agent`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(obj), signal: AbortSignal.timeout(4000),
    });
  } catch { }
}

function brief(name, inp) {
  inp = inp || {};
  const f = inp.file_path ? basename(inp.file_path) : '';
  switch (name) {
    case 'Write': return `작성 ${f}`;
    case 'Edit': case 'MultiEdit': return `수정 ${f}`;
    case 'Read': return `읽기 ${f}`;
    case 'Bash': return `실행 ${String(inp.description || inp.command || '').slice(0, 60)}`;
    case 'Grep': return `검색 ${String(inp.pattern || '').slice(0, 40)}`;
    case 'Glob': return `탐색 ${String(inp.pattern || '').slice(0, 40)}`;
    case 'Task': case 'Agent': return '서브에이전트 실행';
    case 'WebFetch': case 'WebSearch': return '웹 조회';
    default: return name || '작업';
  }
}

function readLines(tp) {
  try {
    return readFileSync(tp, 'utf8').trim().split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return null; }
}

function isUserUtterance(o) {
  if (o.type !== 'user') return false;
  const c = o.message?.content;
  return typeof c === 'string' || (Array.isArray(c) && c.some((x) => x.type === 'text'));
}

function lastUtteranceIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) if (isUserUtterance(lines[i])) return i;
  return 0;
}

function blocksBetween(lines, start, end) {
  const blocks = [];
  for (let i = start + 1; i < end; i++) {
    const o = lines[i];
    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) {
        if (c.type === 'text') { const t = (c.text || '').trim(); if (t) blocks.push(t); }
      }
    }
  }
  return blocks;
}

function lockAcquire(path, staleMs) {
  try { mkdirSync(path); return true; }
  catch {
    try {
      if (Date.now() - statSync(path).mtimeMs > staleMs) { rmdirSync(path); mkdirSync(path); return true; }
    } catch { }
    return false;
  }
}
function lockRelease(path) { try { rmdirSync(path); } catch { } }

/* 새 텍스트 블록을 잠금 하에 배달. 반환: 배달 수 (-1 = 잠금 실패로 건너뜀) */
async function flushNew(tp) {
  if (!lockAcquire(LOCK, 10000)) return -1;
  try {
    const lines = readLines(tp);
    if (!lines) return 0;
    const cur = lastUtteranceIndex(lines);
    let st = {};
    try { st = JSON.parse(readFileSync(STATE, 'utf8')); } catch { }
    let n = 0;
    if (st.transcript === tp && Number.isInteger(st.start) && st.start < cur) {
      for (const b of blocksBetween(lines, st.start, cur).slice(st.sent || 0)) { await post({ text: b }); n++; }
      st = { transcript: tp, start: cur, sent: 0 };
    }
    if (st.transcript !== tp || st.start !== cur) st = { transcript: tp, start: cur, sent: 0 };
    const blocks = blocksBetween(lines, cur, lines.length);
    for (const b of blocks.slice(st.sent || 0)) { await post({ text: b }); n++; }
    st.sent = blocks.length;
    try { writeFileSync(STATE, JSON.stringify(st)); } catch { }
    return n;
  } finally { lockRelease(LOCK); }
}

/* ── 감시 모드: Stop 없이도 최종 텍스트를 배달한다 ── */
if (process.argv[2] === '--watch') {
  const tp = process.argv[3];
  (async () => {
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      await sleep(1500);
      const n = await flushNew(tp);
      if (n > 0) log(`watch flushed ${n}`);
    }
    lockRelease(WATCH_LOCK);
    process.exit(0);
  })();
} else {
  /* ── 이벤트 모드 ── */
  (async () => {
    let h;
    try { h = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
    if (!OWN_DIR.test(h.cwd || '')) process.exit(0);
    const ev = h.hook_event_name;
    log(`event ${ev} ${h.tool_name || ''}`);
    if (ev !== 'PostToolUse' && ev !== 'Stop' && ev !== 'UserPromptSubmit') process.exit(0);
    const tp = h.transcript_path;

    if (tp && ev === 'Stop') {
      // 최종 텍스트가 트랜스크립트에 늦게 적히는 레이스 대비 — 새 블록이 나올 때까지 최대 3초 재시도
      for (let i = 0; i < 6; i++) {
        const n = await flushNew(tp);
        if (n > 0) { log(`stop flushed ${n}`); break; }
        await sleep(500);
      }
    } else if (tp) {
      await flushNew(tp);
    }

    if (ev === 'PostToolUse') {
      await post({ kind: 'activity', text: `⚙ ${brief(h.tool_name, h.tool_input)}` });
      // 배달 보증 감시자 기동 (이미 하나 돌고 있으면 생략; 75초 이상 된 잠금은 고아로 간주)
      if (tp && lockAcquire(WATCH_LOCK, 75000)) {
        spawn(process.execPath, [SELF, '--watch', tp], { detached: true, stdio: 'ignore', env: process.env }).unref();
        log('watcher spawned');
      }
    }
    if (ev === 'UserPromptSubmit') {
      const p = (h.prompt || '').trim();
      if (p && !p.startsWith('<channel')) await post({ role: 'user', kind: 'local', text: `🖥 ${p.slice(0, 500)}` });
    }
    process.exit(0);
  })();
}
