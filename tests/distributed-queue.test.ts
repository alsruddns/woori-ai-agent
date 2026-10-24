import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { approveControllerJob, assertCurrentControllerLease, claimControllerJob, controllerDashboardSnapshot, heartbeatControllerWorker, recoverExpiredControllerJob, registerControllerWorker, renewControllerLease, submitControllerJob, transitionControllerJob } from '../apps/cli/src/distributed-queue.js';
import { controllerNetworkPolicy, controllerWorkerRequest, createDistributedControllerServer, ensureDevelopmentGlobalJobMap } from '../apps/cli/src/distributed-controller-http.js';
import { getAgentPolicy,listPolicyAudit,updateAgentPolicy } from '../apps/cli/src/agent-policy.js';

let root = '';
const dbPath = () => path.join(root, 'controller.sqlite');
function setup() { root = fs.mkdtempSync(path.join(os.tmpdir(), 'woori-controller-')); return dbPath(); }
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = ''; });

function worker(workerId: string, osName: 'windows' | 'linux' = 'windows') {
 return { workerId, os: osName, hostLabel: `${osName}-test`, capabilities: ['qa', 'seo', ...(osName === 'windows' ? ['codex-write'] : [])], codexCliStatus: osName === 'windows' ? 'Ready' : 'Not Configured', chatgptLoginStatus: osName === 'windows' ? 'ChatGPT' : 'Not Configured', sandboxStatus: osName === 'windows' ? 'Ready' : 'Not Configured', cpuCount: 4, availableMemoryBytes: 2_000_000_000, executionStatus: 'Idle' };
}
function register(workerId: string, osName: 'windows' | 'linux' = 'windows', file = dbPath()) {
 return registerControllerWorker(worker(workerId, osName), file, {os:osName,allowCodeChanges:osName==='windows'});
}
function request(url: string, token: string, workerId: string, nonce = crypto.randomUUID(), body: unknown = worker(workerId)) {
 return fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-woori-worker-id': workerId, 'x-woori-timestamp': String(Date.now()), 'x-woori-nonce': nonce, 'x-woori-request-id': crypto.randomUUID() }, body: JSON.stringify(body) });
}

describe('distributed Controller lease safety', () => {
 it('deduplicates local queue submissions and keeps MoneyBook and Calculator code changes locked', () => {
  const file = setup();
  expect(() => submitControllerJob({ service: 'money', kind: 'bug', workClass: 'code_change', idempotencyKey: 'money-1', title: 'change' }, file)).toThrow(/MoneyBook is excluded/i);
  expect(() => submitControllerJob({ service: 'calculator', kind: 'bug', workClass: 'code_change', idempotencyKey: 'calc-1', title: 'change' }, file)).toThrow(/Calculator code changes are locked/i);
  const input = { service: 'docs', kind: 'content', workClass: 'analysis' as const, idempotencyKey: 'same-global-task', localTaskId: 'dev-1', title: 'Review document structure', evidence: 'Check headings and internal links.' };
  const first = submitControllerJob(input, file), duplicate = submitControllerJob(input, file);
  expect(first.created).toBe(true); expect(duplicate.created).toBe(false); expect(duplicate.globalJobId).toBe(first.globalJobId);
 });

 it('serializes simultaneous claims so a job has only one owner and one increasing fencing token', async () => {
  const file = setup(); register('worker-win-01', 'windows', file); register('worker-win-02', 'windows', file);
  const submitted = submitControllerJob({ service: 'tools', kind: 'bug', workClass: 'code_change', requiredOs: 'windows', idempotencyKey: 'tool-job', title: 'Fix a verified tool issue', resourceKeys: ['service:tools', 'src/tool.ts'] }, file);
  approveControllerJob(submitted.globalJobId, file);
  const claims = await Promise.all([Promise.resolve().then(() => claimControllerJob('worker-win-01', 60_000, file)), Promise.resolve().then(() => claimControllerJob('worker-win-02', 60_000, file))]);
  const leases = claims.filter(Boolean);
  expect(leases).toHaveLength(1);
  const lease = leases[0]!;
  expect(lease.fencingToken).toBe(1);
  expect(() => assertCurrentControllerLease({ jobId: lease.jobId, workerId: lease.workerId, fencingToken: lease.fencingToken }, file)).not.toThrow();
 });

 it('honors overlapping repository/path resource locks across service jobs', () => {
  const file=setup();register('worker-win-31','windows',file);register('worker-win-32','windows',file);
  const first=submitControllerJob({service:'docs',kind:'bug',workClass:'code_change',requiredOs:'windows',idempotencyKey:'lock-a',title:'Docs work',resourceKeys:['repo:shared','path:src/common.ts']},file);
  const second=submitControllerJob({service:'quiz',kind:'feature',workClass:'code_change',requiredOs:'windows',idempotencyKey:'lock-b',title:'Quiz work',resourceKeys:['repo:shared','path:src/common.ts']},file);
  approveControllerJob(first.globalJobId,file);approveControllerJob(second.globalJobId,file);
  expect(claimControllerJob('worker-win-31',60_000,file)?.jobId).toBe(first.globalJobId);
  expect(claimControllerJob('worker-win-32',60_000,file)).toBeNull();
 });

 it('does not let a Worker reset its registration or claim a second job while a lease is active', () => {
  const file=setup();register('worker-win-35','windows',file);
  const first=submitControllerJob({service:'docs',kind:'seo',workClass:'analysis',idempotencyKey:'single-lease-a',title:'First analysis'},file);
  const second=submitControllerJob({service:'quiz',kind:'seo',workClass:'analysis',idempotencyKey:'single-lease-b',title:'Second analysis'},file);
  approveControllerJob(first.globalJobId,file);approveControllerJob(second.globalJobId,file);
  const lease=claimControllerJob('worker-win-35',60_000,file)!;
  expect(()=>heartbeatControllerWorker(worker('worker-win-35'),file,{os:'windows',allowCodeChanges:true})).toThrow(/cannot clear or change an active job/i);
  expect(()=>registerControllerWorker(worker('worker-win-35'),file,{os:'windows',allowCodeChanges:true})).toThrow(/cannot clear an active job lease/i);
  expect(claimControllerJob('worker-win-35',60_000,file)).toBeNull();
  expect(controllerDashboardSnapshot(file).jobs.find(job=>job.globalJobId===lease.jobId)?.status).toBe('Claimed');
 });

 it('does not reassign on missed heartbeat or expired lease; recovery requires process-termination evidence and fences old owner', () => {
  const file = setup(); register('worker-win-11', 'windows', file); register('worker-win-12', 'windows', file);
  const submitted = submitControllerJob({ service: 'home', kind: 'bug', workClass: 'code_change', requiredOs: 'windows', idempotencyKey: 'home-job', title: 'Fix a verified home issue' }, file);
  approveControllerJob(submitted.globalJobId, file);
  const lease = claimControllerJob('worker-win-11', 60_000, file)!;
  const db = new Database(file); db.prepare('UPDATE controller_jobs SET expires_at=? WHERE global_job_id=?').run(new Date(Date.now() - 1_000).toISOString(), lease.jobId); db.close();
  expect(claimControllerJob('worker-win-12', 60_000, file)).toBeNull();
  expect(() => renewControllerLease({ jobId: lease.jobId, workerId: lease.workerId, leaseId: lease.leaseId, fencingToken: lease.fencingToken }, 60_000, file)).toThrow(/Expired leases/i);
  expect(() => recoverExpiredControllerJob({ jobId: lease.jobId, processTerminated: false, verifiedBy: '', evidence: '' }, file)).toThrow(/termination evidence/i);
  recoverExpiredControllerJob({ jobId: lease.jobId, processTerminated: true, verifiedBy: 'local-operator', evidence: 'Worker process tree and host were checked after lease expiry.' }, file);
  const replacement = claimControllerJob('worker-win-12', 60_000, file)!;
  expect(replacement.fencingToken).toBeGreaterThan(lease.fencingToken);
  expect(() => transitionControllerJob({ ...lease, status: 'Completed' }, file)).toThrow(/Stale or expired fencing token/i);
  expect(() => assertCurrentControllerLease({ jobId: lease.jobId, workerId: lease.workerId, fencingToken: lease.fencingToken }, file)).toThrow(/side effect blocked/i);
 });

 it('permits Linux analysis but never assigns Linux code modification and reports stale workers Offline', () => {
  const file = setup(); register('worker-linux-01', 'linux', file);
  const code = submitControllerJob({ service: 'docs', kind: 'bug', workClass: 'code_change', requiredOs: 'windows', idempotencyKey: 'linux-not-write', title: 'Code change' }, file);
  approveControllerJob(code.globalJobId, file);
  const analysis = submitControllerJob({ service: 'docs', kind: 'seo', workClass: 'analysis', idempotencyKey: 'linux-analysis', title: 'Review SEO' }, file);
  approveControllerJob(analysis.globalJobId, file);
  const lease = claimControllerJob('worker-linux-01', 60_000, file)!;
  expect(lease.jobId).toBe(analysis.globalJobId);
  heartbeatControllerWorker({ ...worker('worker-linux-01', 'linux'), currentJobId: lease.jobId, executionStatus: 'Running' }, file);
  const snapshot = controllerDashboardSnapshot(file, 0);
  expect(snapshot.workers[0]?.state).toBe('Offline'); expect(snapshot.jobs.find(job => job.globalJobId === code.globalJobId)?.status).toBe('Ready');
  expect(snapshot.events.some(item => item.event === 'claimed')).toBe(true);
 });

 it('preserves jobs across Controller reopen and stores no bearer token field or raw secret', () => {
  const file = setup(); register('worker-win-21', 'windows', file);
  const job = submitControllerJob({ service: 'docs', kind: 'content', workClass: 'analysis', idempotencyKey: 'restart-job', title: 'safe title', evidence: 'api_key=do-not-store-this' }, file);
  const db = new Database(file); const columns = (db.prepare('PRAGMA table_info(controller_workers)').all() as Array<{ name: string }>).map(row => row.name); const evidence = db.prepare('SELECT evidence FROM controller_jobs WHERE global_job_id=?').get(job.globalJobId) as { evidence: string }; db.close();
  expect(columns).not.toContain('token'); expect(columns).not.toContain('token_hash'); expect(evidence.evidence).not.toContain('do-not-store-this');
  expect(controllerDashboardSnapshot(file).jobs[0]?.globalJobId).toBe(job.globalJobId);
 });

 it('adds the local-to-global job mapping to an older local database without replacing existing data', () => {
  setup();const file=path.join(root,'legacy-local.sqlite'),db=new Database(file);
  db.exec('CREATE TABLE development_global_job_map(local_task_id TEXT PRIMARY KEY,global_job_id TEXT NOT NULL UNIQUE,updated_at TEXT NOT NULL)');
  db.prepare('INSERT INTO development_global_job_map VALUES(?,?,?)').run('dev-existing','job-existing','2026-01-01T00:00:00.000Z');
  ensureDevelopmentGlobalJobMap(db);
  const columns=(db.prepare('PRAGMA table_info(development_global_job_map)').all() as Array<{name:string}>).map(row=>row.name);
  const row=db.prepare('SELECT local_task_id,global_job_id,controller_status FROM development_global_job_map').get() as {local_task_id:string;global_job_id:string;controller_status:string};
  db.close();
  expect(columns).toContain('controller_status');expect(row).toMatchObject({local_task_id:'dev-existing',global_job_id:'job-existing',controller_status:'Not Synced'});
 });

 it('requires authentication, rejects replayed nonces, and defaults remote binds to denied', async () => {
  const file = setup(), token = 'test-worker-secret-which-is-long-enough-012345';
  expect(() => createDistributedControllerServer({ host: '8.8.8.8', port: 4180, dbPath: file, workerTokens: { 'worker-net-01': token } })).toThrow(/RFC1918/i);
  expect(controllerNetworkPolicy('10.4.1.5', true, true)).toBe(true); expect(controllerNetworkPolicy('8.8.8.8', true, true)).toBe(false); expect(controllerNetworkPolicy('10.4.1.5', false, true)).toBe(false);
  const app = createDistributedControllerServer({ host: '127.0.0.1', port: 0, dbPath: file, workerTokens: { 'worker-net-01': token },workerPolicies:{'worker-net-01':{os:'windows',allowCodeChanges:false}} }); await app.listen();
  const address = app.server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}/v1/workers/register`;
  try {
   const unauthorized = await fetch(url, { method: 'POST', body: '{}' }); expect(unauthorized.status).toBe(401);
   const nonce = crypto.randomUUID(); const first = await request(url, token, 'worker-net-01', nonce); expect(first.status).toBe(200);
   const replay = await request(url, token, 'worker-net-01', nonce); expect(replay.status).toBe(401);
   const stored = new Database(file); const workerColumns = stored.prepare('PRAGMA table_info(controller_workers)').all() as Array<{ name: string }>; stored.close();
   expect(workerColumns.map(column => column.name).join(' ')).not.toMatch(/token/i);
  } finally { await app.close(); }
 });

 it('exposes scheduler Live Monitor only to an authenticated provisioned Worker', async () => {
  const file=setup(),token='monitor-worker-secret-with-over-32-random-characters-01';
  const app=createDistributedControllerServer({host:'127.0.0.1',port:0,dbPath:file,workerTokens:{'worker-monitor-01':token},workerPolicies:{'worker-monitor-01':{os:'windows',allowCodeChanges:false}}});
  await app.listen();const port=(app.server.address() as {port:number}).port,base=`http://127.0.0.1:${port}`;
  try{
   const registered=await request(`${base}/v1/workers/register`,token,'worker-monitor-01',crypto.randomUUID(),worker('worker-monitor-01'));
   expect(registered.status).toBe(200);
   const denied=await fetch(`${base}/v1/monitor/snapshot`,{method:'POST',body:'{}'});expect(denied.status).toBe(401);
   const response=await request(`${base}/v1/monitor/snapshot`,token,'worker-monitor-01',crypto.randomUUID(),{});
   expect(response.status).toBe(200);const payload=await response.json() as {result:{controller:{status:string};workers:Array<{workerId:string}>;schedulerEnabled:boolean;linuxCodeModification:string}};
   expect(payload.result.controller.status).toBe('Online');expect(payload.result.workers[0]?.workerId).toBe('worker-monitor-01');expect(payload.result.schedulerEnabled).toBe(false);expect(payload.result.linuxCodeModification).toBe('Blocked');
  }finally{await app.close();}
 });

 it('synchronizes the current policy to authenticated Workers and emergency stop blocks new claims',async()=>{
  const file=setup(),token='control-policy-worker-token-with-over-32-characters-01';
  const app=createDistributedControllerServer({host:'127.0.0.1',port:0,dbPath:file,workerTokens:{'worker-policy-sync':token},workerPolicies:{'worker-policy-sync':{os:'windows',allowCodeChanges:false}}});await app.listen();
  const base=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
  try{
   await request(`${base}/v1/workers/register`,token,'worker-policy-sync',crypto.randomUUID(),worker('worker-policy-sync'));
   const policy=await request(`${base}/v1/policy/current`,token,'worker-policy-sync',crypto.randomUUID(),{});expect(policy.status).toBe(200);expect((await policy.json() as any).result).toMatchObject({version:1,mode:'MONITOR_ONLY',emergencyStop:false});
   const current=getAgentPolicy(file);updateAgentPolicy({expectedVersion:current.version,actor:'integration-test',reason:'advance worker policy',patch:{mode:'BUG_FIX'}},file);
   const staleClaim=await request(`${base}/v1/jobs/claim`,token,'worker-policy-sync',crypto.randomUUID(),{policyVersion:1,leaseMs:60_000});expect(staleClaim.status).toBe(409);expect(await staleClaim.json()).toMatchObject({error:'POLICY_VERSION_STALE:2'});
   const latest=getAgentPolicy(file);updateAgentPolicy({expectedVersion:latest.version,actor:'integration-test',reason:'verify emergency gate',patch:{emergencyStop:true}},file);
   const refreshed=await request(`${base}/v1/policy/current`,token,'worker-policy-sync',crypto.randomUUID(),{});expect((await refreshed.json() as any).result).toMatchObject({version:3,emergencyStop:true});expect(listPolicyAudit(file)[0]).toMatchObject({policyVersion:3,workerSyncStatus:'Acknowledged by 1 Worker(s)',workers:[{workerId:'worker-policy-sync',policyVersion:3}]});
   const claim=await request(`${base}/v1/jobs/claim`,token,'worker-policy-sync',crypto.randomUUID(),{policyVersion:3,leaseMs:60_000});expect(claim.status).toBe(403);expect(await claim.json()).toMatchObject({error:'POLICY_BLOCKED:3'});
  }finally{await app.close();}
 });

 it('uses Controller-provisioned OS and write policy instead of trusting Worker readiness claims', async () => {
  const file=setup(),token='policy-worker-test-secret-0123456789-abcdefgh';
  expect(()=>createDistributedControllerServer({host:'127.0.0.1',port:0,dbPath:file,workerPolicies:{'worker-policy-02':{os:'linux',allowCodeChanges:true}}})).toThrow(/Linux code modification cannot be provisioned/i);
  const app=createDistributedControllerServer({host:'127.0.0.1',port:0,dbPath:file,workerTokens:{'worker-policy-01':token},workerPolicies:{'worker-policy-01':{os:'linux',allowCodeChanges:false}}});await app.listen();
  const address=app.server.address() as {port:number},base=`http://127.0.0.1:${address.port}`;
  try{
   const forged=await fetch(`${base}/v1/workers/register`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-woori-worker-id':'worker-policy-01','x-woori-timestamp':String(Date.now()),'x-woori-nonce':crypto.randomUUID(),'x-woori-request-id':crypto.randomUUID()},body:JSON.stringify(worker('worker-policy-01','windows'))});
   expect(forged.status).toBe(400);
   const registerUrl=`${base}/v1/workers/register`,nonce=crypto.randomUUID();
   const accepted=await request(registerUrl,token,'worker-policy-01',nonce,worker('worker-policy-01','linux'));expect(accepted.status).toBe(200);
   const code=submitControllerJob({service:'docs',kind:'bug',workClass:'code_change',requiredOs:'windows',idempotencyKey:'policy-lock',title:'must not run'},file);approveControllerJob(code.globalJobId,file);
   const claimed=await request(`${base}/v1/jobs/claim`,token,'worker-policy-01',crypto.randomUUID(),{policyVersion:1,leaseMs:60_000});
   expect((await claimed.json() as {result:unknown}).result).toBeNull();
   expect(controllerDashboardSnapshot(file).workers[0]?.allowCodeChanges).toBe(false);
  }finally{await app.close();}
 });

 it('fails closed when the Controller is unavailable instead of claiming from a local queue', async () => {
  const oldUrl=process.env.WOORI_CONTROLLER_URL;delete process.env.WOORI_CONTROLLER_URL;
  try{await expect(controllerWorkerRequest('/v1/jobs/claim',{leaseMs:60_000},{workerId:'worker-win-40',token:'a-local-test-secret-with-at-least-32-bytes'})).rejects.toThrow(/ownership is not acquired offline/i);}
  finally{if(oldUrl!==undefined)process.env.WOORI_CONTROLLER_URL=oldUrl;}
 });
});
