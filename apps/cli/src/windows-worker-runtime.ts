import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { unprotectForCurrentWindowsUser, protectForCurrentWindowsUser } from './local-dpapi.js';
import { approveControllerJob } from './distributed-queue.js';

const WORKER_ID = 'windows-local-readonly';
const PORT = 4180;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const runtimeRoot = () => path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'WooriAiAgent', 'worker-runtime');
const paths = () => ({ root: runtimeRoot(), state: path.join(runtimeRoot(), 'runtime.json'), token: path.join(runtimeRoot(), 'worker-token.dpapi'), controllerLog: path.join(runtimeRoot(), 'controller.log'), workerLog: path.join(runtimeRoot(), 'worker.log') });
type RuntimeState = { workerId: string; controllerPid: number; workerPid: number; controllerDbPath: string; startedAt: string; port: number };

function ensureProtectedDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
  if (process.platform === 'win32') {
    const identity = spawnSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).stdout?.trim();
    if (!identity) throw new Error('Could not verify the current Windows account for local Worker credential protection.');
    const restrict = spawnSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (restrict.status !== 0) throw new Error('Could not set the Worker runtime directory ACL.');
    const check = spawnSync('icacls.exe', [directory], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (check.status !== 0 || !check.stdout.includes(identity)) throw new Error('Could not verify the current-user Worker runtime directory ACL.');
  }
}

function readState(): RuntimeState | null {
  const file = paths().state;
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as RuntimeState; } catch { throw new Error('Worker runtime state is invalid; preserve it and inspect manually.'); }
}

function processAlive(pid: number | undefined, expectedCommand?: 'controller serve' | 'worker heartbeat-loop') {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    if (expectedCommand && process.platform === 'win32') {
      const query = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}').CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 });
      return query.status === 0 && query.stdout.includes('apps/cli/src/index.ts') && query.stdout.includes(expectedCommand);
    }
    return true;
  } catch { return false; }
}

function readToken() {
  const file = paths().token;
  if (!fs.existsSync(file)) {
    const value = randomBytes(48).toString('base64url');
    fs.writeFileSync(file, protectForCurrentWindowsUser(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return value;
  }
  return unprotectForCurrentWindowsUser(fs.readFileSync(file, 'utf8'));
}

function childEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key]) env[key] = process.env[key];
  return { ...env, NODE_ENV: 'production', WOORI_CONTROLLER_DB_PATH: path.resolve(process.env.WOORI_CONTROLLER_DB_PATH ?? 'data/controller/queue.sqlite'), WOORI_AGENT_DB_PATH: path.resolve(process.env.WOORI_AGENT_DB_PATH ?? 'data/woori-agent.sqlite'), ...extra };
}

function launch(args: string[], logFile: string, env: NodeJS.ProcessEnv) {
  const cli = path.resolve('node_modules/tsx/dist/cli.mjs');
  if (!fs.existsSync(cli)) throw new Error('Local tsx CLI is not installed. Run the repository pnpm install first.');
  const log = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(process.execPath, [cli, 'apps/cli/src/index.ts', ...args], { cwd: process.cwd(), env, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  if (!child.pid) throw new Error('Worker process failed to start.');
  child.unref();
  return child.pid;
}

async function waitForPort(port: number, pid: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!processAlive(pid, 'controller serve')) throw new Error('Distributed Controller exited or its process identity changed during startup; inspect its private runtime log.');
    const open = await new Promise<boolean>(resolve => { const socket = net.connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
    if (open) return;
    await delay(200);
  }
  throw new Error('Distributed Controller did not listen on the configured loopback port.');
}

async function waitForHeartbeat(databasePath: string, workerPid: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!processAlive(workerPid)) throw new Error('Windows Worker exited during registration; inspect its private runtime log.');
    if (fs.existsSync(databasePath)) {
      try {
        const db = new Database(databasePath, { readonly: true, fileMustExist: true });
        const row = db.prepare('SELECT worker_id,state,heartbeat_at,allow_code_changes FROM controller_workers WHERE worker_id=?').get(WORKER_ID) as { worker_id: string; state: string; heartbeat_at: string; allow_code_changes: number } | undefined;
        db.close();
        if (row && Date.now() - Date.parse(row.heartbeat_at) < 45_000) return { workerId: row.worker_id, state: row.state, heartbeatAt: row.heartbeat_at, allowCodeChanges: Boolean(row.allow_code_changes) };
      } catch { /* Wait for Controller schema initialization or first heartbeat. */ }
    }
    await delay(200);
  }
  throw new Error('Windows Worker heartbeat was not recorded in the configured Controller database.');
}

export async function startWindowsReadOnlyWorker() {
  if (process.platform !== 'win32') throw new Error('Windows Worker runtime is available only on Windows.');
  const existing = readState();
  if (existing && processAlive(existing.controllerPid, 'controller serve') && processAlive(existing.workerPid, 'worker heartbeat-loop')) return { ...(await windowsWorkerRuntimeStatus()), startResult: 'Already Running' };
  const statePaths = paths(); ensureProtectedDirectory(statePaths.root);
  const dbPath = path.resolve(process.env.WOORI_CONTROLLER_DB_PATH ?? 'data/controller/queue.sqlite');
  const portBusy = await new Promise<boolean>(resolve => { const socket = net.connect(PORT, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
  if (portBusy) throw new Error('Port 4180 is already occupied by an unverified process; refusing to attach a Worker to it.');
  const token = readToken();
  const controllerEnv = childEnvironment({ WOORI_CONTROLLER_HOST: '127.0.0.1', WOORI_CONTROLLER_PORT: String(PORT), WOORI_CONTROLLER_WORKER_TOKENS: JSON.stringify({ [WORKER_ID]: token }), WOORI_CONTROLLER_WORKER_POLICIES: JSON.stringify({ [WORKER_ID]: { os: 'windows', allowCodeChanges: false } }) });
  const controllerPid = launch(['controller', 'serve'], statePaths.controllerLog, controllerEnv);
  try {
    await waitForPort(PORT, controllerPid);
    const workerEnv = childEnvironment({ WOORI_CONTROLLER_URL: `http://127.0.0.1:${PORT}`, WOORI_CONTROLLER_WORKER_ID: WORKER_ID, WOORI_CONTROLLER_HOST_LABEL: 'windows-local', WOORI_CONTROLLER_WORKER_TOKEN: token, WOORI_WORKER_CODE_MODIFICATION_ENABLED: 'false' });
    const workerPid = launch(['worker', 'heartbeat-loop', '--interval-seconds=30'], statePaths.workerLog, workerEnv);
    const heartbeat = await waitForHeartbeat(dbPath, workerPid);
    const state: RuntimeState = { workerId: WORKER_ID, controllerPid, workerPid, controllerDbPath: dbPath, startedAt: new Date().toISOString(), port: PORT };
    fs.writeFileSync(statePaths.state, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    return { ...heartbeat, status: 'Running Read Only', controllerPid, workerPid, controllerDbPath: dbPath };
  } catch (error) {
    try { process.kill(controllerPid); } catch { /* Controller may have exited already. */ }
    throw error;
  }
}

export async function windowsWorkerRuntimeStatus() {
  if (process.platform !== 'win32') return { status: 'Unsupported' };
  const state = readState();
  if (!state) return { status: 'Not Configured', workerRegistered: false };
  let worker: Record<string, unknown> | null = null;
  if (fs.existsSync(state.controllerDbPath)) {
    const db = new Database(state.controllerDbPath, { readonly: true, fileMustExist: true });
    try { const row = db.prepare('SELECT worker_id AS workerId,os,state,host_label AS hostLabel,capabilities,heartbeat_at AS heartbeatAt,current_job_id AS currentJobId,execution_status AS executionStatus,allow_code_changes AS allowCodeChanges FROM controller_workers WHERE worker_id=?').get(state.workerId) as any; worker = row ? { ...row, capabilities: JSON.parse(row.capabilities), allowCodeChanges: Boolean(row.allowCodeChanges) } : null; } finally { db.close(); }
  }
  const fresh = worker && typeof worker.heartbeatAt === 'string' && Date.now() - Date.parse(worker.heartbeatAt) < 45_000;
  const controllerAlive = processAlive(state.controllerPid, 'controller serve'), workerAlive = processAlive(state.workerPid, 'worker heartbeat-loop');
  return { status: fresh && controllerAlive && workerAlive ? 'Connected' : 'Offline', controllerPidAlive: controllerAlive, workerPidAlive: workerAlive, controllerPid: state.controllerPid, workerPid: state.workerPid, controllerDbPath: state.controllerDbPath, workerRegistered: Boolean(worker), worker: worker ? { ...worker, state: fresh ? worker.state : 'Offline' } : null, allowCodeChanges: false, runtimeRoot: paths().root };
}

export async function stopWindowsReadOnlyWorker() {
  if (process.platform !== 'win32') throw new Error('Windows Worker runtime is available only on Windows.');
  const state = readState(); if (!state) return { status: 'Not Configured' };
  if (fs.existsSync(state.controllerDbPath)) {
    const db = new Database(state.controllerDbPath, { readonly: true, fileMustExist: true });
    try { const active = db.prepare("SELECT current_job_id AS jobId FROM controller_workers WHERE worker_id=?").get(state.workerId) as { jobId: string | null } | undefined; if (active?.jobId) throw new Error('Worker has an active lease; stop is blocked until it is completed or safely cancelled.'); } finally { db.close(); }
  }
  for (const [pid, expected] of [[state.workerPid, 'worker heartbeat-loop'], [state.controllerPid, 'controller serve']] as const) if (processAlive(pid, expected)) { try { process.kill(pid); } catch { /* Process exited during shutdown. */ } }
  await delay(500);
  return { status: 'Stopped', workerProcessStopped: !processAlive(state.workerPid), controllerProcessStopped: !processAlive(state.controllerPid), heartbeatWillAgeOfflineWithinSeconds: 45, credentialRetainedEncrypted: fs.existsSync(paths().token) };
}

export function runWindowsReadOnlyIntegrationSmoke(approved: boolean) {
  if (process.platform !== 'win32') throw new Error('Windows Worker integration smoke is available only on Windows.');
  if (!approved) throw new Error('The synthetic read-only integration job requires --approve=true.');
  const state = readState(); if (!state || !processAlive(state.controllerPid, 'controller serve') || !processAlive(state.workerPid, 'worker heartbeat-loop')) throw new Error('The persistent Windows Worker and local Controller must be running first.');
  const token = readToken(), cli = path.resolve('node_modules/tsx/dist/cli.mjs');
  const childEnv = childEnvironment({ WOORI_CONTROLLER_URL: `http://127.0.0.1:${state.port}`, WOORI_CONTROLLER_WORKER_ID: state.workerId, WOORI_CONTROLLER_HOST_LABEL: 'windows-local', WOORI_CONTROLLER_WORKER_TOKEN: token, WOORI_WORKER_CODE_MODIFICATION_ENABLED: 'false' });
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [cli, 'apps/cli/src/index.ts', ...args], { cwd: process.cwd(), env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 256 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`Worker integration step failed (${args[1] ?? args[0]}); inspect the private Worker log for non-sensitive diagnostics.`);
    try { return JSON.parse(result.stdout.trim()); } catch { throw new Error('Worker integration command returned invalid structured output.'); }
  };
  const submitted = run(['worker', 'submit-readonly-smoke', '--create=true']) as { globalJobId?: string; created?: boolean; status?: string };
  if (!submitted.globalJobId) throw new Error('Controller did not return a synthetic integration Job ID.');
  const approval = approveControllerJob(submitted.globalJobId, state.controllerDbPath);
  const dispatched = run(['worker', 'dispatch-once', `--job-id=${submitted.globalJobId}`, '--execute=true']) as { status?: string; result?: { status?: string }; workerId?: string; policyVersion?: number; auditJobId?: string };
  return { submitted: { jobId: submitted.globalJobId, status: submitted.status ?? 'Unknown', created: submitted.created ?? null }, approval, dispatch: dispatched, expectedScope: 'Synthetic local Dashboard health check only; no service source, external service data, Codex, PR, push or deployment.' };
}
