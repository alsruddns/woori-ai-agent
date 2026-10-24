# Phase 10A-2.5 — Linux Sandbox 검증 상태

## 안전 상태

Linux 코드 수정은 계속 차단한다. `diagnoseLinuxHost()`는 항상 `codeModificationEnabled: false`를 반환한다. 진단 결과는 실행 준비의 증거일 뿐이며 ChatGPT 로그인, write 범위 검증, 인증과 코드 실행 환경 분리를 대신하지 않는다.

Windows MXC와 DPAPI 경로는 변경하지 않았다. iwinv 운영 서버, 운영 서비스, Docker, 데이터베이스에는 접속하거나 변경하지 않았다.

## 기존 실측

- Ubuntu CI Run `40065026443`에서 정적 검사와 프로젝트 검증이 성공했다. 이 run은 Linux 호스트에 Codex를 설치하거나 로그인하지 않았고, AI 모델 요청도 하지 않았다.
- 같은 runner의 Bubblewrap 경계 probe는 `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`로 실패했다.
- 오류는 Bubblewrap이 network namespace에서 loopback을 설정할 때 커널이 `RTM_NEWADDR`를 거부했다는 사실을 보여준다. 해당 실행에서 namespace 생성, seccomp, AppArmor 상태를 별도로 수집하지 않았으므로 하나를 확정 원인으로 단정하지 않는다.
- Windows 개발 PC에서 WSL이 설치되지 않아 실제 Ubuntu 로컬 검증은 수행하지 않았다.
- Ubuntu에서 Codex ChatGPT 인증, Codex sandbox, workspace 수정, systemd CPU/메모리 제한은 아직 실증되지 않았다.

## Phase 10A-2.5 Ubuntu 실행 결과

- Workflow Run `40095171933`, commit `8ef60519c9c17bc778bff27ceab1133014e8d334`가 성공했다.
- Runner: Ubuntu 24.04.5 LTS, kernel `6.17.0-1022-azure`, UID 1001.
- Bubblewrap: `/usr/bin/bwrap`, version 0.9.0. Codex CLI는 설치되지 않아 버전·인증·Codex sandbox 테스트는 `Not Configured`였다.
- Rootless user namespace probe는 `/proc/self/uid_map: Operation not permitted`로 거부됐다. network namespace probe도 같은 단계에서 거부됐다.
- AppArmor가 활성화됐고 `apparmor_restrict_unprivileged_userns=1`로 확인됐다. 해당 환경에서 user namespace 거부와 Bubblewrap `RTM_NEWADDR` 실패가 함께 재현됐다. AppArmor가 실패의 유일한 원인이라고 단정하지 않는다.
- user systemd scope에서 CPUQuota 100%, MemoryMax 768 MiB, TasksMax 128 probe는 통과했다. 이는 테스트용 `true` 프로세스에 적용된 결과이며 Codex 작업 부하의 적정성까지 검증한 것은 아니다.
- Runner 바깥 프로세스는 `NoNewPrivs=0`, `Seccomp=0`이었다. Bubblewrap가 시작되지 않아 sandbox 내부 seccomp 적용은 검증되지 않았다.
- 실제 Bubblewrap filesystem/network boundary probe는 `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`로 실패했다. workflow 전체의 정적 검사는 통과했고, 해당 미지원 상태는 경고로 남겼다.
- 진단 후 Linux workspace-write를 CLI 버전 환경변수로 켤 수 없도록 차단을 강화했다. 모든 호스트 probe가 Ready여도 이 Phase에서는 Linux 수정 실행기가 `Not Configured`를 반환한다.

## 새 진단 명령

```bash
pnpm agent development linux-diagnostics
```

진단은 다음 상태를 읽기 전용으로 수집한다: 배포판과 커널, Codex/Bubblewrap 경로 및 버전, Codex의 로그인 방식(상태만 읽고 출력 원문은 보존하지 않음), rootless user/network namespace probe, AppArmor와 unprivileged-userns 제한, 프로세스의 no-new-privileges/seccomp 값, user systemd CPU·메모리·task 제한 probe, 임시 디렉터리에서의 Bubblewrap 파일·네트워크 경계, 설치된 경우 공식 `codex sandbox linux --permissions-profile read-only` probe.

진단은 sysctl, AppArmor, seccomp 설정을 바꾸지 않는다. CI에서는 Codex CLI가 없는 것이 정상이며, 이에 따라 Codex 및 인증 상태가 `Not Configured`로 기록된다. CI는 AI 모델 호출이나 인증 파일을 사용하지 않는다.

## 공식 구현 및 오류 근거

OpenAI 문서는 Codex의 Linux sandbox가 Bubblewrap과 seccomp를 사용하고, 컨테이너/호스트가 필요한 namespace 또는 seccomp 동작을 차단할 수 있다고 설명한다: [Codex sandboxing](https://learn.chatgpt.com/docs/sandboxing), [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security).

OpenAI Codex 저장소의 [#15057](https://github.com/openai/codex/issues/15057)에는 Ubuntu/AppArmor 환경에서 같은 `Failed RTM_NEWADDR` 증상이 보고되어 있다. 다른 Codex 보고서 [#29908](https://github.com/openai/codex/issues/29908)도 같은 오류를 기록하지만 launch context 등 복수 요인을 논의한다. 이는 우리 CI에서 AppArmor가 원인임을 입증하지 않는다. 호스트 전체 보안 제한을 끄거나 `danger-full-access`로 우회하지 않는다.

## 실제 Ubuntu 검증 절차

격리된 Ubuntu 테스트 VM에서 비-root 전용 계정으로 진단 명령을 실행한다. 운영 서버는 테스트 대상으로 사용하지 않는다.

```bash
pnpm agent development linux-diagnostics
codex login status
codex sandbox linux /usr/bin/true
```

이후에만 임시 Git 저장소를 사용해 read-only, network 격리, workspace 내부 쓰기, workspace 외부 쓰기 차단을 각각 확인한다. 자원 제한은 user systemd scope의 실제 적용값을 확인한다. ChatGPT 인증은 사용자가 관리하는 해당 테스트 VM에서 직접 수행한다. 토큰을 복사하거나 이 저장소, 로그, SQLite에 남기지 않는다.

Linux write execution readiness는 별도의 안전 검토 후 갱신해야 하며, 현재의 CI probe 통과만으로 잠금을 해제하지 않는다.
