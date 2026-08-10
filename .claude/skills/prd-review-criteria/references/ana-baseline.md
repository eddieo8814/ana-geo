# ANA 베이스라인 — agent-native-agent 저장소에서 추출한 사실

prd-ana-alignment-reviewer 전용. 2026-08-10 기준 `github.com/tykimos/agent-native-agent` (main)에서 추출. 각 항목은 PRD 대조의 근거로 인용한다. 최신 여부가 의심되면 `gh api repos/tykimos/agent-native-agent/contents/{path}`로 원문을 재확인하라.

## B1. 3원칙 (README.md "The Three Principles")

> 이 3원칙은 "이 하네스로 만드는 모든 ANA의 수용 기준(acceptance criteria)"으로 선언되어 있다.

1. **Watch + Converse** — 시각 상태와 채팅이 *한 화면*에 공존. 고정 UI 클릭이 아니라 보고-말하며 운영.
2. **Agent as Runtime** — 에이전트가 데이터를 읽고, 실행하고, 요청 시 **앱 자신의 코드를 재작성**한다. "Inference is the runtime."
3. **Own Your Harness** — 의존성 0, 셀프호스팅, 영구 소유.

## B2. 런타임 아키텍처 (skills/agent-native-app-harness/references/ana-architecture.md)

- 구성요소: **대시보드(웹)** + **채널(fakechat 등)** + **대시보드 서버**(정적 서빙 + 채팅 브리지 API + 상태 JSON, 의존성 0) + **인바운드 릴레이** + **코딩 에이전트(Claude Code)**
- 핵심 규칙: **인바운드는 채널로 자동 푸시, 응답은 대시보드로(제안→승인)** — 이래야 watch+converse가 한 화면에 유지됨
- 응답 경로: 에이전트 → `POST /api/agent` (리치 응답: 텍스트/제안 diff) → 대시보드 표시

## B3. 상태·동기화 계약 (ana-architecture.md §4)

- 상태 파일에 **`version` 필드**를 두고 변경마다 +1
- 대시보드는 **폴링(약 2.5초)**으로 버전 변화 감지 → 재요청 → 전 기기 동기화
- 사용자 액션은 localStorage가 아니라 **서버 저장**
- SSE는 터널 버퍼링 문제로 폴링을 항상 병행

## B4. 제안→승인 패턴

- 에이전트 응답은 "제안(before/after diff) → 사용자 승인 → 적용" 카드 UX를 지원
- README: "ANA proposes the change, applies it on approval, and evolves the app at runtime"

## B5. Use = Build

- README TL;DR: "No PR, no ship step — the running agent rewrites the app live and the dashboard reloads." / "Use = Build. That's the whole idea."

## B6. 저장소 구성

- 앱 코드가 아니라 **스킬 모음**이다: `agent-native-app-harness`(오케스트레이터), `uxui-design-system`(Watch), `fakechat-dashboard-agent`(Converse 배선), `realtime-mirror-channel`, `content-studio`
- 실행 템플릿은 별도 저장소 **ana-starter** (`node server.js` → localhost)

## PRD 대조 시 주의

- PRD의 공통 런타임(§8.1: index.html / app.js / server.js / state.json)은 ana-starter 계열의 단순화다. 단순화 자체는 결함이 아니다 — **베이스 계약(B2~B4) 중 무엇을 채택하고 무엇을 버리는지 명시했는가**를 본다.
- 특히 다음을 대조하라:
  - PRD §12 상태 모델에 `version` 필드가 있는가 (B3)
  - PRD에 Converse Surface의 배선 요구(채널/브리지/응답 경로)가 있는가, 그림에만 존재하는가 (B2)
  - PRD §24.3의 proposal/approval 패턴이 "where available" 수준인가, 필수 계약인가 (B4)
  - 각 앱 수용 기준의 "ANA can alter …"가 B1-2(코드 재작성 포함)를 커버하는가, 상태 변경만 말하는가
  - PRD §3.3 / §27의 셀프호스팅·키 불요 원칙이 B1-3과 일치하는가
