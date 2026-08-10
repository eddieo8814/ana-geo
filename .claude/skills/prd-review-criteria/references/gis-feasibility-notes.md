# GIS 실현성 노트 — 스택·데이터 사실 및 알려진 제약

prd-gis-feasibility-reviewer 전용. 2026-08 기준 일반 지식이다. 외부 서비스 정책(rate limit, 인증)은 변동성이 크므로, finding의 근거로 쓰기 전 의심스러우면 웹 검색으로 재확인하고 확인 불가 시 `confidence: low`로 기록하라.

## N1. Leaflet + Turf.js (브라우저 GIS)

- Leaflet: pan/zoom/타일/마커/GeoJSON 레이어/fitBounds/클릭 이벤트/레이어 토글 — PRD §10.1 요구 전부 코어 기능. 문제 없음.
- 렌더 한계: SVG 기본 렌더러에서 수천 feature부터 체감 저하. §26.1의 500–2,000 캡은 합리적. 그 이상은 `preferCanvas` 또는 클러스터링 필요.
- Turf.js: distance / buffer / booleanPointInPolygon / pointsWithinPolygon / nearestPoint 등 §17.3 연산 모두 제공. 단 **buffer는 평면 근사** — 고위도·대형 버퍼에서 왜곡이 있으나 도시 스케일(수 km)에선 무시 가능.
- 다중조건 AND/OR(§17.3)는 Turf 조합으로 구현 가능 — 라이브러리 기능이 아니라 앱 로직이다.

## N2. OSM / Overpass API

- 공용 Overpass 인스턴스(overpass-api.de 등): 무인증·무키. 단 **rate limit(대략 동시 2슬롯 수준)과 쿼리 timeout**이 있으며 과도 사용 시 일시 차단. 10개 카테고리를 동시·반복 조회하는 UI(§16)는 요청 병합(한 쿼리 다중 카테고리) 또는 스로틀 요구가 없으면 쉽게 한계에 걸린다.
- viewport(bbox) 검색, 카테고리(tag) 검색 모두 표준 사용법 — 실현성 문제 없음.
- Overpass 응답은 GeoJSON이 아니라 OSM JSON — 변환(osmtogeojson 등) 계층이 필요하다는 점이 PRD에 암묵적.

## N3. OSMnx / NetworkX (라우팅)

- `graph_from_bbox/place` 다운로드는 도시 규모에서 수십 초~수 분 + 수백 MB 메모리 가능 — "일반 노트북" 전제와 양립하려면 범위 제한 요구가 필요.
- 최단 거리 경로: 표준. **시간 최소 경로(FR-ROUTE-005)**: OSMnx의 `add_edge_speeds`/`add_edge_travel_times`는 maxspeed 태그 누락 구간을 도로 유형별 평균으로 대체 — "edge data supports it" 단서가 PRD에 있는지 확인. 결과는 추정치다.
- Isochrone(FR-ROUTE-009): ego_graph(travel_time 컷) + convex/alpha shape 근사가 통상 구현 — "approximate"가 PRD에 명시돼 있으면 OK.
- 드라이브/워크/바이크 네트워크 타입 모두 OSMnx 표준 지원.

## N4. STAC / Sentinel-2

- **무인증 STAC**: AWS Earth Search(element84, `sentinel-2-l2a` COG) — 검색·에셋 접근 모두 키 불요. PRD §27.7(키 불요 선호)과 양립하는 공급자가 존재함. Microsoft Planetary Computer는 SAS 토큰 서명 필요(무료지만 절차 존재).
- 검색 파라미터(bbox, datetime range, collection, `eo:cloud_cover` 필터) — STAC API 표준. §20.3 요구 전부 실현 가능.
- footprint는 STAC Item의 geometry(GeoJSON) — Leaflet 표시 즉시 가능.

## N5. NDVI / 변화 탐지 (rasterio)

- Sentinel-2 L2A NDVI: **B04(red), B08(NIR), 10 m** — 표준. L2A는 BOA 반사율이라 NDVI 차분에 적합.
- 두 장면 정렬(FR-CD-003): 같은 MGRS 타일이면 그리드가 거의 일치해 쉬움. **다른 타일/UTM 존에 걸치면 재투영 필요** — 난이도 절벽. "같은 타일 우선" 같은 단순화 전략이 PRD에 없으면 지적 대상.
- COG 부분 읽기: rasterio는 HTTP range request로 AOI 윈도우만 읽을 수 있음 — 전체 장면(수백 MB) 다운로드를 피하는 표준 전략. PRD가 이를 요구하지 않으면 성능 요구(§26)와 긴장.
- 폴리곤화: `rasterio.features.shapes` — 표준. 면적 계산은 투영 좌표계에서 해야 정확(위경도에서 ㎡ 계산 금지).

## N6. 의존성 단계 전략 점검 관점

- 브라우저(Leaflet+Turf) → Python(OSMnx/rasterio) 전환점이 route/change-detection에 놓인 것은 타당하다.
- 점검할 것: Python worker의 실행·통신 방식(§19.2 "JSON request → Python worker")이 구체적 계약(프로세스 방식, 포트, 에러 전파) 없이 다이어그램만 있는가 — 앱 간 일관성이 깨질 지점이다.
