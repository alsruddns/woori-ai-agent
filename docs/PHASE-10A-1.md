# Phase 10A-1 — 플랫폼 경계와 공통 Core

## 적용 범위

기존 CLI, SQLite 모델, 작업 큐, GitHub 연동, 분석 로직과 보고서 생성기는 유지한다. 이번 단계에서는 OS별 기능을 확인할 수 있는 adapter 경계를 추가하고, 기존 Windows 기능의 연결점을 그 경계 뒤로 이동했다. 대규모 디렉터리 이동이나 데이터베이스 마이그레이션은 필요하지 않았다.

`apps/cli/src/core.ts`의 도메인·저장 로직과 나머지 분석/오케스트레이션 모듈은 공통 TypeScript Core다. `apps/cli/src/platform-adapters.ts`는 OS 기능을 다음 인터페이스로 제공한다.

- `CredentialStore`: Windows DPAPI current-user 구현과 Linux의 명시적 `Not Configured` 상태
- `SandboxProvider`: Windows MXC live probe 경계와 Linux sandbox 미구현 상태
- `ProcessRunner`: OS별 timeout 종료 정책 식별
- `FileSystemAdapter`: Node 경로 규칙을 이용한 OS별 경로 처리
- `WorkerHealthProvider`: CPU 수, 메모리 및 지원 OS의 load average
- `CodexExecutorAdapter`: 해당 플랫폼의 안전한 Codex 수정 실행 가능 상태

`createPlatformAdapter()`가 현재 OS를 선택한다. 미지원 기능은 다른 인증 또는 sandbox로 대체하지 않는다.

## Windows 호환성

- Codex CLI 탐색, ChatGPT 로그인 상태 확인, MXC 탐침과 기존 수정 실행 경로를 유지한다.
- MXC 확인 전 수정 실행은 기존처럼 차단된다.
- OAuth 파일은 현재 Windows 사용자용 DPAPI adapter를 통해 복호화한다.
- `codexReadiness`와 Development 환경 진단에 플랫폼 adapter 및 실제 자원 상태를 노출한다.

## Linux 경계

- Linux Codex CLI 경로를 탐지하고 버전 및 로그인 상태를 읽기 전용으로 진단한다.
- Linux 실행 환경에서 API 키 환경변수는 Codex 하위 프로세스에 전달하지 않는다.
- Windows `.dpapi` OAuth 파일은 읽거나 복호화하지 않는다.
- Linux credential encryption 및 Codex sandbox는 Phase 10A-1에서 구현되지 않았고 `Not Configured`다. Codex 쓰기 실행은 현재 Windows MXC 전용 검사로 차단된다.
- Linux에서 load average와 실제 CPU/메모리 값은 worker health snapshot에 제공된다. 이는 아직 중앙 worker heartbeat나 Dashboard의 온라인 상태가 아니다.

## 플랫폼 데이터와 인증

SQLite 파일은 플랫폼 로컬 데이터로 유지한다. 이 단계는 SQLite 공유, 작업 lease 동기화, worker heartbeat 서버 또는 스케줄러를 추가하지 않는다. DPAPI 토큰을 Linux로 복사하는 기능도 없다. Linux OAuth는 별도 인증 저장소 구현과 사용자 동의가 준비될 때까지 `Not Configured`로 유지한다.

## Phase 10A-2 진입 조건

1. 지원되는 Linux Codex CLI 로그인 형태를 사용자 플랜/환경에서 검증한다.
2. 인증 파일을 일반 실행 프로세스와 생성 코드에서 분리할 Linux credential store를 선택하고 threat model 및 파일 권한을 검토한다.
3. Linux sandbox/컨테이너 경계, 네트워크 및 자원 제한, 자격 증명 미노출을 Ubuntu runner에서 검증한다.
4. 격리·credential·resource 검증이 끝나기 전 Linux 코드 수정은 비활성화한다.
5. 실제 iwinv 설치, root 권한, 운영 Docker socket 접근, SSH 키 접근은 별도 단계와 승인 없이는 하지 않는다.

