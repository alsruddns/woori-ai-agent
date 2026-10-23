import React from 'react';

type Workflow = Record<string, unknown>;
type Readiness = { mode?: string; branchProtection?: string; protectionPlan?: { dryRunOnly?: boolean; requiredCheck?: string; adminBypass?: string; currentObservedState?: string }; automaticMerge?: boolean; automaticDeploy?: boolean; automaticRollback?: boolean; workflows?: Workflow[]; records?: Workflow[] };
const label = (value: unknown) => typeof value === 'string' && value ? value : '확인 불가';

export function DeploymentReadiness({ data }: { data?: Readiness }) {
  if (!data) return <section><h3>병합 및 배포 준비</h3><div className="empty card">배포 준비 데이터를 불러오지 못했습니다.</div></section>;
  return <section>
    <h3>승인 기반 병합 및 배포 준비</h3>
    <p className="note">{label(data.mode)} · 브랜치 보호: {label(data.branchProtection)} · 자동 병합/배포/롤백: OFF</p>
    <p className="note">보호 규칙 dry-run: {data.protectionPlan?.dryRunOnly ? '예' : '미확인'} · 필수 check 후보: {label(data.protectionPlan?.requiredCheck)} · 현재 상태: {label(data.protectionPlan?.currentObservedState)} · 관리자 우회: {label(data.protectionPlan?.adminBypass)}</p>
    <div className="grid">{(data.workflows ?? []).map(item => <article className="service" key={String(item.service)}>
      <h3>{label(item.service)}</h3>
      <p>배포 workflow: {label(item.workflow)} · 트리거: {label(item.trigger)}</p>
      <p>위험: {label(item.deployRisk)} · 사후 검사: {label(item.healthcheck)}</p>
      <p>롤백: {label(item.rollback)}</p>
      {item.service === 'home' && <p>Next.js: main {label(item.mainNextVersion)} · develop {label(item.developNextVersion)} · 운영 이미지 {label(item.runtimeNextVersion)}</p>}
    </article>)}</div>
    <h3>배포 실행 이력</h3>
    <div className="finding-list">{(data.records ?? []).map(item => <article key={String(item.deploymentKey)}>
      <span className="state">{label(item.status)} · {label(item.target)}</span>
      <div><b>{label(item.service)} · {item.prNumber ? `PR #${label(item.prNumber)}` : `Actions run ${label(item.runId)}`} · SHA {label(item.headSha)}</b>
        {item.runUrl && <p><a href={String(item.runUrl)} target="_blank" rel="noreferrer">Actions run {label(item.runId)}</a></p>}
        <p>{label(item.detail)}</p>
      </div>
    </article>)}{!(data.records ?? []).length && <div className="empty card">배포 기록이 없습니다. 승인 또는 배포는 이 화면에서 실행되지 않습니다.</div>}</div>
  </section>;
}
