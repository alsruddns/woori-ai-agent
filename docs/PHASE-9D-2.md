# Phase 9D-2: 승인형 병합·배포 오케스트레이션 준비

## 범위와 안전 경계

이 단계는 읽기 전용 실사, 승인 게이트, 배포 상태 저장 및 대시보드 표시를 추가한다. PR 병합, main push, workflow dispatch, 운영 배포, VPS 접속, branch protection 변경, 자동 롤백은 구현 경로에서 실행하지 않는다. 대시보드에는 승인 버튼을 두지 않는다. 자동 병합·배포·롤백은 계속 OFF다.

허용 서비스는 Home, Calculator, Tools, Docs, Quiz다. MoneyBook은 영구 제외한다. 현재 Calculator 자동 변경 잠금을 유지하며 이 오케스트레이터를 통한 병합·배포 준비도 차단한다.

## 현재 읽기 전용 실사 (2026-10-23)

5개 저장소의 `develop`과 `main`은 GitHub Branch Protection API에서 모두 보호 규칙 없음, repository rulesets API에서 모두 0개로 확인됐다. 실제 보호 규칙은 변경하지 않았다. `validate` check 이름은 각 PR CI에서 확인된 검사 이름이지만, 보호 규칙에 필수 검사로 적용되어 있지 않다.

각 서비스의 운영 배포 workflow는 `main` push를 운영 배포 트리거로 사용한다.

| 서비스 | Workflow | 운영 트리거 | Healthcheck / 롤백 관찰 |
|---|---|---|---|
| Home | `publish.yml` | main push, workflow_dispatch, 일부 schedule | portal HTTP 및 Docker health 경로 존재. guarded rollback 코드도 있으나 이번 단계에서 호출하지 않음 |
| Calculator | `deploy.yml` | main push | 경로/sitemap/IndexNow 검사. 컨테이너 health 증거 또는 롤백 자동화는 확인되지 않음 |
| Tools | `deploy.yml` | main push | `robots.txt` HTTP 검사. 롤백은 확인되지 않음 |
| Docs | `deploy.yml` | main push | 설정에 따라 `/ko/docs` HTTP 검사. 롤백은 확인되지 않음 |
| Quiz | `deploy.yml` | main push | `/ko/quiz` HTTP 검사. 롤백은 확인되지 않음 |

Calculator, Tools, Docs, Quiz workflow는 배포 과정에서 SSH 및 IndexNow를 사용한다. 따라서 PR 검사가 아니라 `main` 반영부터 실제 운영 변경을 일으킨다. PR 검사 성공과 배포 성공은 같은 상태로 다루면 안 된다.

읽기 전용 Actions 동기화 결과: Home run `39953548770`의 배포 단계 실패, Calculator run `39936981274`의 SSH 배포 단계 실패, Tools `39012104744`, Docs `39012121582`, Quiz `39017377240`의 배포 단계 성공을 SQLite에 기록했다. 세 성공 기록은 workflow 배포 단계 성공만 뜻하며 Playwright/pageerror/locale/SEO 사후 검증 완료를 뜻하지 않는다. 실패 원문 로그는 저장하지 않았고, Home의 자동 rollback 결과도 미확인이다.

## Home 보안 배포 상태

- Home `develop` 보안 패치: Next.js 16.4.1.
- GitHub main SHA `314a9038c8250e90b75d3e7c1f9040e92ee1dde8`의 `package.json`: Next.js 16.4.0.
- 읽기 전용 Actions 조회에서 run `39952775377`은 이 SHA의 `workflow_dispatch`였고, image 및 deploy job이 success였다. 이 실행은 이 오케스트레이터가 시작하지 않았다.
- 이후 run `39953548770`도 같은 SHA의 외부 `workflow_dispatch`였지만, `Deploy only the portal service` 단계가 failure로 끝났다. workflow에는 guarded rollback 코드가 있으나 이 실행의 rollback 결과/현재 컨테이너 상태는 확인하지 않았다.
- 마지막으로 성공한 배포 산출물은 main manifest 기준 Next.js 16.4.0이다. 현재 실행 중인 이미지 버전은 후속 배포 실패와 미검증 rollback 때문에 **미확정**이다. 공개 HTTP 응답은 런타임 package version을 노출하지 않는다.
- 긴급 조치 제안: main에 보안 패치된 소스를 반영하고, 별도 사용자 승인 아래 기존 `publish.yml`의 `deploy_portal` 경로로 배포한다. 현재 Phase 9D-2 작업에서는 배포하지 않는다.

## 승인 게이트

`assessMergeDeployGate`는 서비스 허용 목록, task 승인, 로컬 검증, 변경 범위, 현재 PR head SHA의 CI, 필수 check 존재, 충돌 여부, secret 검사, 배포 위험 검토, 사용자의 해당 SHA와 `main` 대상 승인 여부를 함께 요구한다. PR head SHA가 바뀌면 저장된 SHA 승인과 일치하지 않아 차단된다.

승인 없는 병합, CI 실패, 오래된 CI, 보호된 경로 변경, 대상 branch 변경은 준비 상태가 될 수 없다. Google AdSense 검토 보호를 위해 ads.txt, robots.txt, 광고 코드, 정책 문서, locale, canonical/hreflang, sitemap, 공개 route 파일 변경은 높은 위험 등급으로 표시하고 수동 검토를 요구한다.

배포 기록은 `(service, PR, SHA, target)` 키로 중복 방지하며 로컬 SQLite에 evidence만 저장한다. 저장 함수 자체는 GitHub API를 호출하거나 branch/PR을 변경하지 않는다.

## 향후 보호 규칙 적용 준비안 (현재 미적용)

각 저장소에서 먼저 `develop` PR 기반 작업 흐름을 정착시키고, 현재 직접 push가 가능한 사용자의 일상 작업과 CI check context를 확인한다. 그 뒤 별도 승인을 받아 develop에 PR 필수, `validate` 필수 검사, force push 및 삭제 금지를 검토한다. 관리자 bypass 정책은 운영 업무 영향 검토 후 정한다. `main`은 운영 배포 trigger이므로 protection을 추가하기 전 승인/required reviewer 및 release 운영 흐름을 별도로 설계한다.

현재 GitHub 계정의 보호 규칙 적용 플랜 세부 정보와 production Environment required reviewers 설정은 이번 읽기 전용 API 점검에서 확정하지 않았다. branch protection은 아직 적용되지 않았다.

## 명령 및 검증

- `pnpm agent development deployment`: 배포 준비 상태 및 로컬 이력의 JSON 출력.
- `pnpm agent development deployment --refresh=true`: GitHub Actions 최근 run/job을 읽기 전용 조회해 실제 deploy step 결과를 로컬 SQLite에 저장한다. workflow를 실행하지 않는다.
- 통합 대시보드 Development 화면은 workflow trigger, healthcheck/rollback 준비 상태, Home 버전 경고, 배포 이력을 표시한다. 실행 버튼은 없다.
- 자동 배포, 자동 병합, 자동 롤백은 false로 유지한다.
