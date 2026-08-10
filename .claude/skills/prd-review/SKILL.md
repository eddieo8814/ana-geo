---
name: prd-review
description: ANA Geo PRD.md를 3개 축(구조·요구사항 품질 / ANA 베이스 정합성 / GIS 기술 실현성)으로 병렬 검수하고 통합 보고서 PRD-REVIEW.md를 산출하는 오케스트레이터. 사용자가 "PRD 검수", "PRD 리뷰", "PRD 감사", "요구사항 검토", "PRD 제대로 됐는지 확인", "문서 검증"을 요청하거나, 후속으로 "PRD 재검수", "다시 검수", "수정했으니 다시 봐줘", "구조만/정합성만/실현성만 다시", "검수 보고서 업데이트", "이전 결과 기반으로 확인"을 요청하면 반드시 이 스킬을 사용할 것. PRD.md를 수정한 직후의 검증 요청도 이 스킬로 처리한다. 단, PRD 내용 작성/수정 자체(검수가 아닌 집필)는 이 스킬의 범위가 아니다.
---

# PRD 검수 오케스트레이터

**실행 모드: 에이전트 팀** — 검수자 3인은 축이 겹치는 발견을 SendMessage로 이관·조율해야 하고(중복 finding 방지, 교차 확인), 리포터는 불명확한 finding을 검수자에게 되물어야 하므로 팀 통신이 필수다.

팀 구성 (4명, 모두 `model: "opus"`):

| 팀원 | 에이전트 정의 | 축 | 산출물 |
|------|--------------|-----|--------|
| structure | `.claude/agents/prd-structure-auditor.md` | 구조·요구사항 품질 | `_workspace/prd-review/01_structure_findings.json` |
| ana | `.claude/agents/prd-ana-alignment-reviewer.md` | ANA 베이스 정합성 | `_workspace/prd-review/02_ana_findings.json` |
| gis | `.claude/agents/prd-gis-feasibility-reviewer.md` | GIS 기술 실현성 | `_workspace/prd-review/03_gis_findings.json` |
| reporter | `.claude/agents/prd-review-reporter.md` | 통합 보고 | `PRD-REVIEW.md` + `04_merged_findings.json` |

공통 기준(스키마·severity·판정 규칙)은 `prd-review-criteria` 스킬 — 모든 팀원 프롬프트에 이 스킬을 로드하라고 명시한다.

## Phase 0: 컨텍스트 확인

시작 시 실행 모드를 판별한다:

1. `PRD.md` 존재 확인 — 없으면 즉시 중단하고 사용자에게 보고
2. `_workspace/prd-review/` 존재 여부:
   - **없음** → 초기 실행 (전체 워크플로우)
   - **있음** + 사용자가 특정 축/섹션 재검수 요청 → **부분 재실행**: 해당 검수자만 팀에 포함(리포터는 항상 포함). 나머지 축의 기존 findings JSON은 그대로 재사용
   - **있음** + PRD가 크게 개정되어 전체 재검수 → 기존 산출물을 `_workspace/prd-review_prev/`로 이동 후 초기 실행과 동일. 단 각 검수자에게 이전 findings 경로를 알려 `resolved` 추적을 지시
3. 라운드 번호 결정: 기존 `PRD-REVIEW.md`의 라운드 + 1

## Phase 1: 팀 구성 및 작업 할당

1. `TeamCreate`로 팀 생성 (예: `prd-review-team`)
2. `TaskCreate`로 작업 등록 — 의존 관계:
   - T1(structure 검수), T2(ana 검수), T3(gis 검수): 상호 독립, 병렬
   - T4(크로스 리뷰 조율): T1~T3 완료 후
   - T5(보고서 작성): T4 완료 후, reporter 담당
3. 각 검수자 스폰 프롬프트에 포함할 것: 담당 에이전트 정의 파일 경로, `prd-review-criteria` 스킬 로드 지시, 산출물 경로, 라운드/이전 findings 경로(재실행 시), `model: "opus"`

## Phase 2: 병렬 검수 (T1~T3)

- 세 검수자가 동시에 PRD.md를 각자의 축으로 검수하고 findings JSON + md를 산출한다.
- 축 경계를 넘는 발견은 검수자 간 SendMessage로 이관한다 (에이전트 정의의 팀 통신 프로토콜 참조).
- 리더는 진행을 모니터링하되 검수 내용에 개입하지 않는다 — 독립성이 교차 확인의 가치를 만든다.

## Phase 3: 크로스 리뷰 (T4)

세 findings가 모이면 리더가 확인한다:

- 같은 대상에 대한 상충 판단이 있는가 → 해당 검수자 둘에게 SendMessage로 상호 조율 지시 (합의 실패 시 양쪽 모두 유지, 출처 병기)
- 한 축의 critical이 다른 축 관점의 확인을 요구하는가 → 해당 검수자에게 교차 확인 요청

## Phase 4: 통합 보고 (T5)

reporter가 세 findings를 병합해 `PRD-REVIEW.md`를 작성한다 (형식: criteria 스킬 `references/report-template.md`, 판정: criteria 스킬 규칙).

## Phase 5: 종료

1. 리더가 사용자에게 최종 요약 보고: **판정 + Top N 수정 항목 + 보고서 경로**
2. 팀 정리 (`_workspace/prd-review/`는 감사 추적용으로 보존)
3. 피드백 기회 제공: "검수 기준이나 팀 구성에서 조정할 부분이 있는지" 1회 질문 (강요하지 않음)

## 데이터 전달 프로토콜

- **태스크 기반**(진행 조율) + **파일 기반**(산출물, `_workspace/prd-review/`) + **메시지 기반**(축 간 이관·조율)
- 파일명 컨벤션: `{순번}_{축}_{산출물}.json|md`
- 최종 산출물은 `PRD-REVIEW.md`(루트)만. 중간 파일은 보존.

## 에러 핸들링

| 상황 | 대응 |
|------|------|
| PRD.md 없음 | 즉시 중단, 사용자 보고 |
| 검수자 1명 실패 | 1회 재스폰. 재실패 시 해당 축 없이 진행하고 보고서에 누락 축 명시 |
| findings JSON 스키마 위반 | 리포터가 해당 검수자에게 SendMessage로 수정 요청 1회. 실패 시 md 산출물로 대체 병합, confidence 하향 |
| 웹/원격 조회 실패 | 검수자 로컬 노트 기반 진행 + confidence 하향 (각 에이전트 정의 참조) |
| 상충 finding 합의 실패 | 삭제하지 않고 양쪽 병기 |

## 테스트 시나리오

**정상 흐름**: PRD.md 존재, 초기 실행 → 팀 4인 구성 → T1~T3 병렬 완료(각 축 finding ≥ 1) → 크로스 리뷰 → PRD-REVIEW.md 생성, 판정이 severity 규칙과 일치 → 사용자 요약 보고.

**부분 재실행**: 사용자 "GIS 부분만 다시 검수" → Phase 0에서 부분 재실행 판별 → gis + reporter만 활성 → 01/02 findings는 기존 파일 재사용 → 보고서 라운드 +1, 해소/잔존/신규 표기.

**에러 흐름**: gis 검수자 재스폰 실패 → 구조·ANA 축만으로 보고서 작성 → 보고서와 사용자 요약에 "GIS 실현성 축 누락, 재실행 필요" 명시.
