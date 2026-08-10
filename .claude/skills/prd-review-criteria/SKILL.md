---
name: prd-review-criteria
description: ANA Geo PRD 검수에 사용하는 공통 기준 스킬 — finding JSON 스키마, 심각도(severity) 사다리, 최종 판정 규칙, 축별 체크리스트(구조/ANA 정합성/GIS 실현성)와 보고서 템플릿을 제공. PRD 검수, PRD 리뷰, 요구사항 감사, finding 작성, 검수 보고서 작성 작업 시 반드시 이 스킬을 로드할 것. 검수자 에이전트(prd-structure-auditor, prd-ana-alignment-reviewer, prd-gis-feasibility-reviewer)와 리포터(prd-review-reporter)가 공유한다.
---

# PRD 검수 공통 기준

모든 검수자와 리포터가 같은 스키마·같은 심각도 기준·같은 판정 규칙을 쓴다. 기준이 갈리면 병합 단계에서 finding들이 비교 불가능해지므로, 이 문서가 단일 기준점이다.

## Finding 스키마

각 검수자는 산출물을 다음 **래퍼 객체**로 저장한다. `scope`는 전체 검수면 `"full"`, 부분 검수면 수행한 체크 항목 목록 — 리포터가 "미검수"와 "통과"를 구분하는 데 필수다.

```json
{
  "scope": "full",
  "findings": [
    {
      "id": "STR-001",
      "dimension": "structure | ana-alignment | gis-feasibility",
      "severity": "critical | major | minor | info",
      "section": "§12",
      "crossref": "§22 vs §18.3 (교차 대조 finding일 때만)",
      "summary": "한 줄 요약 (리포터의 Top N 표에 그대로 사용)",
      "quote": "PRD 원문 인용 (판단 근거가 된 문장)",
      "issue": "무엇이 왜 문제인가 (1~3문장)",
      "recommendation": "구체적 수정문안 또는 수정 방향",
      "confidence": "high | medium | low",
      "handoff": null,
      "resolved": false
    }
  ]
}
```

- `id` 접두: 구조 `STR-`, ANA 정합성 `ANA-`, GIS 실현성 `GIS-`, 병합본 `MRG-`
- `quote`가 없는 finding은 리포터가 병합 시 기각한다 — 재검증 불가능한 지적은 싣지 않는다.
- **부재(absence)형 finding의 인용**: "FR이 없다"류 지적은 그 부재를 드러낸 반대편 문장(예: 매트릭스의 해당 행)을 `quote`에 넣고, 부재한 쪽은 `section`/`crossref`에 범위로 표기한다.
- **표 인용**: 마크다운 표는 행 단위로 원문 인용하고, 문제 셀은 `issue`에서 지목한다.
- `confidence: low`는 외부 사실을 확인하지 못했거나 해석 여지가 큰 경우에만 사용하고, recommendation에 확인 방법을 포함한다.
- **confidence는 finding 본체(issue의 성립 여부)에 대한 것이다.** recommendation의 세부(수치, 문안)만 미확인이면 confidence를 내리지 말고, 미확인 범위를 recommendation 안에서 문장 단위로 격리해 표시한다 — 본체가 확실한 지적을 low로 내리면 "지적 자체가 불확실하다"는 잘못된 신호가 된다.
- `handoff`: 타 검수 축의 확인이 필요한 finding에 해당 에이전트 이름을 기입한다(예: `"prd-gis-feasibility-reviewer"`). 팀 실행 시에는 SendMessage 이관과 병행 표기하고, 단독 실행 시에는 이 필드가 이관을 대체한다. 마감 시점까지 조율이 이뤄지지 않았으면 값을 유지한 채 recommendation에 미회신 마감을 표시한다 — 리포터는 이를 재조율 지시가 아니라 미완 기록으로 읽는다.
- **병합 정본 귀속 기본값**: 두 축이 같은 결함을 병합할 때 정본은 **먼저 제안한 쪽의 안을 기본값**으로 채택한다. 반대 제안은 그 안이 틀렸다는 근거가 있을 때만 내며, 귀속 논리에 대한 선호는 반대 제안의 사유가 되지 않는다 — 병합본 품질은 정본이 어느 축이냐가 아니라 양측 근거가 모두 흡수됐느냐로 결정되고, 리포터 병합 중의 정본 플립은 매번 재작업을 만든다. **라벨 이견과 내용 이견을 가른다**: 이견이 내용이 아니라 어느 ID가 정본이냐뿐이라면(양측 근거가 이미 상호 흡수된 상태), 이미 파일에 반영한 쪽을 유지하고 상대는 수락만 한다.

## Severity 사다리

| 등급 | 기준 | 예시 |
|------|------|------|
| `critical` | 이대로 구현하면 잘못된 제품이 되거나 구현이 불가능함. 문서 내 모순으로 두 구현자가 다른 앱을 만들게 됨 | 필수 스택으로 요구를 충족할 수 없음, 핵심 원칙과 정면 충돌, FR 간 직접 모순 |
| `major` | 구현 단계에서 반드시 되물어야 하는 공백·불일치. 앱 간 일관성이 깨질 위험 | 공통 계약(state 버전 등) 누락, 수용 기준이 FR과 불일치, 교차표와 앱 섹션 불일치 |
| `minor` | 구현자는 합리적으로 추측 가능하지만 문서 정확성을 해침 | ID 오타, 예시 JSON 사소한 불일치, 모호한 단위 |
| `info` | 개선하면 좋은 제안. 결함은 아님 | 더 나은 관례 제안, 스코프 확장 아이디어 |

기준 적용 시 자문할 것: *"이 문서를 처음 보는 구현자가 이 지점에서 멈추거나 틀리는가?"* 멈춘다 → major 이상. 틀린 걸 모르고 지나간다 → critical 검토.

**이 사다리가 최상위 기준이다.** 축별 체크리스트의 "기본 major" 같은 문구는 초기값일 뿐이며, 사다리 기준으로 강등/승격할 수 있다 — 조정 시 사유를 `recommendation` 또는 `issue`에 남긴다.

## 최종 판정 규칙 (리포터용)

- `critical` ≥ 1 → **FAIL** (PRD 수정 후 재검수 필요)
- `critical` = 0, `major` ≥ 1 → **CONDITIONAL PASS** (구현 착수 가능하나 명시된 major를 착수 전 해소)
- `major` = 0 → **PASS**

판정은 이 규칙으로만 한다. 인상·총점으로 뒤집지 않는다.

## 공통 검수 규칙

1. **PRD가 명시한 자기 기준으로 먼저 잰다.** 예: PRD §30이 "모든 앱은 SPEC.md 포함"이라 했으면, §31 템플릿과 각 앱 요구가 그 기준을 충족하는지 본다. 외부 기준은 그 다음이다.
2. **의도적 단순화와 누락을 구분한다.** 문서가 명시적으로 "not intended / optional / future"라 한 것은 결함이 아니다 (§5 Non-Goals, §18.6 등). 다만 문서가 그 결정의 근거로 특정 절을 인용했다면 그 인용이 성립하는지는 검증한다 — 의도가 명시된 것과 그 의도의 근거가 성립하는 것은 별개이며, 근거가 무너진 의도적 결정은 결함으로 다룬다.
3. **한 finding = 한 문제.** 여러 문제를 한 항목에 묶지 않는다. 병합·추적이 깨진다.
4. **검수 범위는 PRD.md 문서다.** 코드가 아직 없으므로 "구현이 없다"는 finding은 무효.
5. **지적 대상은 정의 문장이다.** 어떤 절을 "위반"이라 하려면 그 절의 조작적 정의(판정 기준을 담은 문장)를 인용하라 — 예시나 통념이 아니라. 역방향도 같다: 정의가 말하지 않는 조건을 정의에 넣어 읽고 위반을 선언하지 마라. 두 방향 모두 라운드 실측에서 finding이 무너진 원인이었다.

## 축별 체크리스트 (필요한 것만 로드)

| 담당 | 파일 |
|------|------|
| 구조·요구사항 품질 | `references/structure-checklist.md` |
| ANA 베이스 정합성 | `references/ana-baseline.md` |
| GIS 기술 실현성 | `references/gis-feasibility-notes.md` |
| 보고서 형식 (리포터) | `references/report-template.md` |
