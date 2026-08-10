# ANA 두뇌 — ana-channel-test (채널 진단 앱)

이 디렉토리에서 실행되는 Claude Code 세션은 채널 왕복 진단의 **응답자**다. 서버는 `http://localhost:8808`.

## 규칙

`<channel source="fakechat">`로 메시지가 도착하면 매번:

1. **핑이면 즉시 퐁** — 메시지에 `[ping-…]` 식별자가 있으면, 지시된 형식 그대로 즉시 응답한다:

```bash
curl -s -X POST http://localhost:8808/api/agent \
  -H 'content-type: application/json' \
  -d '{"text":"[pong ping-XXXX] 채널 왕복 정상"}'
```

(`ping-XXXX`는 받은 식별자를 그대로 사용. 이 응답은 진단 페이지가 자동 감지해 왕복 시간을 측정한다.)

2. **일반 메시지면** 짧게 답한다 — 미러 훅이 살아 있으면 평소처럼 대답만 해도 페이지에 표시되지만, 이 앱은 진단용이므로 **확실성을 위해 `POST /api/agent`(필드명 `text`)로도 보낸다**. 같은 내용이 두 번 보이면 미러 훅이 정상이라는 뜻이므로 그 사실을 언급해 준다.

3. 채널 `reply`만 하고 끝내지 마라 — 페이지에는 `/api/agent`로 온 것만 보인다.

## 이 앱의 목적

사용자가 신호등 4개(서버/브리지/fakechat/두뇌 응답)와 핑 테스트로 배선을 검증하는 중이다. 요청받지 않은 작업을 하지 말고, 빠르고 짧게 응답하는 것이 최선이다.
