# PRD 구조 검수 결과 — ANA Geo (라운드 3)

- **검수 축:** 구조 · 요구사항 품질 (prd-structure-auditor)
- **대상:** `PRD.md` v1.2 (2,019행 — v1.1 대비 +39행)
- **범위(scope):** `full` — 체크리스트 7개 영역 + **4-1 신설 절 양방향 접합 점검**
- **비교 기준:** `_workspace/prd-review_r2/01_structure_findings.json` (라운드 2, 활성 32)
- **원시 데이터:** `01_structure_findings.json` (해소 건 포함 50건 전량 보존)

## 요약

| 구분 | 건수 |
|---|---:|
| 라운드 2 활성 | 32 |
| **해소** | **10** |
| 잔존 | 22 |
| **신규** (STR-044~050) | **7** |
| **활성 합계** | **29** |

| severity | 활성 | R2 | R1 |
|---|---:|---:|---:|
| critical | 0 | 0 | 1 |
| **major** | **10** | 15 | 18 |
| minor | 16 | 14 | 15 |
| info | 3 | 3 | 3 |

**판정은 CONDITIONAL PASS 유지.** major가 15에서 10으로 줄었고, 남은 10건 중 5건은 v1.0부터 손대지 않은 영역(§11.1·§12 analysis·§14·§18.3·§28)이다. 기계 점검은 세 라운드 연속 통과했다 — FR 70개(FR-SEARCH-011·FR-CD-012 신설), 형식·중복·건너뜀 없음, JSON 블록 10개 파싱.

## 해소된 10건

라운드 2의 지적이 거의 그대로 반영됐다. 특히 **매트릭스 정합이 완결**됐다.

| ID | 무엇이 해소됐나 |
|---|---|
| STR-013 (major) | §10.1이 "Every application shall support ... each implemented in its own code (§9)"로 전 앱 스코프화. 라운드 2 전수 점검의 미뒷받침 25셀 중 **14셀이 이 한 문장으로 닫혔다** |
| STR-042 (major) | §8.3에 결과 엔드포인트 추가 + §8.2 항목 6(resultVersion 변경 시 stateVersion 증가). 양방향 모두 접합 |
| STR-043 (major) | §30에 requirements.txt + 항목 13(Node >= 20 LTS, Python 버전, "§32의 산문은 매니페스트를 대체하지 않음") |
| STR-040 (major) | §31 규칙 1에 예외 추가 — 교차 계약 검증 기준은 §30 항목 인용 허용 |
| STR-004 (major) | FR-SEARCH-011 Feature Acquisition 신설 |
| STR-005 (major) | FR-CD-012 Scene Acquisition 신설 (§9 참조로 자체 구현 명시) |
| STR-002 (major) | §22 Site 열 외부데이터 ✓ 제거 + 설계 의도 주석 |
| STR-003 (major) | FR-ROUTE-008에 후보 출처 명시 + Route 열 Overpass ✓ 추가 |
| STR-006 (minor) | §22 Buffer 행 Site ✓ 제거 |
| STR-039 (major) | §22 Imagery preview 행 CD ✓ 제거 — GIS 축 실측 기반 방향 B 반영 |

**§22는 이제 20행 × 7앱의 모든 ✓가 뒷받침 FR 매핑표로 추적된다.** 라운드 1에서 "범례가 없어 ✓의 뜻을 모른다"로 시작한 지적이 세 라운드에 걸쳐 범례 → 셀 정정 → 매핑표로 닫혔다.

## 신규 7건 — 체크리스트 4-1 적용 결과 (6건) + 조율 발행 (1건)

리더 지시대로 v1.2가 신설·변경한 절마다 바깥·안쪽 두 방향을 점검했다. **STR-044~049 6건 전부가 이 점검에서 나왔고**, STR-050은 이후 GIS 축 조율 과정에서 추가됐다.

### 안쪽 방향 실패 (신설 절을 참조해야 할 기존 절이 갱신되지 않음)

**STR-045 (major)** — §12 규칙 4가 뷰포트를 `map.view`/`map.observedView`로 가르면서 "for ANA inspection (§24.1)"이라고 §24.1을 지목했는데, **정작 §24.1은 "current viewport"라는 v1.0 문구 그대로다.** 같은 문제가 FR-MAP-003·FR-EXP-001·FR-SAT-001에도 있다. 두 키의 동기화 의미가 정반대(하나는 전 클라이언트 적용, 하나는 절대 미적용)여서 어느 것을 읽느냐가 동작을 바꾼다. 특히 FR-EXP-001·FR-SAT-001은 검색 범위를 결정하므로 결과가 갈린다.

**STR-048 (minor)** — v1.2가 §22 범례를 만족시키려 추가한 뒷받침 매핑표의 첫 항목이 FR이 아닌 §10.1을 인용해, 범례의 "at least one FR **in that app's section**"을 문구상 벗어난다. 같은 유형을 §31에서는 규칙 1 완화로 해소했는데 **§22에는 같은 완화가 적용되지 않았다.**

### 바깥 방향 실패 (신설 절이 참조하는 기존 절이 그 참조를 지원하지 않음)

**STR-047 (major — GIS-011 병합으로 승격)** — §8.4가 Range 전달 요구의 근거로 §26.2를 인용하지만 §26.2에는 부분 읽기·윈도우 읽기·Range 개념이 아예 없다. 게다가 §21.5의 FR 어디에도 AOI 윈도우 부분 읽기 요구가 없어, §8.4가 보호하려는 동작이 요구로 존재하지 않는다.

**STR-049 (minor)** — FR-ROUTE-010이 신설한 상한 초과 거부가 §25를 인용하지만 §25의 닫힌 범주 목록 아홉 항목에 대응 범주가 없다("invalid spatial condition"은 조건식 오류이지 범위 초과가 아니다).

### 신설 절 사이의 충돌

**STR-044 (major)** — §12 규칙 4의 `map.observedView`가 **단수 키 하나**인데 §8.2 항목 2는 "All devices connected to the same app converge automatically"로 다중 디바이스를 명시적으로 전제한다. 두 기기가 붙으면 관측 뷰포트가 같은 슬롯을 덮어써 마지막 쓰기만 남고, ANA의 §24.1 조회는 어느 기기의 것인지 알 수 없다. 또 §8.2 항목 1("Every state change ... increments it by 1")에 따라 한 기기의 팬이 다른 모든 기기의 상태 재조회를 유발한다 — 항목 5의 300 ms 디바운스는 빈도를 낮출 뿐 구조를 바꾸지 않는다.

**STR-046 (major)** — §8.3이 도입한 inbound relay가 바로 위 "server.js owns these responsibilities" 목록에 없고 §8.1 구조·§30 파일 목록에도 자리가 없어, 앱 산출물인지 ANA 하네스 측인지 미정이다. §30 항목 12가 §8.3 이행을 완료 조건으로 삼으므로 **무엇을 확인해야 하는지 정해지지 않은 채 판정을 요구하는 상태**다. handoff: ANA 정합성 축.

## 조율 중 추가 발행 1건

**STR-050 (major, §22)** — gis의 GIS-034 회신 과정에서 확인됐다. v1.2가 Site 열 외부데이터 ✓를 제거하며 붙인 주석이 Site 입력 경로를 규정하는 유일한 문장이 됐는데, **그 근거 둘이 모두 문서에서 지탱되지 않는다.**

1. 주석은 "§18.6 keeps external data optional"을 이유로 들지만 §18.6의 목록은 NASA POWER·DEM·land use·cadastral·public infrastructure뿐이고 **OSM·Overpass는 없다** — 도로·주거지 데이터에 대해 §18.6은 아무 말도 하지 않는다.
2. "prior apps' exported results"는 **문서 전체에서 이 주석 한 곳에만 등장한다**(`export` 전수 확인). 내보내기를 요구하는 FR도 형식도 위치도 없다.

그 결과 FR-SITE-006이 "distance to roads, power infrastructure, residential areas"를 지표로 명시하고 §18.4가 roadDistance·residentialDistance를 보이며 §33 데모가 이를 요구하는데도, 그 피처가 앱에 들어오는 경로가 요구로 존재하지 않는다. **Site는 후보와 참조 피처 어느 쪽에도 취득 FR이 없는 유일한 앱이다.**

이는 STR-002 해소의 회귀가 아니다 — 매트릭스 정합(STR-002)은 실제로 닫혔고, 새로 드러난 것은 그 수정이 입력 경로 문제를 주석으로 넘겼다는 점이다.

## 잔존 major 10건

| ID | 섹션 | 요약 |
|---|---|---|
| STR-008 | §14 | map·explorer·satellite 3개 앱에 의존성 선언 절 부재 (Site는 FR-SITE-006 보강으로 부분 해소) |
| STR-016 | §12 | `analysis` 슬롯과 앱별 모델 5종의 배치 관례 불일치 |
| STR-017 | §11.1 | 공통 property 모델과 §18.4·§21.6 결과 모델의 관계 미정의 |
| STR-023 | §28 | provenance가 §28만 "should optionally" — 필수 전제 절이 다섯으로 늘었다 |
| STR-025 | §18.3 | FR-SITE-005 가중치 합계 위반 시 동작 미정의 |
| STR-044 | §12 | observedView 단수 슬롯 vs 다중 디바이스 (신규) — **ANA-014로 병합, 정본은 ANA-014. 병합 보고서에서 별도 계상 금지** |
| STR-045 | §24.1 | 뷰포트 이원화가 이를 읽는 요구들에 미전파 (신규) |
| STR-046 | §8.3 | inbound relay의 소속·위치 미정의 (신규) |
| STR-050 | §22 | Site 입력 취득 경로가 요구로 부재, 주석의 두 근거가 미성립 (신규) |
| STR-047 | §8.4 | 윈도우 부분 읽기가 요구로 부재 — GIS-011 병합으로 minor→major (신규) |

잔존 5건은 **v1.0 이후 세 라운드 동안 원문이 한 번도 바뀌지 않은 영역**이다. §11.1의 "when applicable", §12의 `analysis: null`, §14 전체, FR-SITE-005, §28의 "should optionally"가 그렇다. 개정이 §8·§12·§22·§30에 집중되는 동안 이 다섯은 손대지 않았다.

## severity 조정 1건

**STR-038: major → minor.** 앱 경계 문제가 해소됐다 — FR-SEARCH-011이 "using the same registry keys as FR-EXP-008", FR-ROUTE-008이 "(as in FR-EXP-002 / FR-EXP-008)"로 명시해 세 앱이 같은 어휘를 참조한다(코드 import가 아닌 어휘 참조라 §9와도 충돌하지 않는다). 잔존은 §17.4의 `subway_station`이 §16.3 프리셋 10종에 없다는 한 건뿐이다.

## 타 축 이관

| ID | 대상 | 확인 요청 |
|---|---|---|
| ~~STR-046~~ | ~~prd-ana-alignment-reviewer~~ | **회신 완료** — 베이스상 릴레이는 **앱 산출물이며 별도 프로세스**(`fakechat-bridge.js`, `npm run all`). "하네스 측" 선택지는 폐기, §8.1·§9·§30 정렬 요구를 recommendation에 추가. handoff 해제 |
| ~~STR-050~~ | ~~prd-gis-feasibility-reviewer~~ | **회신 완료** — GIS 축 실측 후 **(A) 조건부 채택**: 취득 FR + ✓ 복원, 단 도로는 주요 등급 한정(`highway=*` 21,097 way = 캡 10배 초과 vs `motorway\|trunk\|primary\|secondary` 1,544 way). 레지스트리는 feature class registry로 일반화. handoff 해제 |

**열린 handoff 0건.**

## 라운드 3 관찰

**4-1 점검이 신규 6건 전부를 잡아냈다.** 라운드 2에서 "신설 절과 기존 절의 접합 미점검"을 패턴으로 보고하고 체크리스트에 반영한 것이 그대로 효과를 냈다. 다만 v1.2도 같은 유형을 6건 만들었으므로, 이 점검은 개정이 계속되는 한 매 라운드 필수로 유지해야 한다.

주목할 변화는 **결함의 무게중심이 옮겨간 것**이다. 라운드 1의 major는 "요구가 없다"(FR 부재·매트릭스 미뒷받침)가 대부분이었고 지금은 대부분 닫혔다. 라운드 3의 신규 major 3건은 전부 "요구는 있는데 그 요구가 도입한 개념이 문서 전체에 전파되지 않았다"는 유형이다. 문서가 성숙하면서 결함이 누락형에서 전파형으로 바뀌었다.

## 병합 대상 표시 (리포터용)

| 구조 축 | 타 축 | 판정 |
|---|---|---|
| STR-044 | ANA-014 | 동일 §12 규칙 4 마감 문제 — 병합. 구조 축 고유 논거는 단수 슬롯 덮어쓰기(§8.2 항목 2의 다중 디바이스 전제와 충돌)와 관측 뷰포트 쓰기가 stateVersion을 올려 동기화 트래픽을 유발하는 부수효과. 병합본에 이 둘을 남길 것 |
| STR-049 | GIS-035 | 동일 결함(§25 범주 누락) — 병합 |
| STR-050 | GIS-034 | 동일 결함(Site 입력 경로 부재) — 병합. 수정 방향 두 가지가 모두 문서적으로 성립하므로 제품 결정으로 넘긴다 |

## ✓ 제거로 해소한 3건의 재검증 (리포터 질의 회신)

"매트릭스 ✓ 제거"로 해소 판정한 STR-002·006·039에 같은 함정이 있는지 전수 확인했다. **판정 기준은 하나다 — 제거된 능력을 문서의 다른 곳이 여전히 요구하는가.**

| 해소 건 | 제거된 ✓ | 그 능력을 문서가 여전히 요구하는가 | 판정 |
|---|---|---|---|
| STR-002 | Site — OSM·Overpass·POI | **요구한다.** FR-SITE-006이 "distance to roads, power infrastructure, residential areas"를, §18.4가 roadDistance·residentialDistance를, §33이 "roads, and residential separation"을 명시 | **문제가 이전됨 → STR-050** |
| STR-006 | Site — Buffer | 요구하지 않는다. §18 구간(836~991행) 전체에 buffer 언급 0건이고 하드 제약은 거리 계산만으로 성립. Spatial distance ✓는 FR-SITE-006으로 유지 | 해소 유효 |
| STR-039 | CD — Imagery preview | 요구하지 않는다. GIS 축 실측으로 썸네일이 목적을 못 채움이 확인됐고 §21.7 evolution path로 이관됨 | 해소 유효 |

**STR-002의 해소 판정은 되돌리지 않는다.** 그 finding이 기술한 defect(매트릭스 ✓의 FR 미뒷받침 + §18.6 모순)는 실제로 닫혔고, 이전된 문제는 STR-050(major)으로 별도 추적한다. 되돌리면 하나의 결함이 두 건으로 이중 계상되어 대장이 왜곡된다. 대신 STR-002의 recommendation에 계보 주석을 남겨 "해소되었으나 문제가 §22 주석으로 이전됐다"가 원시 데이터에서 읽히게 했다.

**일반 원칙으로 기록한다.** 매트릭스 셀 제거는 그 능력이 문서 다른 곳에서 요구되지 않음을 확인한 뒤에만 유효한 해소다. 확인 없이 제거하면 정합성 점검을 통과하면서 요구는 사라지지 않는 상태가 된다 — 이번 라운드에 셋 중 하나가 그랬다.

## 조율 최종 확정 (라운드 3 마감)

세 축의 왕복이 모두 닫혔다. 열린 handoff 0건.

**STR-050 — (A)가 정본, (B)는 병존으로 최종 확정.** 제가 두 안을 제품 결정으로 넘겼는데, GIS 축이 측정 후 자신의 원안을 부분 수정하며 조건을 붙였다. 대전 도심 약 10 × 11 km bbox 기준 `highway=*`는 21,097 way로 §26.1의 2,000 캡을 10배 초과하지만 주요 등급(`motorway|trunk|primary|secondary`)은 1,544 way로 캡 안에 들어온다. `landuse=residential`은 303 way다. 즉 (A)는 **도로를 주요 등급으로 한정할 때만** 성립한다. "major road"는 §33의 Route 데모가 이미 쓰는 표현이라 새 개념이 아니다.

**추가 측정으로 (A) 단독이 불충분함이 드러났다.** `landuse=residential`은 303 폴리곤·합집합 9.83 km²로 bbox의 9.8%뿐이라(인구 145만 도시) OSM 주거지 매핑이 성기고, §18.2가 이를 hard constraint로 쓰므로 pass/fail이 조용히 틀린다. 그래서 FR-SITE-011이 "권위 있는 데이터로 대체하는 입력 경로"로 병존하고, OSM 유래 주거지 지표는 hard constraint 단독 근거로 쓰지 않는다는 항목이 추가됐다. 레지스트리 일반화 제안도 채택됐다 — 도로는 선형, 주거지는 면형이라 §16.3의 POI 프리셋 개념에 담기지 않으므로, FR-EXP-008을 **feature class registry(키 · 태그 셀렉터 · 기대 지오메트리 3열)**로 일반화해 GIS-029와 일괄 처리한다.

**STR-044 — 정본은 ANA-014로 확정, 본 finding은 포인터로 전환.** 양측이 서로 정본을 양보해 왕복이 길어지자 ANA 축이 결정했다. 구조 축 활성 29건에는 포함되나 **병합 보고서에서는 ANA-014로만 계상해야 한다** — 구조 축 고유 활성은 28건으로 읽는다. 구조 축의 두 논거(단수 슬롯 덮어쓰기, stateVersion 트래픽)와 구체 권고안(`observedViews` 클라이언트별 맵 + clientId 발급 + §8.2 항목 1 예외)이 모두 흡수됐다. ANA 축은 자신의 초안 문장 "귀속은 last-writer-wins로 못박기"를 철회했다 — LWW는 트래픽만 닫고 조회 정확성은 닫지 못하기 때문이다.

**STR-045 — 별건 유지 확정, ANA 축이 오작동 사례를 보강했다.** FR-MAP-003이 `map.view`를 읽으면 사용자가 팬해도 좌표 readout이 갱신되지 않고 ANA가 마지막 설정한 위치에 고정되며, `observedView`를 읽으면 ANA의 "대전으로 이동" 직후 잠깐 어긋난다. 2키 분리가 표시 계열 FR 전체에 "어느 키를 읽는가"를 지정할 의무를 만들었다는 것이 이 finding의 정확한 형태다.

**STR-047 ↔ GIS-011, STR-049 ↔ GIS-035, STR-050 ↔ GIS-034** 병합 확정.
