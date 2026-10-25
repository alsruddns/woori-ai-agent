import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { appendDevelopmentAuditEvent, createDevelopmentAuditJob } from './development-audit.js';

export type CodexInvocationStatus = 'Reserved' | 'Started' | 'Completed' | 'Failed' | 'Timed Out' | 'Cancelled' | 'Unknown' | 'Not Started';
export type InvocationInput = {
  databasePath: string;
  developmentJobId: string;
  workerId: string;
  platform: string;
  featureId?: string;
  attemptNumber: number;
  invocationType: string;
  maxPerJob?: number;
  maxPerDay?: number;
  maxConcurrent?: number;
  now?: Date;
};
export type InvocationRecord = InvocationInput & { invocationId: string; auditEventId: string; auditJobUuid: string; createdAt: string };

function open(file: string) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved, { timeout: 5000 });
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS codex_invocations (
    invocation_id TEXT PRIMARY KEY, development_job_id TEXT NOT NULL, worker_id TEXT NOT NULL,
    platform TEXT NOT NULL, feature_id TEXT, attempt_number INTEGER NOT NULL, invocation_type TEXT NOT NULL,
    created_at TEXT NOT NULL, process_started_at TEXT, process_ended_at TEXT, execution_status TEXT NOT NULL,
    exit_code INTEGER, timed_out INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0,
    subscription_usage_status TEXT NOT NULL DEFAULT 'Unknown', retry_reason TEXT, audit_event_id TEXT NOT NULL,
    process_id INTEGER, audit_job_uuid TEXT NOT NULL DEFAULT '', UNIQUE(development_job_id, attempt_number, invocation_type)
  );
  CREATE INDEX IF NOT EXISTS idx_codex_invocations_created ON codex_invocations(created_at);
  CREATE INDEX IF NOT EXISTS idx_codex_invocations_job ON codex_invocations(development_job_id, attempt_number);
  CREATE INDEX IF NOT EXISTS idx_codex_invocations_state ON codex_invocations(execution_status);`);
  return db;
}

export function reserveCodexInvocation(input: InvocationInput): InvocationRecord {
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  recoverStaleCodexInvocations(input.databasePath);
  const id = randomUUID();
  const maxPerJob = Math.max(1, Math.min(3, input.maxPerJob ?? 3));
  const maxPerDay = Math.max(1, Math.min(10, input.maxPerDay ?? 1));
  const maxConcurrent = Math.max(1, Math.min(1, input.maxConcurrent ?? 1));
  const db = open(input.databasePath);
  let auditJob: ReturnType<typeof createDevelopmentAuditJob>;
  try {
    auditJob = createDevelopmentAuditJob({ kind: 'Feature', service: 'all', title: 'Codex invocation accounting', reason: 'Durably account for an explicit Codex process invocation before process creation.', risk: 'Low', sourceKey: `codex-invocation-job:${input.developmentJobId}`, actor: 'System', metadata: { developmentJobId: input.developmentJobId } }, path.resolve(input.databasePath));
    db.transaction(() => {
      const day = createdAt.slice(0, 10);
      const daily = db.prepare("SELECT COUNT(*) AS n FROM codex_invocations WHERE substr(created_at,1,10)=? AND execution_status!='Not Started'").get(day) as { n: number };
      const perJob = db.prepare("SELECT COUNT(*) AS n FROM codex_invocations WHERE development_job_id=? AND execution_status!='Not Started'").get(input.developmentJobId) as { n: number };
      const running = db.prepare("SELECT COUNT(*) AS n FROM codex_invocations WHERE execution_status IN ('Reserved','Started')").get() as { n: number };
      if (daily.n >= maxPerDay) throw new Error(`Persisted Codex daily invocation budget exhausted (${daily.n}/${maxPerDay}); subscription quota remains Unknown.`);
      if (perJob.n >= maxPerJob) throw new Error(`Persisted Codex per-job invocation budget exhausted (${perJob.n}/${maxPerJob}).`);
      if (running.n >= maxConcurrent) throw new Error('Persisted Codex concurrent process limit reached.');
      db.prepare(`INSERT INTO codex_invocations(invocation_id,development_job_id,worker_id,platform,feature_id,attempt_number,invocation_type,created_at,execution_status,audit_event_id,audit_job_uuid)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.developmentJobId, input.workerId, input.platform, input.featureId ?? null, input.attemptNumber, input.invocationType, createdAt, 'Reserved', 'Pending', auditJob.uuid);
    }).immediate();
    const event = appendDevelopmentAuditEvent({ jobId: auditJob.uuid, type: 'CODEX_INVOCATION_RESERVED', payload: { invocationId: id, developmentJobId: input.developmentJobId, workerId: input.workerId, platform: input.platform, featureId: input.featureId ?? null, attemptNumber: input.attemptNumber, invocationType: input.invocationType, subscriptionUsageStatus: 'Unknown' }, idempotencyKey: `codex-invocation-reserved:${id}`, actor: 'System' }, path.resolve(input.databasePath));
    db.prepare("UPDATE codex_invocations SET audit_event_id=? WHERE invocation_id=? AND execution_status='Reserved'").run(event.eventId, id);
    return { ...input, invocationId: id, auditEventId: event.eventId, auditJobUuid: auditJob.uuid, createdAt };
  } finally { db.close(); }
}

export function markCodexInvocationStarted(record: InvocationRecord, processId?: number) {
  const db = open(record.databasePath);
  try {
    const startedAt = new Date().toISOString();
    const updated = db.prepare("UPDATE codex_invocations SET execution_status='Started',process_started_at=?,process_id=? WHERE invocation_id=? AND execution_status='Reserved'").run(startedAt, processId ?? null, record.invocationId);
    if (!updated.changes) throw new Error('Codex invocation reservation is no longer current.');
    try { appendDevelopmentAuditEvent({ jobId: record.auditJobUuid, type: 'CODEX_PROCESS_STARTED', payload: { invocationId: record.invocationId, processId: processId ?? null, processStartedAt: startedAt }, idempotencyKey: `codex-process-started:${record.invocationId}`, actor: 'System' }, record.databasePath); }
    catch (error) { db.prepare("UPDATE codex_invocations SET execution_status='Unknown',retry_reason='Start audit event failed; process was not launched.' WHERE invocation_id=? AND execution_status='Started'").run(record.invocationId); throw error; }
  } finally { db.close(); }
}

export function recordCodexInvocationProcessId(record: InvocationRecord, processId: number) {
  if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('Codex process ID is invalid.');
  const db = open(record.databasePath);
  try {
    const updated = db.prepare("UPDATE codex_invocations SET process_id=? WHERE invocation_id=? AND execution_status='Started'").run(processId, record.invocationId);
    if (!updated.changes) throw new Error('Codex invocation is not in Started state.');
    appendDevelopmentAuditEvent({ jobId: record.auditJobUuid, type: 'CODEX_PROCESS_ID_RECORDED', payload: { invocationId: record.invocationId, processId }, idempotencyKey: `codex-process-id:${record.invocationId}`, actor: 'System' }, record.databasePath);
  } finally { db.close(); }
}

export function finishCodexInvocation(record: InvocationRecord, result: { status: CodexInvocationStatus; exitCode?: number | null; timedOut?: boolean; cancelled?: boolean; retryReason?: string | null; processId?: number }) {
  const db = open(record.databasePath);
  try {
    const endedAt = new Date().toISOString();
    const update = db.prepare("UPDATE codex_invocations SET execution_status=?,process_ended_at=?,exit_code=?,timed_out=?,cancelled=?,retry_reason=?,process_id=COALESCE(?,process_id),subscription_usage_status='Unknown' WHERE invocation_id=? AND execution_status IN ('Reserved','Started')").run(result.status, endedAt, result.exitCode ?? null, result.timedOut ? 1 : 0, result.cancelled ? 1 : 0, result.retryReason ?? null, result.processId ?? null, record.invocationId);
    if (!update.changes) return false;
    try { appendDevelopmentAuditEvent({ jobId: record.auditJobUuid, type: 'CODEX_PROCESS_EXITED', payload: { invocationId: record.invocationId, status: result.status, processEndedAt: endedAt, exitCode: result.exitCode ?? null, timedOut: Boolean(result.timedOut), cancelled: Boolean(result.cancelled), subscriptionUsageStatus: 'Unknown', retryReason: result.retryReason ?? null }, idempotencyKey: `codex-process-exited:${record.invocationId}`, actor: 'System' }, record.databasePath); }
    catch (error) { db.prepare("UPDATE codex_invocations SET execution_status='Unknown',retry_reason='Exit audit event failed; invocation accounting is uncertain.' WHERE invocation_id=? AND execution_status=?").run(record.invocationId, result.status); throw error; }
    return true;
  } finally { db.close(); }
}

export function markInterruptedCodexInvocationsUnknown(databasePath: string) {
  const db = open(databasePath);
  try {
    const rows = db.prepare("SELECT invocation_id,audit_job_uuid FROM codex_invocations WHERE execution_status IN ('Reserved','Started')").all() as Array<{ invocation_id: string; audit_job_uuid: string }>;
    const now = new Date().toISOString();
    const tx = db.transaction(() => rows.forEach(row => db.prepare("UPDATE codex_invocations SET execution_status='Unknown',process_ended_at=?,retry_reason='Recovered after process restart; whether Codex started is unknown.' WHERE invocation_id=? AND execution_status IN ('Reserved','Started')").run(now, row.invocation_id)));
    tx();
    for (const row of rows) appendDevelopmentAuditEvent({ jobId: row.audit_job_uuid, type: 'CODEX_INVOCATION_UNKNOWN', payload: { invocationId: row.invocation_id, detectedAt: now, budgetTreatment: 'Consumed' }, idempotencyKey: `codex-invocation-unknown:${row.invocation_id}`, actor: 'System' }, databasePath);
    return rows.length;
  } finally { db.close(); }
}

export function recoverStaleCodexInvocations(databasePath: string, staleAfterMs = 25 * 60_000) {
  const db = open(databasePath);
  try {
    const cutoff = Date.now() - Math.max(25 * 60_000, staleAfterMs);
    const rows = db.prepare("SELECT invocation_id,audit_job_uuid,process_id,created_at FROM codex_invocations WHERE execution_status IN ('Reserved','Started')").all() as Array<{ invocation_id: string; audit_job_uuid: string; process_id: number | null; created_at: string }>;
    const stale = rows.filter(row => {
      if (Date.parse(row.created_at) > cutoff) return false;
      if (!row.process_id) return true;
      try { process.kill(row.process_id, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'EPERM'; }
    });
    const now = new Date().toISOString();
    db.transaction(() => stale.forEach(row => db.prepare("UPDATE codex_invocations SET execution_status='Unknown',process_ended_at=?,retry_reason='Stale invocation recovered after process restart; subscription usage remains Unknown.' WHERE invocation_id=? AND execution_status IN ('Reserved','Started')").run(now, row.invocation_id)))();
    for (const row of stale) appendDevelopmentAuditEvent({ jobId: row.audit_job_uuid, type: 'CODEX_INVOCATION_UNKNOWN', payload: { invocationId: row.invocation_id, detectedAt: now, previousProcessId: row.process_id, budgetTreatment: 'Consumed', reason: 'Stale process state recovered; no subscription balance inferred.' }, idempotencyKey: `codex-invocation-stale:${row.invocation_id}`, actor: 'System' }, databasePath);
    return stale.length;
  } finally { db.close(); }
}

export function listCodexInvocations(databasePath: string, limit = 50) {
  const db = open(databasePath);
  try { return db.prepare('SELECT invocation_id AS invocationId,development_job_id AS developmentJobId,worker_id AS workerId,platform,feature_id AS featureId,attempt_number AS attemptNumber,invocation_type AS invocationType,created_at AS createdAt,process_started_at AS processStartedAt,process_ended_at AS processEndedAt,execution_status AS executionStatus,exit_code AS exitCode,timed_out AS timedOut,cancelled,subscription_usage_status AS subscriptionUsageStatus,retry_reason AS retryReason,audit_event_id AS auditEventId,process_id AS processId FROM codex_invocations ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(200, limit))); }
  finally { db.close(); }
}
