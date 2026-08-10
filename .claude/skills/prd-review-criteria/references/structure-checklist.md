# 구조 검수 체크리스트

prd-structure-auditor 전용. 각 항목을 점검하고, 위반 시 finding으로 기록한다.

## 1. 섹션 완비성

- [ ] 제품 개요 / 비전 / 원칙 / 목표 / 비목표(Non-Goals)
- [ ] 앱 목록과 디렉토리 구조 (§6) — 선언된 앱 수와 개별 앱 섹션 수 일치
- [ ] 공통 아키텍처 / 데이터 모델 / 상태 모델
- [ ] 에러 처리 / 성능 / 보안 / 로깅 요구
- [ ] 개발 단계(Phases) / Definition of Done / 성공 기준

## 2. FR ID 체계

- 형식: `FR-{APP약어}-{3자리}` — 약어가 앱마다 일관적인가 (MAP, EXP, SEARCH, SITE, ROUTE, SAT, CD)
- 번호 중복·건너뜀·역순 여부 (스크립트로 전수 추출: `grep -oE 'FR-[A-Z]+-[0-9]+' PRD.md | sort | uniq -c`)
- 문서 내 다른 위치에서 FR을 참조할 때 ID를 쓰는가, 산문으로 재서술하는가 (재서술은 drift 위험 → minor)

## 3. 앱 섹션 템플릿 균일성

7개 앱 각각에 다음 하위 섹션이 있는가:
- Purpose (core question 포함) / Required Features / ANA Interaction Examples / Acceptance Criteria
- 추가 섹션(External Data, Dependencies, Result Model 등)의 유무가 앱 성격상 정당한가

## 4. 교차 일관성 대조표

아래 쌍을 반드시 대조한다. 불일치의 초기 severity는 `major`이며, SKILL.md의 사다리 기준으로 조정한다 (조정 사유 기록):

| A | B | 대조 내용 |
|---|---|---|
| §6 앱 목록 | §7 진행표, §22 capability matrix, §29 phases, §33 데모 시나리오 | 앱 이름·수·순서 |
| §22 capability matrix | 각 앱 Required Features | 매트릭스의 ✓가 해당 앱 FR로 뒷받침되는가 (예: Route 행의 POI discovery ✓ vs §19 FR 목록) |
| §14 의존성 전략 | 각 앱의 의존성 선언 — **선언이 없는 앱(§15, §16, §18, §20 등)도 포함** | 라이브러리 목록·도입 시점·선언 누락 |
| §8.1 공통 구조 | §30 DoD 파일 목록, §31 SPEC 템플릿 | 파일 구성 일치 |
| §11 공통 property 모델 | §18.4, §19.5, §21.6 결과 모델 | 필드 명명 규칙(camelCase 등)·재사용 여부 |
| §12 상태 모델 | §15.2 FR-MAP-006(markers in state.json) 등 상태 언급 FR | 상태 예시에 해당 필드 존재 여부 |
| §16.3 POI 프리셋 | §17.4 조건 모델, §17.6/§33 예시, §11 category 필드 | 카테고리 어휘 정본 존재 여부 — 예시가 프리셋에 없는 카테고리(subway_station 등)를 참조하는지 |
| §1.1/§34 진행 다이어그램 | §6 앱 목록 | 분기 구조(search 아래 site/route 병렬)가 §29 phases와 정합인가 |

## 4-1. 개정 재검수 시 — 신설 절 양방향 접합 점검

라운드 2 이후(문서 개정 재검수)에는 **개정으로 신설·변경된 절**마다 두 방향을 점검한다. 라운드 2 실측에서 신규 결함의 대부분이 이 유형이었다(새 범례를 새 행이 위반, 새 규칙을 자기 문서가 위반, 새 참조 채널이 서버 책임 목록에 부재 등):

1. **바깥 방향**: 신설 절이 참조하는 기존 절이 그 참조를 실제로 지원하는가 (예: 새 규칙이 전제하는 엔드포인트가 서버 책임 목록에 있는가)
2. **안쪽 방향**: 신설 절을 참조해야 할 기존 절이 갱신되었는가 (예: 새 범례가 생겼으면 기존 표의 모든 셀이 그 범례를 만족하는가, 새 판정 규칙이 생겼으면 문서 자신의 기존 문장들이 그 규칙을 통과하는가)
3. **제거의 유효성**: 개정이 요구·표기(매트릭스 ✓ 등)를 **제거**로 해소했다면, 제거된 능력을 문서의 다른 곳이 여전히 요구하지 않는지 확인한 뒤에만 해소로 판정한다. 확인 없는 제거는 정합성 점검은 통과하면서 요구만 사라지게 만든다(라운드 3 실측: Site 열 ✓ 제거가 FR-SITE-006·§33의 요구와 충돌).

## 5. 수용 기준 ↔ FR 매핑

각 앱에서: Acceptance Criteria의 각 항목이 어떤 FR에 대응되는지 추적 가능한가. FR인데 수용 기준에 없는 것, 수용 기준인데 FR에 없는 것을 나열한다.

## 6. 검증 가능성(testability)

- 필수 요구("shall", "must")에 측정 불가 표현이 섞여 있는가 — "where needed", "wherever possible", "when necessary"가 **필수 요구 문장 안에** 있으면 minor~major
- 수치 요구에 단위·범위가 명시되어 있는가

## 7. 예시 JSON 유효성

문서 내 모든 ```json 블록을 추출해 파싱한다:

```bash
python3 - <<'EOF'
import re, json
src = open('PRD.md').read()
for i, m in enumerate(re.findall(r'```json\n(.*?)```', src, re.S)):
    try: json.loads(m)
    except Exception as e: print(f'block {i}: {e}\n{m[:80]}')
EOF
```

파싱 성공 후, §11 공통 property 모델을 따라야 할 블록이 실제로 따르는지 대조한다.
