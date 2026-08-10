#!/usr/bin/env node
// fakechat 인바운드 브리지 — 대시보드 채팅 → fakechat 채널(:8787) → Claude 세션.
// PRD §8.3의 인바운드 릴레이를 fakechat 채널로 배달하는 변형이다. relay.js(stdout 배달)
// 대신 이걸 쓰면, fakechat 채널을 물고 기동한 별도 Claude Code 세션이 두뇌가 된다.
// 응답은 언제나 두뇌가 직접 POST /api/agent 로 보낸다(§8.3 — 채널은 인바운드 전용).
//
// 실행:  node fakechat-bridge.js
// 환경변수: DASH_URL(기본 http://127.0.0.1:8802), FAKECHAT_WS(기본 ws://127.0.0.1:8787/ws),
//          TAG(채널 접두 라벨, 기본 "ana-geo-explorer")
// 요구: Node >= 22 (전역 WebSocket). Node 20이면 relay.js를 쓰거나 22로 올릴 것.

const DASH = process.env.DASH_URL || 'http://127.0.0.1:8802';
const FC_WS = process.env.FAKECHAT_WS || 'ws://127.0.0.1:8787/ws';
const TAG = process.env.TAG || 'ana-geo-explorer';

// 이 앱의 /api/inbox-wait 는 소비형(드레인)이다 — 가져온 메시지는 서버에 남지 않으므로,
// fakechat WS가 끊긴 동안 도착한 메시지는 여기 큐에 보관했다가 재접속 후 배달한다.
const pending = [];
let ws = null;
let wsReady = false;

const log = (...a) => console.log('[bridge]', ...a);

function connectWS() {
  try { ws = new WebSocket(FC_WS); }
  catch (e) { log('ws 생성 실패, 2s 후 재시도:', e.message); return setTimeout(connectWS, 2000); }
  ws.addEventListener('open', () => { wsReady = true; log('fakechat 연결됨:', FC_WS); flush(); });
  ws.addEventListener('close', () => { wsReady = false; log('fakechat 끊김, 2s 후 재접속'); setTimeout(connectWS, 2000); });
  ws.addEventListener('error', () => {}); // close가 뒤따른다
}

function flush() {
  while (wsReady && pending.length) {
    const m = pending.shift();
    ws.send(JSON.stringify({ id: `dash-${m.id}`, text: `[${TAG} #${m.id}] ${m.text}` }));
    log('→ fakechat', m.id, ':', m.text);
  }
}

async function inboxLoop() {
  for (;;) {
    try {
      const r = await fetch(`${DASH}/api/inbox-wait`, { signal: AbortSignal.timeout(30000) });
      const { messages } = await r.json();
      for (const m of messages || []) pending.push(m);
      flush();
    } catch {
      await new Promise((res) => setTimeout(res, 1500)); // 서버 미기동/타임아웃 — 재시도
    }
  }
}

log(`dashboard: ${DASH}  →  channel: ${FC_WS}`);
connectWS();
inboxLoop();
