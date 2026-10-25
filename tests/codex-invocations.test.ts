import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { finishCodexInvocation, listCodexInvocations, markCodexInvocationStarted, recoverStaleCodexInvocations, reserveCodexInvocation } from '../apps/cli/src/codex-invocations.js';

let root = '';
const originalDb = process.env.WOORI_AGENT_DB_PATH;
function database() { root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-invocations-')); return path.join(root, 'agent.sqlite'); }
afterEach(() => { if (originalDb === undefined) delete process.env.WOORI_AGENT_DB_PATH; else process.env.WOORI_AGENT_DB_PATH = originalDb; if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe('persistent Codex invocation accounting', () => {
  it('reserves before process creation and enforces daily budget after reopening the database', () => {
    const file = database(); process.env.WOORI_AGENT_DB_PATH = file;
    const record = reserveCodexInvocation({ databasePath: file, developmentJobId: 'DEV-TEST-1', workerId: 'fixture-worker', platform: 'win32', featureId: 'feature-1', attemptNumber: 1, invocationType: 'fixture', maxPerDay: 1 });
    expect(listCodexInvocations(file)).toMatchObject([{ invocationId: record.invocationId, executionStatus: 'Reserved', subscriptionUsageStatus: 'Unknown' }]);
    expect(() => reserveCodexInvocation({ databasePath: file, developmentJobId: 'DEV-TEST-2', workerId: 'fixture-worker-2', platform: 'win32', attemptNumber: 1, invocationType: 'fixture', maxPerDay: 1 })).toThrow(/daily invocation budget exhausted/);
  });

  it('records process lifecycle and counts interrupted invocations as Unknown', () => {
    const file = database(); process.env.WOORI_AGENT_DB_PATH = file;
    const started = reserveCodexInvocation({ databasePath: file, developmentJobId: 'DEV-TEST-3', workerId: 'worker', platform: 'win32', attemptNumber: 1, invocationType: 'fixture', maxPerDay: 5 });
    markCodexInvocationStarted(started, 456);
    expect(finishCodexInvocation(started, { status: 'Completed', exitCode: 0, processId: 456 })).toBe(true);
    const interrupted = reserveCodexInvocation({ databasePath: file, developmentJobId: 'DEV-TEST-4', workerId: 'worker', platform: 'win32', attemptNumber: 1, invocationType: 'fixture', maxPerDay: 5 });
    markCodexInvocationStarted(interrupted);
    const db = new Database(file);
    try { db.prepare('UPDATE codex_invocations SET created_at=? WHERE invocation_id=?').run(new Date(Date.now() - 26 * 60_000).toISOString(), interrupted.invocationId); }
    finally { db.close(); }
    expect(recoverStaleCodexInvocations(file)).toBe(1);
    expect(listCodexInvocations(file).map((row: any) => row.executionStatus)).toEqual(['Completed', 'Unknown']);
    expect(listCodexInvocations(file)[0]).toMatchObject({ processId: 456 });
    const verify = new Database(file, { readonly: true });
    try { expect(verify.prepare('SELECT COUNT(*) AS n FROM development_audit_events').get()).toMatchObject({ n: 8 }); }
    finally { verify.close(); }
  });
});
