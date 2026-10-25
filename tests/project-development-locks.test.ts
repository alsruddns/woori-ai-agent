import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { changeProjectDevelopmentLock, codexInvocationBudget, createIsolatedAgentClone, ensureProjectDevelopmentLockSchema, evaluateCurrentProjectSelection, getProjectClaimSnapshot, listProjectDevelopmentLocks, selectDevelopmentProject } from '../apps/cli/src/project-development-locks.js';
import { verifyDevelopmentAuditChain } from '../apps/cli/src/development-audit.js';

const roots:string[]=[];
function temp(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'woori-project-lock-'));roots.push(root);return{root,controller:path.join(root,'controller.sqlite'),audit:path.join(root,'audit.sqlite')};}
const repoStates=(overrides:Record<string,Partial<{repositoryVerified:boolean;dirtyFileCount:number;dirtyPaths:string[];observedCurrentBranch:string;writeLocked:boolean;lockReason:string}>>={})=>['home','calculator','tools','quiz','docs'].map(id=>({id,repositoryVerified:true,dirtyFileCount:0,dirtyPaths:[],observedCurrentBranch:'develop',writeLocked:false,...overrides[id]}));
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

describe('project development locks and selection',()=>{
 it('seeds Tools external, Calculator policy, and Home disabled locks while allowing verified Quiz and Docs candidates',()=>{
  const files=temp();const result=listProjectDevelopmentLocks({databasePath:files.controller,auditDatabasePath:files.audit,repositoryStates:repoStates()});
  expect(Object.fromEntries(result.projects.map(row=>[row.projectId,row.state]))).toMatchObject({tools:'LOCKED_EXTERNAL_DEVELOPMENT',calculator:'LOCKED_POLICY',home:'DISABLED',quiz:'AVAILABLE',docs:'AVAILABLE'});
  expect(result.projects.find(row=>row.projectId==='quiz')?.externalSessionDetection).toBe('Incomplete');
  const db=new Database(files.audit,{readonly:true});const job=db.prepare("SELECT job_uuid FROM development_audit_jobs WHERE source_key='project-lock-default:tools:phase11c31'").get() as {job_uuid:string};db.close();expect(verifyDevelopmentAuditChain(job.job_uuid,files.audit).valid).toBe(true);
 });
 it('retains manual locks, uses optimistic lock versions, and prevents unlocking Calculator',()=>{
  const files=temp();ensureProjectDevelopmentLockSchema(files.controller,files.audit);const before=listProjectDevelopmentLocks({databasePath:files.controller,auditDatabasePath:files.audit,repositoryStates:repoStates()});
  const locked=changeProjectDevelopmentLock({projectId:'quiz',action:'lock',expectedVersion:before.version,actor:'test-admin',reason:'Protect ongoing quiz work.'},{databasePath:files.controller,auditDatabasePath:files.audit,repositoryStates:repoStates()});
  expect(locked.locks.projects.find(row=>row.projectId==='quiz')?.state).toBe('LOCKED_MANUAL');
  expect(()=>changeProjectDevelopmentLock({projectId:'docs',action:'lock',expectedVersion:before.version,actor:'test-admin',reason:'stale version'},{databasePath:files.controller,auditDatabasePath:files.audit,repositoryStates:repoStates()})).toThrow(/LOCK_VERSION_CONFLICT/);
  expect(()=>changeProjectDevelopmentLock({projectId:'calculator',action:'unlock',expectedVersion:locked.version,actor:'test-admin',reason:'try unlock'},{databasePath:files.controller,auditDatabasePath:files.audit,repositoryStates:repoStates()})).toThrow(/immutable policy lock/);
 });
 it('requires explicit external-work acknowledgement and still honors dirty-path conflicts after Tools unlock',()=>{
  const files=temp();const states=repoStates({tools:{dirtyFileCount:2,dirtyPaths:['src/i18n/a.json','src/page.tsx']}});const before=listProjectDevelopmentLocks({databasePath:files.controller,auditDatabasePath:files.audit,repositoryStates:states});
  expect(()=>changeProjectDevelopmentLock({projectId:'tools',action:'unlock',expectedVersion:before.version,actor:'test-admin',reason:'finish lock'},{databasePath:files.controller,auditDatabasePath:files.audit,repositoryStates:states})).toThrow(/explicit confirmation/);
  const result=changeProjectDevelopmentLock({projectId:'tools',action:'unlock',expectedVersion:before.version,actor:'test-admin',reason:'External work reviewed.',confirmExternalWorkComplete:true},{databasePath:files.controller,auditDatabasePath:files.audit,repositoryStates:states});
  expect(result.locks.projects.find(row=>row.projectId==='tools')?.state).toBe('LOCKED_CONFLICT');
  expect(result.locks.projects.find(row=>row.projectId==='tools')?.conflictingPaths).toEqual(states.find(row=>row.id==='tools')?.dirtyPaths);
 });
 it('selects Quiz first and falls through to Docs when Quiz is locked; policy-off blocks every target',()=>{
  const files=temp();const state=listProjectDevelopmentLocks({databasePath:files.controller,auditDatabasePath:files.audit,repositoryStates:repoStates()});const gates=Object.fromEntries(['quiz','docs','tools','calculator'].map(projectId=>[projectId,{policyAllowed:true,codexEnabled:true,workerAvailable:true,sandboxReady:true,leaseValid:true,budgetAvailable:true,auditReady:true}])) as any;
  expect(selectDevelopmentProject(state.projects,gates).selectedProject).toBe('quiz');
  const locked=state.projects.map(project=>project.projectId==='quiz'?{...project,state:'LOCKED_MANUAL' as const,reason:'active work'}:project);
  expect(selectDevelopmentProject(locked,gates).selectedProject).toBe('docs');
  for(const gate of Object.values(gates) as any[])gate.policyAllowed=false;
  expect(selectDevelopmentProject(state.projects,gates).status).toBe('NoEligibleProject');
 });
 it('records observed conflicts and skipped projects in the immutable audit trail',()=>{
  const files=temp();const states=repoStates({quiz:{dirtyFileCount:1,dirtyPaths:['src/current-work.ts']},docs:{dirtyFileCount:1,dirtyPaths:['src/template.ts']}});
  const result=evaluateCurrentProjectSelection({databasePath:files.controller,auditDatabasePath:files.audit,repositoryStates:states,codexBudget:{date:'2026-10-25',used:0,limit:1,remaining:1,subscriptionQuota:'Unknown',available:true,reason:'test'}});
  expect(result.status).toBe('NoEligibleProject');const db=new Database(files.audit,{readonly:true});const types=db.prepare("SELECT DISTINCT event_type FROM development_audit_events").all().map((row:any)=>row.event_type);db.close();expect(types).toEqual(expect.arrayContaining(['PROJECT_CONFLICT_DETECTED','PROJECT_SKIPPED']));
 });
 it('counts Unknown invocations as consumed without claiming subscription balance',()=>{
  const files=temp();const db=new Database(files.audit);db.exec(`CREATE TABLE codex_invocations(invocation_id TEXT,development_job_id TEXT,worker_id TEXT,platform TEXT,created_at TEXT,execution_status TEXT,subscription_usage_status TEXT);INSERT INTO codex_invocations VALUES('x','job','worker','win32','2026-10-25T00:00:00.000Z','Unknown','Unknown');`);db.close();const budget=codexInvocationBudget(files.audit,new Date('2026-10-25T10:00:00Z'),1);expect(budget).toMatchObject({used:1,remaining:0,subscriptionQuota:'Unknown',unknownInvocations:1,available:false});const snapshot=getProjectClaimSnapshot({databasePath:files.controller,auditDatabasePath:files.audit,repositoryStates:repoStates()});expect(snapshot.availableProjects).toContain('quiz');
 });
 it('creates a real independent clone from a fixture remote pinned to the verified develop SHA',()=>{
  const files=temp(),source=path.join(files.root,'source'),bare=path.join(files.root,'fixture.git'),workspace=path.join(files.root,'agent-workspaces');fs.mkdirSync(source);execFileSync('git',['init','-b','develop',source],{stdio:'ignore'});execFileSync('git',['-C',source,'config','user.name','Fixture'],{stdio:'ignore'});execFileSync('git',['-C',source,'config','user.email','fixture@example.invalid'],{stdio:'ignore'});fs.writeFileSync(path.join(source,'README.md'),'fixture');execFileSync('git',['-C',source,'add','README.md'],{stdio:'ignore'});execFileSync('git',['-C',source,'commit','-m','fixture'],{stdio:'ignore'});const sha=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();execFileSync('git',['init','--bare',bare],{stdio:'ignore'});execFileSync('git',['-C',source,'remote','add','origin',bare],{stdio:'ignore'});execFileSync('git',['-C',source,'push','-u','origin','develop'],{stdio:'ignore'});
  const clone=createIsolatedAgentClone({repositoryUrl:bare,service:'quiz',baseSha:sha,workspaceRoot:workspace,jobId:'DEV-FIXTURE-001'},{allowedRepositoryUrls:[bare],databasePath:files.controller,auditDatabasePath:files.audit,repositoryStates:repoStates()});expect(clone).toMatchObject({branch:'agent/DEV-FIXTURE-001',baseSha:sha,origin:bare,isolated:true,automaticPush:false,automaticPr:false});expect(fs.readFileSync(path.join(clone.path,'README.md'),'utf8')).toBe('fixture');expect(execFileSync('git',['-C',clone.path,'rev-parse','HEAD'],{encoding:'utf8'}).trim()).toBe(sha);expect(execFileSync('git',['-C',source,'status','--porcelain'],{encoding:'utf8'})).toBe('');
 });
});
