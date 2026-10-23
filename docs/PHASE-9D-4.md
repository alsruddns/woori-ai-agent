# Phase 9D-4 — 운영 런타임 증거와 main PR CI

기록일: 2026-10-24 (KST)

## 결과 요약

- 5개 서비스의 PR CI를 `develop`과 `main` 대상으로 확장하고, 각 서비스의 `develop`에 workflow 변경만 커밋했다.
- 각 서비스에 workflow 파일만 포함한 임시 Draft PR을 `main` 대상으로 열어 실제 `validate` 실행을 확인했다. 모두 성공했으며 전부 병합 없이 닫고 임시 브랜치를 삭제했다.
- PR 이벤트로 실행된 것은 `PR CI`뿐이었다. 테스트 브랜치 실행 목록에는 `publish.yml` 또는 `deploy.yml` 실행이 없었다. 운영 배포, 병합, 롤백은 수행하지 않았다.
- 운영 SSH의 승인된 읽기 전용 연결 설정이 없으므로 실제 컨테이너의 SHA, digest, image ID 및 health 상태는 확인하지 않았다. 운영 런타임은 **Unknown / Not Verified**다.
- 브랜치 보호 설정은 적용하지 않았다.

점검 중 Home `main`에 별도의 push가 발생해 publish workflow run `39986396038`이 실행된 것을 관측했다(`dd92cc85a8df421239327c8238c36c63fc474ea0`, workflow/deploy 단계 성공). 이는 이번에 생성한 `pull_request` CI 테스트와 다른 push 이벤트이며, 에이전트가 유발하지 않았다. 이 배포 후 실제 컨테이너를 관측하지 못했으므로 현재 운영 SHA/digest/health는 여전히 **Unknown**이다. 이 최신 Home SHA의 빌드 digest도 수집되지 않아 이전 배포 digest를 대신 쓰지 않았다.

뒤이어 기존 PR #25 병합으로 Home `main`이 `e216bd3c21b1ec1ddd7a66dd2f791b4f3ce005e4`로 갱신됐고, push 이벤트 Run `39989900060`이 실행됐다. release guard, 이미지 빌드, portal deploy 단계가 모두 성공으로 종료됐다. 이는 다른 작업 흐름의 배포이며 에이전트는 시작·중지·변경하지 않았다. 실제 컨테이너의 SHA/digest/health와 사후 Playwright/SEO QA는 여전히 확인하지 못해 런타임 검증은 미완료다. 배포 로그에는 기존 deploy workflow가 사용하는 checkout/build-push/login/buildx action들의 Node.js 20 deprecation 경고가 있었고 실행기는 Node 24로 강제 전환됐다. 배포 workflow는 이번 작업 범위 밖이라 수정하지 않았다.

세부 PR 번호, HEAD SHA, Actions Run ID, workflow commit 및 단계별 결과는 [`configs/phase9d4-main-ci-results.json`](../configs/phase9d4-main-ci-results.json)에 기록했다.

## PR CI 적용 커밋

각 변경은 `.github/workflows/pr-ci.yml`에만 한정됐다. 서비스별 자동 코드 수정 잠금, 특히 Calculator 잠금은 유지했다.

| 서비스 | develop 커밋 |
|---|---|
| Home | `28e9cee66115cb7bfd23f91402856c6971e13f3d` |
| Calculator | `78b434404099d8320f2374251c3c14e55c43b075` |
| Tools | `2339485` (develop의 동시 변경 `c0e4936` 보존 후 반영) |
| Docs | `071aab9544f7c8b1572771aa7a0bfe954b857696` |
| Quiz | `2247b37aef5a97cebd79955ef95541ad52c09883` |

모든 workflow는 `pull_request`의 `develop` 및 `main`을 대상으로 하고 `contents: read`, PR별 concurrency 취소, 25분 제한 및 저장소에 실제 존재하는 lint/test/typecheck/build 검사를 유지한다. 배포 workflow, production secrets/environment, SSH, 운영 DB 및 IndexNow 작업은 추가하지 않았다.

## 런타임 검증 경계

GitHub 배포 기록에서 배포 workflow가 성공한 SHA와 일부 빌드 이미지 digest를 확인할 수 있다. 이는 현재 운영 컨테이너를 관측한 결과와 다르다. 기존 Home/Calculator 배포 로그의 digest는 빌드 결과 증거일 뿐, 실제 컨테이너 digest나 실행 SHA의 일치 증거가 아니다. HTTP 응답 또는 GitHub workflow 성공만으로 런타임 검증 완료로 표시하지 않는다.

로컬 SSH 설정과 실행 중인 SSH agent가 없고, production SSH 조사 workflow는 production 환경의 수동 실행 경로이므로 호출하지 않았다. 승인된 읽기 전용 운영 접근이 별도로 제공될 때에만 `docker ps`/선택 필드 `docker inspect` 조회를 수행한다. `docker inspect` 전체 출력, 환경변수, 토큰은 수집·저장하지 않는다.

대시보드/SQLite에 append-only `deployment_verifications` 이력을 추가했다. 새 배포 SHA가 기록되면 이전 SHA의 런타임 검증은 현재 증거로 재사용되지 않는다. 예상 digest는 기록된 GitHub 배포 증거와 일치해야 한다. 미관측 상태를 조작해 `Fully Verified`로 표시하는 CLI 자동 수집은 없다. `development runtime-verify`는 승인된 운영 점검자가 이미 확보한 증거를 안전하게 기록하는 로컬 입력 기능이다.

대시보드의 `Deployment Confirmed`는 workflow의 실제 배포 단계가 성공했다는 뜻이며, 실행 컨테이너가 그 SHA/digest라는 뜻은 아니다. 후자는 컨테이너 관측이 일치해야 `Runtime Verified`가 된다.

## 브랜치 보호 적용안

이번 단계에서는 GitHub 보호 설정을 변경하지 않았다.

1. **develop**: PR 필수, 현재 HEAD의 `validate` 필수, force push/삭제 차단. 직접 push 중심의 Codex 작업은 별도 브랜치 → Draft PR → 검증 → 승인/병합 순서로 전환해야 한다.
2. **main**: PR 필수, main 대상 `validate` 필수, 승격 승인 필요, force push/삭제 차단. 다만 이번 smoke PR은 병합되지 않았으므로 PR workflow 정의가 아직 main 브랜치에 실리지 않았다. workflow를 main에 반영하고 main에서 유효한 check context를 확인하기 전에는 `validate`를 required로 지정하지 않는다.
3. 관리자 우회 여부와 GitHub 플랜/권한은 적용 전에 저장소별로 다시 검토한다. 기존 직접 push 개발 흐름 및 배포 트리거와 충돌하는지 확인한 후 별도 승인으로 적용한다.

## Phase 9E 선행 작업

1. 운영 담당자가 최소 권한의 읽기 전용 컨테이너 확인 경로를 제공하거나 승인된 현장 점검 결과를 제공한다.
2. 실제 컨테이너 revision label, image ID/digest, health 상태를 해당 배포 SHA와 비교하고 운영 HTTP 및 사후 QA 증거를 연결한다.
3. 5개 서비스의 workflow-only CI 변경을 검토해 main에 승격한다. 이번 smoke PR은 검증 후 닫았으므로 main 설정을 반영하지 않았다.
4. PR-first 작업 방식과 현재 branch protection을 다시 확인하고 별도 승인 후 보호 규칙을 적용한다.
5. 위 증거와 승인 절차가 확인될 때까지 자동 병합, 운영 배포, 롤백을 계속 비활성화한다.
