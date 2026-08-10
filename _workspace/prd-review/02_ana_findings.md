# ANA 정합성 축 검수 결과 — ANA Geo PRD **라운드 3**

**검수자:** prd-ana-alignment-reviewer (ana)
**대상:** `/Users/tykimos/ana/ana-geo/PRD.md` (Draft **v1.2**, 2019행 — v1.1 대비 +39행)
**검수 범위(scope):** `full` — ana-baseline.md B1~B6 및 "PRD 대조 시 주의" 항목 전부 재검수
**대조 근거:** 베이스 저장소 원문(`README.md`, `agent-native-app-harness/SKILL.md`, `references/ana-architecture.md`) — 라운드 1에서 확인한 사실 사용, 원격 대조 생략 없음
**이전 산출물:** `_workspace/prd-review_r2/02_ana_findings.json` (추적 13건 / 활성 8건)
**작성일:** 2026-08-11

---

## 판정 요약

| | 라운드 1 | 라운드 2 | 라운드 3 |
|---|---:|---:|---:|
| critical | 3 | 0 | **0** |
| major | 6 | 5 | **2** |
| minor | 1 | 2 | 3 |
| info | 1 | 1 | 1 |
| **활성 합계** | 11 | 8 | **6** |

이번 라운드: 해소 3건 · 잔존 5건 · 신규 1건 (누적 추적 14건, 누적 해소 8건).

**판정: CONDITIONAL PASS** (critical 0, major 2). 라운드 2와 동일 등급이나 major가 5 → 2로 줄었다.

## 한 줄 결론

**라운드 2의 신규 2건이 모두 정확히 닫혔고, 회귀는 없다.** §8.3의 인바운드 릴레이 문안은 베이스 B2의 경로(대시보드 → 인박스 → 릴레이 롱폴 → 세션 푸시)를 그대로 복원했고, §12 규칙 4의 2키 의미론은 제가 설계한 형태와 문장 단위로 일치한다. 남은 major 2건은 **v1.0부터 원문이 한 번도 수정되지 않은 두 곳**이다 — §24.3의 `where available`(ANA-004)과 §14의 의존성 경계 부재(ANA-007). 신규 1건은 새 2키 설계의 마감 문제로, 한 문장으로 닫힌다.

---

## 해소된 finding (이번 라운드 3건)

### ANA-012 (major → 해소) — 인바운드 릴레이

> Inbound path: the dashboard posts chat input to the server-side inbox, and an **inbound relay** long-polls that inbox and pushes each message into the ANA session. … **The mechanical polling belongs to the relay component, not to the agent.**

베이스 B2의 인바운드 경로(대시보드 → `/api/chat` → 인박스 → 릴레이가 `/api/inbox-wait` 롱폴 → 세션 푸시)와 구조가 일치한다. 마지막 문장이 라운드 2가 지적한 모순 — "에이전트는 폴링하지 않는다"고 하면서 pull 자료구조를 대체 수단으로 지목한 것 — 을 정확히 겨냥해 **폴링의 주체를 릴레이로 귀속**시켰다. 채널 빌딩블록 미채택 선언은 그대로 유지되므로 "스킬을 안 쓴다"와 "릴레이 역할을 없앤다"의 구분도 분명해졌다. 부수적으로 §8.3에 결과 데이터 엔드포인트(`/api/results/<id>`) 책임이 추가되어 §12 Rule 3의 참조 구조가 배선까지 닫혔다.

### ANA-013 (major → 해소) — 뷰포트 강제 동기화

§12 규칙 4가 2키 의미론을 채택했고, **제가 설계한 것과 문장 단위로 일치한다.** `map.view`는 ANA가 설정하고 모든 클라이언트가 적용(→ "Move the map to Daejeon."이 전 기기에서 동작), `map.observedView`는 클라이언트가 자기 뷰포트를 §24.1 조회용으로 기록하되 다른 클라이언트는 결코 적용하지 않는다. 쓰기 빈도도 §8.2-5로 규정됐다 — `moveend`/`zoomend` 300 ms trailing 디바운스(허용 250~500 ms), 이산 액션은 즉시 쓰기. GIS 축 실측 수치가 그대로 들어갔다. 잔여 마감은 ANA-014로 분리했다.

### ANA-005 (major → 해소) — 진화 수용 기준

권고 양쪽이 모두 반영됐다. §21.7에 §20.5와 **같은 형식의 단서**가 붙어("…is therefore an evolution path only, never a v1 acceptance criterion") 진화 서사를 유지하면서 v1 완료 조건에서 분리했고, §21.8의 기준은 `ANA can evolve the analysis pipeline within Sentinel-2's capabilities, e.g. switch to NDBI/NDWI difference or direction-filtered change (§30, item 11)`로 교체되어 §21.4(딥러닝 금지)·§3.3·§13과 충돌하지 않으면서 코드 변경 요구는 유지한다.

---

## 신규 finding (1건)

### ANA-014 (minor → **major**, §12) — `observedView`의 동기화 의미론 미완 · **STR-044와 병합 대상**

규칙 4는 `observedView`를 "다른 클라이언트가 결코 적용하지 않는" **비공유** 값으로 정의했다. 그런데 §8.2-1은 "모든 상태 변경은 `stateVersion`을 +1"이라 하고 §8.2-6은 `resultVersion` 변경까지 명시적으로 포함시키는데, `observedView`를 예외로 두는 문장이 없다. 기본 해석상 포함되며, 그러면 한 기기가 팬할 때마다(300 ms 단위로) **다른 모든 기기가 적용하지도 않을 값 때문에 상태를 재요청**한다. 베이스 B3에서 version 카운터의 의미는 "공유 상태가 바뀌었으니 모두 다시 받아라"인데, 비공유 값이 그 신호를 올리면 카운터의 의미가 흐려진다. 부수적으로 다중 클라이언트일 때 단일 슬롯인지 클라이언트별인지도 미정이라 ANA가 §24.1에서 어느 화면을 읽는지 불확실하다.

→ `observedView` 변경은 `stateVersion`을 올리지 않는다고 명시하거나, 별도 엔드포인트(`POST /api/observed-view`)로 빼서 §8.2-1의 무예외 규칙을 유지할 것.

**[조율 결과 — minor → major 승격, STR-044와 병합]** 구조 축 STR-044가 같은 §12 규칙 4를 지적하며 제 finding에 없던 논거를 제시했다 — `observedView`가 **단수 키 하나**인데 §8.2-2는 다중 기기 접속을 명시적으로 전제하므로, 두 기기가 붙으면 마지막 쓰기만 남아 ANA가 §24.1로 읽는 "current viewport"가 어느 기기 것인지 알 수 없다. **저는 라운드 1~3 내내 "last-writer-wins면 셀프호스팅 단일 사용자에 충분"으로 판단했으나 그 전제가 틀렸다** — §8.2-2가 다중 기기를 설계된 시나리오로 못박은 이상 성립하지 않고, 잃는 것이 편집 내용이 아니라 **§24.1 질의에 대한 조용한 오답**이므로 minor 유지 근거가 없다. 구조 축 판단대로 major로 승격한다.

**리포터 지시 (최종·확정됨):** 두 건은 동일한 하나의 문제이므로 **단일 MRG finding으로 병합**한다. 두 축 합의로 **정본은 ANA-014**이며, **구조 축이 STR-044를 포인터로 전환 완료**했다(STR-044 summary 머리에 병합 표시, recommendation 머리에 포인터 문단, 원문 권고는 이력 보존). 구조 축 고유 활성은 28건으로 읽어야 한다(원시 29건에 포인터 1건 포함). 정본 근거: 구조 축이 "본체가 상태 동기화 계약과 §24.1의 맞물림이므로 ANA 축 소관"(구조 축이 "본체가 상태 동기화 계약과 §24.1의 맞물림이므로 ANA 축 소관"이라며 정본을 양보했고, 정합성 축이 이를 수락)이며, **STR-044의 두 논거를 ANA-014의 issue에 흡수 완료**했다. 권고안도 STR-044의 구체안(클라이언트별 `observedViews` 맵 + clientId 발급 규칙 + §24.1 조회 대상 정의)을 채택했다. severity **major** 양측 합의. 이중 계상 금지.

**철회 사항 (중요):** 초안의 *"귀속은 last-writer-wins로 못박으면 클라이언트별 슬롯 설계라는 과잉을 막는다"* 는 문장을 **철회한다.** 리포터가 병합 근거로 이 문장을 인용했으나, last-writer-wins는 카운터 오염만 닫고 **단수 슬롯 문제는 닫지 못한다** — 베이스가 공유 데이터에 last-write-wins를 허용하는 것은 편집 충돌 이야기이고(fakechat SKILL.md "동시 수정: 잠금 없음"), 여기서 잃는 것은 편집이 아니라 조회의 정확성이다. 병합 결론은 유지되지만 근거는 "한 권고가 둘을 닫는다"가 아니라 **"같은 키·같은 문장·같은 수정 지점"** 이다.

**STR-045와는 별건.** 이 finding은 상태 키의 자료구조·동기화 의미론이고, STR-045는 §24.1과 FR-MAP-003·FR-EXP-001·FR-SAT-001이 2키 분리를 반영하지 못한 참조 전파 문제다.

---

## 잔존 finding (5건)

| id | severity | 위치 | 상태 |
|---|---|---|---|
| ANA-004 | major | §24.3 | **v1.0 이후 원문 무변경.** §8.3(응답이 제안·승인 카드로 렌더)과 §30-11(제안 → 승인 → 재기동 없이 사용)이 승인을 필수화했는데, 이를 **정의하는 절**만 `where available`로 남아 있다. 코드 변경 이외(상태 스키마 변경, 분석 로직 교체)에서 승인 생략이 문서상 정당화된다. 한 구절 삭제 + 즉시 적용/승인 경계 한 문장이면 닫힌다. |
| ANA-007 | major | §14 | **부분 반영.** §30 item 13이 신설되어 라운드 1 권고 (a)가 들어갔다 — `Node.js >= 20 LTS (global fetch is a precondition of §8.4)` + Python `requirements.txt`. 그러나 §3.3·§14 원문은 무변경이고 **경계 규칙 자체**(코어는 stdlib + vendored만, npm 런타임 의존성·빌드 단계 없음), vendored 범위 정의, hand-rolled 서버 안전 요구는 여전히 없다. server.js에 Express를 얹는 것을 막는 문장이 없어 앱마다 선택이 갈릴 수 있다. |
| ANA-008 | minor | §8.3 | **무변경.** 문서 전체에 `uxui-design-system`·`agent-native-app-harness` 언급이 없음을 재확인했다(전문 grep). 채널 계열 미채택 선언만 있다. |
| ANA-009 | minor | §10.2 | **무변경.** 그림에서 Converse Surface가 여전히 프레임 밖이고 동시 가시성 문구가 없다. §8.3 덕에 최악의 실패 모드는 닫힌 상태 유지. |
| ANA-011 | info | §33 | **무변경.** 데모 7단계에 Use=Build 순간이 없다. §30 item 11이 있으므로 그 항목을 시연하는 단계를 붙이면 문서 전체가 일관된다. |

---

## v1.2에서 특히 잘 된 부분 (결함 아님, 기록용)

- **§8.2-6** — "Any change to a layer's `resultVersion` also increments `stateVersion` — otherwise polling clients cannot detect that a result set changed even though the state file did not." **라운드 2에서 제가 잡지 못한 구멍을 문서 쪽에서 스스로 닫았다.** §12 Rule 3으로 피처 본문을 분리한 순간 생기는 사각지대를 정확히 짚은 추가다.
- **§8.3 결과 엔드포인트 책임 추가** — Rule 3의 `resultRef`가 가리킬 서버 측 주체가 명시되어 상태 모델과 배선 계약이 한 바퀴 닫혔다.
- **§21.7 단서 문안** — §20.5가 세운 관례(진화 서사는 유지, v1 완료 조건에서는 분리)를 같은 형식으로 복제했다. 문서가 자기 관례를 일관되게 적용하기 시작했다는 신호다.
- **§30 item 13** — 런타임 전제를 DoD로 고정했다. Node 버전 근거를 `global fetch is a precondition of §8.4`로 적어, 왜 그 버전인지가 문서 안에서 추적된다.

---

## 타 축 이관 / 조율

### STR-046 회신 — 베이스에서 인바운드 릴레이의 소속 (정합성 축 판정)

구조 축이 "릴레이가 앱 산출물인지 하네스 측 구성요소인지" 판정을 요청했다. **베이스 원문 재조회 결과 릴레이는 앱 산출물이며, 별도 프로세스다.** 근거 3종:

1. **`fakechat-dashboard-agent` SKILL.md, 아키텍처 4요소** — *"2. **인바운드 릴레이** (`references/fakechat-bridge.js`): 대시보드의 새 채팅 요청을 fakechat WS로 밀어넣어 Claude 세션에 자동 도착시킴. (의존성 0, Node 22 전역 fetch/WebSocket.)"* — 대시보드 서버(`references/server.js`)와 **나란히 놓인 별개 파일**이며, 둘 다 빌딩블록이 앱으로 복사해 넣는 산출물이다.
2. **같은 SKILL.md 구축 절차 4단계** — *"**릴레이 실행**: `node fakechat-bridge.js` (백그라운드)."* — server.js 안이 아니라 **독립 프로세스로 기동**한다.
3. **베이스 README(ana-starter 절)** — *"It ships the dashboard + fakechat relay … (`npm run all` starts server + relay together)"* — 실행 템플릿이 릴레이를 **함께 배포**하고 두 프로세스를 같이 띄운다.

따라서 구조 축이 제시한 두 선택지 중 **"하네스 측 구성요소이므로 앱 의무는 인박스·피드 API 노출까지"는 베이스와 어긋난다.** 베이스에서 앱(템플릿)은 릴레이 파일을 소유하고 기동까지 책임진다.

다만 **경계는 릴레이가 아니라 그 너머에 있다.** 베이스에서 릴레이는 인박스를 롱폴해 **채널(fakechat WS)** 로 밀고, 채널이 세션에 푸시한다. 채널은 Claude 세션 기동 시 `--channels`로 붙는 것이라 앱 밖이다. PRD는 §8.3에서 채널 빌딩블록 미채택을 선언했으므로, 릴레이가 "무엇에" 밀어 넣는지가 앱 안에서 닫히지 않는다. 즉 §30 item 12의 판정 대상은 다음과 같이 갈라야 정확하다.

- **앱이 판정받을 것** — 인박스·피드 API 노출, 릴레이 산출물의 동봉과 기동 수단 제공, 응답이 항상 `POST /api/agent`로 오는 경로.
- **앱이 판정받을 수 없는 것** — 에이전트 세션 측 채널 결합(세션 기동 옵션에 달려 있음).

**추가 권고 (STR-046 recommendation에 반영 요청):** 구조 축은 §8.1 구조 예시와 §30 파일 목록의 일치를 요구했는데, **§9도 함께 봐야 한다.** "릴레이 = 별도 프로세스" 쪽으로 정하면 §9의 *"`node server.js`만으로 실행된다"* 는 Converse 루프를 완성하지 못한다(베이스가 `npm run all`로 둘을 함께 띄우는 이유). §9에 기동 명령을 보강하거나, 릴레이를 `server.js` 안에 흡수하는 선택지를 택해야 한다 — 후자는 베이스와 다르지만 채널을 이미 미채택한 PRD에서는 합리적 단순화가 될 수 있다. 어느 쪽이든 §8.1 · §9 · §30이 같은 결정을 가리켜야 한다.

*정합성 축에서 별도 finding은 발행하지 않는다 — 수정 지점이 STR-046과 같아 중복이 된다.*

### ANA-014 ↔ STR-044 — 병합 확정

동일한 하나의 문제로 판정하고 **단일 MRG finding으로 병합**(본문 STR-044, 정합성 축 근거 흡수)하기로 구조 축과 합의했다. ANA-014는 minor → **major** 승격. 상세는 위 신규 finding 절 참조.
- **ANA-007** — GIS 축 PoC 검증 결과(stdlib 전용 구현 가능, Node ≥ 20 LTS 필요, vendored 범위가 GIS-001 해법을 결정)가 recommendation에 이미 반영돼 있다. §30 item 13이 Node 버전만 가져갔으므로 나머지 두 단서(안전 요구·vendored 범위)가 아직 미반영이라는 점이 이 finding의 잔여분이다.

---

## 산출물

- `/Users/tykimos/ana/ana-geo/_workspace/prd-review/02_ana_findings.json` (누적 14건 — `resolved: true` 8건 포함)
- `/Users/tykimos/ana/ana-geo/_workspace/prd-review/02_ana_findings.md` (이 문서)
