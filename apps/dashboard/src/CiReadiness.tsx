import React from 'react';

type Row=Record<string,any>;

export function CiReadiness({services,pullRequests=[],selected='all'}:{services:Row[];pullRequests?:Row[];selected?:string}){
 const rows=services.filter(item=>selected==='all'||item.service===selected);
 const prs=pullRequests.filter(item=>selected==='all'||item.service===selected);
 return <section className="ci-readiness">
  <div className="section-title"><div><h3>서비스 PR CI 준비 상태</h3><p>실제 GitHub Actions 실행과 브랜치 설정 조회 결과입니다. CI 존재 여부와 통과 결과는 별도로 표시합니다.</p></div></div>
  <div className="finding-list">{rows.map(item=><article key={item.service}>
   <span className="state">{item.prCiPresent?'PR CI 확인됨':'PR CI 미구성'} · {item.branchProtectionStatus}</span>
   <div><b>{item.service} · {item.repository}</b>
    <p>기준 브랜치: {item.branch} · required checks: {item.requiredChecksStatus}</p>
    <p>Workflow: {item.workflowName??'Not Configured'} · check context: {item.checkContext??'Not Configured'}</p>
    <p>적용 상태: {item.applyStatus??'Not Configured'}</p>
    <p>임시 PR 검사: {item.smoke?.status??'Not Run'}{item.smoke?.headSha?<> · HEAD <code>{item.smoke.headSha}</code></>:null}{item.smoke?.runId?<> · Run ID <code>{item.smoke.runId}</code></>:null}{item.smoke?.runUrl?<> · <a href={item.smoke.runUrl} target="_blank" rel="noreferrer">Actions 실행 보기</a></>:null}</p>
    <p>배포 트리거 위험: {item.deploymentConflict}</p><p>검증 명령: {(item.commands??[]).join(' · ')}</p>
    <details><summary>기존 워크플로 및 적용안</summary><ul>{(item.workflows??[]).map((workflow:string)=><li key={workflow}>{workflow}</li>)}</ul>
     {item.patchPath&&<p>제안 파일: <code>{item.patchPath}</code> · patch: <code>{item.patchDiffPath}</code></p>}
     <p>{item.notes}</p>{item.smoke?.reason&&<p>{item.smoke.reason}</p>}
    </details>
   </div>
  </article>)}{!rows.length&&<div className="empty card">표시할 서비스 CI 실사 데이터가 없습니다.</div>}</div>
  <h3>PR head SHA별 실제 검사 결과</h3>
  <div className="finding-list">{prs.map(pr=><article key={pr.prId}>
   <span className="state">{pr.state} · CI {pr.ciStatus}</span><div><b>{pr.service} · PR #{pr.number??'—'} · {pr.title}</b>
    <p>검사 head SHA: <code>{pr.headSha??'조회되지 않음'}</code> · 갱신: {pr.updatedAt?new Date(pr.updatedAt).toLocaleString('ko-KR'):'기록 없음'}</p>
    {pr.url&&<p><a href={pr.url} target="_blank" rel="noreferrer">PR 열기</a></p>}
    <details><summary>Required checks, Check Runs, Workflow Runs 구분 보기</summary><pre>{JSON.stringify(pr.checks,null,2)}</pre></details>{pr.errorReason&&<small>{pr.errorReason}</small>}
   </div>
  </article>)}{!prs.length&&<div className="empty card">저장된 PR/CI 이력이 없습니다. 빈 상태는 CI 통과를 뜻하지 않습니다.</div>}</div>
 </section>;
}
