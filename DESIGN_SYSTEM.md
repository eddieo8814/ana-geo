# ANA Geo 디자인 시스템

베이스: [agent-native-agent `uxui-design-system`](https://github.com/tykimos/agent-native-agent/tree/main/skills/uxui-design-system) (토스 스타일, 의존성 0). 각 앱은 §9 독립성에 따라 토큰을 `vendor/ana/tokens.css`로 **벤더링**해서 쓴다 — 컴포넌트는 토큰 변수만 참조하고 색·그림자·라운드를 하드코딩하지 않는다(다크모드 자동 대응).

## 토큰 (vendor/ana/tokens.css)

| 카테고리 | 토큰 |
|---|---|
| 표면/텍스트 | `--bg --surface --surface-2 --text --text-sub --text-weak --line --line-2` |
| 브랜드 | `--blue`(#3182F6) `--blue-700 --blue-weak --green` |
| 배지 | `--cool-bg/fg`(차분) `--warm-bg/fg`(따뜻) |
| 라운드 | `--r-xl:24 --r-lg:20 --r:16 --r-sm:12 --r-xs:10` |
| 그림자 | `--sh-card`(2겹 소프트) `--sh-fab`(브랜드 글로우) `--sh-sheet` |
| 레이아웃 | `--header-h` `--safe-b: env(safe-area-inset-bottom)` |

다크모드는 `@media (prefers-color-scheme: dark)`에서 토큰 재정의로만 처리한다.

## 앱 공통 골격 (3층)

1. **글래스 헤더** — `.glass-header`(sticky + blur), 앱명(800) + 핵심 질문 칩(`.pill.badge-cool`)
2. **메인** — 좌측 패널은 `.card` 묶음(제목 12px/800/`--text-weak` 대문자), 지도가 주 시각 맥락
3. **하단 Converse** — 피드(말풍선) + 입력 바: 알약 입력(44px+) + **48px 원형 전송 버튼**(`--blue`, 프레스 `scale(.9)`)

## 말풍선 규칙

- 사용자: `--blue-weak` 배경, 우측 정렬 · 에이전트: `--surface` 카드, 좌측 · **활동(⚙)**: 배경 없음, `--text-weak`, 11px 모노스페이스
- 상태 수치(좌표·줌·건수)는 `.big-number` 계열 — 굵게(800), 자간 -0.04em, 블루

## 필수 체크

- `<html lang="ko">`, `viewport-fit=cover`, `theme-color`(라이트/다크 각각)
- 터치 타깃 ≥44px, 인터랙티브 요소 `aria-label`, 프레스 피드백 `transform: scale(.96)`
- 높이는 `dvh`, 하단 입력은 `--safe-b` 패딩
- 폰트: Pretendard + 시스템 폴백, 굵기 600/700/800 중심

## 안티패턴

색·그림자 하드코딩 / `vh` 단독 사용 / 44px 미만 타깃 / 얇은 폰트로 지표 표시 / 과한 모션·그라데이션
