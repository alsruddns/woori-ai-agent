import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type WorkerOs = 'windows' | 'linux';
export type ControllerWorkerPolicy = { os: WorkerOs; allowCodeChanges: boolean };
export type WorkerState = 'Online' | 'Idle' | 'Busy' | 'Degraded' | 'Offline' | 'Disabled';
export type WorkClass = 'analysis' | 'code_change';
export type ControllerWorkerInput = {
  workerId: string; os: WorkerOs; hostLabel: string; capabilities: string[];
  codexCliStatus: string; chatgptLoginStatus: string; sandboxStatus: string;
  cpuCount: number; availableMemoryBytes: number; currentJobId?: string | null;
  executionStatus: string; lastErrorCode?: string | null;
};
export type ControllerJobInput = {
  localTaskId?: string; service: string; kind: string; workClass: WorkClass;
  idempotencyKey: string; title: string; evidence?: string; requiredOs?: WorkerOs | 'any';
  resourceKeys?: string[];
};
export type Lease = { jobId: string; workerId: string; leaseId: string; fencingToken: number; expiresAt: string; status: string;policyVersion:number|null };

const SERVICES = new Set(['home', 'calculator', 'tools', 'docs', 'quiz']);
const ACTIVE = ['Claimed', 'Running', 'Testing'] as const;
const MIN_WORKER_MEMORY_BYTES = 256 * 1024 * 1024;
const MIN_CODE_CHANGE_MEMORY_BYTES = 1024 * 1024 * 1024;
const nowIso = () => new Date().toISOString();
const defaultDbPath = () => path.resolve(process.env.WOORI_CONTROLLER_DB_PATH ?? 'data/controller/queue.sqlite');
const redactText = (value: string) => value.replace(/(authorization|api[_ -]?key|token|secret|password)(\s*[:=]\s*)([^\s,;]+)/gi, '$1$2[REDACTED]');

function openControllerDb(dbPath = defaultDbPath()) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath, { timeout: 5_000 });
  if (process.platform === 'linux') fs.chmodSync(dbPath, 0o600);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS controller_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT OR IGNORE INTO controller_meta(key,value) VALUES('fencing_counter','0');
    CREATE TABLE IF NOT EXISTS controller_workers(
      worker_id TEXT PRIMARY KEY, os TEXT NOT NULL, host_label TEXT NOT NULL, capabilities TEXT NOT NULL,
      codex_cli_status TEXT NOT NULL, chatgpt_login_status TEXT NOT NULL, sandbox_status TEXT NOT NULL,
      cpu_count INTEGER NOT NULL, available_memory_bytes INTEGER NOT NULL, heartbeat_at TEXT NOT NULL,
      current_job_id TEXT, execution_status TEXT NOT NULL, last_error_code TEXT, allow_code_changes INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS controller_jobs(
      global_job_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, local_task_id TEXT,
      service TEXT NOT NULL, kind TEXT NOT NULL, work_class TEXT NOT NULL, required_os TEXT NOT NULL,
      resource_keys TEXT NOT NULL, title TEXT NOT NULL, evidence TEXT, status TEXT NOT NULL,
      worker_id TEXT, lease_id TEXT, fencing_token INTEGER, acquired_at TEXT, expires_at TEXT,
      last_renewed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result_json TEXT,
      failure_code TEXT, project_lock_version INTEGER, policy_version INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_controller_jobs_claim ON controller_jobs(status,created_at);
    CREATE INDEX IF NOT EXISTS idx_controller_jobs_worker ON controller_jobs(worker_id,status);
    CREATE TABLE IF NOT EXISTS controller_events(
      id INTEGER PRIMARY KEY, global_job_id TEXT, worker_id TEXT, event TEXT NOT NULL,
      fencing_token INTEGER, detail TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS controller_nonces(
      worker_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY(worker_id,nonce)
    );
  `);
  const workerColumns = db.prepare('PRAGMA table_info(controller_workers)').all() as Array<{ name: string }>;
  if (!workerColumns.some(column => column.name === 'allow_code_changes')) db.exec('ALTER TABLE controller_workers ADD COLUMN allow_code_changes INTEGER NOT NULL DEFAULT 0');
  const jobColumns = db.prepare('PRAGMA table_info(controller_jobs)').all() as Array<{ name: string }>;
  if (!jobColumns.some(column => column.name === 'project_lock_version')) db.exec('ALTER TABLE controller_jobs ADD COLUMN project_lock_version INTEGER');
  if (!jobColumns.some(column => column.name === 'policy_version')) db.exec('ALTER TABLE controller_jobs ADD COLUMN policy_version INTEGER');
  return db;
}

function assertProjectLockVersion(db: Database.Database, job: { work_class?: string; service?: string; project_lock_version?: number | null }) {
  if (job.work_class !== 'code_change') return;
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_lock_meta'").get();
  if (!table) throw new Error('PROJECT_LOCK_UNVERIFIED');
  const current = (db.prepare('SELECT version FROM project_lock_meta WHERE id=1').get() as { version: number } | undefined)?.version;
  if (!current || job.project_lock_version !== current) throw new Error(`PROJECT_LOCK_VERSION_STALE:${current ?? 'Unknown'}`);
  const saved = db.prepare('SELECT state FROM project_development_locks WHERE project_id=?').get(job.service) as { state: string } | undefined;
  if (saved && saved.state !== 'AVAILABLE') throw new Error(`PROJECT_LOCKED:${job.service}`);
}

function validateWorkerInput(input: ControllerWorkerInput) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,100}$/.test(input.workerId)) throw new Error('Invalid Worker ID.');
  if (!['windows', 'linux'].includes(input.os)) throw new Error('Unsupported Worker OS.');
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(input.hostLabel) || input.hostLabel.includes('@')) throw new Error('Use a non-identifying host label; account names and email addresses are not accepted.');
  if (!Array.isArray(input.capabilities) || input.capabilities.length > 40 || input.capabilities.some(value => !['http', 'qa', 'seo', 'content', 'github-read', 'codex-write', 'build', 'lighthouse', 'playwright'].includes(value))) throw new Error('Worker capability is not in the allowlist.');
  if (!Number.isInteger(input.cpuCount) || input.cpuCount < 1 || input.cpuCount > 1024 || !Number.isSafeInteger(input.availableMemoryBytes) || input.availableMemoryBytes < 0) throw new Error('Invalid resource telemetry.');
  if (input.currentJobId != null && !/^job-[a-f0-9-]{36}$/i.test(input.currentJobId)) throw new Error('Invalid current job ID.');
  if (!['Registered', 'Idle', 'Claimed', 'Running', 'Testing', 'Completed', 'Failed', 'RecoveryRequired', 'Disabled'].includes(input.executionStatus)) throw new Error('Unsupported Worker execution status.');
  if (input.lastErrorCode && !/^[A-Z0-9_.-]{1,64}$/i.test(input.lastErrorCode)) throw new Error('lastErrorCode must be a non-sensitive machine code.');
  const valid = (value: string, allowed: string[]) => allowed.includes(value);
  if (!valid(input.codexCliStatus, ['Ready', 'Not Configured', 'Blocked']) || !valid(input.chatgptLoginStatus, ['ChatGPT', 'API Key', 'Unknown', 'Not Configured']) || !valid(input.sandboxStatus, ['Ready', 'Not Configured', 'Blocked', 'Unsupported'])) throw new Error('Worker readiness fields contain an unsupported status.');
}

function event(db: Database.Database, jobId: string | null, workerId: string | null, name: string, fencingToken: number | null, detail?: unknown) {
  db.prepare('INSERT INTO controller_events(global_job_id,worker_id,event,fencing_token,detail,created_at) VALUES(?,?,?,?,?,?)')
    .run(jobId, workerId, name, fencingToken, detail === undefined ? null : JSON.stringify(detail), nowIso());
}

function validateWorkerPolicy(input: ControllerWorkerInput, policy: ControllerWorkerPolicy) {
  if (!policy || !['windows', 'linux'].includes(policy.os) || typeof policy.allowCodeChanges !== 'boolean') throw new Error('Controller-side Worker policy is required.');
  if (policy.os !== input.os) throw new Error('Worker OS does not match the Controller provisioned policy.');
  if (policy.allowCodeChanges && policy.os !== 'windows') throw new Error('Linux code modification is disabled by policy.');
}

export function registerControllerWorker(input: ControllerWorkerInput, dbPath?: string, policy: ControllerWorkerPolicy = { os: input.os, allowCodeChanges: false }) {
  validateWorkerInput(input);
  validateWorkerPolicy(input, policy);
  const db = openControllerDb(dbPath);
  const tx = db.transaction(() => {
    const active = db.prepare("SELECT global_job_id FROM controller_jobs WHERE worker_id=? AND status IN ('Claimed','Running','Testing') LIMIT 1").get(input.workerId) as { global_job_id: string } | undefined;
    if (active && input.currentJobId !== active.global_job_id) throw new Error('Worker registration cannot clear an active job lease.');
    const stamp = nowIso();
    const degraded = input.availableMemoryBytes < MIN_WORKER_MEMORY_BYTES || input.sandboxStatus !== 'Ready' || (input.os === 'windows' && (input.chatgptLoginStatus !== 'ChatGPT' || input.codexCliStatus !== 'Ready'));
    const state: WorkerState = active || input.currentJobId ? 'Busy' : degraded ? 'Degraded' : 'Idle';
    db.prepare(`INSERT INTO controller_workers(worker_id,os,host_label,capabilities,codex_cli_status,chatgpt_login_status,sandbox_status,cpu_count,available_memory_bytes,heartbeat_at,current_job_id,execution_status,last_error_code,allow_code_changes,state,updated_at)
    VALUES(@workerId,@os,@hostLabel,@capabilities,@codexCliStatus,@chatgptLoginStatus,@sandboxStatus,@cpuCount,@availableMemoryBytes,@heartbeatAt,@currentJobId,@executionStatus,@lastErrorCode,@allowCodeChanges,@state,@updatedAt)
    ON CONFLICT(worker_id) DO UPDATE SET os=excluded.os,host_label=excluded.host_label,capabilities=excluded.capabilities,codex_cli_status=excluded.codex_cli_status,chatgpt_login_status=excluded.chatgpt_login_status,sandbox_status=excluded.sandbox_status,cpu_count=excluded.cpu_count,available_memory_bytes=excluded.available_memory_bytes,heartbeat_at=excluded.heartbeat_at,current_job_id=excluded.current_job_id,execution_status=excluded.execution_status,last_error_code=excluded.last_error_code,allow_code_changes=excluded.allow_code_changes,state=excluded.state,updated_at=excluded.updated_at`)
      .run({ ...input, capabilities: JSON.stringify([...new Set(input.capabilities)].slice(0, 40)), heartbeatAt: stamp, currentJobId: active?.global_job_id ?? input.currentJobId ?? null, lastErrorCode: input.lastErrorCode ?? null, allowCodeChanges: policy.allowCodeChanges ? 1 : 0, state, updatedAt: stamp });
    return { workerId: input.workerId, state, heartbeatAt: stamp };
  });
  try { return tx.immediate(); } finally { db.close(); }
}

export function heartbeatControllerWorker(input: ControllerWorkerInput, dbPath?: string, policy: ControllerWorkerPolicy = { os: input.os, allowCodeChanges: false }) {
  validateWorkerInput(input);
  validateWorkerPolicy(input, policy);
  const db = openControllerDb(dbPath); const current = db.prepare('SELECT worker_id FROM controller_workers WHERE worker_id=?').get(input.workerId);
  if (!current) { db.close(); throw new Error('Worker is not registered.'); }
  const active = db.prepare("SELECT global_job_id FROM controller_jobs WHERE worker_id=? AND status IN ('Claimed','Running','Testing') LIMIT 1").get(input.workerId) as { global_job_id: string } | undefined;
  if (active && input.currentJobId !== active.global_job_id) { db.close(); throw new Error('Worker heartbeat cannot clear or change an active job lease.'); }
  const stamp = nowIso();
  const degraded = input.availableMemoryBytes < MIN_WORKER_MEMORY_BYTES || input.sandboxStatus !== 'Ready' || (input.os === 'windows' && (input.chatgptLoginStatus !== 'ChatGPT' || input.codexCliStatus !== 'Ready'));
  const state: WorkerState = input.currentJobId ? 'Busy' : degraded ? 'Degraded' : 'Idle';
  db.prepare(`UPDATE controller_workers SET os=?,host_label=?,capabilities=?,codex_cli_status=?,chatgpt_login_status=?,sandbox_status=?,cpu_count=?,available_memory_bytes=?,heartbeat_at=?,current_job_id=?,execution_status=?,last_error_code=?,allow_code_changes=?,state=?,updated_at=? WHERE worker_id=?`)
    .run(input.os, input.hostLabel, JSON.stringify([...new Set(input.capabilities)].slice(0, 40)), input.codexCliStatus, input.chatgptLoginStatus, input.sandboxStatus, input.cpuCount, input.availableMemoryBytes, stamp, input.currentJobId ?? null, input.executionStatus, input.lastErrorCode ?? null, policy.allowCodeChanges ? 1 : 0, state, stamp, input.workerId);
  db.close(); return { workerId: input.workerId, state, heartbeatAt: stamp };
}

export function submitControllerJob(input: ControllerJobInput, dbPath?: string) {
  if (!SERVICES.has(input.service)) throw new Error(input.service === 'money' ? 'MoneyBook is excluded from distributed development.' : 'Service is not in the development allowlist.');
  if (!['analysis', 'code_change'].includes(input.workClass)) throw new Error('Unsupported work class.');
  if (input.workClass === 'code_change' && input.service === 'calculator') throw new Error('Calculator code changes are locked during multilingual development.');
  if (input.workClass === 'code_change' && input.requiredOs === 'linux') throw new Error('Linux code modification is disabled until sandbox verification is complete.');
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200 || !input.title.trim() || input.title.length > 300) throw new Error('A bounded idempotency key and title are required.');
  if (!['any', 'windows', 'linux'].includes(input.requiredOs ?? 'any')) throw new Error('Unsupported required Worker OS.');
  if ((input.resourceKeys ?? []).some(key => key.length > 200 || !/^[A-Za-z0-9:._/*-]+$/.test(key))) throw new Error('Resource lock keys must be bounded identifiers.');
  const db = openControllerDb(dbPath); const stamp = nowIso();
  const globalJobId = `job-${randomUUID()}`;
  db.prepare(`INSERT OR IGNORE INTO controller_jobs(global_job_id,idempotency_key,local_task_id,service,kind,work_class,required_os,resource_keys,title,evidence,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?, 'Discovered',?,?)`).run(globalJobId, input.idempotencyKey, input.localTaskId?.slice(0, 120) ?? null, input.service, input.kind.slice(0, 80), input.workClass, input.requiredOs ?? 'any', JSON.stringify([...new Set(input.resourceKeys ?? [])].slice(0, 32)), redactText(input.title.trim()), input.evidence ? redactText(input.evidence).slice(0, 4000) : null, stamp, stamp);
  const job = db.prepare('SELECT global_job_id AS globalJobId,status FROM controller_jobs WHERE idempotency_key=?').get(input.idempotencyKey) as { globalJobId: string; status: string };
  if (job.globalJobId === globalJobId) event(db, job.globalJobId, null, 'submitted', null, { service: input.service, workClass: input.workClass });
  db.close(); return { ...job, created: job.globalJobId === globalJobId };
}

export function approveControllerJob(jobId: string, dbPath?: string) {
  const db = openControllerDb(dbPath); const tx = db.transaction(() => {
    const job = db.prepare('SELECT service,work_class,status FROM controller_jobs WHERE global_job_id=?').get(jobId) as { service: string; work_class: WorkClass; status: string } | undefined;
    if (!job) throw new Error('Job not found.'); if (job.status !== 'Discovered') throw new Error('Only Discovered jobs can be approved.');
    if (job.service === 'money' || (job.service === 'calculator' && job.work_class === 'code_change') || job.work_class === 'code_change' && job.service === 'calculator') throw new Error('Service policy blocks this job.');
    db.prepare("UPDATE controller_jobs SET status='Ready',updated_at=? WHERE global_job_id=? AND status='Discovered'").run(nowIso(), jobId);
    event(db, jobId, null, 'approved', null, { actor: 'local-controller-operator' }); return { jobId, status: 'Ready' };
  }); const result = tx.immediate(); db.close(); return result;
}

export function claimControllerJob(workerId: string, leaseMs = 60_000, dbPath?: string, provisionedPolicy?: ControllerWorkerPolicy, projectGuard?: { lockVersion:number; availableProjects:string[];policyVersion?:number }): Lease | null {
  const db = openControllerDb(dbPath); const stamp = Date.now(); const tx = db.transaction(() => {
    const worker = db.prepare('SELECT * FROM controller_workers WHERE worker_id=?').get(workerId) as any;
    const activeWorkerJob = db.prepare("SELECT 1 FROM controller_jobs WHERE worker_id=? AND status IN ('Claimed','Running','Testing') LIMIT 1").get(workerId);
    if (!worker || worker.state === 'Disabled' || worker.available_memory_bytes < MIN_WORKER_MEMORY_BYTES || Date.parse(worker.heartbeat_at) < stamp - 45_000 || worker.current_job_id || activeWorkerJob || provisionedPolicy && (provisionedPolicy.os !== worker.os || provisionedPolicy.allowCodeChanges !== Boolean(worker.allow_code_changes))) return null;
    const jobs = db.prepare("SELECT * FROM controller_jobs WHERE status='Ready' AND (required_os='any' OR required_os=?) ORDER BY created_at,global_job_id LIMIT 20").all(worker.os) as any[];
    for (const job of jobs) {
      if(job.work_class==='code_change'){
        if(!projectGuard||!Array.isArray(projectGuard.availableProjects)||!projectGuard.availableProjects.includes(job.service))continue;
        if(!Number.isSafeInteger(projectGuard.policyVersion))continue;
        const lockTable=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_lock_meta'").get();if(!lockTable)continue;
        const currentVersion=(db.prepare('SELECT version FROM project_lock_meta WHERE id=1').get() as {version:number}|undefined)?.version;if(currentVersion!==projectGuard.lockVersion)continue;
      }
      if (job.work_class === 'code_change' && (worker.os !== 'windows' || worker.available_memory_bytes < MIN_CODE_CHANGE_MEMORY_BYTES || worker.allow_code_changes !== 1 || provisionedPolicy && !provisionedPolicy.allowCodeChanges || worker.sandbox_status !== 'Ready' || worker.chatgpt_login_status !== 'ChatGPT' || worker.codex_cli_status !== 'Ready')) continue;
      if (job.work_class === 'code_change') {
        const active = db.prepare("SELECT 1 FROM controller_jobs WHERE service=? AND work_class='code_change' AND status IN ('Claimed','Running','Testing') LIMIT 1").get(job.service);
        if (active) continue;
        const resources = JSON.parse(job.resource_keys) as string[];
        const otherActive = db.prepare("SELECT resource_keys FROM controller_jobs WHERE work_class='code_change' AND status IN ('Claimed','Running','Testing')").all() as Array<{ resource_keys: string }>;
        if (resources.some(key => otherActive.some(row => (JSON.parse(row.resource_keys) as string[]).includes(key)))) continue;
      }
      const leaseId = randomUUID(); const nextToken = Number((db.prepare("SELECT value FROM controller_meta WHERE key='fencing_counter'").get() as { value: string }).value) + 1;
      const expiresAt = new Date(stamp + Math.max(10_000, Math.min(leaseMs, 5 * 60_000))).toISOString();
      db.prepare("UPDATE controller_meta SET value=? WHERE key='fencing_counter'").run(String(nextToken));
      db.prepare("UPDATE controller_jobs SET status='Claimed',worker_id=?,lease_id=?,fencing_token=?,acquired_at=?,expires_at=?,last_renewed_at=?,updated_at=?,project_lock_version=?,policy_version=? WHERE global_job_id=? AND status='Ready'")
        .run(workerId, leaseId, nextToken, new Date(stamp).toISOString(), expiresAt, new Date(stamp).toISOString(), nowIso(), job.work_class === 'code_change' ? projectGuard!.lockVersion : null, projectGuard?.policyVersion??null, job.global_job_id);
      const changed = db.prepare('SELECT changes() n').get() as { n: number }; if (changed.n !== 1) return null;
      db.prepare("UPDATE controller_workers SET current_job_id=?,state='Busy',execution_status='Claimed',updated_at=? WHERE worker_id=?").run(job.global_job_id, nowIso(), workerId);
      event(db, job.global_job_id, workerId, 'claimed', nextToken, { leaseId, expiresAt });
       return { jobId: job.global_job_id, workerId, leaseId, fencingToken: nextToken, expiresAt, status: 'Claimed',policyVersion:projectGuard?.policyVersion??null } as Lease;
    }
    return null;
  });
  try { return tx.immediate(); } finally { db.close(); }
}

export function currentControllerLease(workerId: string, dbPath?: string): Lease | null {
  const db = openControllerDb(dbPath);
  const lease = db.prepare("SELECT global_job_id AS jobId,worker_id AS workerId,lease_id AS leaseId,fencing_token AS fencingToken,expires_at AS expiresAt,status,policy_version AS policyVersion FROM controller_jobs WHERE worker_id=? AND status IN ('Claimed','Running','Testing') ORDER BY acquired_at DESC LIMIT 1").get(workerId) as Lease | undefined;
  db.close(); return lease && Date.parse(lease.expiresAt) > Date.now() ? lease : null;
}

export function workerMatchesControllerPolicy(workerId: string, policy: ControllerWorkerPolicy, dbPath?: string) {
  const db = openControllerDb(dbPath);
  const worker = db.prepare('SELECT os,allow_code_changes FROM controller_workers WHERE worker_id=?').get(workerId) as { os: WorkerOs; allow_code_changes: number } | undefined;
  db.close();
  return Boolean(worker && worker.os === policy.os && Boolean(worker.allow_code_changes) === policy.allowCodeChanges);
}

export function renewControllerLease(input: { jobId: string; workerId: string; leaseId: string; fencingToken: number;policyVersion?:number|null }, leaseMs = 60_000, dbPath?: string) {
  const db = openControllerDb(dbPath); const tx = db.transaction(() => {
    const job = db.prepare('SELECT status,expires_at,work_class,service,project_lock_version,policy_version FROM controller_jobs WHERE global_job_id=? AND worker_id=? AND lease_id=? AND fencing_token=?').get(input.jobId, input.workerId, input.leaseId, input.fencingToken) as { status: string; expires_at: string; work_class?: string; service?: string; project_lock_version?: number | null;policy_version?:number|null } | undefined;
    if (!job || !ACTIVE.includes(job.status as typeof ACTIVE[number]) && job.status !== 'Claimed') throw new Error('Lease or fencing token is stale.');
    assertProjectLockVersion(db, job);
    if(job.work_class==='code_change'&&(!Number.isSafeInteger(input.policyVersion)||job.policy_version!==input.policyVersion))throw new Error(`POLICY_VERSION_STALE:${job.policy_version??'Unknown'}`);
    if (Date.parse(job.expires_at) <= Date.now()) throw new Error('Expired leases cannot be renewed. Operator recovery evidence is required.');
    const stamp = nowIso(), expiresAt = new Date(Date.now() + Math.max(10_000, Math.min(leaseMs, 5 * 60_000))).toISOString();
    db.prepare('UPDATE controller_jobs SET expires_at=?,last_renewed_at=?,updated_at=? WHERE global_job_id=?').run(expiresAt, stamp, stamp, input.jobId);
    db.prepare('UPDATE controller_workers SET heartbeat_at=?,updated_at=? WHERE worker_id=?').run(stamp, stamp, input.workerId);
    event(db, input.jobId, input.workerId, 'lease-renewed', input.fencingToken, { expiresAt }); return { ...input, expiresAt };
  }); try { return tx.immediate(); } finally { db.close(); }
}

export function transitionControllerJob(input: { jobId: string; workerId: string; leaseId: string; fencingToken: number; policyVersion?:number|null;status: 'Running' | 'Testing' | 'Completed' | 'Failed'; result?: unknown; failureCode?: string }, dbPath?: string) {
  if (input.failureCode && !/^[A-Z0-9_.-]{1,64}$/i.test(input.failureCode)) throw new Error('failureCode must be a non-sensitive machine code.');
  const rawResult = input.result && typeof input.result === 'object' ? input.result as Record<string, unknown> : {};
  const safeResult = {
    testsPassed: typeof rawResult.testsPassed === 'boolean' ? rawResult.testsPassed : undefined,
    changedFilesCount: Number.isInteger(rawResult.changedFilesCount) && Number(rawResult.changedFilesCount) >= 0 ? Number(rawResult.changedFilesCount) : undefined,
    summaryCode: typeof rawResult.summaryCode === 'string' && /^[A-Z0-9_.-]{1,64}$/i.test(rawResult.summaryCode) ? rawResult.summaryCode : undefined,
  };
  const db = openControllerDb(dbPath); const tx = db.transaction(() => {
    const job = db.prepare('SELECT status,expires_at,work_class,service,project_lock_version,policy_version FROM controller_jobs WHERE global_job_id=? AND worker_id=? AND lease_id=? AND fencing_token=?').get(input.jobId, input.workerId, input.leaseId, input.fencingToken) as { status: string; expires_at: string; work_class?: string; service?: string; project_lock_version?: number | null;policy_version?:number|null } | undefined;
    if (!job || Date.parse(job.expires_at) <= Date.now()) throw new Error('Stale or expired fencing token; transition rejected.');
    assertProjectLockVersion(db, job);
    if(job.work_class==='code_change'&&(!Number.isSafeInteger(input.policyVersion)||job.policy_version!==input.policyVersion))throw new Error(`POLICY_VERSION_STALE:${job.policy_version??'Unknown'}`);
    const allowed: Record<string, string[]> = { Claimed: ['Running', 'Testing', 'Completed', 'Failed'], Running: ['Testing', 'Completed', 'Failed'], Testing: ['Completed', 'Failed'] };
    if (!allowed[job.status]?.includes(input.status)) throw new Error(`Invalid job transition ${job.status} -> ${input.status}.`);
    db.prepare('UPDATE controller_jobs SET status=?,result_json=?,failure_code=?,updated_at=? WHERE global_job_id=? AND fencing_token=?').run(input.status, Object.values(safeResult).some(value => value !== undefined) ? JSON.stringify(safeResult) : null, input.failureCode ?? null, nowIso(), input.jobId, input.fencingToken);
    if (['Completed', 'Failed'].includes(input.status)) db.prepare("UPDATE controller_workers SET current_job_id=NULL,state=CASE WHEN sandbox_status='Ready' THEN 'Idle' ELSE 'Degraded' END,execution_status=?,updated_at=? WHERE worker_id=? AND current_job_id=?").run(input.status, nowIso(), input.workerId, input.jobId);
    else db.prepare('UPDATE controller_workers SET execution_status=?,updated_at=? WHERE worker_id=?').run(input.status, nowIso(), input.workerId);
    event(db, input.jobId, input.workerId, `job-${input.status.toLowerCase()}`, input.fencingToken, { failureCode: input.failureCode }); return { jobId: input.jobId, status: input.status };
  }); try { return tx.immediate(); } finally { db.close(); }
}

export function assertCurrentControllerLease(input: { jobId: string; workerId: string; fencingToken: number;leaseId?:string;service?:string;policyVersion?:number;requireCodeChange?:boolean }, dbPath?: string) {
  const db = openControllerDb(dbPath); let row:({ok:number;work_class?:string;service?:string;project_lock_version?:number|null;policy_version?:number|null}|undefined); try { row = db.prepare("SELECT 1 ok,work_class,service,project_lock_version,policy_version FROM controller_jobs WHERE global_job_id=? AND worker_id=? AND fencing_token=? AND (? IS NULL OR lease_id=?) AND (? IS NULL OR service=?) AND status IN ('Claimed','Running','Testing') AND expires_at>? ").get(input.jobId, input.workerId, input.fencingToken, input.leaseId??null,input.leaseId??null,input.service??null,input.service??null,nowIso()) as typeof row; if(row){assertProjectLockVersion(db,row);if(input.requireCodeChange&&row.work_class!=='code_change')throw new Error('CODE_CHANGE_LEASE_REQUIRED');if(input.policyVersion!==undefined&&row.policy_version!==input.policyVersion)throw new Error(`POLICY_VERSION_STALE:${row.policy_version??'Unknown'}`);} } finally { db.close(); }
  if (!row) throw new Error('Current fencing token is not valid; external side effect blocked.'); return true;
}

export function recoverExpiredControllerJob(input: { jobId: string; processTerminated: boolean; verifiedBy: string; evidence: string }, dbPath?: string) {
  if (input.processTerminated !== true || !input.verifiedBy.trim() || !input.evidence.trim()) throw new Error('Recovery requires explicit process-termination evidence and verifier.');
  const db = openControllerDb(dbPath); const tx = db.transaction(() => {
    const job = db.prepare('SELECT worker_id,status,expires_at,fencing_token FROM controller_jobs WHERE global_job_id=?').get(input.jobId) as any;
    if (!job || !ACTIVE.includes(job.status) || Date.parse(job.expires_at) > Date.now()) throw new Error('Job is not an expired active lease.');
    db.prepare("UPDATE controller_jobs SET status='Ready',worker_id=NULL,lease_id=NULL,expires_at=NULL,last_renewed_at=NULL,updated_at=? WHERE global_job_id=?").run(nowIso(), input.jobId);
    db.prepare("UPDATE controller_workers SET current_job_id=NULL,state='Degraded',execution_status='RecoveryRequired',updated_at=? WHERE worker_id=? AND current_job_id=?").run(nowIso(), job.worker_id, input.jobId);
    event(db, input.jobId, job.worker_id, 'operator-recovered-after-process-termination', job.fencing_token, { verifiedBy: redactText(input.verifiedBy).slice(0, 100), evidence: redactText(input.evidence).slice(0, 1000) });
    return { jobId: input.jobId, status: 'Ready', recovery: 'operator-verified process termination' };
  }); try { return tx.immediate(); } finally { db.close(); }
}

export function recordControllerNonce(workerId: string, nonce: string, timestamp: number, dbPath?: string) {
  const now = Date.now(); if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 60_000) throw new Error('Request timestamp outside the allowed replay window.');
  if (!/^[a-f0-9-]{32,64}$/i.test(nonce)) throw new Error('Invalid request nonce.');
  const db = openControllerDb(dbPath); const tx = db.transaction(() => {
    db.prepare('DELETE FROM controller_nonces WHERE expires_at<?').run(now);
    db.prepare('INSERT INTO controller_nonces(worker_id,nonce,expires_at) VALUES(?,?,?)').run(workerId, nonce, now + 120_000);
  }); try { tx.immediate(); } catch { db.close(); throw new Error('Duplicate request nonce rejected.'); } db.close(); return true;
}

export function controllerDashboardSnapshot(dbPath?: string, staleAfterMs = 45_000) {
  const db = openControllerDb(dbPath); const now = Date.now();
  const workers = (db.prepare('SELECT worker_id AS workerId,os,host_label AS hostLabel,capabilities,codex_cli_status AS codexCliStatus,chatgpt_login_status AS chatgptLoginStatus,sandbox_status AS sandboxStatus,cpu_count AS cpuCount,available_memory_bytes AS availableMemoryBytes,allow_code_changes AS allowCodeChanges,heartbeat_at AS heartbeatAt,current_job_id AS currentJobId,execution_status AS executionStatus,last_error_code AS lastErrorCode,state FROM controller_workers ORDER BY worker_id').all() as any[]).map(worker => ({ ...worker, allowCodeChanges: Boolean(worker.allowCodeChanges), capabilities: JSON.parse(worker.capabilities), state: worker.state === 'Disabled' ? 'Disabled' : now - Date.parse(worker.heartbeatAt) > staleAfterMs ? 'Offline' : worker.state }));
   const jobs = db.prepare('SELECT global_job_id AS globalJobId,local_task_id AS localTaskId,service,kind,work_class AS workClass,required_os AS requiredOs,title,status,worker_id AS workerId,lease_id AS leaseId,fencing_token AS fencingToken,acquired_at AS acquiredAt,expires_at AS expiresAt,last_renewed_at AS lastRenewedAt,created_at AS createdAt,updated_at AS updatedAt,failure_code AS failureCode,project_lock_version AS projectLockVersion,policy_version AS policyVersion FROM controller_jobs ORDER BY created_at DESC LIMIT 200').all() as any[];
  const events = db.prepare('SELECT id,global_job_id AS globalJobId,worker_id AS workerId,event,fencing_token AS fencingToken,detail,created_at AS createdAt FROM controller_events ORDER BY id DESC LIMIT 200').all() as any[];
  const workerFresh = workers.filter(worker => worker.state !== 'Offline' && worker.state !== 'Disabled').length;
  db.close(); return { controller: 'Local SQLite Controller', configured: true, workerRegistration: workers.length ? 'Configured' : 'Not Configured', online: workerFresh > 0, checkedAt: nowIso(), workers, jobs, events, counts: { workers: workers.length, onlineWorkers: workerFresh, queued: jobs.filter(job => ['Discovered', 'Ready'].includes(job.status)).length, active: jobs.filter(job => ACTIVE.includes(job.status as typeof ACTIVE[number])).length, completed: jobs.filter(job => job.status === 'Completed').length, failed: jobs.filter(job => job.status === 'Failed').length } };
}

export function controllerJobStatuses(jobIds: string[], dbPath?: string) {
  if (!Array.isArray(jobIds) || jobIds.length > 200 || jobIds.some(id => typeof id !== 'string' || id.length > 80)) throw new Error('Invalid status query.');
  if (!jobIds.length) return [];
  const db = openControllerDb(dbPath); const placeholders = jobIds.map(() => '?').join(',');
   const rows = db.prepare(`SELECT global_job_id AS globalJobId,status,worker_id AS workerId,lease_id AS leaseId,fencing_token AS fencingToken,expires_at AS expiresAt,updated_at AS updatedAt,service,work_class AS workClass,project_lock_version AS projectLockVersion,policy_version AS policyVersion FROM controller_jobs WHERE global_job_id IN (${placeholders})`).all(...jobIds);
  db.close(); return rows;
}
