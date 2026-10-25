import React,{useEffect,useState}from'react';
import{adminFetch}from'./admin-api';

type Worktree={path:string;head:string|null;branch:string|null;detached:boolean;clean:boolean|null;dirtyPaths:string[];operationInProgress:string[];gitLocked:boolean;gitLockReason:string|null;prunable:boolean;prunableReason:string|null;owner:string;agentManaged:boolean};
type Project={projectId:string;state:string;reason:string;owner:string|null;currentBranch:string|null;remoteDevelopSha:string|null;baseCommitSha:string|null;workingTreeClean:boolean|null;conflictingPaths:string[];lastVerifiedAt:string|null;evidence:string[];worktreeInventory:Worktree[];workspaceIsolationStatus:'Ready'|'Blocked'|'Unverified';integrationRisk:string;agentCloneStatus:string;agentClonePath:string|null;developmentPolicyAllowed:boolean;codexExecutionAllowed:boolean};
type Evaluation={projectId:string;status:string;reasons:string[];workspaceIsolationStatus:string;agentCloneStatus:string;developmentPolicyAllowed:boolean;codexExecutionAllowed:boolean;integrationRisk:string};
type Data={admin:{authenticated:boolean};projectDevelopment:{lockVersion:number;policyVersion:number;policyMode:string;selectedProject:string|null;status:string;nextCandidate:string|null;evaluated:Evaluation[];codexBudget:{used:number;limit:number;remaining:number;subscriptionQuota:string;reason:string};locks:Project[]}};

export function ProjectDevelopment(){
 const[data,setData]=useState<Data|null>(null),[spec,setSpec]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[reason,setReason]=useState(''),[confirmToolsDone,setConfirmToolsDone]=useState(false);
 async function load(){try{const response=await fetch('/api/control-center',{cache:'no-store'});if(!response.ok)throw new Error(`API ${response.status}`);setData(await response.json());setError('')}catch(e){setError(String(e))}}
 useEffect(()=>{void load()},[]);
 async function mutate(project:Project,action:'lock'|'unlock'){if(!data)return;setBusy(true);try{const response=await adminFetch('/api/control-center/project-locks',{method:'POST',body:JSON.stringify({projectId:project.projectId,action,expectedVersion:data.projectDevelopment.lockVersion,reason:reason.trim()||`Administrator ${action} request`,confirmExternalWorkComplete:project.projectId==='tools'&&action==='unlock'&&confirmToolsDone})});const value=await response.json();if(!response.ok)throw new Error(value.error??`API ${response.status}`);setReason('');setConfirmToolsDone(false);await load()}catch(e){setError(String(e))}finally{setBusy(false)}}
 async function prepareSpec(){setBusy(true);try{const response=await adminFetch('/api/feature-factory/quiz-specification',{method:'POST',body:JSON.stringify({})});const value=await response.json();if(!response.ok)throw new Error(value.error??`API ${response.status}`);setSpec(value);setError('')}catch(e){setError(String(e))}finally{setBusy(false)}}
 const projectData=data?.projectDevelopment;
 return <section id="project-development-locks">
  <div className="section-title"><div><h2>Project Development Locks</h2><p>작업 공간 격리, 개발 정책, Codex 실행 권한을 각각 표시합니다. 기존 worktree는 읽기 전용으로 확인하며 자동 정리하지 않습니다.</p></div></div>
  {error&&<div className="error">{error}</div>}
  <label className="reason-field">잠금 변경 사유<input value={reason} onChange={e=>setReason(e.target.value)} placeholder="관리자 변경 사유"/></label>
  <label className="toggle"><input type="checkbox" checked={confirmToolsDone} onChange={e=>setConfirmToolsDone(e.target.checked)}/><span>Tools 외부 다국어 작업 완료를 확인</span><small>확인만으로 미커밋 변경, worktree 충돌 또는 실행 정책이 해제되지는 않습니다.</small></label>
  <div className="finding-list">{(data?.projectDevelopment.locks??[]).map(project=><article key={project.projectId}>
   <span className={`state ${project.state==='AVAILABLE'?'':'bad'}`}>{project.state}</span>
   <div><b>{project.projectId}</b><p>{project.reason}</p>
    <small>잠금 주체: {project.owner??'없음'} · 현재 브랜치: {project.currentBranch??'Unknown'} · 원격 develop: {project.remoteDevelopSha?.slice(0,12)??'Unknown'}</small>
    <small>작업 공간 격리: {project.workspaceIsolationStatus} · Agent Clone: {project.agentCloneStatus}{project.agentClonePath?` (${project.agentClonePath})`:''} · 통합 위험: {project.integrationRisk}</small>
    <small>개발 정책 허용: {project.developmentPolicyAllowed?'Yes':'No'} · Codex 실행 허용: {project.codexExecutionAllowed?'Yes':'No'} · 마지막 확인: {project.lastVerifiedAt??'Unknown'}</small>
    {project.conflictingPaths.length>0&&<small>기준 checkout 경고: {project.conflictingPaths.join(', ')}</small>}
    <details><summary>기존 Git worktree ({project.worktreeInventory?.length??0})</summary>{project.worktreeInventory?.length?<ul>{project.worktreeInventory.map((tree,index)=><li key={`${tree.path}-${index}`}><code>{tree.path}</code><br/>Branch: {tree.branch??(tree.detached?'detached':'Unknown')} · HEAD: {tree.head?.slice(0,12)??'Unknown'} · 상태: {tree.clean===null?'Unknown':tree.clean?'Clean':'Dirty'} · 소유자: {tree.owner}<br/>Git lock: {tree.gitLocked?(tree.gitLockReason??'잠김'):'없음'} · Prunable: {tree.prunable?(tree.prunableReason??'확인 필요'):'아님'}<br/>{tree.operationInProgress.length?`진행 중 작업: ${tree.operationInProgress.join(', ')}`:'진행 중인 Git 작업 표식 없음'}{tree.dirtyPaths.length>0&&<><br/>변경 경로: {tree.dirtyPaths.join(', ')}</>}</li>)}</ul>:<p>worktree가 발견되지 않았습니다.</p>}</details>
    <details><summary>검사 근거</summary><pre>{project.evidence.join('\n')}</pre></details>
   </div>
   {project.projectId!=='calculator'&&project.projectId!=='home'&&data?.admin.authenticated&&<button disabled={busy||(project.projectId==='tools'&&project.state!=='AVAILABLE'&&!confirmToolsDone)} onClick={()=>void mutate(project,project.state==='AVAILABLE'?'lock':'unlock')}>{project.state==='AVAILABLE'?'잠금':'관리자 잠금 해제'}</button>}
  </article>)}</div>
  <div className="control-card"><h3>Automatic Project Selection</h3><p>우선순위: Quiz → Docs → Tools → Calculator</p><p>실행 선택: <b>{projectData?.selectedProject??'없음'}</b> · {projectData?.status??'Loading'} · {projectData?.policyMode??'Unknown'}</p><p>다음 후보: {projectData?.nextCandidate??'없음'}</p><p>Codex 로컬 호출: {projectData?.codexBudget.used??'?'}/{projectData?.codexBudget.limit??'?'} · 구독 잔여량: {projectData?.codexBudget.subscriptionQuota??'Unknown'}</p><small>{projectData?.codexBudget.reason}</small>
   <div className="finding-list">{(projectData?.evaluated??[]).map(item=><article key={item.projectId}><span className={`state ${item.status==='Eligible'?'':'bad'}`}>{item.status}</span><div><b>{item.projectId}</b><small>Workspace: {item.workspaceIsolationStatus} · 개발 정책: {item.developmentPolicyAllowed?'Allowed':'Blocked'} · Codex: {item.codexExecutionAllowed?'Allowed':'Blocked'} · Clone: {item.agentCloneStatus} · 통합 위험: {item.integrationRisk}</small><small>{item.reasons.join(' · ')||'모든 실행 게이트 통과'}</small></div></article>)}</div>
  </div>
  <div className="control-card"><h3>Quiz Feature Specification</h3><p>기존 결과 흐름에 오답 문제만 다시 풀기 동작을 추가하는 명세 초안입니다. 새 URL은 만들지 않으며 검색 수요는 Unknown입니다.</p><button disabled={!data?.admin.authenticated||busy} onClick={()=>void prepareSpec()}>감사 기록과 함께 명세 준비</button>{spec&&<><p>{spec.jobId} · {spec.featureId} · 실행하지 않음</p><details><summary>명세 보기</summary><pre>{JSON.stringify(spec.specification,null,2)}</pre></details></>}</div>
 </section>;
}
