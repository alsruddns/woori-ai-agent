# Phase 10A-3 — Windows/Linux 분산 작업 큐

## 구현 상태

- 중앙 Controller는 Controller 호스트의 로컬 SQLite (`data/controller/queue.sqlite`)를 사용한다. 새 Linux 데이터 디렉터리는 권한 `0700`, DB 파일은 `0600`으로 제한한다. Worker끼리 SQLite 파일을 네트워크 공유하지 않는다. `WOORI_CONTROLLER_DB_PATH`로 경로를 지정할 수 있다.
- API는 기본 `127.0.0.1:4180`에서만 수신한다. 원격 Worker 연결은 사설 IPv4(RFC1918) 또는 ULA IPv6, 명시적 opt-in, TLS 인증서와 Worker별 32자 이상 bearer secret이 모두 설정돼야 한다. 공개 IP 및 임의 hostname 바인딩은 거부한다.
- Worker 인증은 HTTPS(원격) + Worker ID + timing-safe bearer 비교 + 60초 timestamp 창 + 1회용 nonce로 처리한다. `WOORI_CONTROLLER_WORKER_POLICIES`의 Controller 측 신뢰 정책에 Worker별 OS 및 코드 변경 Claim 허용 여부를 별도로 등록한다. Worker 요청 본문만으로 OS나 코드 변경 권한을 높일 수 없다. Linux의 코드 변경 정책은 항상 거부된다. 서버는 token을 SQLite나 로그에 저장하지 않는다. 비밀값은 사용자 OS의 비밀 저장 수단이나 프로세스 환경에서 직접 관리하고 Git에 넣지 않는다.
- 작업 제출은 idempotency key, Claim은 SQLite `BEGIN IMMEDIATE` 트랜잭션, 전역 증가 Fencing Token과 Lease를 사용한다. Lease가 만료되어도 자동 재할당하지 않는다. 운영자가 프로세스 종료 증거를 확인하고 `controller recover`를 명시적으로 수행해야 한다.
- 외부 side effect 전 `/v1/leases/assert`를 통해 현재 Fencing Token을 다시 확인해야 한다. 현재 단계에는 PR 생성·병합·배포 호출을 연결하지 않았다.
- 기존 로컬 Development Queue에 `development_global_job_map`을 additive 방식으로 추가한다. 기존 큐 및 실행 이력은 삭제하거나 초기화하지 않는다.
- Linux는 QA/SEO 등 분석 작업만 Claim할 수 있다. Linux 코드 수정은 sandbox 상태, 버전, 환경변수 또는 Worker 요청으로 켤 수 없으며 계속 비활성화다. 코드 변경 Claim 자격은 Controller 측 Worker 정책과 Windows OS, ChatGPT 로그인, 검증된 sandbox, CLI readiness, 1 GiB 여유 메모리를 모두 요구한다. 분석 Claim도 최소 256 MiB 여유 메모리가 필요하다. 이는 작업 예약 자격만 검사하며 Codex 코드를 자동 실행하지 않는다. Calculator 코드 수정과 MoneyBook 작업은 Controller에서 차단된다.

## 설정과 실행

1. `.env.example`을 참고해 각 호스트의 로컬 환경에 설정한다. 실제 Worker token, TLS key/certificate는 저장소, SQLite, GitHub Actions, 로그에 넣지 않는다.
2. Controller를 실행할 개발용 호스트에서 `pnpm agent controller serve`를 실행한다. 이 단계에서는 운영 VPS에 설치하지 않는다.
3. 각 Worker에 고유 `WOORI_CONTROLLER_WORKER_ID`, 비식별 `WOORI_CONTROLLER_HOST_LABEL`, Controller에서 해당 ID에 등록한 Worker token, `WOORI_CONTROLLER_URL`을 별도로 설정한다.
4. Worker 초기 등록은 `pnpm agent worker register`로 한다. 주기 상태 보고는 `pnpm agent worker heartbeat-loop --interval-seconds=30`으로 시작하고 Ctrl+C로 종료한다. Heartbeat 간격 허용 범위는 15~120초다.
5. 기존 승인된 로컬 Ready 작업을 중앙으로 복사하려면 `pnpm agent worker sync`를 실행한다. 같은 로컬 task는 idempotency key로 중복 생성되지 않는다. Controller 장애 시 offline claim은 수행되지 않는다.
6. Controller 로컬 운영자가 `pnpm agent controller approve --job-id=<id> --approve=true`로 명시 승인한 다음 Worker가 `pnpm agent worker claim`으로 Claim한다. Claim은 작업 예약이며 Codex 실행을 의미하지 않는다.
7. 실행 Lease를 유지할 때는 `heartbeat-loop`에 `--job-id`, `--lease-id`, `--fencing-token`을 모두 제공한다. 이를 생략하면 작업 heartbeat만 갱신되고 Lease는 자동 연장되지 않는다. stale/expired fencing 응답이면 loop가 중단된다.
8. 작업 상태 변경은 Controller가 발급한 최신 lease 값으로 `pnpm agent worker transition ...`을 사용한다. 완료/실패는 해당 fencing token이 현재 유효할 때만 기록된다.

## 현재의 중요한 한계

- Controller는 단일 권한자 프로세스다. SQLite는 동시 쓰기를 serialize하지만 Controller의 HA/리더 선출은 구현하지 않았다. 같은 DB 파일을 여러 호스트에서 열면 안 된다.
- Controller 호스트를 이용할 수 없으면 Worker는 등록/상태 보고/Claim을 실패 처리하고 임의로 소유권을 얻지 않는다. 안정적인 사설 네트워크의 Controller 호스트 구성과 운영 승인은 후속 단계다.
- Heartbeat가 끊기면 Dashboard에서 Worker를 Offline으로 표시하지만 실행 중인 프로세스의 종료로 간주하지 않는다. 명시적인 프로세스 종료 확인 전까지 Lease를 다른 Worker에 주지 않는다.
- `heartbeat-loop`는 Worker 상태 보고/선택적 Lease 갱신이다. 작업 dispatch daemon, 자동 Codex 실행, 자동 PR, 자동 merge, 자동 deploy가 아니다.
- 이 단계에서 확인한 것은 로컬 Windows Node/SQLite 로직과 모의 API 경로다. 별도 Ubuntu 실행, 실제 사설망/TLS 통신, Linux Codex 인증·sandbox, 외부 Worker 장애 복구는 아직 실측하지 않았다.
- Windows 기존 MXC/DPAPI Codex 실행 경로는 변경하지 않았다. 분산 큐 코드가 Codex를 자동 호출하지 않는다.

## 안전한 복구

Lease 만료만으로 재할당하지 않는다. 이전 Worker 프로세스가 종료됐다는 증거와 확인자를 확보한 뒤에만 다음 명령을 실행한다.

```powershell
pnpm agent controller recover --job-id=<id> --process-terminated=true --verified-by=<operator> --evidence=<termination evidence>
```

새 Claim은 더 큰 Fencing Token을 받는다. 이전 Token으로 제출된 결과 및 side effect 검사는 거부된다. `--evidence`에는 비밀정보나 개인정보를 넣지 않는다.

## 확인 범위

`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`를 실행한다. 테스트에는 idempotency, 두 동시 Worker의 단일 Claim, Lease 만료 및 명시적 복구, 오래된 Fencing Token, 재시작 후 저장 데이터, credential 미저장, replay nonce, private bind 조건을 포함한다. 실제 운영 서버/서비스 저장소 접근은 하지 않는다.
