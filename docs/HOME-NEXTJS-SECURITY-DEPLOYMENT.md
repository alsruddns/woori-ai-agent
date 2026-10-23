# 긴급 제안: Home 운영 Next.js 보안 패치

**상태: 승인 대기 제안. 이 문서는 배포를 실행하지 않습니다.**

## 확인된 근거 (2026-10-23)

- Home `develop`에는 Next.js 16.4.1 보안 수정이 반영되어 있다.
- GitHub `main`의 배포 커밋 `314a9038c8250e90b75d3e7c1f9040e92ee1dde8`은 `package.json`에서 Next.js 16.4.0을 사용한다.
- Actions run [39952775377](https://github.com/alsruddns/woori-home/actions/runs/39952775377)은 해당 커밋의 `workflow_dispatch`이며 image 및 deploy job이 success로 끝났다. 이 실행은 Phase 9D-2 에이전트가 시작하지 않았다.
- 공개 서비스는 HTTP 200으로 응답했다. 공개 응답만으로 실행 중 컨테이너의 package.json을 읽을 수는 없으므로, Actions의 성공한 빌드와 배포 커밋을 현재 배포 버전의 근거로 사용한다.

## 제안 순서

1. Home 저장소에서 `develop`의 16.4.1 패치 커밋과 `main`의 최신 작업을 비교한다.
2. 운영 변경을 포함하는 현재 PR/변경 범위를 검토하고, 충돌·데이터베이스 작업 여부를 확인한다.
3. 운영 반영을 담당하는 사용자가 대상 SHA를 확인하고 별도 승인한다.
4. 기존 `publish.yml` 정책에 따라 패치된 SHA를 main에 반영하고, 승인된 `deploy_portal` 실행으로 portal image만 배포한다.
5. Actions deploy job 결과와 `/ko`, `/robots.txt`, sitemap, 컨테이너 health를 각각 확인한다. 배포 workflow 성공과 사용자 경로 정상 응답을 따로 기록한다.
6. 실패하면 추가 배포를 중단한다. 기존 workflow 안의 guarded rollback은 해당 스크립트가 이번 보안 패치에 대해서도 안전한지 담당자가 검토한 뒤에만 고려한다.

이번 오케스트레이터는 이 작업을 자동 병합하거나 dispatch하지 않으며, 운영 VPS에도 접근하지 않는다.

## 후속 읽기 전용 확인 (2026-10-23)

이후 외부 run [39953548770](https://github.com/alsruddns/woori-home/actions/runs/39953548770)은 `Deploy only the portal service` 단계에서 실패했다. Workflow에 guarded rollback 코드가 있지만 rollback 완료 여부나 현재 운영 이미지 버전은 확인되지 않았다. 별도 승인된 보안 패치 배포 및 사후 검증 전까지 운영 Next.js 버전은 미확정이며 취약 가능 상태로 취급한다. 이 에이전트는 두 workflow run 모두 시작하지 않았다.
