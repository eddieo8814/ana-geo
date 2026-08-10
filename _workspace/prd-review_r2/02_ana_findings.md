# ANA 정합성 축 검수 결과 — ANA Geo PRD **라운드 2**

**검수자:** prd-ana-alignment-reviewer (ana)
**대상:** `/Users/tykimos/ana/ana-geo/PRD.md` (Draft **v1.1**, 1980행 — v1.0 대비 +124행)
**검수 범위(scope):** `full` — ana-baseline.md B1~B6 및 "PRD 대조 시 주의" 항목 전부 재검수
**대조 근거:** 베이스 저장소 원문(`README.md`, `agent-native-app-harness/SKILL.md`, `references/ana-architecture.md`) — 라운드 1에서 확인한 사실을 그대로 사용, 원격 대조 생략 없음
**이전 산출물:** `_workspace/prd-review_prev/02_ana_findings.json` (11건)
**작성일:** 2026-08-10

---

## 판정 요약

| | 라운드 1 | 라운드 2 |
|---|---:|---:|
| critical | 3 | **0** |
| major | 6 | 5 |
| minor | 1 | 2 |
| info | 1 | 1 |
| **활성 합계** | **11** | **8** |

해소 5건 · 잔존 6건 · 신규 2건 (추적 총계 13건).

**판정: CONDITIONAL PASS** (critical 0, major ≥ 1). 라운드 1의 **FAIL → CONDITIONAL PASS**.

## 한 줄 결론

**세 critical이 모두 실질적으로 해소됐다.** v1.1은 라운드 1이 지적한 "원칙은 선언했으나 강제하는 계약이 없다"는 구조적 결함을 §8.2(동기화)·§8.3(Converse 배선)·§30 item 11(코드 진화 시연)·item 12(공통 계약 준수)로 메웠고, 특히 §30 item 11은 상태 편집으로는 통과할 수 없는 문안이라 Agent as Runtime이 처음으로 검증 가능해졌다. 남은 major 5건 중 2건은 **수정이 만든 신규 결함**이다 — 인바운드 푸시 요구와 대체 수단의 모순(ANA-012), 동기화 계약과 `map.center`의 결합이 낳은 뷰포트 강제 동기화(ANA-013). 둘 다 새로 도입한 계약의 마감 문제이며 각각 한 절 보강으로 닫힌다.

---

## 해소된 finding (5건)

### ANA-001 (critical → 해소) — 상태 변경 전파 계약

§8.2가 B3의 네 항목을 모두 계약화했다. `stateVersion` 단조 카운터를 두면서 "distinct from the semantic `app.version`"이라고 못박아 라운드 1이 지적한 **이름 오인 위험까지** 해소했고, 2.5초 폴링·전 기기 수렴(§8.2-2), 서버 저장·localStorage 금지(§8.2-3), SSE 병행 폴링(§8.2-4)이 모두 들어갔다. §12에는 `stateVersion` 필드와 Rules 1~3이 추가됐고, **Rule 3의 피처 본문 인라인 금지**(`resultRef`/`resultVersion`/`featureCount`)는 GIS 축 실측 권고까지 반영한 것이다. §30 item 12가 준수를 DoD로 강제한다.

### ANA-002 (critical → 해소) — Converse Surface 배선

§8.3이 `server.js` 책임 5종을 명시하고, 응답은 항상 `POST /api/agent`로 가며 제안·승인 카드로 렌더된다는 **B2의 응답 경로 규칙**을 계약화했다. fakechat/realtime-mirror 미채택을 "의도적 단순화"로 선언하고 대체 수단과 일탈 시 SPEC.md 문서화 의무까지 적어, 라운드 1이 요구한 "암묵적 누락과 의도적 단순화의 구분"도 충족했다. 다만 인바운드 푸시 메커니즘의 공백이 새로 드러나 **ANA-012로 분리 발행**했다.

### ANA-003 (critical → 해소) — Agent as Runtime 검증

§30 item 11이 신설됐다 — *"at least one README example prompt requests a capability the app does not have, and ANA proposes a code change that, once approved, is usable in the running app without a restart"*. 상태 편집으로는 충족이 불가능한 독립 항목이라 item 4의 `or` 우회로가 무력화된다. 원칙 2(코드 재작성) · B4(승인) · B5(배포 단계 없음)를 한 문장으로 커버한 좋은 문안이다. 7개 앱 수용 기준 전부에 대응 항목이 추가된 것도 확인했다(§15.4 · §16.6 · §17.7 · §18.7 · §19.7 · §20.6 · §21.8).

### ANA-006 (major → 해소) — 클라이언트 상태 서버 영속화

§8.2-3이 본체를 해소했다. §24.1의 6개 조회 대상도 §12에서 대응 키를 찾을 수 있게 됐다(viewport→`map.center`/`zoom`, selected feature→`selection`, visible layers→`layers[].visible`, current result set→`layers[].resultRef`, current analysis→`analysis`). 이 수정이 낳은 뷰포트 동기화 문제는 **ANA-013으로 분리 발행**했다.

### ANA-010 (minor → 해소) — SPEC.md 템플릿

템플릿 항목 자체는 추가되지 않았으나 **우려한 결과가 다른 경로로 차단됐다.** v1.1은 §8.2~§8.5에서 계약을 중앙에 한 번 정의하고 §30 item 12로 준수를 DoD에 걸었으며, §31 Rule 3이 "PRD.md is the canonical source … must not diverge"로 보강한다. 계약이 앱별로 재기술되지 않으므로 템플릿에 전용 절이 없어도 앱마다 갈릴 위험이 사라졌다. 지적의 목적이 달성됐으므로 해소 처리한다.

---

## 신규 finding (2건) — 수정이 만든 결함

### ANA-012 (major, §8.3) — 인바운드 푸시 요구와 대체 수단의 모순

> Inbound path: a message typed into the dashboard reaches the ANA session automatically — the user never copies text into another tool and **the agent never polls manually**.
> This is an intentional simplification of the ANA base (the `fakechat` / `realtime-mirror` channel building blocks are not adopted); **the chat bridge API above is the replacement** …

베이스에서 "에이전트가 수동 폴링하지 않는다"를 성립시키는 것은 인박스가 아니라 **인바운드 릴레이 + 채널**이다(대시보드 → `/api/chat` → 인박스 → 릴레이가 `/api/inbox-wait` 롱폴 → 채널 WS → Claude 세션). v1.1은 그 요구를 유지한 채 채널 빌딩블록을 미채택으로 선언하고 대체 수단으로 "chat inbox and feed API"를 지목하는데, 인박스는 본질적으로 pull 자료구조여서 무언가가 큐를 비워 세션으로 밀어 넣지 않으면 에이전트는 폴링할 수밖에 없다. **요구와 대체 수단이 서로를 부정하므로 구현자는 이 지점에서 멈춘다.**

→ 릴레이 역할을 한 줄로 명시하거나(스킬 미채택 ≠ 역할 제거), 폴링을 허용하되 `never polls manually` 문구를 함께 수정하고 트레이드오프를 남길 것.

### ANA-013 (major, §8.2) — 뷰포트 강제 동기화

§8.2 자체는 옳지만(B3 충족) §12의 `map.center`와 결합하면 **의도치 않은 동작을 규정**한다. 휴대폰에서 팬 → 사용자 액션이므로 서버 저장(§8.2-3) → `stateVersion` 증가 → 노트북이 2.5초 안에 수렴(§8.2-2) → **노트북 지도가 따라 움직인다.** "여러 기기가 같은 상태를 본다"가 아니라 "한 사람의 화면이 다른 화면을 끌고 간다"로 체감된다. 또한 팬/줌은 연속 제스처라 쓰기 빈도 규정이 없으면 `stateVersion`이 초당 수십 회 증가해 폴링 계약 자체가 흔들린다.

→ 뷰포트를 두 키로 분리: `map.view`(ANA가 설정, 모든 클라이언트가 적용 — §15.3 "Move the map to Daejeon."이 동작하려면 필수)와 `map.observedView`(클라이언트가 보고, §24.1 조회용, 적용하지 않음). 함께 `moveend`/`zoomend` 기준 **300ms trailing 디바운스**(안전 구간 250~500ms, GIS 축 실측), 이산 액션은 즉시 쓰기.

---

## 잔존 finding (6건)

| id | severity | 위치 | 상태 |
|---|---|---|---|
| ANA-004 | major | §24.3 | **성격 변화.** §24.3 원문 무변경. §8.3·§30-11이 제안→승인을 필수화했는데 이를 **정의하는 절**만 `where available`로 남아, 코드 변경 이외(상태 스키마 변경 등)에서 승인 생략이 정당화된다. |
| ANA-005 | major | §21.8 | **부분 수정이 새 충돌 유발.** 진화 수용 기준은 추가됐으나 `as illustrated in §21.7`로 건물 탐지 도식을 지목 → 같은 앱 §21.4("must not require deep learning")와 정면 충돌. 라운드 1 권고에서 피하라고 한 형태다. **§20.5가 같은 문제를 올바르게 처리한 내부 모범 사례**이므로 그 문안을 §21.7에 복제하면 된다. |
| ANA-007 | major | §14 | **무변경.** 오히려 §8.4(프록시)·§8.5(워커 spawn) 신설로 server.js 부담이 커져 경계 규칙의 필요성이 v1.0보다 높아졌다. GIS 축 PoC로 stdlib 전용 구현은 이미 실현 가능함이 확인됨. |
| ANA-008 | minor | §8.3 | **major → minor 강등.** §8.3이 채널 계열 미채택을 선언해 하중 지점 해소. 남은 것은 `uxui-design-system`·`agent-native-app-harness` 미언급. 구현자가 합리적으로 추측 가능하므로 강등. |
| ANA-009 | minor | §10.2 | **major → minor 강등.** §8.3의 "a message typed into the dashboard"가 대화 입력 위치를 확정해 최악의 실패 모드(별도 터미널)는 닫혔다. 남은 것은 §10.2 그림이 여전히 프레임 밖이고 동시 가시성 문구가 없다는 점. |
| ANA-011 | info | §33 | **무변경.** 데모 시나리오에 Use=Build 순간이 여전히 없다. §30 item 11이 생겼으므로 데모에 그 항목을 시연하는 단계를 붙이면 문서 전체가 일관된다. |

---

## v1.1에서 특히 잘 된 부분 (결함 아님, 기록용)

- **§30 item 11** — 라운드 1의 핵심 지적에 대한 정확한 응답. "없는 기능을 요청 → 코드 변경 제안 → 승인 → 재기동 없이 사용"은 원칙 2·B4·B5를 한 문장에 담았고 우회 불가능하다.
- **§12 Rule 3** — 피처 본문 인라인 금지를 "성능"이 아니라 §12 자신의 가독성 기준과 §8.2 폴링 계약으로 정당화했다. GIS 축 실측의 결론을 원칙 언어로 정확히 옮겼다.
- **§20.2 / §20.3 FR-SAT-010 / §20.5** — 공급자를 이름으로 고정하고 "검색과 에셋 접근 **둘 다** 무인증"을 요구한 것은 §3.3·§13·§27.7을 한 번에 만족시킨다. 전체 해상도 렌더링을 v1 밖으로 빼되 진화 요청으로 남긴 §20.5의 처리는 §21.7이 따라야 할 모범이다.
- **§8.3의 미채택 선언** — 무엇을 버렸는지, 무엇으로 대체하는지, 일탈 시 어디에 적는지를 함께 적었다. 라운드 1이 요구한 "의도적 단순화의 명시"의 정확한 형태다(그 대체 수단의 실효성 문제는 ANA-012로 별건).

---

## 타 축 이관 / 조율

**신규 이관 0건.** ANA-012·ANA-013 모두 정합성 축 단독 판단으로 종결 가능하다. 다만 리포터 참고용으로:

- **ANA-013 ↔ 구조 축** — §8.2와 §12 사이의 결합 문제이므로 구조 축이 §12 상태 모델을 다시 봤다면 겹칠 수 있다. 조율 필요 시 리더가 지정하면 대응한다.
- **ANA-005 ↔ 구조 축 STR-024 계열** — 라운드 1의 인접 배치 권고가 그대로 유효하다(§21.7 무변경).
- **ANA-007** — GIS 축 PoC 검증 결과(Node stdlib 전용 구현 가능, Node ≥ 20 LTS 필요, vendored 범위가 GIS-001 해법을 결정)가 recommendation에 이미 반영돼 있다.

---

## 산출물

- `/Users/tykimos/ana/ana-geo/_workspace/prd-review/02_ana_findings.json` (13건 — `resolved: true` 5건 포함)
- `/Users/tykimos/ana/ana-geo/_workspace/prd-review/02_ana_findings.md` (이 문서)

**ID 주의:** 리더 지시는 "신규는 ANA-011부터"였으나 `ANA-011`은 라운드 1의 info finding(§33 데모 시나리오)이 이미 사용 중이다. ID 충돌과 추적 단절을 피하려고 신규 번호를 **ANA-012부터** 부여했다.
