# Phase 11C-2.2 — Codex 증거 보존 및 재검증

## 결과

Windows 임시 fixture에서 실제 Codex CLI를 정확히 1회 실행했다. CLI는 `0.163.0`, ChatGPT 로그인, Windows MXC sandbox를 확인한 뒤 실행했고, API key 환경변수 경로는 사용되지 않았다. Codex 호출 기록의 구독 잔여량은 조회할 수 없어 `Unknown`으로 저장했다. 이 기록은 토큰 사용량이나 ChatGPT 요금과 동일한 지표가 아니다.

- Job: `FEATURE-2026-000001`
- Invocation: `d13decb6-af90-4d79-b838-851f5747b4d6`
- 원본 fixture commit: `f9b865af5c2c5cc1d621045e958dc48f569318f3`
- 실제 변경: TypeScript 정규화 함수, 영어·한국어 메시지, 메타데이터, robots, sitemap, 두 locale의 렌더링 HTML
- 실행 중 독립 검사: TypeScript, ESLint, build, 3개 단위 테스트 모두 통과
- Codex 재시도: 0회
- 실제 AI 모델 호출 합계: 1회

첫 실행의 readiness 보고는 `Not Ready`였다. 파서가 `.example`/`.invalid` fixture 도메인과 HTML hreflang 표현을 충분히 처리하지 못해 SEO 및 경로 근거가 누락됐다. 이 원본 결과는 보존되어 있고 덮어쓰지 않았다. 파서를 고친 뒤 보존 증거를 사용하는 `feature-revalidate`를 모델 호출 없이 실행했다. 재검증은 파일 해시, 선언된 변경 경로와 diff, 계약, audit chain, TypeScript, ESLint, build, 단위 테스트, locale, route, SEO/canonical/hreflang/x-default, robots, sitemap, security 및 audit 항목을 `Verified`로 판정했고 `Revalidated`를 반환했다. 이는 임시 fixture 결과이며 실제 서비스의 출시 준비를 뜻하지 않는다.

## 구현

- SQLite `codex_invocations` 원장에 프로세스 실행 전 예약을 기록하고, 프로세스 시작·종료·PID·exit code·timeout·취소·재시도 이유를 추가 기록한다. 기본 fixture 예산은 작업당 1회, 일일 1회, 동시 1개다. 불확실한 호출은 `Unknown`으로 남기며 보수적으로 일일 예산을 소비한다.
- 큐 이력과 Development Audit 이벤트를 연결한다. 오래된 실행 상태는 프로세스 존재 여부를 확인한 후 `Unknown`으로 복구한다.
- 선택된 파일만 크기 제한과 secret scan을 거쳐 `artifacts/feature-execution/{job-id}/{invocation-id}/`에 보존한다. 파일별 SHA-256 manifest를 기록한다. 실행 worktree 정리와 감사 증거 보존을 분리한다. 이 디렉터리는 Git에서 제외된다.
- `development feature-revalidate` 및 `feature-factory revalidate`는 Codex를 호출하지 않는다. 저장된 증거를 해시 확인 후 격리된 임시 폴더에서 고정 검증 명령으로 다시 검사하고 새 감사 이벤트를 남긴다. 증거가 부족하거나 변조되면 완료 처리하지 않는다.
- JSON BOM 파싱, Cheerio 기반 HTML metadata/hreflang 판독, NUL 안전 Git status 경로 처리, untracked 파일 diff 검증을 유지한다.
- Vitest는 저장 artifact의 테스트 파일을 실제 테스트와 혼합하지 않도록 `tests/`만 수집한다.
- 대시보드는 invocation 횟수 및 상태를 보이고, CLI invocation 수와 ChatGPT 구독 잔여량을 구분한다.

## 검증

- TypeScript: 통과
- ESLint: 통과
- Vitest: 28개 파일, 162개 테스트 통과
- Dashboard production build: 통과
- 결정론적 readiness 정상/결함 fixture: 통과
- 실제 Codex fixture: 1회 실행, 위 독립 명령 통과
- 무호출 재검증: `Revalidated`, Codex 호출 0회
- 비용: 유료 API 요청 없음. ChatGPT 로그인 세션의 기존 구독 사용량은 소비될 수 있으며 잔여량은 확인되지 않음.
- Ubuntu Actions: 이번 변경에 대한 새 Run은 아직 확인하지 않았다. push 이후 workflow 결과를 별도로 조회한다.

## 제한 및 다음 단계

실제 서비스 저장소, MoneyBook, iwinv/VPS, PR, merge, production deploy는 건드리지 않았다. Linux Codex 코드 수정은 계속 잠겨 있다. 원본 live 실행의 최초 readiness는 실패 상태로 보존되어 있으며, 별도의 no-AI 재검증 이벤트가 이를 정정 판정한다. 따라서 실제 fixture 흐름은 검증됐지만 실제 서비스 개발·공개에 대한 Phase 11C-3은 이 결과만으로 활성화되지 않는다.
