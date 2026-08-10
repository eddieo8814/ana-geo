# PRD 구조 검수 결과 — ANA Geo

- **검수 축:** 구조 · 요구사항 품질 (prd-structure-auditor)
- **대상:** `PRD.md` (Draft v1.0, 1,856행)
- **범위(scope):** `full` — 구조 체크리스트 7개 영역 전부
- **라운드:** 1 (이전 스모크 테스트 finding 11건 재검증 후 통합)
- **원시 데이터:** `01_structure_findings.json`

## 요약

| severity | 건수 |
|---|---:|
| critical | 1 |
| major | 19 |
| minor | 15 |
| info | 3 |
| **합계** | **38** |

라운드 1 마감 후 GIS 축 실측 회신을 받아 권고안 3건을 정정하고 1건(STR-038)을 신설했다 — 하단 "마감 후 정정" 절 참조.

기계적 점검은 모두 통과했다. FR ID는 63개가 형식(`FR-{APP}-{NNN}`)을 지키고 중복·건너뜀·역순이 없으며, 문서 내 10개 JSON 블록은 전부 파싱된다. §6 앱 목록(7개)과 §7 진행표·§22 매트릭스 열·§29 phases·§33 데모 시나리오도 이름·수·순서가 모두 일치한다.

결함은 전부 **섹션 간 교차 일관성과 검증 가능성**에 몰려 있다. 성격상 세 덩어리다.

1. **§22 capability matrix가 FR로 뒷받침되지 않는다** (STR-001~007). 범례가 없어 ✓의 의미부터 미정의이고, 그 아래에서 Search·Site·Route·Change Detection 열의 외부 데이터 ✓가 해당 앱 FR 목록에 대응물을 갖지 않는다.
2. **공통 계약(§10 프론트엔드 · §11 데이터 모델 · §12 상태 모델)이 앱별 요구와 연결되지 않는다** (STR-013~017). 특히 §12는 예시 하나뿐이고 markers·layers 요소·analysis 하위 구조가 모두 비어 있어, ANA가 상태를 읽고 고치는 §3.2/§24.1 계약이 앱마다 다른 형태로 구현될 여지가 있다.
3. **수용 기준이 FR을 검증하지 않는다** (STR-019·020·021·035). FR ID는 정의 위치 밖에서 단 한 번도 인용되지 않으며(63회 출현 = 63개 정의), 20개 이상의 FR에 대응 기준이 없고 반대로 FR 없는 기준도 있다.

## critical

### STR-012 — Satellite 앱이 자신의 core question에 답할 수 없다 (§20.3)

> **What did this place look like at a given time?**

§20.1의 core question과 §35의 성공 기준("I can observe the Earth at a point in time.")은 영상을 보는 것을 성공 조건으로 삼지만, FR-SAT-001~009는 검색·footprint·메타데이터까지만 요구하고 픽셀 렌더링 FR이 없다. §20.6 수용 기준에도 영상 표시 항목이 없다. 반대로 §7은 이 앱을 "Earth observation discovery"로, §22는 Raster 행의 Satellite 열을 공백으로 두어 표시가 범위 밖임을 시사한다. 한 구현자는 footprint만 그리고 다른 구현자는 타일 렌더러를 만들며, 전자는 §20.6을 전부 통과하고도 §20.1의 질문에 답하지 못한다.

**수정 방향:** (A) `FR-SAT-010 — Scene Preview`를 신설하고 §20.6과 §22 Raster 행을 맞추거나, (B) §20.1의 질문을 "Which observations exist for this place and time?"으로, §35를 "I can find observations…"로 교정한다. 브라우저 COG/타일 렌더링 실현성은 GIS 축 확인 대상.

## major 18건

| ID | 섹션 | 요약 |
|---|---|---|
| STR-001 | §22 | capability matrix에 범례가 없어 ✓의 의미가 미정의 |
| STR-002 | §22 vs §18.3/§18.6 | Site에 OSM·Overpass·POI ✓이나 대응 FR 없음, §18.6은 선택이라 규정 |
| STR-003 | §22 vs §19.4 | Route에 POI discovery ✓이나 목적지 후보 취득 FR 없음 |
| STR-004 | §22 vs §17 | Search에 OSM·Overpass ✓이나 External Data 절도 취득 FR도 없음 |
| STR-005 | §22 vs §21.5 | Change Detection에 STAC·Sentinel-2 ✓이나 장면 검색 FR 없음 |
| STR-008 | §14 | 7개 앱 중 4개(map·explorer·site·satellite)에 의존성 선언 절 없음 |
| STR-013 | §10.1 | "the baseline application"으로 한정되어 앱 2~7의 지도 기본 기능 요구가 부재 |
| STR-014 | §12 vs FR-MAP-006 | 마커 저장을 요구하나 상태 예시에 markers 필드 없음 |
| STR-015 | §12 | layers 요소 스키마 부재 — 레이어 토글 FR과 ANA 상태 조회 계약이 무근거 |
| STR-016 | §12 vs §17.4/§18.4/§19.5/§20.4/§21.6 | analysis 슬롯 vs 최상위 래퍼 키 — 분석 모델의 상태 저장 위치 미정의 |
| STR-017 | §11.1 vs §18.4/§21.6 | 공통 property 모델과 결과 모델의 관계 미정의 (점수·면적의 위치가 갈림) |
| STR-019 | 앱별 수용 기준 전체 | 20개 이상 FR이 어떤 수용 기준에도 대응되지 않음 (역방향 4건 포함) |
| STR-020 | §19.7 vs FR-ROUTE-009 | 수용 기준이 isochrone 1종만 요구해 3종 요구 FR을 약화 |
| STR-021 | §19.4 | 도로망 적재가 수용 기준·매트릭스에만 있고 FR 없음 |
| STR-022 | §30/§31 | FR·수용 기준이 PRD와 SPEC.md에 이중 존재, 정본 규칙 없음 |
| STR-023 | §28 vs §24.4 | provenance가 한쪽은 요구, 한쪽은 "should optionally" |
| STR-024 | §15.3/§19.6/§20.5 | 대응 FR 없는 ANA 예시가 §21.7과 달리 evolution으로 표시되지 않음 |
| STR-025 | FR-SITE-005 | 가중치 합계 위반 시 동작 미정의 — §18.5 예시가 두 갈래로 갈림 |
| STR-038 | §16.3 vs §17.4/§17.6 | 카테고리 어휘의 정본이 없어 §17.4 예시가 유일한 목록을 이미 위반 (`subway_station` 미등재) |

## minor 15건 / info 3건

- **minor:** STR-006(Site Buffer ✓ 무근거), STR-009(§14 도입 시점 부재), STR-010(§21.3 벡터 의존성 누락), STR-018(mode `drive` vs `driving`), STR-026(§26 측정 불가·DoD 미연결), STR-027(§27 modality 혼재·"where practical"), STR-028(§25 "All apps must"의 과대 범위), STR-029(§8.1 두 파일 목록 상호 불일치), STR-030(§1.1 다이어그램 분기 모호), STR-032(POI 프리셋에 FR ID 없음), STR-033(§18.2 예시가 optional 데이터 전제), STR-034("where … supports it" 조건절), STR-035(FR ID 참조 0회), STR-036(§17.3 제목 불균일), STR-037(STAC 제공자 미지정)
- **info:** STR-007(매트릭스 누락 행), STR-011(패키지 표기 불일치), STR-031(§34 계층 스택에 discovery 누락)

## 타 축 이관 (handoff) — 전건 해소, 잔여 0건

아래는 라운드 1 시점의 이관 내역이며, 모두 회신·조율이 완료되어 최종본의 `handoff` 필드는 전부 null이다.

| ID | 대상 | 확인 요청 |
|---|---|---|
| STR-012 | prd-gis-feasibility-reviewer | 브라우저에서 Sentinel-2 COG/타일 미리보기 렌더링의 실현성 |
| STR-010 | prd-gis-feasibility-reviewer | rasterio만으로 폴리곤화·CRS별 면적 계산이 가능한지 |
| STR-021 | prd-gis-feasibility-reviewer | OSMnx 그래프 적재 범위(뷰포트/반경)의 현실적 상한 |
| STR-032 | prd-gis-feasibility-reviewer | 10종 POI 프리셋 ↔ OSM 태그 매핑의 타당성 |
| STR-033 | prd-gis-feasibility-reviewer | v1에서 경사도·면적·일사량 계산에 필요한 데이터 가용성 |
| STR-037 | prd-gis-feasibility-reviewer | 키 불필요·안정적 STAC 제공자 특정 |
| ~~STR-024~~ | ~~prd-ana-alignment-reviewer~~ | **조율 완료** — ANA 축은 진화 요청의 명시 자체를 문제 삼지 않고 그 진화가 검증되지 않는 점(ANA-005)을 지적하므로, 예시를 evolution으로 분류하는 선택지는 ANA 계약과 충돌하지 않는다. 단 ANA-005의 조치와 함께 적용해야 한다. severity 유지, handoff 해제 |

STR-012는 **방향 A(FR-SAT-010 신설)로 확정**됐고 handoff를 해제했다 — STAC thumbnail 에셋 + `L.imageOverlay`는 추가 벤더링 없이 가능하고, 전체 해상도 COG는 georaster-layer-for-leaflet 벤더링이 필요해 ANA-007의 vendored 스크립트 제약과 충돌한다는 GIS 축 판정(리더 경유)과 ANA 축 결론이 일치한다.

구조 축에서 방향 A에 두 가지를 덧붙였다.

1. **FR-SAT-010에 충실도를 명시**한다 — "thumbnail/overview asset을 footprint에 정렬된 image overlay로 렌더링하며 full-resolution band rendering은 v1 범위 밖"이라고 적지 않으면 "영상이 보인다"의 통과 기준이 다시 열린다.
2. **§22의 Raster 행을 Satellite까지 확장하지 않는다.** 대신 "Imagery preview" 행을 신설한다. 썸네일 오버레이는 밴드 연산이 아니므로 Raster 행에 넣으면 그 행이 가리키던 래스터 처리(§21.3 rasterio)와 의미가 섞이고, STR-001이 지적한 매트릭스 미정의가 그대로 재발한다. 전체 해상도 COG 경로는 STR-024의 관례에 따라 §20.5의 evolution requests 묶음에 등록한다.

**STR-010·021·032·033·037은 GIS 축 미회신 상태로 마감**했다. 다섯 건 모두 recommendation 말미에 `[GIS 축 미회신 — 마감]` 표시와 확인 방법을 넣었다.

confidence는 일괄 하향하지 않았다. 다섯 건 모두 **finding의 본체는 문서 내부에서 확인된 사실**이고, 확인되지 않은 것은 권고안의 세부(수치·태그 표현식·엔드포인트 유효성)뿐이기 때문이다. 예컨대 STR-021의 본체는 "네트워크 취득 FR이 §19.4에 존재하지 않는다"이고 이는 GIS 답변과 무관하게 참이며, 미확인 부분은 FR 문안에 넣을 반경 수치다. 이 상태에서 confidence를 low로 내리면 리포터에게 "지적 자체가 불확실하다"는 잘못된 신호를 준다. 대신 미확인 범위를 recommendation 안에서 문장 단위로 격리했다. 최종 confidence 분포는 high 31 / medium 6 / low 0이다.

handoff 필드는 다섯 건 모두 값을 유지했다 — 조율이 이뤄지지 않았다는 사실 자체가 기록이어야 하기 때문이다. 리포터는 이를 재조율 지시가 아니라 미완 표시로 읽으면 된다.

## 라운드 1 교차 조율 (ana · gis 축)

**병합 후보 (같은 문제)**

| 상대 축 finding | 구조 축 finding | 판정 |
|---|---|---|
| GIS-001 (critical, §20.3/§20.6) | STR-012 (critical) | 동일 문제. 병합 후 근거 합산 — GIS 축은 FR 커버리지, 구조 축은 §7·§22가 반대 방향을 가리키는 내부 모순 |
| GIS-012 (major, §21.5) | STR-005 (major) | 동일 문제. §9·§21.5·§22 3자 불일치라는 GIS 축 정식화가 더 정확하므로 그 문장을 흡수 |
| GIS-024 (minor, §19.6) | STR-024 (major) 하위 사례 | "Avoid this road."는 STR-024가 열거한 4개 사례 중 하나. 개별 항목 유지 불필요 |
| GIS-016 (minor, §22 Overpass 행) | STR-003 (major) 권고 | STR-003 recommendation이 이미 Route 열 Overpass 공백 재검토를 지시. OSMnx가 내부적으로 Overpass를 호출한다는 GIS 축 근거를 흡수 |

**병합 대상 아님 (같은 섹션·다른 문제)**

- ANA-001(§12 동기화 카운터) vs STR-014/015/016 — 모두 §12지만 각각 markers 필드·layers 스키마·analysis 슬롯·동기화 version으로 문제가 다르다. 보고서에서 "§12 상태 모델" 묶음으로 인접 배치하되 항목은 유지.
- ANA-003(§30 DoD 4항 "or") vs STR-019 — DoD의 "state **or** behavior"와 앱 수용 기준의 FR 미대응은 별개 문제. 다만 STR-019에 7개 앱의 "ANA can …" 항목이 전부 FR 없이 판정 불가라는 근거를 보강하고 ANA-003과 함께 판단하도록 상호 참조를 넣었다.
- ANA-005(§21.7 evolution의 수용 기준 부재) vs STR-024 — 구조 축은 "다른 앱의 예시에 evolution 표시가 없다", ANA 축은 "표시된 evolution에 수용 기준이 없다". 진화 능력 자체가 검증 대상이어야 하는 근거는 ANA 원칙 2에서 나오므로 ANA 축 소관으로 둔다.
- ANA-010(§31 템플릿 항목 부재) vs STR-022 — 둘 다 §31을 건드리지만 전자는 항목 누락, 후자는 PRD/SPEC.md 정본 규칙 부재. 수정 시 §31을 함께 손대야 하므로 보고서에서 인접 배치 권장.

**구조 축에서 확인했으나 별도 finding을 내지 않은 것** — GIS-006(Python worker 실행 계약 부재)과 GIS-007(§30에 의존성 매니페스트 없음 / §9의 `node server.js` 정의가 App 5·7에 성립하지 않음)은 구조 축 기준으로도 유효하다. "Python worker"는 §19.2 다이어그램에 한 번 등장할 뿐이고 §21.2는 이름조차 쓰지 않으면서 §25·§26.2·§27.4가 이를 전제하므로, 공통 계약 누락에 해당한다. GIS 축이 더 나은 기술 근거로 먼저 제기했으므로 중복 발행하지 않는다.

## 마감 후 정정 (리더 승인 — 제한적 해제)

라운드 1 마감 후 GIS 축이 이관 6건에 실측으로 회신했고, 그 결과 **제 권고안 3건이 틀렸음이 확인됐다.** 리더 승인을 받아 recommendation만 정정했으며 각 건에 `[라운드 1 마감 후 정정 — GIS 실측 근거]`를 표기했다. 원문 인용·severity·issue는 손대지 않았다.

| ID | 원안의 오류 | 정정 |
|---|---|---|
| STR-021 | FR 초안이 범위를 "current viewport 또는 반경"으로 제시 | 뷰포트는 줌아웃으로 임의로 커져 상한이 될 수 없다. bbox+패딩 2 km, 최대 면적 약 100 km² 상한, `(bbox, network_type)` 캐싱으로 교체. 병목은 로컬 계산이 아니라 공용 Overpass다(대전 규모 질의 8회 중 5회 실패) |
| STR-033 | 경사도·일사량·**면적** 셋을 함께 optional로 분리하라고 지시 | 면적은 OSM 폴리곤 + `turf.area`로 v1 계산 가능하므로 하드 제약 예시로 존치. 경사도(DEM)·일사량(NASA POWER) 둘만 분리 |
| STR-037 | "no API key required" 한 줄로 무키 조건을 표현 | **검색과 에셋 접근이 모두** 무키여야 한다는 2단계 조건으로 교체. 검색만 무키이고 에셋에서 막히는 것이 실제 함정이며, Earth Search도 일부 에셋은 requester-pays `s3://`다 |

신설 1건은 **STR-038 (major)** — §17.4 조건 모델과 §17.6이 `subway_station`을 참조하지만 §16.3 프리셋 10종에 없고(원문 전수 확인: 692·721행만), 더 근본적으로 카테고리 어휘의 정본이 문서 어디에도 없다. 라운드 1에서 놓친 이유는 체크리스트 교차 대조표에 §16.3↔§17.4 쌍이 없어서이며, 리더가 하네스 개선으로 해당 쌍을 표에 추가한다.

STR-010과 STR-012는 GIS 축 확인 결과 제 권고안이 그대로 옳았다 — 각각 rasterio+numpy만으로 폴리곤화·면적 산출이 가능함(실측: 픽셀 수 × 100 ㎡로 기대값과 소수 넷째 자리까지 일치)과 썸네일 오버레이 방식의 영상 표시가 추가 의존성 0으로 가능함이 확인됐다.

**표기 정리 완료 (리더 승인).** STR-010·STR-032의 `[GIS 축 미회신 — 마감]` 표기를 `[라운드 1 마감 후 GIS 회신으로 해소 — …]`로 교체하고 회신 결론을 본문에 적었다. 이관 5건(STR-010·021·032·033·037)의 `handoff`는 모두 null로 정리했고, 조율 이력은 각 recommendation의 `[조율 결과]`에 남겼다. **최종적으로 열린 handoff는 0건, 미회신 표기도 0건이다.**

- **STR-010** — rasterio 1.5.0 + numpy로 UTM 52N·10 m·1000×1000 래스터에 FR-CD-006~011을 실행해 확인됐다. `shapes`가 폴리곤 3개를 정확히 분리했고 면적은 픽셀 수 × 100 ㎡로 4.7200 km², 기대값과 소수 넷째 자리까지 일치했다. 의존성 추가 없이 FR-CD-009/008 문안에 방법을 명시하는 쪽으로 확정.
- **STR-032** — `amenity=charging_station`은 단일 태그로 깔끔하나 대전 전역에 10건뿐이고, bus station은 `amenity=bus_station`(7건)과 `highway=bus_stop`(2,554건)이 365배 차이 나는 함정이다. 후자를 기대하는 사용자에게 전자로 매핑해도 §16.6의 "at least ten POI types are supported"는 통과한다 — **고장이 수용 기준을 빠져나가는 사례**라 STR-019의 실증으로 함께 배치한다.

## 스모크 테스트 finding 처리

이전 `smoke_findings.json`의 11건을 PRD 현행본으로 재검증한 결과 전부 유효하며, 현행 래퍼 스키마로 변환해 STR-001~011로 이관했다. 해소된 항목은 없다. severity는 STR-006(minor)·STR-007(info)·STR-009~011을 포함해 원안을 유지했고, STR-008에는 §31 SPEC 템플릿의 "## 7. Dependencies" 요구를 PRD 자신의 기준으로 추가 근거로 붙였다.
