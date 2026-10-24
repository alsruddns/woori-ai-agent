# Phase 11A — Agent Control Center

## 운영 방식

Control Center는 기존 Dashboard의 `/api/control-center` 및 `/api/control-center/policy`와 같은 Controller SQLite를 사용합니다. 기본 모드는 `MONITOR_ONLY`이며, 정책은 optimistic version check와 SQLite `BEGIN IMMEDIATE` 트랜잭션으로 저장됩니다. 각 변경과 전후 snapshot은 `policy_change_events`에 기록됩니다.

관리자 비밀번호를 로컬 `.env`의 `WOORI_ADMIN_PASSWORD`에 16자 이상으로 직접 설정하고 Dashboard API를 재시작해야 정책을 변경할 수 있습니다. 비밀번호가 없으면 설정 조회만 가능하며 정책 변경은 거부됩니다. 브라우저 세션은 메모리에서 최대 8시간 유지되고 HttpOnly/SameSite 쿠키와 CSRF 토큰을 사용합니다. Controller는 loopback에만 바인딩됩니다. 비밀번호·세션 토큰은 SQLite나 로그에 저장하지 않습니다.

## 실행 게이트

운영 모드와 기능 토글은 정책 의도를 저장하며 실행기 준비 상태를 대신하지 않습니다. Phase 11A에서는 Codex 자동 실행, 자동 버그 수정, 자동 기능 개발, 자동 PR, 자동 병합, 운영 배포를 Controller 게이트에서 계속 차단합니다. Linux 코드 수정, Calculator 코드 수정, MoneyBook 자동 개발도 잠금 상태입니다. Emergency Stop과 `PAUSED`는 새 스케줄 실행 및 Worker 작업 claim을 차단합니다. 대시보드 조회와 감사 이력 열람은 계속 허용됩니다.

Scheduler에는 기존 `WOORI_SCHEDULER_ENABLED=true`, zero-cost 환경 정책이 계속 필요합니다. Control Center의 Scheduler 토글도 ON이어야 하며 두 조건 중 하나라도 없으면 실행되지 않습니다. 이 phase에서는 유료 AI API 호출 경로를 추가하지 않았습니다.

Worker는 인증된 Controller 요청으로 `/v1/policy/current`를 조회할 수 있고, 모든 작업 claim은 Controller의 현재 정책/긴급 정지 상태로 검사됩니다. `pnpm agent worker policy`로 연결된 Controller 정책을 확인합니다. 현재 자동 개발 권한으로 사용되는 기능은 없습니다.

## 현재 기본값

- Mode: `MONITOR_ONLY`
- 우선순위 가중치: Tools 40, Calculator 30, Quiz 15, Docs 15, Home 0
- 자동 개발, Codex, PR, merge, deploy: OFF 또는 Blocked
- 자동 동시 작업 상한: 서비스당 1, Worker 기존 단일 실행 제한 유지
- 감사 이벤트: 항상 활성화, 일반 HTTP API로 삭제할 수 없음
- Emergency Stop: 기본 해제, 관리자 인증 필요

Home 우선순위 0은 기능 확장 작업 선택에 대한 값이고 Home의 읽기 전용 모니터링에는 영향을 주지 않습니다. Calculator의 잠금은 UI나 운영 모드 변경으로 해제할 수 없습니다.

## 검증 한계

대시보드 정책 설정과 Controller/Worker 정책 조회는 구현되어 있지만 Windows/Linux Worker의 장기 실행 세션이 정책 변경을 실시간 push 방식으로 받지는 않습니다. Worker는 claim 시 Controller의 현재 상태를 적용하며, 개발·PR·merge·deploy는 이 phase에서 모두 차단됩니다. 비상 정지는 진행 중인 외부 GitHub Actions 또는 이미 시작된 배포를 취소하지 않습니다.
