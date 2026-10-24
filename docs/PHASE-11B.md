# Phase 11B — Development Audit Trail

## 구현 범위

development_audit_jobs, development_audit_events, development_audit_counters, feature_release_history를 추가했다. 기존 SQLite DB를 초기화하거나 대체하지 않는다. 모든 개발 이벤트는 job UUID, 표시용 DEV/BUG/FEATURE ID, 작업별 sequence, policy version, idempotency key, 이전/현재 SHA-256 hash를 기록한다. 업데이트/삭제 트리거가 이벤트와 Feature Release 행의 변경을 거부한다. Hash chain은 데이터 불일치 감지용이며, SQLite 호스트 관리자에 대한 변조 방지 보증은 아니다.

콘솔의 Development History는 /api/development/history와 /api/development/history/:id에서 실제 SQLite 이력을 서버 페이지네이션으로 읽는다. 기존 Queue, Codex 실행, PR/CI, Deployment 및 Runtime Verification 행은 최초 조회 때 HISTORICAL_*_IMPORT 이벤트로 연결된다. 중복 import는 idempotency key로 막는다. 과거 상태는 GitHub/운영 환경에서 다시 확인하지 않으므로 현재 성공으로 간주하지 않는다. 정책 감사 기록은 기존 policy_change_events 원장을 보존하며 해당 변경은 개발 이력에 과거 import 이벤트로도 연결한다.

Codex worktree/branch 생성, Commit, PR 생성 전에 감사 Job과 intent 이벤트 저장을 요구한다. 감사 저장이 실패하면 로컬 변경 절차가 시작되지 않는다. 실행된 Codex 변경 파일은 실제 Git 상태와 validation 결과를 기록한다. PR 및 CI 상태, 배포 workflow, 런타임 검증도 현재 PR SHA/Run ID와 함께 이벤트로 연결한다. 외부 CI/Actions는 별도 시스템이며 분산 트랜잭션은 제공하지 않는다. intent 이후 응답이 끊기면 원본 GitHub 상태를 조회해 재조정해야 한다.

## Feature Release 증거 기준

recordFeatureRelease는 Proposed/Implemented/Unknown 등의 기록을 허용한다. Released를 기록하려면 실제 deployed revision, deploy/CI run ID, 같은 commit SHA, PR 번호, 실제 publicLocales와 coveredLocales의 완전 일치, locale별 route/title/description/canonical/hreflang/x-default 증거, sitemap 및 robots 결과, tests와 CI 성공 증거가 필요하다. 기능 제거/변경은 최초 release row를 수정하지 않고 새 audit event를 추가한다. 실제 공개 locale 목록은 서비스 저장소별 검증을 아직 수행하지 않았으므로 자동으로 만들거나 배포 증거로 추정하지 않는다.

## 보존과 백업

감사 이벤트/기능 출시 이력에는 정리 작업을 제공하지 않는다. backupDevelopmentAudit(target)은 SQLite 온라인 백업 API를 사용하고 백업의 integrity_check를 확인한다. 백업 파일을 다른 매체에 복제하는 것은 이 작업에서 자동 수행하지 않는다. DB와 모든 백업을 동시에 잃으면 감사 이력을 복구할 수 없으므로 운영 적용 전 독립 보관 매체와 정기 복구 연습을 준비해야 한다.

## 현재 제한

- 자동 Codex 개발, PR 자동 생성, 병합, 운영 배포는 계속 차단되어 있다.
- Linux 코드 수정, Calculator 코드 수정, MoneyBook 자동 개발은 계속 차단되어 있다.
- 이번 단계는 기존 task/execution/PR/CI/deployment 행을 보수적으로 연결하며, 과거 실행에서 저장되지 않은 diff나 증거를 재구성하지 않는다.
- 감사 API는 로컬 Dashboard API와 동일하게 loopback에서 제공된다. 이벤트 생성·수정용 공개 HTTP API는 추가하지 않았다.
- 기존 policy audit 원장은 별도 immutable 테이블로 유지된다. 두 SQLite 테이블의 해시 체인은 독립적이다.
- hash chain 검증은 우발적인 변조나 누락 감지에 유용하지만 악의적인 DB 파일 재작성과 백업 동시 변조를 방지하지는 않는다.

## 검증

tests/development-audit.test.ts는 ID/idempotency, sequence/hash chain, update/delete 거부, secrets redaction, legacy queue import, Feature release evidence gate, 온라인 백업 무결성을 검사한다. 전체 TypeScript, ESLint, Vitest, Dashboard build 및 Ubuntu workflow는 프로젝트 검증 결과에 기록한다.
