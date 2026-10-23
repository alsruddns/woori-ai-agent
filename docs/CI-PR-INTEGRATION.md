# 서비스 PR 전용 CI 실사 및 적용안

실사일: 2026-10-23. 저장소와 브랜치 설정은 GitHub CLI/API로 읽기 전용 조회했다. 서비스 저장소에는 파일을 쓰거나 PR을 만들지 않았다.

## 확인 결과

다섯 저장소 모두 `develop` 브랜치에 PR 전용 CI가 없고 브랜치 보호 및 required checks가 설정되어 있지 않다. 기존 CI가 통과해도 보호 규칙이 없으면 병합 차단 조건으로 작동하지 않는다. `develop` 브랜치는 PR 대상으로 확인되었으며, 기본 브랜치는 `main`이다.

| 서비스 | PR 검사 | 기존 workflow 및 PR 트리거 배포 위험 | 제안 파일 |
|---|---|---|---|
| Home | 없음 | `publish.yml`은 `main` push 및 수동 실행. 이미지 발행/production 배포 포함. 세 데이터 갱신 workflow는 schedule/manual에서 develop에 스냅샷을 커밋. 운영 routing 검사도 production 환경·SSH를 사용하지만 `workflow_dispatch` 전용. PR 이벤트에서 실행되는 workflow는 확인되지 않음. | [`pr-ci.yml`](ci-proposals/home/pr-ci.yml) · [`patch`](ci-proposals/home/pr-ci.patch) |
| Calculator | 없음 | `deploy.yml`은 `main` push 전용. 이미지 발행, SSH 배포, 상태 점검, IndexNow 포함. PR 이벤트에서 실행되지 않음. 자동 수정은 계속 잠금. | [`pr-ci.yml`](ci-proposals/calculator/pr-ci.yml) · [`patch`](ci-proposals/calculator/pr-ci.patch) |
| Tools | 없음 | `deploy.yml`은 `main` push 전용. 이미지 발행, SSH 배포, 상태 점검, IndexNow 포함. PR 이벤트에서 실행되지 않음. | [`pr-ci.yml`](ci-proposals/tools/pr-ci.yml) · [`patch`](ci-proposals/tools/pr-ci.patch) |
| Docs | 없음 | `deploy.yml`은 `main` push 전용. 테스트/정적검사 뒤 이미지 발행·SSH 배포·상태 점검·IndexNow 포함. PR 이벤트에서 실행되지 않음. | [`pr-ci.yml`](ci-proposals/docs/pr-ci.yml) · [`patch`](ci-proposals/docs/pr-ci.patch) |
| Quiz | 없음 | `deploy.yml`은 `main` push 전용. 테스트/정적검사 뒤 이미지 발행·SSH 배포·상태 점검·IndexNow 포함. PR 이벤트에서 실행되지 않음. | [`pr-ci.yml`](ci-proposals/quiz/pr-ci.yml) · [`patch`](ci-proposals/quiz/pr-ci.patch) |

## 검사 명령 실사

모든 저장소에서 `package.json`의 `packageManager`는 `pnpm@9.12.1`이며 `pnpm-lock.yaml`이 존재한다.

- Home: `pnpm lint`, `pnpm test`, `pnpm build`; 별도 typecheck script 없음.
- Calculator: `pnpm lint`, `pnpm test`, `pnpm typecheck`, `pnpm build`.
- Tools: `pnpm lint`, `pnpm test`, `pnpm check:service-catalog`, `pnpm build`; 별도 typecheck script 없음.
- Docs: 현재 배포 workflow에 있는 `pnpm test`, `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build`.
- Quiz: 현재 배포 workflow에 있는 `pnpm test`, `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm check:localization-quality`, `pnpm build`.

## 안전 적용안

각 제안은 `pull_request` 이벤트만 사용하고 base를 `develop`으로 한정한다. workflow/job 권한은 `contents: read`; production 환경, 저장소 secrets, packages write, SSH/Docker/IndexNow 동작은 없다. 작업 시간은 25분으로 제한하고 PR별 동시 실행은 이전 실행을 취소한다. 체크아웃과 Node 설정 Action은 Node 24 지원 릴리스(`checkout@v6`, `setup-node@v6`)를 사용하고, 애플리케이션 런타임은 Node 22로 고정한다.

GitHub의 보안 문서는 `pull_request`에서 fork PR 토큰 권한과 secrets를 제한하며, 최소 권한 설정을 권고한다. `pull_request_target`은 이 제안에 사용하지 않는다. [GitHub Actions 보안 가이드](https://docs.github.com/en/actions/reference/security/secure-use), [pull_request_target 보안 안내](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target). Node 20 런타임은 2026-09-23에 제거되었으므로 Node 24 지원 Action 릴리스를 사용한다. [GitHub Changelog](https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/).

워크플로 추가만으로 required check는 되지 않는다. 저장소 관리자가 제안 워크플로를 적용한 뒤 실제 check context 이름을 확인하고 `develop` 보호 규칙에 필수 검사로 등록해야 한다. 이 보호 규칙과 Checks API를 실제 확인하기 전까지 orchestrator는 PR을 승인 대기로 승격시키지 않는다.

## GitHub 권한/검증 범위

읽기 전용 GitHub CLI 확인은 현재 인증 계정으로 수행했다. Actions 목록, develop branch workflow 파일, package scripts, lockfile, repository visibility/default branch, develop protection endpoint를 조회했다. 다섯 저장소 모두 protection endpoint가 `Branch not protected`를 반환했다. GitHub 쓰기, PR 생성, workflow 실행, 서비스 파일 수정은 수행하지 않았다. 사용자 승인된 비운영 테스트 저장소가 제공되지 않았으므로 실제 쓰기 흐름은 Phase 9D-2 전 별도 확인 대상이다.

## Phase 9D-2 진입 조건

1. 서비스별 제안 워크플로를 저장소 소유자가 검토·적용한다.
2. 각 저장소의 `develop`에 required status checks와 병합 보호를 별도로 설정한다.
3. Calculator 잠금 해제 및 Tools의 미커밋 변경 정리는 별도 사용자 지시 후에만 가능하다.
4. 승인된 비운영 저장소에서 PR 작성·Checks 조회를 검증한다.
5. CI 성공은 자동 병합이나 배포를 허용하지 않는다. 9D-2에서도 병합/배포는 별도 승인 및 검증 범위다.
