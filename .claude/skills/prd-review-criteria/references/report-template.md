# PRD-REVIEW.md 보고서 템플릿

prd-review-reporter 전용. 프로젝트 루트에 `PRD-REVIEW.md`로 저장한다.

```markdown
# PRD 검수 보고서 — ANA Geo

**대상:** PRD.md (버전/해시: {git hash 또는 날짜})
**검수일:** {YYYY-MM-DD} · **라운드:** {N}
**판정:** {PASS | CONDITIONAL PASS | FAIL}

## 판정 근거

critical {n} · major {n} · minor {n} · info {n}
{판정 규칙 적용 한 줄 설명}

{2라운드 이상이면: 이전 라운드 대비 해소 {n} / 잔존 {n} / 신규 {n}}

## 지금 고쳐야 할 것 Top {N}

| # | ID | 심각도 | 섹션 | 요약 | 수정 제안 |
|---|----|--------|------|------|-----------|

## 축별 상세

### 1. 구조·요구사항 품질 ({n}건)
{finding별: **[ID] severity — §section** / 인용 / 문제 / 수정 제안}

### 2. ANA 정합성 ({n}건)

### 3. GIS 기술 실현성 ({n}건)

## 교차 확인된 발견

{두 축 이상에서 독립적으로 지적된 항목 — 신뢰도 높음}

## 잘된 점

{PRD가 잘 갖춘 부분 3~5개 — 수정 시 훼손하지 않도록 명시}

## 재검수 안내

수정 후 "PRD 재검수해줘"로 부분/전체 재검수를 요청할 수 있다.
```

## 작성 규칙

- Top N은 critical 전부 + major 중 파급 큰 것으로 5~10개. 나열이 아니라 **행동 순서**다.
- 상세 섹션의 finding은 severity 내림차순.
- "잘된 점"을 생략하지 않는다 — 수정 과정에서 멀쩡한 부분을 건드리는 회귀를 막는 안전선이다.
- `_workspace/prd-review/04_merged_findings.json`에 병합 결과(MRG- ID, 원본 ID 매핑 포함)를 함께 저장한다.
```
