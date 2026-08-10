# ana-channel-test

대시보드 ↔ 브리지 ↔ fakechat ↔ Claude Code 세션의 **채팅 왕복을 단계별로 진단**하는 유틸리티 앱. ANA Geo 7개 앱의 Converse 배선(§8.3)과 동일한 계약을 쓰므로, 여기서 왕복이 되면 다른 앱에서도 된다.

상세 가이드와 트러블슈팅은 **페이지 자체에 있다** → `http://localhost:8808`

## Run

```bash
node server.js            # ① 진단 페이지 + 채팅 브리지   → http://localhost:8808
./brain.sh                # ② 두뇌 세션 (고아 정리 + claude --channels ...)  — 별도 터미널
node fakechat-bridge.js   # ③ 인박스 → fakechat WS 브리지                  — 별도 터미널
```

Node >= 20 (브리지는 전역 WebSocket 때문에 22 권장), npm 의존성 0.

## 무엇을 진단하나

- **신호등 4개** (2.5초 갱신): 앱 서버 / 브리지 롱폴 / fakechat 리스너(+**고아 프로세스 자동 감지**) / 두뇌 응답 최근성
- **🏓 핑 테스트**: 전 구간 왕복을 실측 — 세션이 `[pong …]`으로 응답하면 왕복 시간 표시 (응답 규칙은 이 디렉토리 `CLAUDE.md`가 세션에 자동 전달)
- **🔁 셀프 에코**: 세션 없이 서버·피드 렌더링만 분리 검증 (이분 탐색용)

## 참고

- 이 앱은 PRD의 7개 GIS 앱 패밀리에 속하지 않는 진단 도구다 (SPEC.md 없음).
- 미러 훅(`.claude/settings.json` + `tools/mirror-hook.mjs`) 포함 — 세션의 도구 활동·중간/최종 텍스트가 페이지에 흐른다. 훅 로그: `/tmp/ana-channel-test-mirror.log`
