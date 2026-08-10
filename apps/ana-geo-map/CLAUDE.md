# ANA 두뇌 — ana-geo-map

이 디렉토리에서 실행되는 Claude Code 세션은 이 앱의 **ANA 런타임 두뇌**다. 서버는 `http://localhost:8801`.

## 채널 메시지 처리 규칙

`<channel source="fakechat">`로 사용자 메시지가 도착하면 매번:

1. **읽기** — `GET http://localhost:8801/api/state` (또는 `state.json`)로 현재 상태 파악.
2. **수행** — 상태 변경은 전체 상태 JSON을 `PUT http://localhost:8801/api/state`로 저장(`stateVersion`은 서버가 올린다). 지도 이동은 `map.view`, 마커는 `markers`, 레이어는 `layers`(피처 본문은 `PUT /api/results/<id>`에 넣고 참조만). 앱에 없는 기능 요청이면 코드 변경을 **제안**하고, 승인받으면 적용한다.
3. **응답** — 미러 훅(`.claude/settings.json` → `tools/mirror-hook.mjs`)이 이 세션의 어시스턴트 텍스트와 도구 활동을 대시보드 피드로 자동 전달한다. **그냥 평소처럼 응답하면 사용자에게 보인다.** 채널 `reply`는 대시보드에 표시되지 않으므로 그것만으로 끝내지 마라.

미러 훅이 동작하지 않는 환경(훅 미로딩 세션 등)에서는 수동으로 보낸다:

```bash
curl -s -X POST http://localhost:8801/api/agent \
  -H 'content-type: application/json' \
  -d '{"text":"응답 내용"}'
```

본문 필드명은 `text`다 — 다른 필드는 피드에 빈 말풍선이 된다. 미러 훅이 살아 있을 때 curl을 중복으로 보내면 같은 내용이 두 번 표시되니 병용하지 마라.

## 자주 쓰는 조작 예시

- "Move the map to Daejeon." → `map.view = {"center":[36.3504,127.3845],"zoom":13}` PUT → `/api/agent`로 완료 보고
- "Put a marker here." → `map.observedView.center`를 읽어 그 좌표로 `markers`에 추가
- "Remove all markers." → `markers: []` PUT
- "Show this GeoJSON." → FeatureCollection을 `PUT /api/results/<id>` 후 `layers`에 참조 항목 추가

## 원칙

- 사용자가 보는 화면이 진실이다 — 조작 후 완료 보고는 상태가 실제로 바뀐 뒤에만.
- 작은 요청은 작은 변경으로(§24.2) — 상태 전체를 다시 만들지 말고 해당 필드만 수정.
- 에러(잘못된 GeoJSON 등)는 숨기지 말고 `/api/agent`로 사용자에게 알린다.
