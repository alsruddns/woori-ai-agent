import React,{useEffect,useState}from'react';
import{adminFetch}from'./admin-api';

type Worktree={path:string;head:string|null;branch:string|null;detached:boolean;clean:boolean|null;dirtyPaths:string[];operationInProgress:string[];gitLocked:boolean;gitLockReason:string|null;prunable:boolean;prunableReason:string|null;owner:string;agentManaged:boolean};
type Project={projectId:string;state:string;reason:string;owner:string|null;currentBranch:string|null;remoteDevelopSha:string|null;baseCommitSha:string|null;workingTreeClean:boolean|null;conflictingPaths:string[];lastVerifiedAt:string|null;evidence:string[];worktreeInventory:Worktree[];workspaceIsolationStatus:'Ready'|'Blocked'|'Unverified';integrationRisk:string;agentCloneStatus:string;agentClonePath:string|null;developmentPolicyAllowed:boolean;codexExecutionAllowed:boolean};
type Evaluation={projectId:string;status:string;reasons:string[];workspaceIsolationStatus:string;agentCloneStatus:string;developmentPolicyAllowed:boolean;codexExecutionAllowed:boolean;integrationRisk:string};
type Data={admin:{authenticated:boolean};projectDevelopment:{lockVersion:number;policyVersion:number;policyMode:string;selectedProject:string|null;status:string;nextCandidate:string|null;evaluated:Evaluation[];codexBudget:{used:number;limit:number;remaining:number;subscriptionQuota:string;reason:string};locks:Project[]}};

const projectName=(id:string)=>({tools:'Tools',calculator:'Calculator',quiz:'Quiz',docs:'Docs',home:'Home'} as Record<string,string>)[id]??id;
const lockLabel=(state:string)=>({AVAILABLE:'개발 후보 가능',LOCKED_MANUAL:'관리자 잠금',LOCKED_EXTERNAL_DEVELOPMENT:'외부 개발 중 잠금',LOCKED_POLICY:'정책 잠금',LOCKED_CONFLICT:'변경 충돌 잠금',LOCKED_UNVERIFIED:'검증 필요로 잠금',DISABLED:'개발 비활성'} as Record<string,string>)[state]??state;
const readiness=(value:string)=>({Ready:'준비됨',Blocked:'차단됨',Unverified:'미검증',Eligible:'개발 후보 가능',NotEligible:'개발 불가',Unknown:'확인 필요'} as Record<string,string>)[value]??value;
const modeLabel=(value:string)=>({MONITOR_ONLY:'감시 전용',FEATURE_EXPANSION:'기능 확장',BUG_FIX:'오류 수정',FULL_AUTONOMOUS:'전체 자율 운영',PAUSED:'일시 중지'} as Record<string,string>)[value]??value;
const riskLabel=(value:string)=>({Low:'낮음',Medium:'보통',High:'높음',Critical:'매우 높음',Unknown:'확인 불가',Unverified:'미검증'} as Record<string,string>)[value]??value;

export function ProjectDevelopment(){
 const[data,setData]=useState<Data|null>(null),[spec,setSpec]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[reason,setReason]=useState(''),[confirmToolsDone,setConfirmToolsDone]=useState(false);
 async function load(){try{const response=await fetch('/api/control-center',{cache:'no-store'});if(!response.ok)throw new Error(`API ${response.status}`);setData(await response.json());setError('')}catch(e){setError(String(e))}}
 useEffect(()=>{void load()},[]);
 async function mutate(project:Project,action:'lock'|'unlock'){if(!data)return;setBusy(true);try{const response=await adminFetch('/api/control-center/project-locks',{method:'POST',body:JSON.stringify({projectId:project.projectId,action,expectedVersion:data.projectDevelopment.lockVersion,reason:reason.trim()||`Administrator ${action} request`,confirmExternalWorkComplete:project.projectId==='tools'&&action==='unlock'&&confirmToolsDone})});const value=await response.json();if(!response.ok)throw new Error(value.error??`API ${response.status}`);setReason('');setConfirmToolsDone(false);await load()}catch(e){setError(String(e))}finally{setBusy(false)}}
 async function prepareSpec(){setBusy(true);try{const response=await adminFetch('/api/feature-factory/quiz-specification',{method:'POST',body:JSON.stringify({})});const value=await response.json();if(!response.ok)throw new Error(value.error??`API ${response.status}`);setSpec(value);setError('')}catch(e){setError(String(e))}finally{setBusy(false)}}
 const projectData=data?.projectDevelopment;
 return <section id="project-development-locks">
  <div className="section-title"><div><h2>프로젝트 개발 잠금</h2><p>작업 공간 격리, 개발 정책, Codex 실행 권한을 각각 표시합니다. 기존 worktree는 읽기 전용으로 확인하며 자동 정리하지 않습니다.</p></div></div>
  {error&&<div className="error">{error}</div>}
  <label className="reason-field">잠금 변경 사유<input value={reason} onChange={e=>setReason(e.target.value)} placeholder="관리자 변경 사유"/></label>
  <label className="toggle"><input type="checkbox" checked={confirmToolsDone} onChange={e=>setConfirmToolsDone(e.target.checked)}/><span>Tools 외부 다국어 작업 완료를 확인</span><small>확인만으로 미커밋 변경, worktree 충돌 또는 실행 정책이 해제되지는 않습니다.</small></label>
  <div className="finding-list">{(data?.projectDevelopment.locks??[]).map(project=><article key={project.projectId}>
   <span className={`state ${project.state==='AVAILABLE'?'':'bad'}`}>{lockLabel(project.state)}</span>
   <div><b>{projectName(project.projectId)}</b><p>{project.reason}</p>
    <small>잠금 주체: {project.owner??'확인 불가'} · 현재 브랜치: {project.currentBranch??'확인 불가'} · 원격 develop: {project.remoteDevelopSha?.slice(0,12)??'확인 불가'}</small>
    <small>작업 공간 격리: {readiness(project.workspaceIsolationStatus)} · Agent Clone: {readiness(project.agentCloneStatus)}{project.agentClonePath?` (${project.agentClonePath})`:''} · 통합 위험: {riskLabel(project.integrationRisk)}</small>
    <small>개발 정책: {project.developmentPolicyAllowed?'허용':'차단'} · Codex 실행: {project.codexExecutionAllowed?'허용':'차단'} · 마지막 확인: {project.lastVerifiedAt?new Date(project.lastVerifiedAt).toLocaleString('ko-KR'):'확인 불가'}</small>
    {project.conflictingPaths.length>0&&<small>기준 checkout 경고: {project.conflictingPaths.join(', ')}</small>}
    <details><summary>기존 Git worktree ({project.worktreeInventory?.length??0})</summary>{project.worktreeInventory?.length?<ul>{project.worktreeInventory.map((tree,index)=><li key={`${tree.path}-${index}`}><code>{tree.path}</code><br/>브랜치: {tree.branch??(tree.detached?'분리 HEAD':'확인 불가')} · HEAD: {tree.head?.slice(0,12)??'확인 불가'} · 상태: {tree.clean===null?'확인 불가':tree.clean?'깨끗함':'수정 있음'} · 소유자: {tree.owner}<br/>Git 잠금: {tree.gitLocked?(tree.gitLockReason??'잠김'):'없음'} · 정리 가능 표시: {tree.prunable?(tree.prunableReason??'확인 필요'):'아니요'}<br/>{tree.operationInProgress.length?`진행 중 작업: ${tree.operationInProgress.join(', ')}`:'진행 중인 Git 작업 표식 없음'}{tree.dirtyPaths.length>0&&<><br/>변경 경로: {tree.dirtyPaths.join(', ')}</>}</li>)}</ul>:<p>worktree가 발견되지 않았습니다.</p>}</details>
    <details><summary>검사 근거</summary><pre>{project.evidence.join('\n')}</pre></details>
   </div>
   {project.projectId!=='calculator'&&project.projectId!=='home'&&data?.admin.authenticated&&<button disabled={busy||(project.projectId==='tools'&&project.state!=='AVAILABLE'&&!confirmToolsDone)} onClick={()=>void mutate(project,project.state==='AVAILABLE'?'lock':'unlock')}>{project.state==='AVAILABLE'?'잠금':'관리자 잠금 해제'}</button>}
  </article>)}</div>
  <div className="control-card"><h3>개발 대상 자동 선택</h3><p>우선순위: Quiz → Docs → Tools → Calculator</p><p>선택된 프로젝트: <b>{projectData?.selectedProject?projectName(projectData.selectedProject):'없음'}</b> · {readiness(projectData?.status??'확인 중')} · {modeLabel(projectData?.policyMode??'')}</p><p>다음 후보: {projectData?.nextCandidate?projectName(projectData.nextCandidate):'없음'}</p><p>Codex 로컬 호출: {projectData?.codexBudget.used??'?'}/{projectData?.codexBudget.limit??'?'} · 구독 잔여량: {projectData?.codexBudget.subscriptionQuota==='Unknown'?'확인 불가':projectData?.codexBudget.subscriptionQuota??'확인 불가'}</p><small>{projectData?.codexBudget.reason}</small>
   <div className="finding-list">{(projectData?.evaluated??[]).map(item=><article key={item.projectId}><span className={`state ${item.status==='Eligible'?'':'bad'}`}>{readiness(item.status)}</span><div><b>{projectName(item.projectId)}</b><small>작업 공간: {readiness(item.workspaceIsolationStatus)} · 개발 정책: {item.developmentPolicyAllowed?'허용':'차단'} · Codex: {item.codexExecutionAllowed?'허용':'차단'} · Clone: {readiness(item.agentCloneStatus)} · 통합 위험: {riskLabel(item.integrationRisk)}</small><small>{item.reasons.join(' · ')||'모든 실행 게이트 통과'}</small></div></article>)}</div>
  </div>
  <div className="control-card"><h3>Quiz 기능 명세</h3><p>기존 결과 흐름에 오답 문제만 다시 풀기 동작을 추가하는 명세 초안입니다. 새 URL은 만들지 않으며 검색 수요는 확인되지 않았습니다.</p><button disabled={!data?.admin.authenticated||busy} onClick={()=>void prepareSpec()}>감사 기록과 함께 명세 준비</button>{spec&&<><p>{spec.jobId} · {spec.featureId} · 실행하지 않음</p><details><summary>명세 보기</summary><pre>{JSON.stringify(spec.specification,null,2)}</pre></details></>}</div>
 </section>;
}
