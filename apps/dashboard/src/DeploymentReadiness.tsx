import React from 'react';

type Workflow = Record<string, unknown>;
type Readiness = {
  mode?: string;
  evidenceSnapshotAt?: string;
  branchProtection?: string;
  protectionPlan?: { dryRunOnly?: boolean; requiredCheck?: string; adminBypass?: string; currentObservedState?: string; mainBranchCi?: string };
  homeSecurityPromotion?: Workflow;
  automaticMerge?: boolean;
  automaticDeploy?: boolean;
  automaticRollback?: boolean;
  workflows?: Workflow[];
  records?: Workflow[];
};
const label = (value: unknown) => value !== undefined && value !== null && value !== '' ? String(value) : '확인 불가';

export function DeploymentReadiness({ data }: { data?: Readiness }) {
  if (!data) return <section><h3>병합 및 배포 준비</h3><div className="empty card">배포 준비 데이터를 불러오지 못했습니다.</div></section>;
  const home = data.homeSecurityPromotion;
  return <section>
    <h3>승인 기반 병합 및 배포 준비</h3>
    <p className="note">{label(data.mode)} · 브랜치 보호: {label(data.branchProtection)} · 자동 병합/배포/롤백: 모두 OFF</p>
    <p className="note">보호 규칙 dry-run: {data.protectionPlan?.dryRunOnly ? '예' : '확인 불가'} · 필수 검사 후보: {label(data.protectionPlan?.requiredCheck)} · 현재 상태: {label(data.protectionPlan?.currentObservedState)} · 관리자 우회: {label(data.protectionPlan?.adminBypass)}</p>
    {data.protectionPlan?.mainBranchCi && <p className="note">main 브랜치 검사 조건: {label(data.protectionPlan.mainBranchCi)}</p>}
    {home && <article className="service">
      <h3>Home 보안 패치 승격 진단</h3>
      <p>상태: {label(home.status)} · Next.js main {label(home.mainNext)} / develop {label(home.developNext)}</p>
      <p>main SHA {label(home.mainSha)} · develop SHA {label(home.developSha)}</p>
      <p>마지막 성공 배포 run {label(home.latestSuccessfulDeployRun)} · 배포 SHA {label(home.latestSuccessfulDeploySha)}</p>
      <p>실행 중 컨테이너 버전: {label(home.runtimeVersion)}</p>
      <p>main PR 검사: {label(home.currentMainCi)}</p>
      <p>운영 승인 필요: {home.productionApprovalRequired ? '예, 정확한 SHA와 배포 대상을 승인해야 합니다.' : '아니요'} · 에이전트가 병합/배포했는가: {home.mergeOrDeployPerformedByAgent ? '예' : '아니요'}</p>
      {data.evidenceSnapshotAt && <small>증거 스냅샷: {data.evidenceSnapshotAt}</small>}
    </article>}
    <div className="grid">{(data.workflows ?? []).map(item => <article className="service" key={String(item.service)}>
      <h3>{label(item.service)}</h3>
      <p>배포 workflow: {label(item.workflow)} · trigger: {label(item.trigger)}</p>
      <p>위험: {label(item.deployRisk)} · 사후 검사: {label(item.healthcheck)}</p>
      <p>롤백: {label(item.rollback)}</p>
      {item.service === 'home' && <p>Next.js main {label(item.mainNextVersion)} · develop {label(item.developNextVersion)} · 운영 런타임 {label(item.runtimeNextVersion)}</p>}
      {item.lastKnownFailure && <p>최근 실패: {label(item.lastKnownFailure)} · Run {label(item.lastKnownFailureRunId)}</p>}
    </article>)}</div>
    <h3>배포 실행 이력</h3>
    <div className="finding-list">{(data.records ?? []).map(item => <article key={String(item.deploymentKey)}>
      <span className="state">{label(item.status)} · {label(item.target)}</span>
      <div><b>{label(item.service)} · {item.prNumber ? `PR #${label(item.prNumber)}` : `Actions run ${label(item.runId)}`} · SHA {label(item.headSha)}</b>
        {item.runUrl && <p><a href={String(item.runUrl)} target="_blank" rel="noreferrer">Actions run {label(item.runId)}</a></p>}
        <p>{label(item.detail)}</p>
      </div>
    </article>)}{!(data.records ?? []).length && <div className="empty card">배포 실행 기록이 없습니다. 이 화면은 승인 또는 배포를 실행하지 않습니다.</div>}</div>
  </section>;
}
