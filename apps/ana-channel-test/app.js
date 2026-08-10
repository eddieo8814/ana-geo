// ana-channel-test client — 신호등 진단 + 핑 왕복 + 채팅.

let feedSince = 0;
let pingPending = null; // { id, sentAt, timer }

const $ = (id) => document.getElementById(id);

function setLight(id, cls, why) {
  const el = $(id);
  el.className = `light ${cls}`;
  el.querySelector('.why').textContent = why;
}

// ---------- 신호등 ----------
async function health() {
  let h;
  try {
    const r = await fetch('/api/health', { signal: AbortSignal.timeout(2000) });
    h = await r.json();
  } catch {
    setLight('L1', 'bad', '서버 응답 없음 — node server.js 실행 확인');
    setLight('L2', '', '서버 먼저'); setLight('L3', '', '서버 먼저'); setLight('L4', '', '서버 먼저');
    return;
  }
  setLight('L1', 'ok', `정상 (stateVersion ${h.stateVersion})`);

  if (h.bridge.active) setLight('L2', 'ok', h.bridge.waitingNow ? '연결됨 — 롱폴 대기 중' : '연결됨 (직전 폴 ' + Math.round(h.bridge.lastWaitAgoMs / 1000) + 's 전)');
  else setLight('L2', 'bad', '롱폴 없음 — node fakechat-bridge.js 실행 필요');

  const fc = h.fakechat;
  if (fc.listening && fc.orphan === false) setLight('L3', 'ok', `리스닝 중 (pid ${fc.pid}, 세션 자식)`);
  else if (fc.listening && fc.orphan === true) setLight('L3', 'warn', `고아 의심 pid ${fc.pid} (부모 launchd) — 핑이 성공하면 유지, 실패하면 kill 후 ./brain.sh`);
  else if (fc.listening) setLight('L3', 'ok', '리스닝 중');
  else setLight('L3', 'bad', '없음 — ./brain.sh 로 세션을 채널과 함께 기동');

  if (h.brain.lastAgentAgoMs === null) setLight('L4', 'warn', '이 서버로 응답이 온 적 없음 — 핑 테스트로 확인');
  else if (h.brain.lastAgentAgoMs < 5 * 60 * 1000) setLight('L4', 'ok', `최근 응답 ${Math.round(h.brain.lastAgentAgoMs / 1000)}s 전`);
  else setLight('L4', 'warn', `마지막 응답 ${Math.round(h.brain.lastAgentAgoMs / 60000)}분 전`);
}

// ---------- 피드 ----------
function renderItem(it) {
  const div = document.createElement('div');
  div.className = it.kind === 'activity' ? 'msg activity' : `msg ${it.role}`;
  div.textContent = it.text || '';
  $('feed').appendChild(div);
  $('feed').scrollTop = $('feed').scrollHeight;
}

async function poll() {
  try {
    const r = await fetch(`/api/feed?since=${feedSince}`);
    const { items } = await r.json();
    for (const it of items) {
      renderItem(it);
      feedSince = it.seq;
      if (pingPending && it.role === 'agent' && (it.text || '').includes(pingPending.id)) resolvePing(it);
    }
  } catch { }
}

// ---------- 핑 ----------
function resolvePing(item) {
  const ms = Date.now() - pingPending.sentAt;
  clearTimeout(pingPending.timer);
  pingPending = null;
  $('pingresult').innerHTML = `<span class="ok-t">✅ 왕복 성공 — ${(ms / 1000).toFixed(1)}초</span> (페이지 → 서버 → 브리지 → fakechat → 세션 → /api/agent → 페이지)`;
}

async function ping() {
  if (pingPending) return;
  const id = `ping-${Date.now().toString(36)}`;
  $('pingresult').innerHTML = `⏳ <b>${id}</b> 발사 — 두뇌 세션의 [pong ${id}] 응답 대기 중… (최대 90초)`;
  pingPending = {
    id, sentAt: Date.now(),
    timer: setTimeout(() => {
      pingPending = null;
      $('pingresult').innerHTML = '<span class="bad-t">❌ 90초 내 응답 없음</span> — 신호등 2·3 확인 후, 트러블슈팅 "신호등 4가 빨강" 절의 이분 탐색을 해보세요.';
    }, 90000),
  };
  const r = await fetch('/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: `[${id}] 채널 왕복 테스트입니다. 정확히 "[pong ${id}]"를 포함한 응답을 POST /api/agent 로 보내주세요.` }),
  });
  if (!r.ok) {
    clearTimeout(pingPending.timer); pingPending = null;
    $('pingresult').innerHTML = '<span class="bad-t">❌ /api/chat 실패 — 서버(신호등 1) 확인</span>';
  }
}

async function selfEcho() {
  const t = `셀프 에코 ${new Date().toLocaleTimeString()}`;
  const r = await fetch('/api/agent', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: `🔁 ${t} — 서버와 피드 표시는 정상입니다. (세션을 거치지 않은 메시지)` }),
  });
  $('pingresult').innerHTML = r.ok
    ? '<span class="ok-t">✅ 셀프 에코 성공</span> — 서버·피드 렌더링은 정상. 왕복이 안 되면 원인은 브리지/fakechat/세션 쪽입니다.'
    : '<span class="bad-t">❌ 셀프 에코 실패 — 서버(신호등 1) 확인</span>';
}

// ---------- 채팅 ----------
async function send() {
  const text = $('chatinput').value.trim();
  if (!text) return;
  $('chatinput').value = '';
  await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
}

// ---------- boot ----------
$('btn-ping').addEventListener('click', ping);
$('btn-echo').addEventListener('click', selfEcho);
$('btn-send').addEventListener('click', send);
// IME(한글 등) 조합 중 Enter는 keydown이 두 번 발화한다(조합 중 1회 + 종료 후 1회).
// isComposing/keyCode 229를 거르지 않으면 "안녕" 입력 시 "안녕"과 "녕"이 따로 전송된다.
$('chatinput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) send();
});
health(); poll();
setInterval(health, 2500);
setInterval(poll, 1500);
