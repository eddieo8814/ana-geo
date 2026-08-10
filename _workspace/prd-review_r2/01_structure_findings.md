# PRD 구조 검수 결과 — ANA Geo (라운드 2)

- **검수 축:** 구조 · 요구사항 품질 (prd-structure-auditor)
- **대상:** `PRD.md` v1.1 (1,980행 — v1.0 대비 +124행)
- **범위(scope):** `full` — 구조 체크리스트 7개 영역 전부
- **비교 기준:** `_workspace/prd-review_prev/01_structure_findings.json` (라운드 1, 38건)
- **원시 데이터:** `01_structure_findings.json` (해소 건 포함 43건 전량 보존)

## 요약

| 구분 | 건수 |
|---|---:|
| 라운드 1 finding | 38 |
| **해소** (`resolved: true`) | **11** |
| 잔존 | 27 |
| **신규** (STR-039~043) | **5** |
| **활성 합계** | **32** |

활성 32건의 severity 분포:

| severity | 건수 | 라운드 1 대비 |
|---|---:|---|
| critical | **0** | −1 |
| major | 15 | −3 |
| minor | 14 | −1 |
| info | 3 | ±0 |

**판정이 FAIL에서 CONDITIONAL PASS로 바뀐다.** 유일한 critical이었던 STR-012가 해소되어 구조 축에는 critical이 남지 않는다. 다만 major 15건이 있으므로 착수 전 해소가 필요하다.

기계 점검은 v1.0과 마찬가지로 전부 통과했다. FR은 63개에서 68개로 늘었고(FR-EXP-008, FR-SEARCH-009/010, FR-ROUTE-010, FR-SAT-010) 형식·중복·건너뜀 문제가 없다. JSON 블록 10개 모두 파싱된다. FR 언급이 63회에서 123회로 늘어 실제 상호 참조가 55회 생겼다.

## 해소된 11건

개정이 가장 성공적인 영역은 **수용 기준의 추적 가능성**과 **상태 모델**이다.

| ID | 무엇이 해소됐나 |
|---|---|
| STR-012 (critical) | FR-SAT-010 신설. 권고한 충실도 단서("scene-level visual context, not analysis-grade imagery")까지 그대로 반영됐고, §20.6·§22·§20.5 네 곳이 일관되게 정리됐다 |
| STR-019 (major) | 7개 앱 수용 기준이 전부 FR ID를 인용. 68개 FR 중 무참조가 0 |
| STR-021 (major) | FR-ROUTE-010 신설. bbox+2 km 패딩, ~100 km² 상한, 캐싱, "viewport is never used" 모두 반영 |
| STR-022 (major) | §31 규칙 3으로 PRD가 FR·수용 기준의 정본임이 확정 |
| STR-001 (major) | §22 범례 신설. "every ✓ must be backed by at least one FR"라는 검증 규칙까지 포함 |
| STR-014 (major) | §12에 `markers` 필드 추가 |
| STR-015 (major) | §12 layers 요소 스키마 + 인라인 금지 규칙. GIS-028도 함께 해소 |
| STR-020 (major) | §19.7이 isochrone 3구간을 요구하도록 수정 |
| STR-032 (minor) | FR-EXP-008 신설로 프리셋이 FR 체계에 편입 |
| STR-035 (minor) | FR ID 상호 참조 관행 확립 |
| STR-037 (minor) | §20.2에 Earth Search 고정 + 2단계 무키 조건 명시 |

## 신규 5건 — 개정이 만든 결함

라운드 1 권고를 반영하는 과정에서 새 불일치가 생겼다. 네 건은 major다.

**STR-039 (major, §22)** — 새로 만든 Imagery preview 행이 Change Detection에 ✓를 줬지만 §21.5에 대응 FR이 없다. 같은 개정이 신설한 범례("every ✓ must be backed by at least one FR")를 도입 즉시 위반한다. **GIS 축 실측으로 수정 방향은 (B) CD 열 ✓ 제거로 확정됐다** — 썸네일은 343 × 343 px, MGRS 타일 한 변 109.8 km이므로 픽셀당 약 320 m이고, 변화 폴리곤은 4.0 km²가 약 6 px, 0.12 km²가 약 1 px이다. 육안 대조 자체는 필요하지만(NDVI 차분은 구름 그림자와 벌목을 수치로 구분하지 못한다) 썸네일로는 그 필요를 채울 수 없고, §21.8에 넣어도 "무엇이 보이면 통과인가"에 답할 수 없어 판정 불가 기준만 하나 늘어난다. 장면 대조는 폐기하지 않고 §21.7 evolution request로 등록한다 — 올바른 형태는 Python worker가 이미 읽는 AOI 윈도우(FR-CD-004)로 `visual` 에셋을 같은 창만큼 읽어 AOI 크기 PNG를 만드는 것이다.

**STR-040 (major, §31)** — §31 규칙 1이 "FR을 인용하지 않는 수용 기준은 spec defect"라고 규정했는데, PRD 자신의 수용 기준 중 7개 앱의 진화 항목이 전부 FR 대신 `§30, item 11`을 인용한다. 규칙 3에 따라 SPEC.md로 옮겨지면 7개 앱 SPEC이 모두 위반 상태로 태어난다. §30 항목 11·12에 대응하는 FR이 없는 것이 근인이다.

**STR-042 (major, §12)** — §12 규칙 3이 도입한 `resultRef`/`resultVersion` 재조회 채널이 §8과 접합되지 않았다. §8.3의 서버 책임 목록에 결과 제공 엔드포인트가 없고, §8.2는 `resultVersion` 변경 시 `stateVersion`도 증가하는지를 말하지 않는다. 증가하지 않으면 클라이언트는 결과 변경을 감지할 수 없다.

**STR-043 (major, §30)** — v1.1이 §8.4·§8.5를 공통 계약으로 못박고 §30 항목 12로 그 이행을 완료 조건에 넣었지만, §30 파일 목록에는 그 계약을 설치·재현할 명세가 없다. §8.5의 `python3 tools/<op>.py`는 route·CD에 Python 환경을 하드 전제로 만드는데 `requirements.txt`가 필수 목록에 없고, §8.4를 npm 의존성 없이 구현하려면 전역 `fetch`가 필요해 Node 최소 버전이 사실상 전제가 됐는데 명시가 없다. §32 항목 6의 README "dependencies"는 산문이지 재현 가능한 매니페스트가 아니다. GIS-007과 병합 확정.

> **프레이밍 정정 기록.** 이 finding은 최초에 "§8.5가 §9 독립성 유지를 단언하지만 그것이 거짓"이라는 각도로 발행했다가 GIS 축 지적을 받아 철회했다. §9의 조항은 289행("independently runnable")·305행("without depending on another app directory at runtime")·307행("must not require importing code from a preceding app") 모두 **앱 간 의존성만**을 판정 기준으로 삼고, 예시 두 개도 Python을 쓰지 않는 map·satellite다. spawn 방식 워커는 다른 앱 디렉터리에 의존하지 않으므로 §8.5의 단언은 §9 자신의 정의 아래에서 참이며, 그 각도로는 "§9는 앱 간 의존성만 말한다"는 반문에 무너진다. 라운드 1에서 구조 축이 GIS 축에 준 조언(예시가 아니라 정의 문장을 지적 대상으로 삼으라)이 이번에는 반대 방향으로 돌아온 사례다.

**STR-041 (minor, §17.7)** — FR ID 부착 과정에서 범위 인용 한 줄("Turf.js-based spatial operations work (FR-SEARCH-001–FR-SEARCH-006)")이 5개 공간 술어의 유일한 판정 근거로 남았다.

## 잔존 major 11건

개정이 손대지 않은 영역이다. 세 덩어리로 묶인다.

**§22 매트릭스가 자신의 새 범례를 위반한다 (STR-002·003·004·005, 그리고 STR-006 minor).** 범례가 "모든 ✓는 해당 앱 FR로 뒷받침"을 요구하게 되면서, Site의 OSM·Overpass·POI discovery, Route의 POI discovery, Search의 OSM·Overpass, CD의 STAC·Sentinel-2가 전부 해석 차이가 아니라 **명시적 규칙 위반**이 됐다. 라운드 1에서는 "✓의 뜻이 모호하다"였지만 이제는 "규칙이 있고 그것을 어긴다"이므로 지적의 성격이 강해졌다.

**공통 계약이 앱별 요구와 이어지지 않는다 (STR-008·013·016·017).** §12는 layers에 대해 "All apps represent layers with the element schema shown above"라는 강제 규칙을 얻었지만, `analysis` 슬롯은 여전히 비어 있고 앱별 모델 5종은 세 가지 배치 관례로 흩어져 있다(STR-016). §11.1과 결과 모델의 관계도 그대로다(STR-017). §10.1은 여전히 "the baseline application"으로 한정돼 앱 2~7의 지도 기본 기능 요구가 없다(STR-013). 4개 앱의 의존성 선언 부재도 그대로다(STR-008).

**모순이 오히려 확대된 건 (STR-023·025·027·034).** 개정이 새 절을 추가하면서 기존 결함과 부딪힌 사례다.

- STR-023 — §8.4가 프록시를 provenance 기록 지점으로 규정하면서, 필수로 전제하는 절이 §24.4·§11.1·§30에 더해 넷이 됐는데 §28만 "should optionally"로 남았다.
- STR-027 — §8.4가 허용 목록을 무조건 요구하는데 §27.3은 여전히 "where practical"이다. 두 절이 다른 강도를 말한다.
- STR-025 — §18.7이 "validated to sum to 1.0"으로 좁혔는데 인용된 FR-SITE-005는 "1.0 or 100%"를 허용한다. 수용 기준이 FR보다 좁아졌다.
- STR-034 — §19.7이 "where edge data supports it"를 그대로 옮겨 적어, 판정 불가 조건절이 요구뿐 아니라 합격 판정 문장에도 들어갔다.

## §22 매트릭스 전수 점검 (라운드 2 추가 검증)

v1.1이 신설한 범례가 "every ✓ must be backed by at least one FR in that app's section"를 요구하므로, 20개 행 × 7개 앱의 모든 ✓를 해당 앱 FR과 대조했다. **뒷받침 FR이 없는 셀이 25개**이며, 전부 기존 finding 6건에 귀속된다. 새로 발행할 finding은 없다.

| 행 | 미뒷받침 앱 | 셀 수 | 귀속 finding |
|---|---|---:|---|
| Leaflet map | Explorer·Search·Site·Route·Satellite·CD | 6 | STR-013 |
| Marker | Explorer·Search·Site·Route·Satellite·CD | 6 | STR-013 |
| GeoJSON | Site·Satellite | 2 | STR-013 |
| OSM | Search·Site | 2 | STR-004 / STR-002 |
| Overpass | Search·Site | 2 | STR-004 / STR-002 |
| POI discovery | Search·Site·Route | 3 | STR-004 / STR-002 / STR-003 |
| Buffer | Site | 1 | STR-006 |
| STAC | Change Detection | 1 | STR-005 |
| Sentinel-2 | Change Detection | 1 | STR-005 |
| Imagery preview | Change Detection | 1 | STR-039 |
| **합계** | | **25** | |

Marker 행이 가장 선명한 사례다. 7개 앱 전부 ✓인데 마커를 요구하는 FR은 FR-MAP-005·006 둘뿐이고, §16~§21의 FR 목록에는 마커·pan/zoom·fit bounds를 요구하는 항목이 하나도 없다(전수 확인). GeoJSON은 Explorer(FR-EXP-003)·Search(FR-SEARCH-009)·Route(FR-ROUTE-006)·CD(FR-CD-010)가 뒷받침하지만 Site와 Satellite에는 대응 FR이 없다.

반대로 라운드 1에서 미뒷받침이었던 **Network graph 행의 Route ✓는 FR-ROUTE-010 신설로 해소**됐다(STR-021).

이 25개 셀은 원인이 둘로 갈린다. 14개는 공통 프론트엔드 요구가 앱별 FR로 내려오지 않은 것(STR-013, 수정은 §10.1 한 문장)이고, 11개는 앱별 능력 요구가 누락된 것(STR-002~006·039, 수정은 각 앱에 FR 신설 또는 ✓ 제거)이다. 원인과 수정 위치가 다르므로 **하나의 finding으로 병합하지 않는다.** 다만 보고서에서는 위 표를 함께 실어 "범례를 신설했으나 매트릭스가 그 규칙을 25곳에서 지키지 않는다"는 한 장면으로 보이게 하는 편이 읽힌다.

## severity 조정 1건

**STR-024: major → minor.** §20.5가 마지막 두 예시를 evolution request로 명시하고 §19.6의 "Avoid this road."가 §19.7 진화 기준으로 분류되면서 세 사례 중 둘이 해소됐다. 잔존은 §15.3의 "Remove all markers." 하나이며 관례 자체는 자리잡았다.

## 타 축 이관 (handoff)

| ID | 대상 | 확인 요청 |
|---|---|---|
| ~~STR-043~~ | ~~prd-gis-feasibility-reviewer~~ | **조율 완료** — GIS-007과 병합 확정. 회신 과정에서 프레이밍 오류가 드러나 지적 대상을 §8.5에서 §30으로 옮겼다(위 정정 기록 참조). handoff 해제, 잔여 이관 0건 |

## 다음 라운드에 볼 것

STR-039·040·042·043 네 건은 모두 **v1.1이 만든 결함**이다. 개정 시 신설 절과 기존 절의 접합을 확인하는 절차가 없었음을 시사한다. v1.2에서는 새 절을 추가할 때 그 절이 참조하는 기존 절과 그 절을 참조해야 할 기존 절을 양방향으로 점검하면 같은 유형이 반복되지 않는다.
