import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { load } from 'cheerio';
import { config, finishRun, initDb, localeFor, saveChecks, saveFindings, saveAgentData, serviceFor, startRun, type Check, type Finding } from './core.js';

export type ScheduleAction = 'http-smoke' | 'seo-sample' | 'localization-content' | 'weekly-regression-summary';
export type ScheduleDefinition = { id: string; label: string; intervalMs: number; priority: number; action: ScheduleAction; enabled: boolean; timeoutMs: number; maxPages: number; catchUpGraceMs: number };
export type SchedulerStatus = 'Scheduled' | 'Queued' | 'Running' | 'Testing' | 'Completed' | 'Failed' | 'Skipped' | 'Blocked' | 'Awaiting Approval' | 'Recovery Required';
const SERVICES = new Set(['home', 'calculator', 'tools', 'docs', 'quiz']);
const DEFAULT_DB = () => path.resolve(process.env.WOORI_CONTROLLER_DB_PATH ?? 'data/controller/queue.sqlite');
const nowIso = () => new Date().toISOString();
const redact = (v: string) => v.replace(/(authorization|api[_ -]?key|token|secret|password)(\s*[:=]\s*)([^\s,;]+)/gi, '$1$2[REDACTED]').slice(0, 1000);
const schedulerInstanceId=`scheduler-${os.hostname().replace(/[^a-zA-Z0-9.-]/g,'').slice(0,32)||'local'}-${process.pid}-${randomUUID().slice(0,8)}`;

function open(dbPath = DEFAULT_DB()) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath, { timeout: 5000 });
  db.pragma('busy_timeout=5000'); db.pragma('journal_mode=WAL');
  if (process.platform === 'linux') fs.chmodSync(dbPath, 0o600);
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_jobs(schedule_id TEXT PRIMARY KEY,label TEXT NOT NULL,interval_ms INTEGER NOT NULL,priority INTEGER NOT NULL,action TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,timeout_ms INTEGER NOT NULL,max_pages INTEGER NOT NULL,catch_up_grace_ms INTEGER NOT NULL,next_run_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduler_runs(run_id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,scheduled_for TEXT NOT NULL,status TEXT NOT NULL,owner_id TEXT,lease_id TEXT,lease_expires_at TEXT,started_at TEXT,finished_at TEXT,exit_code INTEGER,summary TEXT,error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(schedule_id,scheduled_for));
    CREATE INDEX IF NOT EXISTS idx_scheduler_runs_status ON scheduler_runs(status,scheduled_for);
    CREATE TABLE IF NOT EXISTS scheduler_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_execution_events(id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL,schedule_id TEXT NOT NULL,agent TEXT NOT NULL,service TEXT NOT NULL,event TEXT NOT NULL,status TEXT NOT NULL,error_code TEXT,detail TEXT,occurred_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_agent_execution_events_time ON agent_execution_events(occurred_at DESC);
    CREATE TABLE IF NOT EXISTS worker_health_snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT,worker_id TEXT NOT NULL,os TEXT NOT NULL,state TEXT NOT NULL,cpu_count INTEGER NOT NULL,available_memory_bytes INTEGER NOT NULL,sandbox_status TEXT NOT NULL,current_job_id TEXT,recorded_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_worker_health_time ON worker_health_snapshots(recorded_at DESC);
    CREATE TABLE IF NOT EXISTS operator_notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,notification_key TEXT NOT NULL UNIQUE,severity TEXT NOT NULL,source TEXT NOT NULL,title TEXT NOT NULL,detail TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Open',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduler_service_controls(service TEXT PRIMARY KEY,auto_qa INTEGER NOT NULL,seo_checks INTEGER NOT NULL,adsense_checks INTEGER NOT NULL,localization_checks INTEGER NOT NULL,improvement_candidates INTEGER NOT NULL,codex_auto_fix INTEGER NOT NULL DEFAULT 0,pr_auto_create INTEGER NOT NULL DEFAULT 0,auto_merge INTEGER NOT NULL DEFAULT 0,auto_deploy INTEGER NOT NULL DEFAULT 0,auto_rollback INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
  `);
  return db;
}

export const defaultSchedules: ScheduleDefinition[] = [
  { id: 'hourly-http-smoke', label: 'Hourly read-only HTTP smoke', intervalMs: 60 * 60_000, priority: 100, action: 'http-smoke', enabled: true, timeoutMs: 180_000, maxPages: 5, catchUpGraceMs: 10 * 60_000 },
  { id: 'six-hour-seo-sample', label: 'Six-hour SEO metadata sample', intervalMs: 6 * 60 * 60_000, priority: 70, action: 'seo-sample', enabled: true, timeoutMs: 240_000, maxPages: 5, catchUpGraceMs: 30 * 60_000 },
  { id: 'daily-localization-content', label: 'Daily localization and content rules', intervalMs: 24 * 60 * 60_000, priority: 50, action: 'localization-content', enabled: true, timeoutMs: 360_000, maxPages: 10, catchUpGraceMs: 2 * 60 * 60_000 },
  { id: 'weekly-regression-summary', label: 'Weekly issue recurrence summary', intervalMs: 7 * 24 * 60 * 60_000, priority: 30, action: 'weekly-regression-summary', enabled: true, timeoutMs: 60_000, maxPages: 0, catchUpGraceMs: 12 * 60 * 60_000 },
];

export function initializeScheduler(dbPath?: string, definitions = defaultSchedules, now = new Date()) {
  for (const d of definitions) {
    if (!/^[a-z0-9-]{3,80}$/.test(d.id) || !Number.isInteger(d.intervalMs) || d.intervalMs < 60_000 || !Number.isInteger(d.maxPages) || d.maxPages < 0 || d.maxPages > 20 || d.timeoutMs < 5_000 || d.timeoutMs > 10 * 60_000) throw new Error('Invalid bounded scheduler definition.');
    if (!['http-smoke', 'seo-sample', 'localization-content', 'weekly-regression-summary'].includes(d.action)) throw new Error('Scheduler action is not allowlisted.');
  }
  const db = open(dbPath), put = db.prepare(`INSERT OR IGNORE INTO scheduler_jobs(schedule_id,label,interval_ms,priority,action,enabled,timeout_ms,max_pages,catch_up_grace_ms,next_run_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction((items: ScheduleDefinition[]) => items.forEach(d => put.run(d.id,d.label,d.intervalMs,d.priority,d.action,d.enabled?1:0,d.timeoutMs,d.maxPages,d.catchUpGraceMs,new Date(now.getTime()+d.intervalMs).toISOString(),now.toISOString())));
  tx(definitions); db.close(); return { initialized: definitions.length, schedulerEnabled: process.env.WOORI_SCHEDULER_ENABLED === 'true' };
}

export function initializeServiceControls(dbPath?:string) {
  const db=open(dbPath),put=db.prepare(`INSERT OR IGNORE INTO scheduler_service_controls(service,auto_qa,seo_checks,adsense_checks,localization_checks,improvement_candidates,updated_at) VALUES(?,1,1,0,1,1,?)`),now=nowIso();
  for(const service of SERVICES) put.run(service,now);
  const controls=db.prepare('SELECT service,auto_qa AS autoQa,seo_checks AS seo,adsense_checks AS adsense,localization_checks AS localization,improvement_candidates AS improvementCandidates,codex_auto_fix AS codexAutoFix,pr_auto_create AS prAutoCreate,auto_merge AS autoMerge,auto_deploy AS autoDeploy,auto_rollback AS autoRollback FROM scheduler_service_controls ORDER BY service').all();
  db.close();return controls;
}

export function updateSchedulerServiceControl(service:string,field:string,enabled:boolean,dbPath?:string) {
  if(!SERVICES.has(service)) throw new Error(service==='money'?'MoneyBook is excluded from scheduled automation.':'Service is not in the automation allowlist.');
  const columns:Record<string,string>={autoQa:'auto_qa',seo:'seo_checks',localization:'localization_checks',improvementCandidates:'improvement_candidates'};
  if(['codexAutoFix','prAutoCreate','adsense','autoMerge','autoDeploy','autoRollback'].includes(field)) throw new Error('This control is locked or Not Configured in Phase 10A-4.');
  const column=columns[field];if(!column)throw new Error('Unsupported scheduler control.');
  initializeServiceControls(dbPath);const db=open(dbPath);db.prepare(`UPDATE scheduler_service_controls SET ${column}=?,updated_at=? WHERE service=?`).run(enabled?1:0,nowIso(),service);db.close();
  return (initializeServiceControls(dbPath) as any[]).find(row=>row.service===service);
}

function appendEvent(db: Database.Database, input: { runId: string; scheduleId: string; agent: string; service: string; event: string; status: string; errorCode?: string | null; detail?: string }) {
  const eventKey = createHash('sha256').update([input.runId,input.event,input.service,input.status].join('|')).digest('hex');
  db.prepare(`INSERT OR IGNORE INTO agent_execution_events(event_key,run_id,schedule_id,agent,service,event,status,error_code,detail,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(eventKey,input.runId,input.scheduleId,input.agent,input.service,input.event,input.status,input.errorCode??null,input.detail?redact(input.detail):null,nowIso());
}

export function schedulerTick(dbPath?: string, now = new Date(), controllerId = schedulerInstanceId) {
  const db = open(dbPath); const tx = db.transaction(() => {
    const lock = db.prepare("SELECT value FROM scheduler_meta WHERE key='leader' ").get() as {value:string}|undefined;
    if (lock) { const value = JSON.parse(lock.value) as { owner: string; expiresAt: string }; if (Date.parse(value.expiresAt) > now.getTime() && value.owner !== controllerId) return { leader: false, queued: 0, skipped: 0 }; }
    db.prepare("INSERT INTO scheduler_meta(key,value) VALUES('leader',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({owner:controllerId,expiresAt:new Date(now.getTime()+10*60_000).toISOString()}));
    updateWorkerOfflineNotifications(db,now);
    const due = db.prepare('SELECT * FROM scheduler_jobs WHERE enabled=1 AND next_run_at<=? ORDER BY priority DESC,schedule_id LIMIT 20').all(now.toISOString()) as Array<{schedule_id:string;interval_ms:number;catch_up_grace_ms:number;next_run_at:string}>;
    let queued=0, skipped=0;
    for (const job of due) {
      const scheduledAt = new Date(job.next_run_at), lateBy = now.getTime()-scheduledAt.getTime();
      const status = lateBy > job.catch_up_grace_ms ? 'Skipped' : 'Queued';
      const runId = `sched-${createHash('sha256').update(`${job.schedule_id}|${scheduledAt.toISOString()}`).digest('hex').slice(0,32)}`;
      const inserted = db.prepare(`INSERT OR IGNORE INTO scheduler_runs(run_id,schedule_id,scheduled_for,status,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`).run(runId,job.schedule_id,scheduledAt.toISOString(),status,status==='Skipped'?'Catch-up window expired; backlog was not replayed.':null,nowIso(),nowIso());
      if (inserted.changes) { if(status==='Skipped') skipped++; else queued++; appendEvent(db,{runId,scheduleId:job.schedule_id,agent:'scheduler',service:'all',event:status==='Skipped'?'catch-up-skipped':'scheduled',status}); }
      db.prepare('UPDATE scheduler_jobs SET next_run_at=?,updated_at=? WHERE schedule_id=?').run(new Date(now.getTime()+job.interval_ms).toISOString(),nowIso(),job.schedule_id);
    }
    return { leader: true, queued, skipped };
  });
  try { const result=tx.immediate(); pruneSchedulerHistory(db); return result; } finally { db.close(); }
}

function updateWorkerOfflineNotifications(db:Database.Database,now:Date) {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='controller_workers'").get())return;
  const staleAfter=Number(process.env.WOORI_WORKER_OFFLINE_AFTER_MS??45_000);
  const workers=db.prepare("SELECT worker_id AS workerId,heartbeat_at AS heartbeatAt,state FROM controller_workers WHERE state<>'Disabled'").all() as Array<{workerId:string;heartbeatAt:string;state:string}>;
  for(const worker of workers) {
    const offline=now.getTime()-Date.parse(worker.heartbeatAt)>staleAfter,key=`worker-offline:${worker.workerId}`;
    if(offline) db.prepare(`INSERT INTO operator_notifications(notification_key,severity,source,title,detail,status,created_at,updated_at) VALUES(?,'Medium','worker','Worker Offline',?,'Open',?,?) ON CONFLICT(notification_key) DO UPDATE SET detail=excluded.detail,status='Open',updated_at=excluded.updated_at`).run(key,`No Worker heartbeat since ${worker.heartbeatAt}. A running process is not assumed terminated.`,now.toISOString(),now.toISOString());
    else db.prepare("UPDATE operator_notifications SET status='Resolved',detail='Worker heartbeat resumed.',updated_at=? WHERE notification_key=? AND status='Open'").run(now.toISOString(),key);
  }
}

function pruneSchedulerHistory(db: Database.Database) {
  db.prepare("DELETE FROM scheduler_runs WHERE status IN ('Completed','Failed','Skipped','Blocked','Recovery Required') AND julianday(finished_at)<julianday('now','-30 days')").run();
  db.prepare("DELETE FROM agent_execution_events WHERE id NOT IN (SELECT id FROM agent_execution_events ORDER BY id DESC LIMIT 20000) OR julianday(occurred_at)<julianday('now','-30 days')").run();
  db.prepare("DELETE FROM worker_health_snapshots WHERE id NOT IN (SELECT id FROM worker_health_snapshots ORDER BY id DESC LIMIT 10000) OR julianday(recorded_at)<julianday('now','-30 days')").run();
  db.prepare("DELETE FROM operator_notifications WHERE id NOT IN (SELECT id FROM operator_notifications ORDER BY id DESC LIMIT 1000) OR julianday(created_at)<julianday('now','-90 days')").run();
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='controller_nonces'").get()) db.prepare("DELETE FROM controller_nonces WHERE expires_at < ?").run(Date.now());
}

export function claimScheduledRun(dbPath?: string, workerId = `scheduler-${os.hostname().replace(/[^a-zA-Z0-9.-]/g,'').slice(0,40) || 'local'}`, now = new Date(), leaseMs = 10 * 60_000) {
  const db = open(dbPath); const tx = db.transaction(() => {
    const active = db.prepare("SELECT run_id,schedule_id,lease_expires_at FROM scheduler_runs WHERE status IN ('Running','Testing') LIMIT 1").get() as {run_id:string;schedule_id:string;lease_expires_at:string}|undefined;
    if (active) {
      if(Date.parse(active.lease_expires_at)<=now.getTime()) {
        db.prepare("UPDATE scheduler_runs SET status='Recovery Required',updated_at=?,error_code='RUNNER_LEASE_EXPIRED' WHERE run_id=? AND status IN ('Running','Testing')").run(now.toISOString(),active.run_id);
        appendEvent(db,{runId:active.run_id,scheduleId:active.schedule_id,agent:'scheduler',service:'all',event:'lease-expired-recovery-required',status:'Recovery Required',errorCode:'RUNNER_LEASE_EXPIRED'});
      }
      return null;
    }
    const run = db.prepare(`SELECT r.run_id AS runId,r.schedule_id AS scheduleId,r.scheduled_for AS scheduledFor,j.action,j.timeout_ms AS timeoutMs,j.max_pages AS maxPages
      FROM scheduler_runs r JOIN scheduler_jobs j USING(schedule_id) WHERE r.status='Queued' AND j.enabled=1 ORDER BY j.priority DESC,r.scheduled_for,r.run_id LIMIT 1`).get() as any;
    if (!run) return null;
    const leaseId=randomUUID(),expiresAt=new Date(now.getTime()+Math.min(Math.max(leaseMs,15_000),10*60_000)).toISOString();
    const changed=db.prepare("UPDATE scheduler_runs SET status='Running',owner_id=?,lease_id=?,lease_expires_at=?,started_at=?,updated_at=? WHERE run_id=? AND status='Queued'").run(workerId,leaseId,expiresAt,now.toISOString(),now.toISOString(),run.runId);
    if (!changed.changes) return null;
    appendEvent(db,{runId:run.runId,scheduleId:run.scheduleId,agent:run.action,service:'all',event:'started',status:'Running'});
    return {...run,workerId,leaseId,expiresAt};
  });
  try { return tx.immediate(); } finally { db.close(); }
}

function readOnlyRoutes(action: ScheduleAction, maxPages: number, scheduledFor:string, dbPath?:string) {
  const controls=new Map((initializeServiceControls(dbPath) as any[]).map(row=>[row.service,row]));
  const services=config.services.filter(service=>SERVICES.has(service.id) && (action==='http-smoke'?controls.get(service.id)?.autoQa:action==='seo-sample'?controls.get(service.id)?.seo:Boolean(controls.get(service.id)?.localization || controls.get(service.id)?.improvementCandidates)));
  const urls:string[]=[];
  for(const service of services) {
    const routes=service.qaPaths??[];
    if(action==='http-smoke') { if(routes[0]) urls.push(safeTarget(routes[0])); }
    else if(action==='seo-sample') { for(const route of routes.slice(0,Math.min(1,maxPages))) urls.push(safeTarget(route)); }
    else if(action==='localization-content') {
      const local=initDb();const discovered=local.prepare("SELECT url,locale FROM discovered_urls WHERE service=? AND source='sitemap' AND locale<>'unknown' ORDER BY locale,url").all(service.id) as Array<{url:string;locale:string}>;local.close();
      if(discovered.length){const locales=[...new Set(discovered.map(row=>row.locale))].sort(),day=Math.floor(Date.parse(scheduledFor)/86_400_000),locale=locales[day%locales.length]!,pages=discovered.filter(row=>row.locale===locale),page=pages[day%pages.length]!;urls.push(safeTarget(page.url));}
      else if(service.qaPaths?.[0]) urls.push(safeTarget(service.qaPaths[0]));
    }
  }
  return urls.filter(Boolean).slice(0,maxPages);
}

function safeTarget(route:string) {
  const base=new URL(config.baseUrl),url=new URL(route,base);
  if(base.protocol!=='https:'||url.protocol!=='https:'||url.origin!==base.origin||url.username||url.password) return '';
  return url.href;
}

async function fetchScheduledPage(initialUrl:string):Promise<{check:Check;durationMs:number}> {
  const started=Date.now();
  const check:Check={url:initialUrl,service:serviceFor(initialUrl).id,locale:localeFor(initialUrl),status:null,hreflangCount:0,h1Count:0,links:[],errors:[]};
  let current=initialUrl;
  try {
    for(let redirects=0;redirects<=3;redirects++) {
      const response=await fetch(current,{redirect:'manual',signal:AbortSignal.timeout(12_000),headers:{'user-agent':'WooriSiteIntelligence/0.1 (read-only quality monitoring)'}});check.status=response.status;
      if([301,302,303,307,308].includes(response.status)) {
        if(redirects===3){check.errors.push('redirect_limit');break;}
        const location=response.headers.get('location');if(!location){check.errors.push('redirect_without_location');break;}
        const next=new URL(location,current);if(next.protocol!=='https:'||next.origin!==new URL(config.baseUrl).origin){check.errors.push('external_redirect_blocked');break;}
        current=next.href;continue;
      }
      if(!(response.headers.get('content-type')??'').includes('text/html'))break;
      const $=load(await response.text());check.title=$('title').first().text().trim()||undefined;check.description=$('meta[name="description"]').attr('content')?.trim();check.canonical=$('link[rel="canonical"]').attr('href');check.htmlLang=$('html').attr('lang');check.hreflangCount=$('link[rel="alternate"][hreflang]').length;check.h1Count=$('h1').length;
      check.links=[...new Set($('a[href]').toArray().map(a=>$(a).attr('href')).filter((href):href is string=>Boolean(href)).map(href=>{try{return new URL(href,current).href}catch{return ''}}).filter(href=>href.startsWith(new URL(config.baseUrl).origin)))];break;
    }
  } catch(error) {check.errors.push(error instanceof Error?error.message:'request_failed');}
  return {check,durationMs:Date.now()-started};
}

async function executeAction(run: {runId:string;scheduleId:string;scheduledFor:string;action:ScheduleAction;maxPages:number;timeoutMs:number;startedAt:string}, dbPath?:string) {
  const runId=run.runId;
  if (process.platform==='linux' && os.freemem()<384*1024*1024) throw Object.assign(new Error('Available memory is below the read-only scheduler floor.'),{code:'MEMORY_FLOOR'});
  if (run.action==='weekly-regression-summary') {
    const db=initDb();
    const issues=db.prepare("SELECT service,state,severity,COUNT(*) AS count FROM issue_registry WHERE last_seen>=datetime('now','-7 days') GROUP BY service,state,severity ORDER BY service,state,severity").all();
    const total=db.prepare("SELECT COUNT(*) AS count FROM issue_registry WHERE state IN ('New','Recurred','Suspected','Known Issue')").get() as {count:number}; db.close();
    saveAgentData(runId,'change','Completed','Scheduler weekly stored issue summary',{window:'last 7 days',issues,openIssueCount:total.count,competitorStatus:'Not Configured: automatic competitor collection requires a separately approved target.'});
    return {status:'Completed',summary:`Stored issue recurrence summary; ${issues.length} grouped rows. Competitor collection was not run.`};
  }
  const urls=readOnlyRoutes(run.action,run.maxPages,run.scheduledFor,dbPath), checks:Check[]=[], findings:Finding[]=[];
  if(!urls.length) return {status:'Skipped',summary:'No enabled read-only service controls produced eligible URLs.'};
  startRun(runId,`scheduled:${run.action}`,urls.length);
  let stoppedForLatency=false;
  try {
    for(let i=0;i<urls.length;i++) {
      if(Date.now()-Date.parse(run.startedAt??nowIso())>run.timeoutMs) throw Object.assign(new Error('Scheduled read-only action exceeded its time limit.'),{code:'SCHEDULE_TIMEOUT'});
      const result=await fetchScheduledPage(urls[i]!),check=result.check;
      check.service=serviceFor(check.url).id;
      checks.push(check);
      const make=(severity:Finding['severity'],title:string,description:string,evidence?:string)=>findings.push({id:`${runId}-f${findings.length+1}`,service:check.service,url:check.url,locale:check.locale,agent:run.action==='http-smoke'?'qa':run.action==='seo-sample'?'seo':'localization',severity,status:'confirmed',title,description,evidence});
      if(check.status===null || check.status>=500) make('Critical','Scheduled route unavailable',check.errors.join('; ')||`HTTP ${check.status}`,String(check.status));
      else if(check.status>=400) make('High','Scheduled route returned an error',`HTTP ${check.status}`,String(check.status));
      if(run.action!=='http-smoke' && check.status!==null && check.status<400) {
        if(!check.title) make('Medium','Missing page title','The sampled public page did not expose a document title.');
        if(!check.description) make('Low','Missing description','The sampled public page did not expose a meta description.');
        if(run.action==='localization-content' && (!check.htmlLang || check.locale!=='unknown'&&!check.htmlLang.toLowerCase().startsWith(check.locale))) make('Medium','Locale metadata requires review',`Route locale ${check.locale}; document lang ${check.htmlLang??'missing'}.`);
        if(run.action==='localization-content' && !check.h1Count) make('Low','Content structure requires review','The sampled page has no H1; this is a rule-based review candidate, not an AdSense decision.');
      }
      if(result.durationMs>=8_000&&i<urls.length-1){stoppedForLatency=true;make('Medium','Sampling stopped after a slow response',`The read-only request took ${result.durationMs} ms; remaining routes were left Not Covered to reduce load.`);break;}
      if(i<urls.length-1) await new Promise(resolve=>setTimeout(resolve,1000));
    }
    const failed=findings.some(f=>f.severity==='Critical'),status=failed?'Failed':stoppedForLatency?'Blocked':'Completed';
    saveChecks(runId,checks); saveFindings(runId,findings); finishRun(runId,status,checks.length,findings.length,Math.max(0,urls.length-checks.length));
    return {status,summary:`Checked ${checks.length} read-only public routes; ${findings.length} rule-based findings${stoppedForLatency?'; remaining sample stopped after a slow response':''}. Browser JS, axe, Lighthouse and functional flows were not run.`};
  } catch(error) { saveChecks(runId,checks); saveFindings(runId,findings); finishRun(runId,'Failed',checks.length,findings.length,Math.max(0,urls.length-checks.length)); throw error; }
}

export async function runOneScheduledAction(dbPath?:string, workerId?:string) {
  if(process.env.WOORI_SCHEDULER_ENABLED!=='true'||process.env.PAID_AI_API_ENABLED!=='false'||process.env.AI_API_BUDGET_USD!=='0'||process.env.AI_AUTO_EXECUTION!=='false') throw new Error('Scheduled execution requires global opt-in and the explicit zero-cost AI policy.');
  if(!controllerIsAlive(dbPath)) throw new Error('Central Controller heartbeat is absent or stale; no offline scheduling or execution is allowed.');
  const lease=claimScheduledRun(dbPath,workerId); if(!lease) return {status:'Idle' as const};
  const startedAt=nowIso();
  try {
    const result=await executeAction({...lease,startedAt},dbPath);
    finishScheduledRun(lease.runId,lease.leaseId,result.status,result.summary,undefined,dbPath);
    return {...result,runId:lease.runId};
  } catch(error) {
    const code=error&&typeof error==='object'&&'code'in error?String((error as {code:unknown}).code):'SCHEDULE_ACTION_FAILED';
    try{finishScheduledRun(lease.runId,lease.leaseId,'Failed',undefined,/^[A-Z0-9_.-]{1,64}$/.test(code)?code:'SCHEDULE_ACTION_FAILED',dbPath);return {status:'Failed' as const,runId:lease.runId,errorCode:code};}
    catch{return {status:'Recovery Required' as const,runId:lease.runId,errorCode:'STALE_SCHEDULER_LEASE'};}
  }
}

export function finishScheduledRun(runId:string,leaseId:string,status:string,summary?:string,errorCode?:string,dbPath?:string) {
  if(!['Completed','Failed','Blocked','Skipped'].includes(status)) throw new Error('Unsupported scheduler completion state.');
  const db=open(dbPath); const tx=db.transaction(()=>{
    const row=db.prepare('SELECT schedule_id AS scheduleId,owner_id AS ownerId,status,lease_expires_at AS expiresAt FROM scheduler_runs WHERE run_id=? AND lease_id=?').get(runId,leaseId) as any;
    if(!row || row.status!=='Running' || Date.parse(row.expiresAt)<=Date.now()) throw new Error('Stale scheduler lease rejected.');
    db.prepare('UPDATE scheduler_runs SET status=?,finished_at=?,exit_code=?,summary=?,error_code=?,updated_at=? WHERE run_id=? AND lease_id=?').run(status,nowIso(),status==='Completed'?0:1,summary?redact(summary):null,errorCode??null,nowIso(),runId,leaseId);
    appendEvent(db,{runId,scheduleId:row.scheduleId,agent:'scheduler',service:'all',event:`finished-${status.toLowerCase()}`,status,errorCode,detail:summary});
    if(status==='Failed') db.prepare(`INSERT INTO operator_notifications(notification_key,severity,source,title,detail,status,created_at,updated_at) VALUES(?,?,?,?,?,'Open',?,?) ON CONFLICT(notification_key) DO UPDATE SET detail=excluded.detail,updated_at=excluded.updated_at`).run(`scheduler:${runId}`,'High','scheduler','Scheduled check failed',errorCode??'See run history.',nowIso(),nowIso());
  });
  try{tx.immediate();}finally{db.close();}
}

export function recoverScheduledRun(input:{runId:string;processTerminated:boolean;verifiedBy:string;evidence:string},dbPath?:string) {
  if(!input.processTerminated||input.verifiedBy.trim().length<3||input.evidence.trim().length<8)throw new Error('Recovery requires operator-verified process termination and bounded evidence.');
  const db=open(dbPath);const tx=db.transaction(()=>{
    const run=db.prepare("SELECT schedule_id AS scheduleId,status FROM scheduler_runs WHERE run_id=?").get(input.runId) as {scheduleId:string;status:string}|undefined;
    if(!run||run.status!=='Recovery Required')throw new Error('Only an expired Recovery Required scheduler run can be recovered.');
    db.prepare("UPDATE scheduler_runs SET status='Failed',finished_at=?,error_code='OPERATOR_RECOVERED_AFTER_TERMINATION',summary=?,updated_at=? WHERE run_id=?").run(nowIso(),`Stopped after verified process termination by ${redact(input.verifiedBy)}. Evidence: ${redact(input.evidence)}`,nowIso(),input.runId);
    appendEvent(db,{runId:input.runId,scheduleId:run.scheduleId,agent:'scheduler',service:'all',event:'operator-recovered-after-process-termination',status:'Failed',errorCode:'OPERATOR_RECOVERED_AFTER_TERMINATION',detail:input.evidence});
  });try{tx.immediate();}finally{db.close();}return {runId:input.runId,status:'Failed',recovered:true};
}

export function schedulerSnapshot(dbPath?:string,afterEventId=0) {
  const db=open(dbPath), jobs=db.prepare('SELECT schedule_id AS id,label,action,interval_ms AS intervalMs,priority,enabled,max_pages AS maxPages,next_run_at AS nextRunAt,updated_at AS updatedAt FROM scheduler_jobs ORDER BY priority DESC').all();
  const runs=db.prepare('SELECT run_id AS runId,schedule_id AS scheduleId,scheduled_for AS scheduledFor,status,owner_id AS ownerId,started_at AS startedAt,finished_at AS finishedAt,summary,error_code AS errorCode,updated_at AS updatedAt FROM scheduler_runs ORDER BY created_at DESC LIMIT 100').all();
  const eventRows=afterEventId>0?db.prepare('SELECT id,run_id AS runId,schedule_id AS scheduleId,agent,service,event,status,error_code AS errorCode,detail,occurred_at AS occurredAt FROM agent_execution_events WHERE id>? ORDER BY id ASC LIMIT 501').all(afterEventId):db.prepare('SELECT id,run_id AS runId,schedule_id AS scheduleId,agent,service,event,status,error_code AS errorCode,detail,occurred_at AS occurredAt FROM agent_execution_events ORDER BY id DESC LIMIT 100').all();
  const events=afterEventId>0?eventRows.slice(0,500):eventRows.reverse();
  const eventsTruncated=afterEventId>0&&eventRows.length>500;
  const eventCursor=(events.length?(events[events.length-1] as any).id:afterEventId) as number;
  const hasWorkers=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='controller_workers'").get());
  const workers=hasWorkers?(db.prepare('SELECT worker_id AS workerId,os,state,cpu_count AS cpuCount,available_memory_bytes AS availableMemoryBytes,sandbox_status AS sandboxStatus,current_job_id AS currentJobId,heartbeat_at AS heartbeatAt FROM controller_workers ORDER BY worker_id').all() as any[]):[];
  const snapshots=db.prepare('SELECT worker_id AS workerId,os,state,cpu_count AS cpuCount,available_memory_bytes AS availableMemoryBytes,sandbox_status AS sandboxStatus,current_job_id AS currentJobId,recorded_at AS recordedAt FROM worker_health_snapshots ORDER BY recorded_at DESC LIMIT 100').all();
  const notifications=db.prepare("SELECT id,severity,source,title,detail,status,created_at AS createdAt FROM operator_notifications WHERE status='Open' ORDER BY id DESC LIMIT 100").all();
  const dbLeader=db.prepare("SELECT value FROM scheduler_meta WHERE key='leader'").get() as {value:string}|undefined;
  const controllerMeta=db.prepare("SELECT value FROM scheduler_meta WHERE key='controller'").get() as {value:string}|undefined;
  db.close(); let leader:any=null,controller:any=null; try{leader=dbLeader?JSON.parse(dbLeader.value):null;}catch{/* invalid legacy metadata remains unknown */} try{controller=controllerMeta?JSON.parse(controllerMeta.value):null;}catch{/* invalid legacy metadata remains unknown */}
  const timeout=Number(process.env.WOORI_WORKER_OFFLINE_AFTER_MS??45_000),now=Date.now();
  const liveWorkers=workers.map(worker=>({...worker,state:now-Date.parse(worker.heartbeatAt)>timeout?'Offline':worker.state}));
  return {observedAt:nowIso(),controller:controller&&now-Date.parse(controller.heartbeatAt)<45_000?{status:'Online',instanceId:controller.instanceId,heartbeatAt:controller.heartbeatAt}: {status:'Offline',reason:'No recent Controller process heartbeat.'},scheduler:leader&&Date.parse(leader.expiresAt)>now?{status:'Online',ownerId:leader.owner,leaseExpiresAt:leader.expiresAt}:{status:process.env.WOORI_SCHEDULER_ENABLED==='true'?'Idle':'Disabled'},schedulerEnabled:process.env.WOORI_SCHEDULER_ENABLED==='true',schedules:jobs,runs,events,eventsTruncated,eventCursor,workers:liveWorkers,healthSnapshots:snapshots,notifications,serviceControls:initializeServiceControls(dbPath),counts:{queued:runs.filter((x:any)=>x.status==='Queued').length,running:runs.filter((x:any)=>x.status==='Running').length,completed:runs.filter((x:any)=>x.status==='Completed').length,failed:runs.filter((x:any)=>x.status==='Failed').length,openNotifications:notifications.length},linuxCodeModification:'Blocked',codexAutomation:'Disabled by Phase 10A-4 policy',merge:'OFF',deployment:'OFF'};
}

export function recordControllerHeartbeat(state:'Online'|'Offline',instanceId:string,dbPath?:string) {
  const db=open(dbPath);const value=state==='Online'?{status:state,instanceId,heartbeatAt:nowIso()}:{status:state,instanceId,heartbeatAt:nowIso()};
  db.prepare("INSERT INTO scheduler_meta(key,value) VALUES('controller',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));db.close();
}

function controllerIsAlive(dbPath?:string,now=new Date()) {
  const db=open(dbPath),row=db.prepare("SELECT value FROM scheduler_meta WHERE key='controller'").get() as {value:string}|undefined;db.close();
  if(!row)return false;
  try{const status=JSON.parse(row.value) as {status?:string;heartbeatAt?:string};return status.status==='Online'&&Boolean(status.heartbeatAt)&&now.getTime()-Date.parse(status.heartbeatAt!)<45_000;}catch{return false;}
}

function releaseSchedulerLeadership(dbPath?:string,owner=schedulerInstanceId) {
  const db=open(dbPath);const row=db.prepare("SELECT value FROM scheduler_meta WHERE key='leader'").get() as {value:string}|undefined;
  try{if(row&&JSON.parse(row.value).owner===owner)db.prepare("UPDATE scheduler_meta SET value=? WHERE key='leader'").run(JSON.stringify({owner,expiresAt:nowIso()}));}catch{/* keep leadership unknown if metadata is invalid */}db.close();
}

export async function runSchedulerDaemon(options:{dbPath?:string;intervalMs?:number;workerId?:string;signal?:AbortSignal}={}) {
  if(process.env.WOORI_SCHEDULER_ENABLED!=='true') throw new Error('Scheduler is disabled. Set WOORI_SCHEDULER_ENABLED=true after reviewing local/systemd configuration.');
  if(process.env.PAID_AI_API_ENABLED!=='false'||process.env.AI_API_BUDGET_USD!=='0'||process.env.AI_AUTO_EXECUTION!=='false') throw new Error('Scheduler requires the explicit zero-cost AI policy environment.');
  initializeScheduler(options.dbPath);
  const interval=Math.min(60_000,Math.max(5_000,options.intervalMs??15_000));
  try{while(!options.signal?.aborted) {
    if(!controllerIsAlive(options.dbPath)){await new Promise<void>(resolve=>setTimeout(resolve,interval));continue;}
    const tick=schedulerTick(options.dbPath, new Date(),schedulerInstanceId);
    if(tick.leader) await runOneScheduledAction(options.dbPath,options.workerId??schedulerInstanceId);
    await new Promise<void>(resolve=>{const timer=setTimeout(resolve,interval);options.signal?.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
  }}finally{releaseSchedulerLeadership(options.dbPath,schedulerInstanceId);}
}

export function recordWorkerHealthSnapshots(dbPath?:string, now=new Date()) {
  const db=open(dbPath); const workers=db.prepare('SELECT worker_id,os,state,cpu_count,available_memory_bytes,sandbox_status,current_job_id,heartbeat_at FROM controller_workers').all() as any[];
  const insert=db.prepare('INSERT INTO worker_health_snapshots(worker_id,os,state,cpu_count,available_memory_bytes,sandbox_status,current_job_id,recorded_at) VALUES(?,?,?,?,?,?,?,?)');
  const tx=db.transaction((rows:any[])=>{for(const w of rows){const last=db.prepare('SELECT recorded_at FROM worker_health_snapshots WHERE worker_id=? ORDER BY recorded_at DESC LIMIT 1').get(w.worker_id) as {recorded_at:string}|undefined;if(!last||now.getTime()-Date.parse(last.recorded_at)>=5*60_000)insert.run(w.worker_id,w.os,w.state,w.cpu_count,w.available_memory_bytes,w.sandbox_status,w.current_job_id,now.toISOString());}});
  tx(workers);pruneSchedulerHistory(db);db.close();return workers.length;
}
