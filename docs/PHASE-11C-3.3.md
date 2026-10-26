# Phase 11C-3.3 — Controller 실행 제한 및 Quiz 실행 사전 판정

## 결과 요약

Controller·Worker·Codex 실행 경로에 서비스별 제한 검사를 연결했다. 격리 SQLite 테스트에서 제한 경계와 정책 갱신 동작을 확인했다. 실제 Quiz 개발은 현재 Controller 정책이 실행을 차단하므로 시작하지 않았다.

## 실행 제한 적용

- **최대 동시 개발 작업 수:** `code_change` Claim을 SQLite 즉시 트랜잭션에서 검사한다. 0이면 거부하며 같은 서비스의 활성 Claim/Running/Testing 건수가 설정값에 도달하면 추가 Claim을 차단한다.
- **일일 개발 작업 수:** Controller UTC 날짜 기준으로 `Running`에 처음 진입한 고유 전역 작업 ID를 집계한다. 작업 생성 및 Claim은 사용량으로 세지 않고, 같은 작업의 재실행은 다시 집계하지 않는다. 상한을 넘긴 Claim은 차단 이력을 남긴다.
- **재시도:** Codex 실행기는 서비스별 `maximumRetryCount`와 전역 `automaticRetry`를 함께 적용한다. Feature Planner도 두 제한 중 낮은 값을 계약에 반영한다. 최초 실행은 재시도 횟수에 포함하지 않는다.
- **Codex 시간 제한:** Codex 실행기에 요청된 시간과 서비스별 초 제한 중 낮은 값을 적용한다. 상한은 60–3600초다. 기존 ProcessRunner의 timeout 종료 및 결과 기록을 사용한다.
- **기능 복잡도:** 기능 개발 Claim과 실행기 사전 검사에서 0–5 점수를 서비스 상한과 비교한다. 복잡도 정보가 없으면 차단한다.
- **우선순위 가중치:** 기존 후보 기본 점수 × (`priorityWeight` / 100) 계산을 유지했다. 실행 권한이나 호출 예산에는 영향을 주지 않는다.

코드 변경 Claim은 최신 Controller Policy Version, 현재 Worker의 정책 확인 응답, 운영 모드, 긴급 정지, 전역 및 서비스별 개발/Codex 허용, 프로젝트 잠금, Windows 쓰기 권한, ChatGPT 로그인 상태, Codex CLI 및 Sandbox 준비를 확인한다. Lease 갱신, 실행 상태 전환, 코드 변경 Lease 검증에도 정책 버전과 실행 게이트를 다시 적용한다. 차단 근거는 `controller_job_policy_blocks` 및 Controller 이벤트에 중복 없이 기록된다.

SQLite 마이그레이션은 기존 `controller_jobs` 데이터에 `complexity_score`와 `started_at` 열을 추가한다. 실제 운영 DB에는 이번 작업에서 마이그레이션을 실행하지 않았다.

## Codex 호출 계량

실제 기본 Codex ProcessRunner 경로는 프로세스 생성 전 Invocation 예약을 기록하고, spawn callback에서 PID와 시작 상태를 저장한다. 종료 후 상태를 기록한다. 예약/실행 기록은 Controller 작업 일일 한도와 별도인 Codex CLI 호출 예산으로 계산하며, 구독 잔여량은 계속 `Unknown`으로 취급한다. 주입된 테스트 실행 함수는 실제 CLI 프로세스가 아니므로 Invocation Ledger에 실제 AI 호출로 세지 않는다.

## Dashboard

Control Center 응답에 Controller Policy Version, Worker 등록/온라인 수, 서비스별 활성 작업 수, UTC 일일 시작량 및 제한값을 추가했다. 설정된 숫자와 현재 Worker 실행 가능 상태를 별도로 표시하며, 제한 구현 표시는 실제 실행 중이라는 뜻이 아니다.

## 실제 실행 직전 상태 확인

읽기 전용 조회 결과:

- woori-ai-agent develop: `bec930283a6b6dc1563641a6b1fccab1b4dcd7c3`
- Controller Policy Version 6, 모드 `FEATURE_EXPANSION`, 긴급 정지 OFF
- 전역 `featurePlanning`, `featureSpecification`, `autonomousFeatureDevelopment`, `codexExecution`: 모두 OFF
- Quiz 서비스 개발 및 Codex 토글: ON, 동시 작업 1, UTC 일일 작업 1, 재시도 1, Codex 제한 900초, 복잡도 제한 1
- Controller 등록 Worker 0명, Controller 작업 0건
- Codex Invocation Ledger: 2026-10-26 UTC의 기록 없음(로컬 1회 한도 중 0회 사용); ChatGPT 구독 잔여량은 확인되지 않음
- Quiz develop/origin develop: `1053b8896a5363adbfb15d5061f27470b5094371`, 기존 로컬 worktree는 깨끗함. 기존 CI worktree 2개는 그대로 보존.

전역 기능 계획·명세·자동 개발·Codex 정책이 OFF이고 등록 Worker도 없으므로 Codex 인증/Sandbox를 다시 점검하거나 Quiz Clone을 만들지 않았다. 관리자 정책, 호출 예산, 기존 Worktree는 변경하지 않았다. Quiz 소스 변경, Codex 모델 호출, GitHub push/PR, 병합, 운영 배포는 없었다.

실행을 재검토할 때 관리자 Control Center에서 다음 전역 설정을 정책에 맞게 켜고 새 Policy Version을 확인해야 한다: Feature Planning, Feature Specification, Autonomous Feature Development, Codex Execution. 그 뒤 Windows Worker 등록·인증·Sandbox 준비와 해당 Policy Version acknowledgement가 확인돼야 한다. 이 보고서는 설정 변경 승인이 아니다.

## 검증

- `pnpm typecheck`: 통과
- `pnpm lint`: 통과
- `pnpm test`: 29개 파일, 178개 테스트 통과
- `pnpm build`: Dashboard Vite 빌드 통과
- 실제 Windows Codex 모델 실행 및 Ubuntu Actions 실행: 미실행

주요 새/수정 테스트는 동시 Claim, 0/1 제한, UTC 일일 작업 상한, 중복 시작 집계, 복잡도 Unknown/초과, 최신 Worker 정책 acknowledgement, 정책 버전 변경, Codex 시간/재시도 상한 및 실제 비-AI CLI 프로세스의 Invocation Ledger 기록을 검증한다.

## 상태

- Quiz 실제 기능 개발: **차단, 실행하지 않음**
- 실제 Windows Worker 및 Sandbox 상태: **이번 실행에서는 재확인하지 않음**
- Quiz 기능 결과/locale/SEO/Sitemap: **미검증, Clone을 만들지 않아 소스 검사를 실행하지 않음**
- 실제 배포, PR, 병합: **수행하지 않음**
- Phase 11D: **진입 준비 미완료**
