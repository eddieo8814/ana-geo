# GIS 기술 실현성 검수 — ANA Geo PRD.md v1.2 (라운드 3)

**검수 축:** GIS 기술 실현성 (gis-feasibility) · **검수 범위:** `scope: "full"`
**대상 문서:** `PRD.md` Draft v1.2, 2,019행 (v1.1 대비 +39행)
**검수 일자:** 2026-08-11 · **원시 데이터:** `03_gis_findings.json` (해소 누적 포함 35건)
**이전 라운드:** `_workspace/prd-review_r2/03_gis_findings.json` (활성 25)

---

## 총평

**라운드 2 신규 4건이 모두 해소됐다.** GIS-030(Imagery preview CD ✓)·GIS-031(상한 초과 동작)·GIS-032(프록시 Range 전달)·GIS-033(FR-SAT-010 세부)이 전부 닫혔고, 잔존이던 GIS-012·GIS-016·GIS-026까지 더해 **이번 라운드 해소는 7건**이다. 수정의 정확도가 높다 — 특히 §22에 **행별 뒷받침 FR 목록**을 붙여 범례가 선언한 규칙을 독자가 직접 검증할 수 있게 만든 것, FR-ROUTE-010의 거부 조항에 "so an over-cap request cannot be mistaken for a road disconnection"이라는 *이유*를 남긴 것은 문안만 고친 것이 아니라 판단 근거를 보존한 처리다.

**신규는 2건뿐이고, 하나는 앞선 수정의 부작용이다.** §22의 미뒷받침 ✓ 문제를 v1.2는 두 방식으로 처리했다 — FR을 신설하거나(Route·Search·CD) ✓를 제거하거나(Site). 앞의 방식은 잘 작동했지만 **Site에 적용한 뒤의 방식이 데이터 경로를 끊었다**(GIS-034). §18.4가 필수로 명명한 `roadDistance`·`residentialDistance`를 공급할 출처가 문서에서 사라졌는데, 각주가 제시한 대체 경로("prior apps' exported results")로는 도로·토지이용이 흐르지 않는다. 라운드 2에서 관찰한 "수정이 새 결함을 만든다"는 패턴이 이번에도 재현됐으나, 건수는 4 → 2로 줄었다.

**활성 major 11건 중 9건은 라운드 1부터의 이월분이다.** Overpass 요청 예산(GIS-003), 질의 범위(GIS-004), OSM JSON 변환(GIS-005), Python 매니페스트(GIS-007), travel time 모순(GIS-009), 씬 정렬(GIS-010), 윈도우 읽기(GIS-011), Turf 거리(GIS-013), 좌표 규약(GIS-014), 카테고리 레지스트리(GIS-029)로, Top 10 밖이라 세 라운드 연속 손대지 않은 항목들이다.

---

## 집계

| 구분 | 건수 |
|---|---:|
| 라운드 2 활성 | 25 |
| **이번 라운드 해소** | **7** |
| **잔존** | **18** |
| **신규 (GIS-034, 035)** | **2** |
| **활성 계** | **20** |
| 문서 총계(해소 누적 15 포함) | 35 |

### 활성 severity 분포

| 등급 | 건수 | ID |
|---|---:|---|
| critical | **0** | — |
| major | 11 | GIS-003, 004, 005, 007, 009, 010, 011, 013, 014, 029, **034** |
| minor | 7 | GIS-015, 017, 018, 019, 020, 021, **035** |
| info | 2 | GIS-025, 027 |

**이 축 단독 판정: CONDITIONAL PASS** (critical 0, major ≥ 1). 라운드 2와 동일하나 major가 15 → 11로 줄었다.

---

## 이번 라운드 해소 7건

| ID | 등급 | 해소 근거 (v1.2) |
|---|---|---|
| GIS-012 | major | FR-CD-012 신설 — CD가 자체 STAC 검색으로 씬 획득, §21.8 수용 기준·§22 뒷받침 목록 연결 |
| GIS-016 | major | §22 Route 열에 OSM·Overpass·POI discovery ✓ + 뒷받침 목록에 "(OSMnx queries Overpass internally)" 명시 |
| GIS-026 | minor | §21.7에 10 m 해상도 한계 단서, §21.8 진화 기준을 "within Sentinel-2's capabilities (NDBI/NDWI, direction-filtered)"로 교체 |
| GIS-030 | major | §22 Imagery preview 행에서 CD ✓ 제거(방향 B), 뒷받침 목록이 Satellite 단독을 가리킴 |
| GIS-031 | major | FR-ROUTE-010에 초과 시 가시적 거부 + "절대 조용히 자르지 않는다" + 근거 문장 |
| GIS-032 | major | §8.4에 `Range`·`206` 무변형 전달 필수 + 워커의 allowlist 적용 범위 명시 |
| GIS-033 | minor | FR-SAT-010이 `thumbnail` 특정(`overview` 삭제)·bbox 배치·코너 오차 허용 명시 |

---

## 리더 질의 3건에 대한 답

### Q1. §8.4 Range 전달 요구는 충분한가 — GIS-011 쌍이 해소됐는가

**전송 계층 절반만 해소됐다. GIS-011은 잔존이다.**

§8.4의 새 문장은 프록시가 부분 읽기를 *깨지 않을* 것을 요구하지만, 부분 읽기를 *하라*고 요구하지 않는다. 문장이 "raster window reads **depend on** range requests", "their range reads **must remain** partial reads"처럼 이미 부분 읽기를 하고 있다고 전제한다. grep으로 확인한 결과 window·partial read·range 관련 문구는 PRD 전체에서 §8.4 한 곳뿐이며 §21의 FR-CD-001~012에도 §26.2에도 없다.

따라서 **전체 장면을 내려받아 crop하는 구현은 §8.4를 위반하지 않는다** — 보존할 range read 자체가 없기 때문이다. §21에 FR 한 줄(`FR-CD-013 — Windowed Read`)을 넣어야 §8.4의 전송 요구가 보호할 대상을 갖는다.

### Q2. FR-SEARCH-011의 Overpass 부하 함의 — GIS-003과의 관계

**GIS-003의 적용 대상이 1개 앱에서 3개 앱으로 늘었다.**

FR-SEARCH-011이 Search를 Overpass 소비자로 정식 편입시켰고 §22가 Search 열에 Overpass ✓를 부여해 확정했다. 부하는 Explorer보다 나쁠 수 있다 — §17.4 조건 모델 예시 하나가 target(cafe) + reference 2종(university, subway_station) = **카테고리 3종 질의**를 요구하고, §17.6의 상호작용("Change that to 3 km.")은 조건을 고칠 때마다 재취득을 유발한다. 여기에 GIS-016 해소로 Route까지 Overpass 소비자가 됐다.

따라서 요청 예산 요구는 §16의 앱별 FR이 아니라 **§8 공유 계약에 두어야 한다.** §8.4가 이미 "concentrates throttling, caching, and provenance recording in one place"라고 프록시를 스로틀 지점으로 지목했으므로, 거기에 규칙(동시 1건·debounce 300 ms·429/502/504 backoff·상태 코드만으로 성공 판정 금지)을 추가하는 것이 최소 수정이다.

### Q3. FR-CD-012는 §9 자체 구현 요구와 실현성이 양립하는가

**양립한다. 해소 판정에 문제없다.**

STAC 검색은 단일 HTTP POST(`/v1/search`)에 JSON 바디이고 라운드 2에서 무인증 200 응답을 확인했으므로, 앱 7이 앱 6의 검색을 재구현하는 비용은 낮고 새 의존성도 없다. 참조 범위를 **FR-SAT-001~009로 끊어 FR-SAT-010(미리보기)을 제외한 것**도 §22에서 CD의 Imagery preview ✓를 뺀 결정(GIS-030)과 정확히 일관된다 — 두 수정이 서로 어긋나지 않았다.

---

## 신규 2건

### GIS-034 (major, §22) — Site의 데이터 경로가 끊겼다

v1.2는 §22의 미뒷받침 ✓ 문제를 Site 열의 OSM·Overpass·POI discovery ✓를 **제거**해 해소하고 각주로 정당화했다. 그런데 각주가 제시한 두 경로 중 어느 것도 §18이 스스로 명명한 지표를 공급하지 못한다.

- **"loaded GeoJSON"** — 사용자가 도로망과 주거지 폴리곤을 제품 밖에서 준비해야 한다는 뜻인데, §18 어디에도 요구로 적혀 있지 않고 §33 데모의 전제로도 서술되지 않았다.
- **"prior apps' exported results"** — Explorer/Search가 내보낼 수 있는 것은 §16.3 레지스트리의 10종뿐이고 전부 `amenity`류 포인트 POI다. **도로 선형도 주거지 토지이용도 레지스트리에 없다.**

그런데 §18.4는 `roadDistance`·`residentialDistance`를 결과 모델의 필드로 보이고, §18.2는 hard constraint 예시로 "Distance from residential area >= 1 km"를, §33은 Site 데모로 "university proximity, **roads, and residential separation**"을 지정한다. §18.6은 'land use data'를 optional·future로 분류한다. **문서가 필수 지표로 제시한 것의 출처가 문서 안에서 optional이거나 아예 없다.**

**GIS 축 판정: (A) Site에 취득 FR 신설 + §22 ✓ 복원. 단 레지스트리가 도로를 주요 등급으로 한정해야 한다.**

구조 축이 확인한 두 사실이 근거를 굳혔다 — §18.6 목록에 OSM·Overpass가 없어 각주의 인용이 근거가 되지 못하고, `export`는 PRD 전체에서 이 각주 한 곳뿐이라 정의되지 않은 메커니즘을 유일한 입력 경로로 제시한 셈이다.

실현성은 태그 필터의 정밀도에 달려 있고, 정밀하게 쓰면 성립한다(대전 도심 약 10 × 11 km bbox 실측, 2026-08-11):

| 태그 셀렉터 | way 수 | §26.1 캡(2,000) |
|---|---:|---|
| `highway=*` | 21,097 | **10배 초과** |
| `highway~"^(motorway\|trunk\|primary\|secondary)$"` | **1,544** | 이내 |
| `landuse=residential` | 303 | 이내 |

PRD 자신의 어휘도 이를 뒷받침한다 — §33의 Route 데모가 이미 "the nearest **major road** or station"이라고 쓴다.

**레지스트리 일반화 질문에 대한 답**: (A)를 택하면 FR-EXP-008을 POI 목록이 아니라 **feature class registry(키 · 태그 셀렉터 · 기대 지오메트리 3열)로 일반화**하는 것이 맞다 — 도로는 선형, 주거지는 면형이라 POI 프리셋 개념에 담기지 않는다. GIS-029가 요구한 작업과 동일하므로 한 번에 처리된다.

**병합본 권고 확정 — (A) 정본 + (B) 병존 + 데이터 품질 단서.** 두 안 중 하나를 고르는 문제가 아니라 역할이 다르다. 데이터 품질까지 재고 나서 확정했다.

**도로는 (A)로 충분하지만, 주거지는 (A)만으로는 위험하다.** 같은 bbox에서 `landuse=residential`은 303 폴리곤·합집합 **9.83 km²로 100.23 km² bbox의 9.8%**만 덮는다(폴리곤 중앙값 27,143 m²). 인구 약 145만 도시의 실제 주거지 비율은 이보다 훨씬 높으므로 **OSM 주거지 토지이용 커버리지가 성기다.** 결과적으로 `residentialDistance`는 체계적으로 편향된다 — 매핑되지 않은 주거지 한가운데 있는 후보가 "주거지에서 멀다"로 계산된다.

**이 편향이 가장 위험한 자리가 하필 §18.2의 hard constraint**("Distance from residential area >= 1 km")다. pass/fail 판정은 틀려도 사용자가 알아채지 못하는 형태로 나오며, 이는 심각도 사다리의 "틀린 걸 모르고 지나간다" 유형이다.

따라서 병합본은 셋을 함께 요구해야 한다.

1. 취득 FR 신설 + 레지스트리 등록 — `major_road: highway~"^(motorway|trunk|primary|secondary)$" (line)`, `residential: landuse=residential (area)` **(=A)**
2. FR-SITE-011을 역할 태깅된 GeoJSON 입력 경로로 **병존** — 권위 있는 토지이용 데이터가 있으면 OSM 취득분을 대체. §24.4·§28을 위해 역할별 파일에 출처 메타데이터 요구 **(=B)**
3. **OSM 유래 주거지 지표를 hard constraint의 단독 근거로 쓰지 않는다** — soft criterion으로 두거나, hard로 쓸 경우 §23.3 설명에 커버리지 한계를 노출

> 대안 태그(`building=residential|apartments` 계열)의 커버리지가 더 나은지는 Overpass 응답 실패로 측정하지 못했다 — 채택 전 확인이 필요하다.

### GIS-035 (minor, §25) — 새 오류 유형이 참조하는 범주가 목록에 없다

FR-ROUTE-010은 상한 초과를 "(§25)"로 넘기면서 그 이유를 "so an over-cap request cannot be mistaken for a road disconnection"이라고 명시한다. 그런데 §25의 필수 범주 목록은 v1.0 이래 동일해 대응 항목이 없다. **구현자가 이 오류를 목록의 기존 항목(가장 그럴듯한 것은 "external API unavailable")으로 표시하면, FR-ROUTE-010이 막으려던 바로 그 오해가 발생한다.** 같은 이유로 GIS-003이 요청한 rate limit 범주도 여전히 없다.

§25에 두 항목을 추가하고, 목록이 닫힌 집합이 아님을 한 줄로 밝히면 향후 같은 누락이 반복되지 않는다.

---

## 잔존 major 10건 (이월)

| ID | 섹션 | v1.2에서의 변화 |
|---|---|---|
| GIS-003 | §16 | **노출 확대** — FR-SEARCH-011로 Search가, GIS-016 해소로 Route가 Overpass 소비자로 편입. 요구를 §8.4로 올려야 함 |
| GIS-004 | §26.1 | **신설 FR이 미정의 용어에 의존** — FR-SEARCH-011의 "within the analysis area"가 Search에는 정의되지 않음. Route는 FR-ROUTE-010이 정의 |
| GIS-005 | §14 | **필요 지점 증가** — FR-SEARCH-011로 OSM JSON→GeoJSON 변환이 Explorer·Search 두 앱에서 각각 필요(§9가 import 금지) |
| GIS-007 | §30 | **성격 명료화** — §8.5가 "the Python runtime … remains an installation prerequisite **declared per §30**"을 추가했으나 §30에 그 선언 자리가 없음. 구조 축 STR-043과 병합 중 |
| GIS-009 | §19.4 | 변화 없음 |
| GIS-010 | §21.5 | 변화 없음 |
| GIS-011 | §21 | **부분 해소** — 전송 계층은 §8.4로 해결, 앱 계층(윈도우 읽기 요구) 잔존. 위 Q1 참조 |
| GIS-013 | §17.3 | **범위 축소 + 근거 강화**(자체 정정) — Turf 7.3의 `pointToPolygonDistance` 추가로 점–폴리곤은 네이티브 지원. 잔존은 **폴리곤 후보**뿐. 한편 v1.2의 FR-SITE-006이 "computed with **Turf.js**"로 라이브러리를 못박으며 라인·폴리곤 대상 지표를 명명해 지적은 오히려 날카로워짐 |
| GIS-014 | §12 | **표면 증가** — map 블록이 `view`/`observedView`로 재구성됐으나 좌표 규약은 여전히 없고, `observedView: null`은 좌표 표현 자체가 미정 |
| GIS-029 | §16.3 | **위반 이중화** — `subway_station`이 FR-EXP-008에 더해 신설 FR-SEARCH-011("same registry keys")까지 위반 |

## 잔존 minor 6건 · info 2건

GIS-015(§18.2 예시 — GIS-034가 데이터 경로를 정리하면 자연히 닫힘), GIS-017(§10.1 주어가 "Every application"으로 바뀌어 타일 정책·ODbL 준수가 7개 앱 공통 요구가 됨 — 근거 강화), GIS-018·019·020·021(변화 없음), GIS-025·027(info).

---

## 타 축 확인 요청 (handoff)

| ID | 대상 | 사유 |
|---|---|---|
| **GIS-034** | prd-structure-auditor | §22 각주의 "prior apps' exported results"가 §9(코드 import 금지, 산출물 전달은 허용)와 어떻게 맞물리는지, 그리고 매트릭스 ✓ 제거로 결함을 해소하는 방식의 일반적 위험 |
| GIS-007 | prd-structure-auditor | STR-043과 병합 진행 중 |
| GIS-014, 017 | prd-ana-alignment-reviewer | 라운드 1~2 조율 기록 유지 |
| GIS-029 | prd-structure-auditor | 어휘 정본 사안 |

---

## 라운드 3 사실 확인 기록

- **STAC 검색의 자체 재구현 비용** — 단일 `POST /v1/search` + JSON 바디, 무인증 200 확인(라운드 2 실측 재사용). FR-CD-012 실현성 확인 근거
- **§16.3 레지스트리의 커버리지** — 프리셋 10종이 모두 `amenity`류 포인트이며 도로·토지이용을 포함하지 않음(원문 대조). GIS-034 근거
- **부분 읽기 요구의 소재** — window·partial read·range 문구가 PRD 전체에서 §8.4 한 곳뿐임(grep 전수). GIS-011 잔존 판정 근거
- **Turf.js 거리 함수 현황(재확인)** — 7.3.0에 `pointToPolygonDistance`가 추가되어 점–폴리곤이 네이티브 지원됨(내부는 음수, geodesic/planar 선택). 폴리곤–라인·폴리곤–폴리곤은 여전히 없음. **라운드 1 판단의 자체 정정 근거** — GIS-013의 범위를 폴리곤 후보로 좁혔다
- **OSM 도로·주거지 피처 규모(대전 도심 약 10 × 11 km)** — `highway=*` 21,097 way, 주요 등급만 1,544 way(7.3%), `landuse=residential` 303 way. GIS-034의 (A) 실현성 판정 근거

라운드 1~2에서 확인한 외부 사실(Overpass 슬롯·실패 3종, 대전 POI 태그별 건수, Sentinel-2 썸네일 343 × 343 px, baseline 오프셋, Earth Search 무인증)은 재사용했다. **35건 전부 confidence high**이며, 미확인 영역은 해당 recommendation 안에 문장 단위로 격리했다.
