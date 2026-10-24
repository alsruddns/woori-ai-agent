import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimScheduledRun, defaultSchedules, finishScheduledRun, initializeScheduler, initializeServiceControls, recoverScheduledRun, runOneScheduledAction, schedulerSnapshot, schedulerTick, updateSchedulerServiceControl } from '../apps/cli/src/scheduler.js';

let dir:string,file:string;
const oneSchedule=()=>[{...defaultSchedules[0]!,id:'test-hourly',intervalMs:60_000,action:'http-smoke' as const,enabled:true,maxPages:1,catchUpGraceMs:1_000}];
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'woori-scheduler-'));file=path.join(dir,'controller.sqlite');});
afterEach(()=>fs.rmSync(dir,{recursive:true,force:true}));

describe('central SQLite scheduler',()=>{
 it('creates one deterministic scheduled run when simultaneous ticks occur',()=>{
  const now=new Date('2026-10-25T00:00:00.000Z');initializeScheduler(file,oneSchedule(),new Date(now.getTime()-60_000));
  const a=schedulerTick(file,now,'controller-a'),b=schedulerTick(file,now,'controller-b');
  expect(a.queued).toBe(1);expect(b.leader).toBe(false);
  expect(schedulerSnapshot(file).runs).toHaveLength(1);
 });
 it('allows only one worker to claim a run and validates the lease on completion',()=>{
  const now=new Date();initializeScheduler(file,oneSchedule(),new Date(now.getTime()-60_000));schedulerTick(file,now,'controller-a');
  const first=claimScheduledRun(file,'worker-a',now),second=claimScheduledRun(file,'worker-b',now);
  expect(first).toBeTruthy();expect(second).toBeNull();
  finishScheduledRun(first!.runId,first!.leaseId,'Completed','read-only checks complete',undefined,file);
  expect((schedulerSnapshot(file).runs[0] as any)?.status).toBe('Completed');
 });
 it('skips missed catch-up slots instead of replaying backlog',()=>{
  const now=new Date('2026-10-25T02:00:00.000Z');initializeScheduler(file,oneSchedule(),new Date(now.getTime()-120_000));
  const tick=schedulerTick(file,now,'controller-a');
  expect(tick.skipped).toBe(1);expect((schedulerSnapshot(file).runs[0] as any)?.status).toBe('Skipped');
 });
 it('requires operator-verified termination before recovering an expired run',()=>{
  const now=new Date('2026-10-25T00:00:00.000Z');initializeScheduler(file,oneSchedule(),new Date(now.getTime()-60_000));schedulerTick(file,now,'controller-a');
  const lease=claimScheduledRun(file,'worker-a',now,15_000)!;
  expect(claimScheduledRun(file,'worker-b',new Date(now.getTime()+20_000))).toBeNull();
  expect((schedulerSnapshot(file).runs[0] as any)?.status).toBe('Recovery Required');
  expect(()=>recoverScheduledRun({runId:lease.runId,processTerminated:false,verifiedBy:'operator',evidence:'process not confirmed'},file)).toThrow(/termination/i);
  expect(recoverScheduledRun({runId:lease.runId,processTerminated:true,verifiedBy:'local-operator',evidence:'verified process exit in isolated test'},file).recovered).toBe(true);
 });
 it('keeps service controls read-only and excludes MoneyBook and dangerous toggles',()=>{
  const rows=initializeServiceControls(file) as Array<Record<string,unknown>>;
  expect(rows.map(x=>x.service)).not.toContain('money');
  expect(rows.find(x=>x.service==='calculator')?.codexAutoFix).toBe(0);
  expect(()=>updateSchedulerServiceControl('money','autoQa',true,file)).toThrow(/MoneyBook/i);
  expect(()=>updateSchedulerServiceControl('home','autoDeploy',true,file)).toThrow(/locked/i);
  expect(updateSchedulerServiceControl('home','autoQa',false,file)?.autoQa).toBe(0);
 });
 it('does not report live Controller without a fresh heartbeat',()=>{
  initializeScheduler(file,oneSchedule());
  expect((schedulerSnapshot(file).controller as any).status).toBe('Offline');
 });
 it('replays execution events after the client event cursor',()=>{
  const now=new Date();initializeScheduler(file,oneSchedule(),new Date(now.getTime()-60_000));schedulerTick(file,now,'controller-a');
  const first=schedulerSnapshot(file),cursor=first.eventCursor as number;
  expect((first.events as any[]).length).toBeGreaterThan(0);
  expect(schedulerSnapshot(file,cursor).events).toHaveLength(0);
  const lease=claimScheduledRun(file,'worker-a',now)!;
  const replay=schedulerSnapshot(file,cursor);
  expect((replay.events as any[]).some(row=>row.runId===lease.runId&&row.event==='started')).toBe(true);
 });
 it('preserves the scheduler schema and data after reopening SQLite',()=>{
  const now=new Date();initializeScheduler(file,oneSchedule(),new Date(now.getTime()-60_000));schedulerTick(file,now,'controller-a');
  const db=new Database(file);const count=db.prepare('SELECT COUNT(*) AS n FROM scheduler_runs').get() as {n:number};db.close();
  expect(count.n).toBe(1);expect((schedulerSnapshot(file).runs[0] as any)?.status).toBe('Queued');
 });
 it('blocks execution when the global opt-in or zero-cost policy is absent',async()=>{
  const now=new Date();initializeScheduler(file,oneSchedule(),new Date(now.getTime()-60_000));schedulerTick(file,now,'controller-a');
  const saved={enabled:process.env.WOORI_SCHEDULER_ENABLED,paid:process.env.PAID_AI_API_ENABLED,budget:process.env.AI_API_BUDGET_USD,auto:process.env.AI_AUTO_EXECUTION};
  delete process.env.WOORI_SCHEDULER_ENABLED;process.env.PAID_AI_API_ENABLED='false';process.env.AI_API_BUDGET_USD='0';process.env.AI_AUTO_EXECUTION='false';
  try{await expect(runOneScheduledAction(file,'scheduler-test')).rejects.toThrow(/global opt-in/i);expect((schedulerSnapshot(file).runs[0] as any)?.status).toBe('Queued');}
  finally{for(const [key,value] of [['WOORI_SCHEDULER_ENABLED',saved.enabled],['PAID_AI_API_ENABLED',saved.paid],['AI_API_BUDGET_USD',saved.budget],['AI_AUTO_EXECUTION',saved.auto]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
 });
 it('does not execute locally without a fresh central Controller heartbeat',async()=>{
  const now=new Date();initializeScheduler(file,oneSchedule(),new Date(now.getTime()-60_000));schedulerTick(file,now,'controller-a');
  const old={enabled:process.env.WOORI_SCHEDULER_ENABLED,paid:process.env.PAID_AI_API_ENABLED,budget:process.env.AI_API_BUDGET_USD,auto:process.env.AI_AUTO_EXECUTION};
  process.env.WOORI_SCHEDULER_ENABLED='true';process.env.PAID_AI_API_ENABLED='false';process.env.AI_API_BUDGET_USD='0';process.env.AI_AUTO_EXECUTION='false';
  try{await expect(runOneScheduledAction(file,'scheduler-test')).rejects.toThrow(/Central Controller heartbeat/i);expect((schedulerSnapshot(file).runs[0] as any)?.status).toBe('Queued');}
  finally{for(const [key,value] of [['WOORI_SCHEDULER_ENABLED',old.enabled],['PAID_AI_API_ENABLED',old.paid],['AI_API_BUDGET_USD',old.budget],['AI_AUTO_EXECUTION',old.auto]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
 });
});
