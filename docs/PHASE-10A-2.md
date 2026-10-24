# Phase 10A-2 — Linux Codex Worker

## 구현 범위와 fail-closed 조건

- Linux CLI 경로 탐지와 `codex --version`, `codex login status` 진단을 지원한다.
- Linux Codex 호출은 `--sandbox read-only|workspace-write`, `--ignore-user-config`, `--ephemeral`을 사용하고 workspace-write의 network access를 끈다. Windows `windows.sandbox=mxc` 설정은 Linux 인자에 포함하지 않는다.
- 실행 전 Linux worker는 root가 아니어야 하고, 전용 절대 경로 `WOORI_LINUX_WORKER_HOME`을 `HOME`으로 사용해야 한다. 홈 디렉터리는 현재 UID 소유, 0700 이하 권한이어야 하며 SSH, GitHub CLI, Docker, cloud credential 디렉터리가 있으면 차단한다. `CODEX_HOME`은 worker home 내부여야 한다.
- API key 계열 환경변수는 실행 전에 거부하고, Codex 및 검증 자식 프로세스에는 최소 환경만 전달한다. Windows DPAPI 파일은 Linux에서 읽지 않는다.
- `bubblewrap` user namespace 경계가 실제로 작동하는지 검사한다. probe는 임시 workspace 쓰기, host-only marker/home 비가시성, system path 쓰기 거부, network namespace 생성을 확인한다.
- Codex와 테스트 명령은 user systemd scope에서 기본 CPU 100%, 메모리 768 MiB, 128 task로 제한한다. memory ceiling은 환경변수로 낮출 수 있고 768 MiB보다 높일 수 없다. MemAvailable이 작업 상한 + 1 GiB보다 낮거나 systemd cgroup 제한을 적용할 수 없으면 중단한다. 실행 중에도 5초마다 메모리 여유와 load average를 확인하고 임계치 초과 시 프로세스 그룹을 종료한다.
- 검증 스크립트는 별도 bubblewrap 환경에서 workspace만 쓰기 가능하고 네트워크·worker home이 마운트되지 않은 상태로 실행된다.
- 모든 환경 조건이 통과해도 현재 Codex CLI 버전의 sandbox 경계 검증 전에는 실행을 허용하지 않는다. 검증 이후 `WOORI_LINUX_CODEX_SANDBOX_VERIFIED_VERSION`을 실제 `codex --version` 출력과 일치시켜야 한다. 대시보드의 `Ready`는 이 조건까지 충족한 경우에만 표시한다.

## Ubuntu 설정 전제

OpenAI 공식 Codex sandbox 문서는 Linux에서 `bubblewrap` 설치를 안내하고, Codex의 OS native sandbox에서 `read-only` 및 `workspace-write` 모드를 제공한다. Ubuntu/Debian에서는 `bubblewrap` 패키지를 설치하고 user namespace/AppArmor 상태를 확인한다. Ubuntu 24.04에서 user namespace 제한으로 실패하면 시스템 제한을 전역 해제하지 말고 공식 문서의 bubblewrap AppArmor profile 절차를 검토한다.

1. Ubuntu 비운영 머신에 일반 권한의 전용 worker 계정을 준비한다. root로 Worker를 실행하지 않는다.
2. 해당 계정에 SSH 키, `gh` 로그인, Docker socket, 운영 DB 자격 증명을 두지 않는다.
3. 전용 home을 만들고 소유자와 권한을 계정에 맞춰 설정한다. `HOME`과 `WOORI_LINUX_WORKER_HOME`을 동일한 경로로 둔다.
4. 전용 계정에서 Codex CLI를 설치하고 ChatGPT 로그인만 수행한다. `codex login status`가 ChatGPT 로그인이라고 명확히 표시되어야 한다. API key 로그인은 거부된다.
5. `pnpm agent development status`로 bubblewrap, systemd 사용자 scope, MemAvailable, 전용 home 진단을 확인한다.
6. 격리된 임시 저장소에서 `codex exec --sandbox read-only`와 `--sandbox workspace-write`를 수동 실행한다. workspace 바깥 marker와 worker home을 읽을 수 없고, workspace 쓰기는 가능하며 외부 네트워크는 차단되는지 확인한다. CI는 Codex 호출을 하지 않는다.
7. 해당 Codex 버전에 대한 테스트를 직접 완료한 뒤에만 `WOORI_LINUX_CODEX_SANDBOX_VERIFIED_VERSION`을 설정한다. 다른 CLI 버전에서는 재검증 전까지 다시 차단된다.

Linux에서는 이 단계에서 ChatGPT 인증 파일을 암호화해 복사하거나 Windows DPAPI 파일을 가져오지 않는다. 실제 Linux Codex 실행은 이 저장소 작업 중 수행하지 않았다. Linux Codex login, 실제 `codex exec`, 실제 Codex sandbox 경계는 현재 Ubuntu worker의 사용자 설정 후 확인해야 한다.

## CI

`.github/workflows/linux-platform.yml`은 Ubuntu 24.04에서 Node 22, pnpm 9.12.1, TypeScript, ESLint, Vitest, Dashboard build 및 실제 rootless bubblewrap probe를 수행한다. Workflow는 읽기 전용 권한이며 Codex, API 키, GitHub token, 운영 secrets를 사용하지 않는다.

공식 설명: [Codex sandboxing](https://learn.chatgpt.com/docs/sandboxing)
