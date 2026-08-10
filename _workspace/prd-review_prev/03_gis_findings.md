# GIS 기술 실현성 검수 — ANA Geo PRD.md

**검수 축:** GIS 기술 실현성 (gis-feasibility)
**검수 범위:** `scope: "full"` — N1(브라우저 GIS) · N2(Overpass) · N3(OSMnx/NetworkX) · N4(STAC/Sentinel-2) · N5(래스터 처리) · N6(의존성 단계 전략) 전부
**대상 문서:** `/Users/tykimos/ana/ana-geo/PRD.md` (Draft v1.0, 1,856행)
**검수 일자:** 2026-08-10 (라운드 1)
**원시 데이터:** `03_gis_findings.json`

---

## 총평

**PRD가 고른 스택은 요구를 감당한다.** Leaflet·Turf.js·OSMnx·NetworkX·STAC·rasterio 조합으로 7개 앱의 기능 요구를 구현하는 데 원리적 장벽은 없고, §13의 데이터 소스 여섯 개는 모두 API 키 없이 접근하는 경로가 존재해 §27.7과 §3.3 Own Your Harness가 데이터 측면에서 성립한다(GIS-027). 브라우저→Python 전환점을 route와 change-detection에 둔 §14의 판단도 타당하다.

**문제는 '가능한가'가 아니라 '어디까지, 어떻게'가 비어 있다는 점이다.** findings 27건 중 다수가 같은 형태를 띤다 — 요구가 *무엇을* 만들지는 말하지만, 외부 서비스의 실제 제약(Overpass 슬롯 2개, 씬 하나에 밴드당 수백 MB, 그래프 다운로드 GB급 메모리) 아래에서 *어떤 한계로* 만들지는 말하지 않는다. 이 공백은 구현자가 순진하게 구현했을 때 정확히 실패하는 지점들이다.

**판정에 영향을 주는 것은 critical 1건이다.** `ana-geo-satellite`는 자기 핵심 질문("What did this place look like at a given time?")에 답하는 요구를 갖고 있지 않다 — footprint와 메타데이터만 요구하고 픽셀을 화면에 그리라는 FR이 없다.

---

## 심각도 분포

| 등급 | 건수 | ID |
|---|---:|---|
| critical | 1 | GIS-001 |
| major | 15 | GIS-002 ~ GIS-014, GIS-028, GIS-029 |
| minor | 10 | GIS-015 ~ GIS-024 |
| info | 3 | GIS-025 ~ GIS-027 |
| **합계** | **29** | |

> GIS-028·GIS-029는 라운드 1 이후 타 축의 교차 질의(ana의 ANA-001 폴링 페이로드, structure의 STR-032 태그 매핑)에 답하며 실측으로 확인된 건이다.

공통 판정 규칙(§최종 판정 규칙)에 따르면 critical ≥ 1이므로 이 축 단독으로는 **FAIL**이다. 최종 판정은 리포터가 세 축을 병합해 내린다.

---

## Critical

### GIS-001 — 위성 앱이 영상을 보여주지 않아도 수용 기준을 통과한다 (§20.3, §20.6)

FR-SAT-001~009는 AOI 정의, 날짜·구름 필터, STAC 검색, **footprint 표시**, 메타데이터 표시, 씬 선택까지만 요구한다. 실제 영상 픽셀을 지도에 렌더링하라는 요구가 없고, §20.6 수용 기준에도 없다. 그대로 구현하면 사각형 경계와 메타데이터만 보여주는 카탈로그 브라우저가 완성되며 모든 수용 기준을 통과한다. 그런데 §20.1의 핵심 질문과 §35의 성공 기준("I can observe the Earth at a point in time")은 영상을 전제한다.

구현 경로는 두 가지이고 비용이 다르다 — STAC Item의 `thumbnail`/`overview` 에셋을 Item geometry bbox에 맞춰 `L.imageOverlay`로 올리면 **의존성 추가 없이** 해결되고, 전체 해상도가 필요하면 `visual` COG를 georaster-layer-for-leaflet으로 렌더링해야 하는데 이는 §14 브라우저 의존성 목록에 없는 새 라이브러리다. PRD가 이 선택을 하지 않으면 구현자 A와 B가 다른 앱을 만든다.

---

## Major (13건)

### 외부 서비스 제약이 요구에 반영되지 않음

- **GIS-003 — Overpass 요청 예산 부재 (§16.3, §16.4)**
  공용 Overpass 인스턴스는 사용자당 동시 슬롯이 약 2개이고 초과분은 HTTP 429로 거부된다(2026-08 웹 확인). §16.3이 POI 10종, FR-EXP-006이 동시 표시, FR-EXP-001이 viewport 검색을 요구하므로, 순진한 구현은 지도를 움직일 때마다 최대 10건을 동시에 발사해 대부분 실패한다. 카테고리 병합 쿼리·in-flight 1건 제한·debounce·429 backoff가 요구로 필요하고, §25 에러 범주에 rate limit 항목이 없다.

- **GIS-004 — 질의 범위 하한도, 결과 캡 강제도 없음 (§26.1)**
  500–2,000 feature 캡 자체는 Leaflet 기본 SVG 렌더러 기준으로 타당하다. 문제는 이것이 성능 '권고'일 뿐 강제하는 FR이 없고, **질의 단계** 제한이 전무하다는 것이다. zoom 6에서 "cafe 찾기"는 렌더 캡으로 막을 수 없다 — Overpass가 먼저 죽는다. 초과 시 자르는지·경고하는지·거부하는지도 미정.

- **GIS-005 — Overpass는 GeoJSON을 주지 않는데 변환 계층이 없다 (§14, §16.2)**
  §11.1은 GeoJSON 정규화를, §16.6은 "GeoJSON-compatible layers"를 요구하지만 Overpass는 OSM JSON을 반환한다. §14의 브라우저 의존성은 Leaflet과 Turf.js뿐이라 osmtogeojson 도입 여부가 미정이다. `out center;`로 발급해 node/way center만 Point로 매핑하면 라이브러리 없이 §16.3의 10종을 다 커버할 수 있고, 폴리곤이 필요해지는 §18(site) 시점에 라이브러리를 §14에 단계 의존성으로 추가하는 것이 §14의 점진 도입 원칙에 맞다.

### Python 계층의 계약 부재

- **GIS-006 — Python worker가 다이어그램뿐이다 (§19.2)**
  프로세스 방식(spawn/HTTP/파이프), 요청·응답 스키마, 타임아웃, 에러 전파가 모두 미정이다. 같은 계약을 앱 7(rasterio)도 써야 하는데(§21.2, §26.2) 명시가 없어 두 앱이 다르게 구현될 것이 사실상 확실하다. §27.4의 "structured input rather than raw shell commands"도 계약이 있어야 검증 가능하다. **권장: `server.js`가 `python3 tools/<op>.py`를 spawn하고 stdin/stdout으로 JSON을 주고받는 방식** — 포트 관리가 불필요해 §9 독립 실행과 §27.4에 모두 부합한다.

- **GIS-007 — Python 런타임이 독립 실행 계약과 DoD에 없다 (§9, §30)**
  §9는 독립 실행을 `node server.js`로 정의하고 하필 `ana-geo-satellite`를 예시로 든다. 그러나 앱 5·7은 osmnx/geopandas/rasterio를 요구하며 이들은 GDAL/GEOS 바이너리를 동반한다. §30의 DoD 파일 목록에 `requirements.txt`가 없고, Python 환경 부재 시 동작도 정의되지 않았다.

- **GIS-008 — OSMnx 그래프 범위 상한도, route 앱 성능 요구도 없다 (§19, §26)**
  §26.1의 성능 요구는 앞 세 앱에만 적용된다. `graph_from_bbox`는 범위에 비례해 비용이 폭증하며, 알려진 사례로 LA County 도로망은 약 200만 엣지·8 GB RAM을 소모한다. §19.7의 "OSM road networks can be loaded"에는 범위 제약이 없어 시 전역 drive 네트워크를 그대로 받는 구현이 정상 통과한다.

### 요구 간 모순 / 계산 정의 공백

- **GIS-009 — 시간 최소 경로가 조건부인데 요약·계약·수용 기준은 무조건이다 (§19.4)**
  FR-ROUTE-005는 "where edge data supports it"인데 FR-ROUTE-007은 조건 없이 travel time을 요구하고, §19.5 계약은 `travelTimeSeconds`를 필수처럼 두며, §19.7은 "distance and time summaries are shown"을 수용 기준으로 삼는다. 기술적으로는 OSMnx `add_edge_speeds()`가 `maxspeed` 결측을 도로 유형별 평균으로 대체하므로 **항상 산출 가능하되 추정치**다. PRD는 '조건부 불가'와 '항상 추정치' 중 무엇인지 정해야 한다.

- **GIS-013 — Turf.js에는 폴리곤 간 거리 함수가 없다 (§17.3)**
  `turf.distance`는 점–점 전용이고 폴리곤–폴리곤/폴리곤–라인 최단거리 함수는 **존재하지 않는다**. 그런데 FR-SITE-001은 후보가 폴리곤일 수 있다 하고, §18.4는 `roadDistance`(라인)·`residentialDistance`(폴리곤)를 요구한다. 구현자가 중심점 근사·정점 근사·경계 샘플링 중 임의로 고르면 FR-SITE-009의 랭킹이 달라지는데, **아무도 틀렸음을 알아채지 못한다.** 지원 조합과 근사 규칙을 FR에 못박아야 한다.

- **GIS-014 — state 안에 좌표 순서 두 규약이 선언 없이 공존한다 (§12)**
  §12의 `center: [36.3504, 127.3845]`는 Leaflet 관례인 [위도, 경도]다(대전 좌표로는 정확하다). §11.1의 GeoJSON은 RFC 7946에 따라 [경도, 위도], §20.4의 STAC `bbox`도 경도 우선이다. 규약을 밝힌 문장이 없다. 좌표 뒤바뀜은 예외를 던지지 않고 조용히 틀리며, ANA가 state를 직접 편집하는 제품(§3.2, §24.2)이라 에이전트 오편집도 유발한다. `center`를 `{"lat":…, "lon":…}` 객체로 바꾸면 순서를 틀릴 수 없다.

### 위성/래스터 파이프라인

- **GIS-002 — STAC 공급자를 이름으로 고정하지 않았다 (§20.2)**
  "one stable STAC provider"만으로는 부족하다. AWS Earth Search(`earth-search.aws.element84.com/v1`)는 검색·https 에셋 모두 무인증이지만(2026-08 확인), Planetary Computer는 SAS 토큰 서명이, Copernicus Data Space는 계정이 필요하다. 후자를 고르면 §27.7과 §3.3이 무너진다. **§20.4의 collection id `sentinel-2-l2a`는 Earth Search의 실제 컬렉션 id와 일치하므로 그대로 두면 된다.**

- **GIS-010 — 씬 정렬에 단순화 전략이 없다 (§21.5, FR-CD-003)**
  같은 MGRS 타일이면 창 교집합만 맞추면 끝나지만, 다른 타일·다른 UTM 존이면 `rasterio.warp.reproject`와 리샘플링·타깃 그리드 결정이 줄줄이 따라온다. §4.8의 최소 의존성 목표와 긴장하는 난이도 절벽이다. **"V1은 동일 MGRS 타일·동일 CRS 쌍만 허용, 위반 시 §25의 incompatible raster data로 거부"**를 명시하면 절벽이 사라진다.

- **GIS-011 — COG 윈도우 부분 읽기 요구가 없다 (§21, §26.2)**
  Sentinel-2 L2A의 B04/B08은 각각 10 m·10980×10980으로 밴드당 수백 MB, 두 시점 × 두 밴드면 GB 단위다. rasterio는 HTTP range request로 AOI 창만 읽을 수 있고 이것이 표준인데, 요구가 없으면 '전체 다운로드 후 crop' 구현이 정상 통과한다.

- **GIS-012 — 앱 7이 씬을 어떻게 얻는지 요구가 없다 (§21.5)**
  §9는 선행 앱 코드 import를 금지하고 §22 매트릭스는 CD 열에 STAC ✓를 준다. 즉 앱 7은 스스로 STAC 검색을 해야 하는데, FR-CD-001/002는 "Select scene A/B"로 시작할 뿐 AOI·날짜·구름 필터·에셋 URL 해석 요구가 하나도 없다.

### GIS-028 — state의 `layers`가 정의되지 않아 결과를 통짜로 담는 구현이 나온다 (§12)

§12는 `"layers": []`만 보여 줄 뿐 안에 무엇이 들어가는지 정의하지 않는다. 결과 FeatureCollection을 그대로 넣는 것이 가장 자연스러운 독해인데, §26.1이 허용하는 2,000 피처에서 state가 MB급으로 부푼다. 실측(§11.1 property 모델 준수):

| 구성 | compact | 들여쓰기(사람 가독) | 2.5초 폴링 지속 대역폭 | 유휴 시간당 |
|---|---:|---:|---:|---:|
| 포인트 500개 | 229 KB | 365 KB | 1.1 Mbps | 514 MB |
| 포인트 2,000개 | 914 KB | 1,460 KB | 4.6 Mbps | 2,054 MB |
| 폴리곤 2,000개(정점 40) | 2,440 KB | 3,904 KB | 12.2 Mbps | 5,490 MB |
| **레이어 10개 참조만** | — | **2.4 KB** | **0.008 Mbps** | **3.4 MB** |

피해는 두 방향이다. 폴링 동기화에 얹으면 유휴 상태로 시간당 2 GB가 흐르고, 더 근본적으로 §12 자신의 기준인 "State must be simple enough for a coding agent to inspect and modify"가 깨진다 — §24.2의 증분 수정("2 km를 3 km로")을 하려고 에이전트가 1.4 MB 파일을 통째로 읽고 다시 써야 한다. 참조 방식(`resultRef` + `resultVersion`)이 통짜 대비 약 596배 작으며, §12 가독성·§26.1 상한·폴링 요구를 동시에 만족시키는 유일한 조합이다.

### GIS-029 — 카테고리 프리셋의 OSM 태그 매핑이 정의되지 않았다 (§16.3)

§16.3은 사람이 읽는 이름 10개만 나열하고 각각이 어떤 OSM 태그인지 정하지 않는다. 대부분은 `amenity=*`로 자명하지만 두 곳에서 실제로 갈라진다. 대전광역시 전역 실측(2026-08-10):

| OSM 태그 | 건수 |
|---|---:|
| `highway=bus_stop` | **2,554** |
| `amenity=bus_station` | **7** |
| `amenity=cafe` | 216 |
| `amenity=charging_station` | **10** |

'bus station'을 `amenity=bus_station`으로 매핑하면 광역시 전체에서 7건만 나와 레이어가 고장 난 것처럼 보이는데, §16.6 수용 기준 "at least ten POI types are supported"는 그대로 통과한다. `charging_station`은 §33이 기본 데모 지역으로 지정한 대전에서 10건뿐이라 거의 빈 레이어가 된다. 어휘는 앱 간에도 어긋난다 — §17.4 조건 모델과 §17.6이 `subway_station`을 참조하는데 §16.3 목록에는 없다.

어휘 정본이 문서 어디에도 없다는 점이 근본이다(구조 축 원문 대조). §11 공통 property 모델은 342행에서 `"category": "cafe"`라는 값 하나를 보일 뿐 열거값을 규정하지 않고, FR-EXP-002(557행)는 "Search OSM objects by category"라고만 하며, §16.3은 태그도 지오메트리도 없는 이름 목록이다. §9가 앱 간 코드 import를 금지하므로 재사용은 어휘 수준에서만 가능한데 그 어휘가 정의되지 않았다.

따라서 §16.3을 이름 목록이 아니라 **태그 셀렉터와 기대 지오메트리를 함께 적은 공유 카테고리 레지스트리**로 바꾸고, §17·§18·§19가 같은 어휘를 재사용하도록 §11 공통 데이터 모델 쪽에 두어야 한다. §31 SPEC 템플릿이 모든 앱에 "## 10. Data Model"(1670행)을 요구하므로, §11에 두면 7개 앱 SPEC이 같은 정본을 가리키게 되어 PRD 자신의 템플릿 요구와도 맞는다.

---

## GIS-003 보강 — 실측으로 확인한 Overpass 실패 3종 (2026-08-10)

대전 전역(약 0.14°×0.14°) 다중 카테고리 질의를 시도한 한 번의 측정 세션에서 실패 형태 세 가지가 모두 나왔다.

1. **HTTP 200 + `content-type: application/json`인데 본문은 XHTML 오류 문서**("The server is probably too busy")
2. HTTP 504 + XHTML 본문
3. 미러(overpass.kumi.systems)에서 HTTP 502 + 평문 (동일 질의가 120초 초과)

1번이 특히 위험하다 — 순진한 클라이언트의 `if (res.ok)` 검사를 통과한 뒤 `res.json()`이 SyntaxError로 터지므로, 사용자에게는 rate limit이 아니라 정체불명의 파싱 오류로 보인다. 따라서 §25 에러 요구에 **"상태 코드만으로 성공을 판정하지 말 것"**을 명시해야 한다. 사전 점검용으로 `https://overpass-api.de/api/status`가 남은 슬롯 수를 평문으로 반환한다(측정 시 "Rate limit: 2 / 2 slots available now" 확인).

이 관찰은 GIS-004(질의 범위 상한)의 근거이기도 하다 — 공개 미러조차 도시 규모 단일 질의를 120초 안에 처리하지 못했다.

---

## Minor (10건)

| ID | 섹션 | 요약 |
|---|---|---|
| GIS-015 | §18.2 | slope·solar irradiance 예시는 §18.6의 선택 데이터(DEM/NASA POWER) 없이는 계산 불가 — v1 가용 여부 구분 필요 |
| GIS-016 | §22 | Route 열에 OSM·POI discovery는 ✓인데 Overpass만 공란 — OSMnx가 내부적으로 Overpass를 호출하므로 rate limit 요구가 Route에도 상속됨이 감춰짐 |
| GIS-017 | §10.1, §13 | ODbL 출처 표기와 OSM Tile Usage Policy 준수 요구가 전무 — 오픈데이터 레퍼런스로서 공백 |
| GIS-018 | §19.4 | isochrone의 면 생성 방식(convex hull vs alpha shape vs 엣지 버퍼)과 적용 travel mode 미정 — convex hull은 도달 영역을 과대 추정 |
| GIS-019 | §21.5 | NDVI 밴드가 "where bands are available"로 모호 — L2A에는 B04/B08이 항상 있다. 진짜 문제는 공급자별 에셋 키(`red`/`nir` vs `B04`/`B08`)이며 `eo:bands` 공통명으로 해석해야 함 |
| GIS-020 | §21.4, §21.5 | processing baseline 04.00의 `BOA_ADD_OFFSET`(−1000 DN) 미처리 — NDVI는 곱셈 스케일은 상쇄하지만 **가산 오프셋은 상쇄하지 않아** baseline이 다른 두 시점 비교 시 허위 변화가 생김. `raster:bands` 메타데이터에서 읽거나 `sentinel-2-c1-l2a`로 통일 |
| GIS-021 | §21.5, §21.6 | 변화 면적의 계산 좌표계 미정 — 위경도에서 ㎡를 재면 조용히 틀린다. 네이티브 UTM에서 픽셀 수 × 100 ㎡로 산출 |
| GIS-022 | §19 | 도로 그래프 캐싱 요구 없음 — 재계산마다 재다운로드하면 GIS-003의 rate limit을 route 앱에서 재현 |
| GIS-023 | §27 | Overpass·STAC 호출이 브라우저 직접인지 `server.js` 프록시 경유인지 미정 — 정하지 않으면 §27.2/§27.3의 프록시·allowlist 요구가 적용 지점을 잃는다. 프록시 채택 권고이며, 그 경우 CORS 가용성이 무관해진다(아래 PoC 검증 참조) |
| GIS-024 | §19.6 | "Avoid this road." 예시에 대응 FR 없음 — 구현은 쉬우므로 FR 추가 또는 §24.3 진화 시연 사례로 이관 |

---

## Info (3건)

- **GIS-025 (§17.3)** — Turf `buffer`는 평면 근사라 대반경·고위도에서 왜곡되지만 대전(36.35°N) 도시 스케일에서는 무시 가능. **거리 판정은 버퍼 폴리곤이 아니라 `turf.distance`(측지)로 하고 버퍼는 시각화 전용으로 쓰면** 오차 영향을 아예 받지 않는다.
- **GIS-026 (§21.7)** — 건물 탐지 진화 서사는 사전학습 가중치와 서브미터 영상을 동반한다. Sentinel-2의 10 m로는 개별 건물 윤곽이 부족해 데이터 소스까지 바꿔야 하고 대부분 상용이라 §3.3과 긴장한다. 10 m에서 현실적인 다음 단계는 NDBI 같은 built-up 지수(B11은 20 m라 리샘플링 필요)나 SAR 변화 탐지다.
- **GIS-027 (§13, §26.1)** — 검수 결과 **문제가 아닌** 항목의 기록: §10.1의 Leaflet 요구 9종은 전부 코어 기능(플러그인 불요), §17.3의 Turf 연산은 점 기반인 한 전부 커버(예외는 GIS-013), 500–2,000 캡은 현실적(초과 시 `preferCanvas` 또는 클러스터링), §13의 여섯 소스는 모두 무키 경로 존재(OSM/Overpass 무인증, Earth Search 무인증, NASA POWER 무키, Copernicus DEM은 Earth Search에 포함).

---

## 타 축 확인 요청 (handoff)

| ID | 대상 | 확인 요청 사유 |
|---|---|---|
| GIS-001 | prd-structure-auditor | 핵심 질문(§20.1)·성공 기준(§35)과 FR 집합의 미대응 — 요구사항 완비성 축에서도 잡히는지 |
| GIS-002 | prd-ana-alignment-reviewer | 인증 필요 STAC 공급자 선택 시 §3.3 Own Your Harness·§27.7 위반 |
| GIS-006 | prd-structure-auditor | Python worker 계약 부재는 앱 간 공통 계약 누락 사안 |
| GIS-007 | prd-structure-auditor | §30 DoD 파일 목록의 조건부 항목 누락 |
| GIS-012 | prd-structure-auditor | §9 독립성 요구와 §21.5 FR 집합, §22 매트릭스의 3자 불일치 |
| GIS-014 | prd-ana-alignment-reviewer | ANA가 직접 편집하는 state의 규약 미선언 — 에이전트 오편집 위험 |
| GIS-016 | prd-structure-auditor | §22 매트릭스와 §19 앱 요구의 교차 불일치 |
| GIS-017 | prd-ana-alignment-reviewer | 오픈데이터 라이선스 준수와 §3.3 Own Your Harness의 관계 |
| GIS-024 | prd-structure-auditor | 상호작용 예시와 FR 집합의 미대응 |
| GIS-026 | prd-ana-alignment-reviewer | 진화 서사가 무키·오픈 원칙과 충돌 가능한 영역으로 향함 |

---

## 외부 사실 확인 기록

웹 검색으로 재확인한 항목(2026-08-10):

- Overpass 공용 인스턴스: 사용자당 슬롯 약 2개, 초과 시 HTTP 429, `[timeout:]`/`[maxsize:]` 선언과 소규모 요청 우선 정책 — GIS-003/004 근거 (confidence: high)
- AWS Earth Search v1: 무인증 접근, `sentinel-2-l2a`(JPEG2000+COG)·`sentinel-2-c1-l2a`(COG 전용, baseline 5.0+) 컬렉션 제공, 2022-01-25 이후 아이템은 `raster:bands`에 오프셋 노출 — GIS-002/011/020 근거 (confidence: high). CORS 지원 여부만 공개 문서에서 확인하지 못했으나, GIS-023의 권고대로 `server.js` 프록시를 경유하면 브라우저 CORS 가용성이 무관해지므로 finding 본체는 영향받지 않는다(PoC로 서버 측 접근 성공을 확인했다). **최종 28건 전부 confidence high다** — 미확인 영역은 confidence를 내리는 대신 해당 recommendation 안에 문장 단위로 격리해 표시했다(GIS-026의 대안 지수 선택).
- Sentinel-2 processing baseline 04.00 `BOA_ADD_OFFSET` = −1000 DN(반사율 −0.1), 정규화 차분 지수에서 곱셈 스케일은 상쇄되나 가산 오프셋은 상쇄되지 않음 — GIS-020 근거 (confidence: high)
- OSMnx `graph_from_bbox`는 Overpass API를 질의하며, LA County 도로망 사례에서 200만 엣지·8 GB RAM 소요 — GIS-008/016 근거 (confidence: high)

### PoC 검증 — npm 의존성 0 server.js (ana의 ANA-007 이관 요청)

ana 축의 ANA-007("ANA 런타임 코어는 Node 표준 라이브러리만") 실현성 확인 요청에 답하기 위해, 표준 모듈만 쓰는 `server.js`를 실제로 작성해 네 기능을 모두 통과시켰다(Node 24.13.1, 주석 포함 65행).

- (a) 정적 서빙 — `node:fs/promises` + 수동 MIME 맵. 경로 이탈 3종(`--path-as-is ../`, `%2e%2e%2f` 인코딩, `//etc/passwd`) 모두 워크스페이스 밖으로 나가지 못함(§27.5 충족)
- (b) state.json 읽기/쓰기 — GET/PUT 동작, temp write + `rename`으로 원자적 교체(동시 쓰기 시 파일 파손 방지)
- (c) 외부 API 프록시 — `node:http` + 전역 `fetch`. **overpass-api.de와 earth-search.aws.element84.com에 실제 질의 성공**, 비allowlist 호스트는 403 차단(§27.2/§27.3 충족)
- (d) Python 워커 — `child_process.spawn` + stdin/stdout JSON. 셸을 거치지 않아 §27.4 충족, 워커 부재 시 `python_worker_failure` 코드로 502 전파(§25 충족)

**결론: 실현 가능하며 ANA-007 권고안을 지지한다.** 단 세 가지 단서 — (1) 전역 `fetch`는 Node 18+ 전용이므로 §30에 최소 Node 버전 명시 필요(GIS-007에 반영), (2) 프레임워크가 막아 주던 실수를 직접 처리해야 한다(PoC 첫 판이 파일 읽기 전 헤더를 보내 404에서 크래시했고, 에러 메시지가 절대경로를 노출했다 — 둘 다 요구로 못박아야 함), (3) Leaflet 벤더링은 단일 파일이 아니다(`leaflet.css`가 `images/marker-icon.png` 등을 상대 경로로 참조).
