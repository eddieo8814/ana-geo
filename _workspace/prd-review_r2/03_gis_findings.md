# GIS 기술 실현성 검수 — ANA Geo PRD.md v1.1 (라운드 2)

**검수 축:** GIS 기술 실현성 (gis-feasibility)
**검수 범위:** `scope: "full"` — N1(브라우저 GIS) · N2(Overpass) · N3(OSMnx/NetworkX) · N4(STAC/Sentinel-2) · N5(래스터 처리) · N6(의존성 단계 전략) 전부 재검수
**대상 문서:** `/Users/tykimos/ana/ana-geo/PRD.md` (Draft v1.1, 1,980행 — v1.0 대비 124행 증가)
**검수 일자:** 2026-08-10 (라운드 2)
**원시 데이터:** `03_gis_findings.json` (해소 건 포함 전 33건)
**이전 라운드:** `_workspace/prd-review_prev/03_gis_findings.json` (29건)

---

## 총평

**이 축의 critical이 사라졌다.** 라운드 1의 유일한 critical이었던 GIS-001 — 위성 앱이 영상을 한 장도 표시하지 않고도 수용 기준을 통과하는 문제 — 은 FR-SAT-010 신설로 해소됐고, 조율 과정에서 합의한 세부(무의존 썸네일 경로, 충실도 단서, §22의 별도 "Imagery preview" 행, 전체 해상도의 evolution request 등록)가 모두 반영됐다. 이 축 단독 판정은 **FAIL → CONDITIONAL PASS**로 바뀐다.

**해소된 8건의 품질이 높다.** §8.4(프록시)·§8.5(Python worker 계약)·FR-ROUTE-010(네트워크 상한)·§12(layers 참조 스키마)는 권고 문안을 거의 그대로 채택했을 뿐 아니라, 제가 제시한 *근거*까지 문서에 남겼다 — 예컨대 §12 규칙 3은 "Inlining a 2,000-feature result makes the state file megabytes large"라는 실측 논거를, FR-ROUTE-010은 "The current viewport is never used as the network bound"라는 제약 이유를 본문에 담았다. 문안만 베낀 것이 아니라 왜 그런지가 남아서, 다음 수정자가 되돌리기 어렵다.

**한편 수정이 새 결함 4건을 만들었다.** 이것이 라운드 2의 핵심 소득이다. §22에 범례를 새로 달아 "모든 ✓는 해당 앱의 FR로 뒷받침돼야 한다"고 선언한 순간 **뒷받침 없는 ✓들이 드러났고**(GIS-030, 그리고 GIS-012·GIS-016의 성격이 바뀜), §8.4가 "모든 외부 요청"을 프록시로 모으면서 브라우저 fetch가 아닌 데이터 경로 둘이 회색지대에 남았으며(GIS-032), FR-ROUTE-010의 두 규칙(2 km 패딩과 100 km² 상한)이 충돌할 때의 동작이 비었다(GIS-031). 신설 문안의 기술 세부 두 가지도 실제 데이터와 어긋났다(GIS-033).

**잔존 15건의 major는 대부분 라운드 1에서 그대로 넘어온 것들이다.** Overpass 요청 예산(GIS-003), 질의 범위 상한(GIS-004), OSM JSON→GeoJSON 변환(GIS-005), Python 런타임 DoD(GIS-007), 좌표 순서 규약(GIS-014), COG 윈도우 읽기(GIS-011), 씬 정렬 전략(GIS-010) 등 Top 10에 들지 않았던 항목들이다.

---

## 집계

| 구분 | 건수 |
|---|---:|
| 이전 라운드 총계 | 29 |
| **해소 (`resolved: true`)** | **8** |
| **잔존** | **25** |
| **신규 (GIS-030~033)** | **4** |
| 문서 총계 | 33 |

### 잔존 severity 분포 (판정 기준)

| 등급 | 건수 | ID |
|---|---:|---|
| critical | **0** | — |
| major | 15 | GIS-003, 004, 005, 007, 009, 010, 011, 012, 013, 014, 016, 029, **030**, **031**, **032** |
| minor | 8 | GIS-015, 017, 018, 019, 020, 021, 026, **033** |
| info | 2 | GIS-025, 027 |

**이 축 단독 판정: CONDITIONAL PASS** (critical 0, major ≥ 1). 최종 판정은 리포터가 세 축을 병합해 낸다.

### severity 변경 2건

| ID | 변경 | 사유 |
|---|---|---|
| GIS-016 | minor → **major** | §22 범례가 "Blank = out of scope"를 새로 명시해, Route 열 Overpass 공백이 표기 누락에서 **적극적 선언**으로 바뀌었다. 신설 FR-ROUTE-010이 OSM 도로망 적재를 요구하는데 OSMnx는 Overpass를 질의하므로 구현자가 멈춘다. |
| GIS-026 | info → **minor** | §21.8이 "ANA can evolve the analysis pipeline **as illustrated in §21.7**"로 바뀌면서, 10 m 해상도로는 불가능한 건물 탐지가 §30 item 11("usable in the running app")과 묶여 **통과할 수 없는 수용 기준**이 됐다. |

---

## 해소 8건

| ID | 등급 | 해소 근거 (v1.1) |
|---|---|---|
| **GIS-001** | critical | FR-SAT-010 신설(썸네일 image overlay + 충실도 단서), §20.6 수용 기준 추가, §22 "Imagery preview" 행 신설, §20.5 전체 해상도 evolution 등록 |
| GIS-002 | major | §20.2가 Earth Search v1 + `sentinel-2-l2a`를 이름 고정, "검색과 에셋 접근 **모두** 무키" 2단계 조건, requester-pays `s3://` 배제 |
| GIS-006 | major | §8.5 Python Worker Contract 신설 — spawn/stdin·stdout JSON/봉투 스키마/60초 타임아웃/stderr 로그 전용, §21.2가 재사용 명시, §30 item 12가 DoD 연결 |
| GIS-008 | major | FR-ROUTE-010 신설 — bbox+2 km 패딩, 약 100 km² 상한, 캐싱, "viewport는 네트워크 경계로 쓰지 않는다" |
| GIS-022 | minor | FR-ROUTE-010에 `(bbox, network_type)` 캐싱 포함 |
| GIS-023 | minor | §8.4 External Data Proxy 신설 — allowlist, 브라우저 직접 호출 금지(타일만 예외), §30 item 12 |
| GIS-024 | minor | §19.7이 "avoid this road"를 진화 시연 사례로 이관 (제시한 선택지 (b)) |
| GIS-028 | major | §12 layer 요소 스키마 + 규칙 3 "Feature bodies are never inlined into state" + 메가바이트 근거 문장 |

### 해소 건에 대한 기술 사실 재확인

리더 지시대로 신설 문안의 외부 사실을 재검증했다.

- **Earth Search 엔드포인트·컬렉션 표기** — `https://earth-search.aws.element84.com/v1`에 무인증 `POST /search`가 HTTP 200으로 응답하고 `sentinel-2-l2a` 컬렉션 id 표기도 실제와 일치한다. §20.2 표기는 정확하다.
- **100 km² 상한의 적정성** — 10 km × 10 km로, 대전 시 전체 약 539 km² 대비 도심 통근 규모 라우팅을 담기에 합리적이다. 다만 상한 초과 시 동작이 비어 GIS-031로 발행했다.
- **썸네일 에셋 존재 여부** — 존재한다. 다만 **`overview` 키는 없다**. 아래 GIS-033 참조.

---

## 신규 4건 (수정이 만든 결함)

### GIS-030 (major, §22) — 새 범례를 표 자신이 위반한다

v1.1은 §22에 범례를 달아 *"every ✓ must be backed by at least one FR in that app's section"* 을 자기 기준으로 선언했다. 그런데 같은 개정에서 추가된 "Imagery preview" 행은 Satellite와 **Change Detection 두 열**에 ✓를 주는데, §21.5의 FR-CD-001~011에는 이미지 미리보기 요구가 하나도 없다.

구조 축 STR-039와 동일 결함이므로 병합한다. structure가 요청한 A/B 판단(CD에서 before/after 썸네일을 실제로 보여줄 필요가 있는가)에 대한 **GIS 축 판정은 (B) CD 열의 ✓ 제거**다.

**근거는 썸네일 해상도다(실측).** Sentinel-2 STAC 아이템의 `thumbnail`은 **343 × 343 px**이고 MGRS 타일 한 변이 109.8 km이므로 **픽셀당 약 320 m**다. 변화 탐지가 산출하는 폴리곤은 이보다 훨씬 작다.

| 변화 영역 | 한 변 | 썸네일에서 |
|---|---:|---:|
| 4.0 km² | 약 2,000 m | 약 6 px |
| 0.6 km² | 약 775 m | 약 2 px |
| 0.12 km² | 약 346 m | 약 1 px |

게다가 CD의 AOI는 통상 타일 전체가 아니라 그 일부이므로(윈도우 부분 읽기, GIS-011) 5 × 5 km AOI는 썸네일에서 약 15 × 15 px이다. **(A)를 정당화할 유일한 목적인 "변화 폴리곤의 육안 검증"을 썸네일 충실도로는 달성할 수 없고**, 판정 가능한 수용 기준도 만들 수 없다(무엇이 보이면 통과인가?).

> **나중에 장면 대조를 넣고 싶다면 올바른 형태는 썸네일이 아니다.** Python worker가 이미 AOI 윈도우를 읽고 있으므로(FR-CD-004), 같은 창으로 `visual` 에셋을 읽어 AOI 크기의 작은 PNG를 만들어 오버레이하면 해상도 문제가 원천 해결된다. 다만 v1 범위 밖이며 §20.5의 evolution request 경로로 보내는 것이 §14의 점진 도입 원칙에 맞다.

> 같은 범례 기준으로 보면 Leaflet map·Marker·GeoJSON 행도 앱 2~7에서 대응 FR이 없다. 구조 축 전수 점검 결과 **미뒷받침 셀이 25개**이며, 이 부분은 기존 STR-013 등에 귀속되어 별도 발행하지 않는다.

### GIS-031 (major, §19.4) — 100 km² 상한과 2 km 패딩이 충돌할 때가 비어 있다

FR-ROUTE-010은 분석 영역을 "origin·destination·대상의 bbox + 2 km 패딩"으로 *결정*하면서 동시에 "약 100 km²"로 *제한*한다. 출발지·목적지가 대각선으로 약 12 km 이상 떨어지면 패딩 포함 bbox가 이미 상한을 넘는다(대각 20 km면 약 18 × 18 = 324 km²). 이때 거부하는지, 잘라내는지, 상한을 무시하는지가 없다.

구현자 A가 거부하고 B가 잘라내면 같은 요청에 다른 답이 나오고, **B의 사용자는 "경로 없음"을 네트워크 범위 탓이 아니라 실제 도로 단절로 오해한다.** 초과 시 거부 + 가시적 사유(§25)를 명시해야 한다. 덧붙여 이 상한은 사실상 경로 길이 상한(대각 약 12 km)이며, 이는 §5 Non-Goals의 "a global routing service가 아니다"와 정합적이므로 문서에 드러내는 편이 정직하다.

### GIS-032 (major, §8.4) — 프록시 규칙이 브라우저 fetch만 전제한다

§8.4의 첫 문장은 "asset downloads"를 포함한 **모든** 외부 요청에 프록시를 강제하고, 둘째 문장은 금지 대상을 **브라우저**로 한정한다. 두 문장의 범위가 달라 실제 데이터 경로 둘이 회색지대에 남는다.

1. **Python worker의 COG 읽기** — rasterio가 HTTP Range로 AOI 창만 읽는 것이 표준인데(GIS-011), 프록시 대상인지 불명확하다. 대상이라면 프록시가 Range 헤더와 206 응답을 그대로 전달해야 하고, 그러지 않으면 **부분 읽기가 조용히 전체 파일 다운로드로 퇴화한다**(밴드당 수백 MB). 대상이 아니라면 첫 문장과 어긋난다.
2. **브라우저 이미지 오버레이** — FR-SAT-010의 썸네일은 `L.imageOverlay`가 `<img>`로 로드하므로 브라우저의 서드파티 직접 호출이다. 예외는 basemap 타일뿐인데, 신설된 두 절이 서로를 참조하지 않는다.

§8.4에 "규칙은 브라우저와 Python worker 모두를 구속하며, **프록시는 `Range` 요청 헤더와 `206 Partial Content` 응답을 변형 없이 전달한다**"를 넣어야 한다. 이 요구는 GIS-011과 한 쌍이며, **둘 중 하나만 고치면 성능 요구가 조용히 무력화된다.**

### GIS-033 (minor, §20.3) — FR-SAT-010의 구현 세부 둘이 실제 데이터와 어긋난다

방향은 옳지만 두 세부가 실제와 다르다. 대전 AOI의 실제 아이템(`S2B_52SCF_20250725_0_L2A`)으로 확인했다.

1. **에셋 키** — `thumbnail`(image/jpeg, 공개 https)은 있으나 **`overview`라는 키는 없다.** "thumbnail/overview"를 키 후보로 읽은 구현자는 없는 키를 찾게 된다.
2. **정렬 기준** — STAC Item의 geometry는 UTM 정사각 타일이 위경도로 투영된 **사변형**이고 축 정렬 직사각형이 아니다. 반면 `L.imageOverlay`는 직사각형 bounds만 받는다. 따라서 "aligned to the scene footprint"는 문자 그대로 구현할 수 없고, 실무 대안인 `item.bbox` 사용 시 **코너에서 최대 약 2.6 km 어긋난다**(bbox 대각 158 km의 약 1.6%).

오차는 명시하되 허용하는 편이 낫다 — FR이 이미 "scene-level visual context, not analysis-grade imagery"로 충실도를 한정했고 110 km 타일에서 1.6%는 그 목적에 부합한다. 한 줄 단서를 남기면 구현자가 정확한 정합을 쫓다가 §14에 없는 회전 오버레이 플러그인을 도입하는 일을 막을 수 있다(ANA-007의 vendored 제약과도 맞물린다).

---

## 잔존 major 11건 (라운드 1에서 이월)

| ID | 섹션 | 요약 | v1.1 변화 |
|---|---|---|---|
| GIS-003 | §16 | Overpass 요청 예산(병합·스로틀·backoff) 부재, §25에 rate limit 범주 없음 | 없음. 단 FR-EXP-008이 카테고리를 한 레지스트리로 모아 **병합 쿼리 구현이 오히려 쉬워졌다** |
| GIS-004 | §26.1 | 질의 범위 하한도 캡 초과 동작도 없음 | 없음 |
| GIS-005 | §14 | Overpass는 OSM JSON 반환 — GeoJSON 변환 계층 미선언 | 없음. FR-EXP-008은 태그 매핑만 다룸 |
| GIS-007 | §9/§30 | Python 런타임·requirements.txt·런타임 버전이 DoD에 없음 | **근거 강화** — §8.4를 npm 의존성 0으로 구현하려면 전역 `fetch`(Node 18+)가 필요해 Node 버전 명시가 §8.4 이행의 전제가 됐다 |
| GIS-009 | §19.4 | FR-ROUTE-005는 조건부인데 FR-ROUTE-007·§19.5는 travel time을 무조건 요구 | **부분 개선** — §19.7은 조건절과 맞춰졌으나 FR-007의 무조건 요구는 그대로 |
| GIS-010 | §21.5 | FR-CD-003에 정렬 단순화 전략(동일 MGRS 타일) 없음 | 없음 |
| GIS-011 | §21 | COG 윈도우 부분 읽기 요구 없음 | **긴장 증가** — §8.4의 "asset downloads" 프록시 강제와 맞물림(GIS-032) |
| GIS-012 | §21.5 | App 7의 씬 획득 FR 부재 | **위반이 명시적이 됨** — §22 범례가 "모든 ✓는 FR로 뒷받침"을 선언했는데 CD 열의 STAC ✓·Sentinel-2 ✓가 이를 위반 |
| GIS-013 | §17.3 | Turf.js에 폴리곤–폴리곤/폴리곤–라인 거리 함수 없음 | 없음 |
| GIS-014 | §12 | 좌표 순서 규약 미선언 | **표면 증가** — layer 스키마에 `"bbox": []`가 추가돼 Leaflet/GeoJSON 순서가 섞이는 지점이 하나 더 생김 |
| GIS-029 | §16.3 | 카테고리 레지스트리 | **부분 해소** — FR-EXP-008로 레지스트리 요구는 반영. 잔존: (1) 태그 값이 PRD에 고정되지 않아 bus station→`amenity=bus_station`(대전 7건) 함정이 그대로, (2) §17.4의 `subway_station`이 §16.3에 없어 **신설 FR-EXP-008을 위반** |

## 잔존 minor 8건 · info 2건

GIS-015(§18.2 slope·solar), GIS-017(ODbL·타일 정책 — §8.4가 타일을 유일한 직접 호출 예외로 두면서 근거가 보강됨), GIS-018(isochrone 방법 — §19.7이 세 구간 모두 요구로 강화됐으나 방법은 여전히 미정), GIS-019(NDVI 밴드·에셋 키), GIS-020(baseline 04.00 오프셋 — §20.2가 `sentinel-2-c1-l2a` 회피 경로를 열었으나 기본값은 그대로), GIS-021(면적 계산 좌표계), GIS-026(건물 탐지 — 위 승격), GIS-033(신규), GIS-025·GIS-027(info).

---

## 타 축 확인 요청 (handoff)

라운드 1의 handoff 10건은 모두 회신·조율 완료됐다. 라운드 2 신규는 1건이다.

| ID | 대상 | 사유 |
|---|---|---|
| GIS-030 | prd-structure-auditor | §22 범례를 표 자신이 위반. Imagery preview 외에 Leaflet map·Marker·GeoJSON 행도 앱 2~7에서 뒷받침 FR이 없어 동일 문제 — 매트릭스 전반 점검은 구조 축 사안 |

라운드 1의 handoff 표기(GIS-007·012·014·016·017·026·029)는 조율 완료 기록으로 유지한다.

### 별도 발행하지 않은 접합 1건 — 구조 축 STR-042가 커버

§12가 전제하는 피처 서빙 엔드포인트(`resultRef: "/api/results/poi-cafe"`, 428행)가 **§8.3의 `server.js` 책임 목록에 없다.** 목록은 정적 서빙 / state 읽기·쓰기 API / 채팅 inbox·feed API / agent 응답 엔드포인트 / 외부 데이터 프록시 다섯 개뿐이다(256~260행). 구조 축 STR-042(major)가 이를 정확히 커버하며, 거기에 더해 §8.2의 `stateVersion`과 §12의 `resultVersion` 사이 관계가 미정이라는 점까지 다룬다 — 피처 본문이 바뀌었을 때 `stateVersion`도 올라가는지가 정해지지 않으면 폴링 클라이언트가 결과 갱신을 놓친다. 병합본에서는 STR-042를 정본으로 삼고, GIS-028을 그 전제(§12 참조 스키마)를 제공한 건으로 인접 배치하면 된다.

### STR-043 병합 판정 (구조 축 이관 회신)

STR-043(§8.5의 "§9 독립성 유지" 단언 vs Python 매니페스트 부재)은 **GIS-007과 병합하되, "§8.5가 §9와 모순된다"는 프레이밍은 빼야 한다.**

§9의 조작적 정의는 *"must work **without depending on another app directory at runtime**"*(305행)이다. spawn 방식 워커는 다른 앱 디렉터리에 의존하지 않으므로, §8.5의 단언(283행)은 **그 정의 아래에서 참이다.** 라운드 1에서 구조 축이 "지적 대상을 §9의 예시가 아니라 정의 문장에 두라"고 조언했는데, 같은 원칙을 §8.5에 적용하면 반박 가능한 지점이 사라진다.

따라서 병합본의 지적은 **§30에 고정해야 한다** — 파일 목록(1738~1745행)에 Python 매니페스트도 런타임 버전 명시도 없다는 것이 반박 불가능한 결함이다. §32 항목 6이 README에 "dependencies"를 요구하지만(1813행) 이는 산문 서술일 뿐 설치 가능한 매니페스트가 아니다.

---

## 라운드 2 외부 사실 확인 기록

새 주장만 재확인했다(2026-08-10).

- **Earth Search `sentinel-2-l2a` 아이템의 에셋 목록** — `thumbnail`(image/jpeg), `visual`·`red`·`nir` 등 COG, JP2 변형까지 확인. **`overview` 키는 없음** — GIS-033 근거 (confidence: high)
- **STAC Item geometry의 형상** — 5정점 폴리곤이지만 축 정렬 직사각형이 아님. `item.bbox` 기준 오버레이 시 코너 최대 2.6 km 오정합(bbox 대각 158 km 대비 1.6%) — GIS-033 근거 (confidence: high)
- **무인증 STAC 검색** — `POST /v1/search`가 키 없이 HTTP 200 응답 — GIS-002 해소 근거 (confidence: high)

라운드 1에서 확인한 사실(Overpass 슬롯 2개·실패 3종, Sentinel-2 baseline 오프셋, OSMnx의 Overpass 경유, 대전 POI 태그별 실측 건수)은 재사용했다. **33건 전부 confidence high다** — 미확인 영역은 confidence를 내리는 대신 해당 recommendation 안에 문장 단위로 격리했다.
