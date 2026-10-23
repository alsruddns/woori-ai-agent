# Phase 9D-3 — 운영 배포 증거 및 Home 보안 상태

검사 기준 시각: 2026-10-23 (GitHub Actions 및 GitHub REST/CLI 읽기 전용 조회). 서비스 저장소, VPS, 브랜치 보호 설정은 변경하지 않았다.

## Home 보안 상태

- 현재 `main` SHA `8414cbf2d6ca1440bcec5135448d8b45db031f45`, `develop` SHA `614a1f122f9423d1ea0ac7fbf6e7d23bcf51f257`에서 `package.json`과 `pnpm-lock.yaml` 모두 Next.js `16.4.1`을 확인했다.
- `main`은 `develop`보다 61개 커밋 앞서 있다. 따라서 develop 전체를 main으로 승격하는 방식은 이번 보안 패치만 분리하는 방식이 아니다.
- 보안 버전은 이미 main에 포함되어 있다. 이번 점검에서는 보안 전용 PR을 만들거나 서비스 저장소에 변경을 가하지 않았다.
- Home PR CI는 `pull_request`의 base가 `develop`일 때만 실행된다. main 대상으로 통과한 현재 SHA의 PR 검사 근거가 없으므로 main 보호 규칙에 `validate`를 필수로 지정하면 안 된다.
- Home `main` 보호 API에는 규칙이 없었고 repository ruleset은 0개였다. 보호 규칙 변경은 하지 않았다.

## Home 배포 증거

- Run [39952775377](https://github.com/alsruddns/woori-home/actions/runs/39952775377), SHA `314a9038c8250e90b75d3e7c1f9040e92ee1dde8`: 이미지 빌드와 배포 workflow는 성공. 그 SHA의 manifest는 Next.js 16.4.0이었다.
- Run [39953548770](https://github.com/alsruddns/woori-home/actions/runs/39953548770), 같은 SHA: 이미지 빌드는 성공했다. 배포가 Docker Healthcheck까지 진행한 뒤 HTTP smoke 요청에서 503을 받고 실패했다. workflow는 이전 Portal 이미지 복구 절차를 시작했으나, 실패 로그만으로 rollback 완료/건강 상태를 확정할 수 없다.
- 이후 Run [39963337013](https://github.com/alsruddns/woori-home/actions/runs/39963337013)과 [39963970414](https://github.com/alsruddns/woori-home/actions/runs/39963970414)는 현재 main SHA `8414cbf2d6ca1440bcec5135448d8b45db031f45`에서 이미지 빌드 및 Portal 배포 단계를 성공시켰다. 마지막 run 로그는 배포 SHA와 이미지 digest를 기록하고 Docker health 및 HTTP 확인을 통과했다.
- 이는 GitHub workflow가 artifact를 배포하고 그 안의 확인을 통과했다는 증거다. VPS에서 현재 실행 중인 컨테이너를 `docker inspect`로 읽지 않았으므로 현재 런타임 image ID/label/Next.js 버전은 여전히 **미확인**이다. HTTP 200만으로 런타임 버전 또는 Fully Verified를 판정하지 않는다.
- 마지막 workflow는 Playwright/SEO post-deploy 검사를 수행하지 않으므로 전체 검증은 미완료다.

## Calculator 배포 실패

- Run [39936981274](https://github.com/alsrddns/woori-calculator/actions/runs/39936981274), SHA `caa5b2de713dca6cc8dfd3b115bf3721c8344dc6`: 이미지 build/push 성공 후 SSH 명령이 `docker compose --env-file .env.moneybook ... pull calculator` 단계에서 실패했다. Compose가 전체 파일을 해석하면서 Portal의 필수 환경변수(`DATABASE_URL`, `DB_TARGET`, `PRODUCTION_DB_ALLOWED_HOSTS`, `WORLD_BANK_DATA_SOURCE`, `WORLD_BANK_DB_PRODUCTION_ENABLED`) 값이 없는 것으로 판정했다. 값 자체는 보고서에 기록하지 않았다.
- 실패는 `up` 전에 발생했으며, 따라서 이 실행이 Calculator 컨테이너를 바꿨다는 증거는 없다. 이후 Run [39965563732](https://github.com/alsruddns/woori-calculator/actions/runs/39965563732), SHA `caffc59985826d3dbf9fe549db008e64b59a853f`는 배포 및 route/locale/sitemap 검증까지 성공했다. 운영 컨테이너를 직접 조사하지 않았다.
- 이 저장소의 workflow/소스 및 다국어 작업은 수정하지 않았다.

## 판정 기준

배포 상태는 별개 증거로 유지한다.

1. Workflow Succeeded
2. Deployment Confirmed
3. Runtime Version Confirmed — 실행 중 컨테이너의 revision과 image digest가 workflow artifact와 일치해야 함
4. Healthcheck Passed
5. Post-deploy QA Passed
6. Fully Verified — 위 항목이 모두 확인된 경우만

Home은 workflow와 배포 단계 성공, workflow 내 health/HTTP check 증거가 있다. 현재 런타임 컨테이너 일치 및 Playwright/SEO QA 증거는 없어 Fully Verified가 아니다.

## 운영자 수동 확인 절차

운영 권한이 있는 담당자가 기존 운영 절차에 따라 읽기 전용으로 현재 Portal 컨테이너의 image ID와 OCI revision label을 확인한다. 이를 최근 성공 run의 배포 SHA `8414cbf2d6ca1440bcec5135448d8b45db031f45` 및 workflow가 출력한 digest와 비교한다. 값이 일치하지 않거나 확인 명령 실행 권한이 없다면 런타임은 미확인으로 유지한다. 에이전트는 VPS 접속이나 원격 명령을 수행하지 않는다.

## Branch Protection 준비

- PR 필수, 현 head SHA의 `validate`, force-push 금지, 삭제 금지를 dry-run 제안으로 둔다.
- Home의 현재 PR CI base는 `develop`만 포함한다. main에는 main을 대상으로 하는 CI가 실제 성공하기 전까지 `validate`를 Required로 지정하지 않는다.
- 관리자 우회 여부와 기존 직접 push 흐름의 영향은 별도 검토 항목이다. 보호 설정은 적용하지 않았다.

## 이번 작업에서 하지 않은 동작

Home/Calculator 저장소 수정, PR 생성, main 병합, 배포 실행, VPS 접근, rollback, branch protection 변경은 수행하지 않았다. Home 보안 의존성은 현재 main/develop 양쪽에 이미 16.4.1로 확인되어 보안 패치 승격 PR을 준비할 잔여 dependency diff가 없다. `develop` 전체를 main으로 합치는 것은 61개 커밋 차이 때문에 별도 변경 검토가 필요하다.
