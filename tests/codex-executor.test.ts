import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { enqueueDevelopmentTask, listDevelopmentTasks, transitionDevelopmentTask } from '../apps/cli/src/development-orchestrator.js';
import { cleanupDevelopmentWorktree, codexExecutorInternals, executeApprovedTask, listDevelopmentExecutions } from '../apps/cli/src/codex-executor.js';
import { codexExecArgs, paidCredentialVariablesPresent, parseAllowedPaths, pathMatchesAllowlist, redactCodexOutput, safeCodexEnv } from '../apps/cli/src/codex-cli.js';

const previousDb=process.env.WOORI_AGENT_DB_PATH;
let tempDir:string|undefined;
afterEach(()=>{if(previousDb===undefined)delete process.env.WOORI_AGENT_DB_PATH;else process.env.WOORI_AGENT_DB_PATH=previousDb;if(tempDir)fs.rmSync(tempDir,{recursive:true,force:true});tempDir=undefined;});
function setup(){tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'woori-codex-runner-'));process.env.WOORI_AGENT_DB_PATH=path.join(tempDir,'queue.sqlite');return tempDir;}
function makeTask(){const task=enqueueDevelopmentTask({service:'docs',title:'Add approved focused change',kind:'qa',priority:'Low',evidence:'A synthetic fixture needs a source file.',acceptanceCriteria:'Add one file under src and report its path.',sourceAgent:'qa'});transitionDevelopmentTask(task.taskId!,'Triaged');transitionDevelopmentTask(task.taskId!,'Ready');return task.taskId!;}
function fixtureRepo(root:string){const repo=path.join(root,'source-docs');fs.mkdirSync(path.join(repo,'src'),{recursive:true});fs.writeFileSync(path.join(repo,'package.json'),JSON.stringify({name:'fixture-docs',version:'1.0.0',scripts:{lint:'node -e "process.exit(0)"',test:'node -e "process.exit(0)"',build:'node -e "process.exit(0)"'}}));fs.writeFileSync(path.join(repo,'src','index.ts'),'export const marker = 1;\n');execFileSync('git',['init','-q',repo]);execFileSync('git',['-C',repo,'add','.']);execFileSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);return repo;}
const repository=(localPath:string,overrides:Record<string,unknown>={})=>({id:'docs',name:'woori-docs',repositoryUrl:'https://github.com/alsruddns/woori-docs.git',localPath,stack:['Next.js','TypeScript','pnpm'],observedBranch:'develop',observedDirtyFiles:0,commands:{lint:'pnpm lint',test:'pnpm test',build:'pnpm build'},deploymentWorkflow:'.github/workflows/deploy.yml',codeAutomationEnabled:true,autoDeployEnabled:false,writeLocked:false,exists:true,observedOrigin:'https://github.com/alsruddns/woori-docs.git',observedCurrentBranch:'main',dirtyFileCount:0,dirtyPaths:[],repositoryVerified:true,worktreeEligible:true,blockReasons:[],...overrides}) as never;
function fakeCli(root:string){const file=path.join(root,'fake-codex.cjs');fs.writeFileSync(file,`const a=process.argv.slice(2);if(a[0]==='--version')console.log('codex-cli 0.163.0');else if(a[0]==='login'&&a[1]==='status')console.log('Logged in using ChatGPT');`);return{kind:'node' as const,executable:process.execPath,prefixArgs:[file],version:'codex-cli 0.163.0'};}

describe('Codex local execution safety',()=>{
 it('requires explicit scoped paths and pins the supported sandbox without danger-full-access',()=>{
  expect(parseAllowedPaths('src/**,tests/**/*.test.ts')).toEqual(['src/**','tests/**/*.test.ts']);
  expect(pathMatchesAllowlist('src/i18n/page.ts',['src/**'])).toBe(true);
  expect(pathMatchesAllowlist('src/.env.local',['src/**'])).toBe(false);
  expect(()=>parseAllowedPaths('**')).toThrow(/overly broad/i);
  expect(()=>parseAllowedPaths('../outside/**')).toThrow(/unsafe/i);
  expect(()=>parseAllowedPaths('.github/workflows/**')).toThrow(/protected/i);
  const args=codexExecArgs('C:/tmp/worktree','workspace-write','fixture task');
  expect(args).toContain('workspace-write');expect(args).toContain('--ignore-user-config');expect(args).toContain('--ephemeral');expect(args.join(' ')).toContain('windows.sandbox=mxc');expect(args.join(' ')).not.toContain('danger-full-access');
  expect(safeCodexEnv().OPENAI_API_KEY).toBeUndefined();expect(safeCodexEnv().CODEX_API_KEY).toBeUndefined();expect(safeCodexEnv().COREPACK_ENABLE_NETWORK).toBe('0');expect(safeCodexEnv().PLAYWRIGHT_WORKERS).toBe('1');
 });

 it('blocks API credentials and redacts token-like values from logs',()=>{
  expect(paidCredentialVariablesPresent({OPENAI_API_KEY:'never-print'})).toContain('OPENAI_API_KEY');
  expect(redactCodexOutput('Bearer abc.def token sk-123456789012345678901234')).not.toContain('abc.def');
  expect(redactCodexOutput('Bearer abc.def token sk-123456789012345678901234')).not.toContain('sk-123456789012345678901234');
 });

 it('blocks without explicit consent and persists the blocked attempt',async()=>{
  setup();const taskId=makeTask();
  const result=await executeApprovedTask({taskId,approved:false,allowedPaths:''});
  expect(result.status).toBe('Blocked');expect(String(result.error)).toMatch(/explicit one-task approval/i);
  expect(listDevelopmentExecutions()).toHaveLength(1);
  expect((listDevelopmentTasks().tasks[0] as {status:string}).status).toBe('Ready');
 });

 it('fails closed for Linux code modification until a Linux sandbox adapter is ready',async()=>{
  setup();const taskId=makeTask();let invoked=false;
  const result=await executeApprovedTask({taskId,approved:true,platform:'linux',allowedPaths:'src/**',runCodex:async()=>{invoked=true;return{exitCode:0,timedOut:false,stdout:'',stderr:''};}});
  expect(result.status).toBe('Blocked');expect(result.error).toMatch(/Windows workstation only/i);expect(invoked).toBe(false);
 });

 it('blocks API-key environments before creating a worktree or invoking Codex',async()=>{
  const root=setup();const taskId=makeTask();let invoked=false;
  const result=await executeApprovedTask({taskId,approved:true,allowedPaths:'src/**',env:{CODEX_API_KEY:'secret-never-log'},repositoryOverride:repository(path.join(root,'source')),runCodex:async()=>{invoked=true;return{exitCode:0,timedOut:false,stdout:'',stderr:''};}});
  expect(result.status).toBe('Blocked');expect(result.error).toMatch(/credentials are present/i);expect(invoked).toBe(false);
 });

 it('enforces one active run lock per service',()=>{
  setup();codexExecutorInternals.lockService('docs','task-one');
  expect(()=>codexExecutorInternals.lockService('docs','task-two')).toThrow(/holds the docs lock/i);
  codexExecutorInternals.unlockService('docs','task-one');
 });

 it('uses a temporary Git worktree and records successful verification without touching the source worktree',async()=>{
  const root=setup();const source=fixtureRepo(root);const taskId=makeTask();const before=execFileSync('git',['-C',source,'status','--porcelain'],{encoding:'utf8'});
  const cli=fakeCli(root);const result=await executeApprovedTask({taskId,approved:true,platform:'win32',allowedPaths:'src/**,tests/**',launcher:cli,repositoryOverride:repository(source),agentDataRoot:path.join(root,'orchestrator'),sandboxProbe:()=>({status:'Ready',message:'fixture sandbox ready',exitCode:0}),runCodex:async(_cli,_args,cwd)=>{fs.writeFileSync(path.join(cwd,'src','generated.ts'),'export const generated = true;\n');return{exitCode:0,timedOut:false,stdout:'done',stderr:''};},runValidation:(_cli,cwd,patterns)=>({passed:patterns.includes('src/**')&&fs.existsSync(path.join(cwd,'src','generated.ts')),changedFiles:['src/generated.ts'],verification:{passed:true,failures:[],scripts:[{script:'lint',exitCode:0,timedOut:false,output:''},{script:'test',exitCode:0,timedOut:false,output:''},{script:'build',exitCode:0,timedOut:false,output:''}]}})});
  expect(result.status).toBe('Completed');expect((result as Record<string,unknown>).changedFiles).toEqual(['src/generated.ts']);expect((result as Record<string,unknown>).branchName).toContain('codex-agent/docs/');
  expect(execFileSync('git',['-C',source,'status','--porcelain'],{encoding:'utf8'})).toBe(before);
  expect((listDevelopmentTasks().tasks[0] as {status:string}).status).toBe('Testing');
  expect((listDevelopmentExecutions()[0] as Record<string,unknown>)?.authMode).toBe('ChatGPT');
 });

 it('marks out-of-scope edits and test failures as Failed and never retries',async()=>{
  const root=setup();const source=fixtureRepo(root);const taskId=makeTask();const cli=fakeCli(root);let calls=0;
  const result=await executeApprovedTask({taskId,approved:true,platform:'win32',allowedPaths:'src/**',launcher:cli,repositoryOverride:repository(source),agentDataRoot:path.join(root,'orchestrator'),sandboxProbe:()=>({status:'Ready',message:'fixture sandbox ready',exitCode:0}),runCodex:async(_cli,_args,cwd)=>{calls++;fs.mkdirSync(path.join(cwd,'docs'),{recursive:true});fs.writeFileSync(path.join(cwd,'docs','outside.md'),'outside allowlist');return{exitCode:0,timedOut:false,stdout:'done',stderr:''};},runValidation:()=>({passed:false,changedFiles:['docs/outside.md'],verification:{passed:false,failures:['Changes outside approved path allowlist: docs/outside.md']}})});
  expect(result.status).toBe('Failed');expect(calls).toBe(1);expect((listDevelopmentTasks().tasks[0] as {status:string}).status).toBe('Failed');
 });

 it('blocks pre-existing user modifications before creating a worktree',async()=>{
  const root=setup();const taskId=makeTask();let invoked=false;
  const result=await executeApprovedTask({taskId,approved:true,platform:'win32',allowedPaths:'src/**',launcher:fakeCli(root),repositoryOverride:repository(path.join(root,'source'),{dirtyFileCount:2,dirtyPaths:['README.md','src/a.ts'],worktreeEligible:false}),agentDataRoot:path.join(root,'orchestrator'),sandboxProbe:()=>({status:'Ready',message:'fixture sandbox ready',exitCode:0}),runCodex:async()=>{invoked=true;return{exitCode:0,timedOut:false,stdout:'',stderr:''};}});
  expect(result.status).toBe('Blocked');expect(result.error).toMatch(/pre-existing modified file/i);expect(invoked).toBe(false);
 });

 it('cleans only the recorded, clean isolated worktree and preserves task history',async()=>{
  const root=setup();const source=fixtureRepo(root);const taskId=makeTask();const cli=fakeCli(root);const dataRoot=path.join(root,'orchestrator');
  const result=await executeApprovedTask({taskId,approved:true,platform:'win32',allowedPaths:'src/**',launcher:cli,repositoryOverride:repository(source),agentDataRoot:dataRoot,sandboxProbe:()=>({status:'Ready',message:'fixture sandbox ready',exitCode:0}),runCodex:async()=>({exitCode:0,timedOut:false,stdout:'no edits',stderr:''}),runValidation:()=>({passed:false,changedFiles:[],verification:{passed:false,failures:['no changed files']}})});
  expect(result.status).toBe('Failed');
  const cleaned=cleanupDevelopmentWorktree(taskId,dataRoot,repository(source));
  expect(cleaned.status).toBe('Cleaned');expect(fs.existsSync(cleaned.worktreePath)).toBe(false);
  expect((listDevelopmentExecutions()[0] as unknown as {status:string}|undefined)?.status).toBe('Failed');
 });
});
