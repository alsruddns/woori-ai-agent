import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const repositoryRoot = process.cwd();
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'woori-agent-worker-smoke-'));
const databasePath = path.join(testRoot, 'controller.sqlite');
const workerId = `windows-worker-smoke-${randomUUID().slice(0, 8)}`;
const workerToken = randomBytes(32).toString('hex');
const port = 42_000 + Math.floor(Math.random() * 15_000);
const environment = {
  ...process.env,
  WOORI_CONTROLLER_DB_PATH: databasePath,
  WOORI_CONTROLLER_HOST: '127.0.0.1',
  WOORI_CONTROLLER_PORT: String(port),
  WOORI_CONTROLLER_URL: `http://127.0.0.1:${port}`,
  WOORI_CONTROLLER_WORKER_ID: workerId,
  WOORI_CONTROLLER_HOST_LABEL: 'local-validation',
  WOORI_CONTROLLER_WORKER_TOKEN: workerToken,
  WOORI_CONTROLLER_WORKER_TOKENS: JSON.stringify({ [workerId]: workerToken }),
  WOORI_CONTROLLER_WORKER_POLICIES: JSON.stringify({ [workerId]: { os: 'windows', allowCodeChanges: false } }),
};
const cliArgs = (...args) => [path.join(repositoryRoot, 'node_modules/tsx/dist/cli.mjs'), 'apps/cli/src/index.ts', ...args];

function runWorker(args, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, cliArgs('worker', ...args), { cwd: repositoryRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Worker command timed out.')); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Worker command failed (${code}): ${stderr.slice(-1000)}`));
      else {
        try { resolve(JSON.parse(stdout.trim())); }
        catch { reject(new Error(`Worker command returned invalid JSON: ${stderr.slice(-1000)}`)); }
      }
    });
  });
}

async function startController() {
  const child = spawn(process.execPath, cliArgs('controller', 'serve'), { cwd: repositoryRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (stdout.includes('Distributed Controller listening')) return child;
    if (child.exitCode !== null) throw new Error(`Controller failed to start: ${stderr.slice(-1000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`Controller startup timed out: ${stderr.slice(-1000)}`);
}

async function stopController(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGINT');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 5000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

function startLeaseRenewalWorker(lease) {
  const child = spawn(process.execPath, cliArgs('worker', 'heartbeat-loop', '--interval-seconds=15', `--job-id=${lease.jobId}`, `--lease-id=${lease.leaseId}`, `--fencing-token=${lease.fencingToken}`, `--policy-version=${lease.policyVersion}`), { cwd: repositoryRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  const watchers = new Set();
  const observe = chunk => { const text = chunk.toString(); for (const watcher of watchers) if (watcher.pattern.test(text)) watcher.resolve(text); };
  child.stdout.on('data', chunk => { stdout += chunk.toString(); observe(chunk); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); observe(chunk); });
  const acknowledged = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker did not acknowledge a lease renewal.')), 10_000);
    watchers.add({ pattern: /Heartbeat acknowledged/, resolve: () => { clearTimeout(timer); resolve(); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { if (!stdout.includes('Heartbeat acknowledged')) { clearTimeout(timer); reject(new Error(`Lease Worker ${lease.jobId} exited before acknowledgement (${code}): ${stderr.slice(-1000)}`)); } });
  });
  acknowledged.catch(() => {});
  const waitFor = (pattern, timeoutMs = 10_000) => new Promise((resolve, reject) => {
    if (pattern.test(stdout) || pattern.test(stderr)) { resolve(`${stdout}\n${stderr}`); return; }
    const watcher = { pattern, resolve: text => { clearTimeout(timer); watchers.delete(watcher); resolve(text); } };
    watchers.add(watcher);
    const timer = setTimeout(() => { watchers.delete(watcher); reject(new Error(`Worker did not report ${pattern}.`)); }, timeoutMs);
  });
  return { child, acknowledged, waitFor, output: () => ({ stdout, stderr }) };
}

async function stopWorker(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* The test process may already have exited. */ } resolve(); }, 1000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

let controller;
try {
  controller = await startController();
  const registration = await runWorker(['register']);
  const heartbeat = await runWorker(['heartbeat']);
  const policy = await runWorker(['policy']);

  const { approveControllerJob, controllerDashboardSnapshot, submitControllerJob } = await import(pathToFileURL(path.join(repositoryRoot, 'apps/cli/src/distributed-queue.ts')).href);
  const readOnlyJob = submitControllerJob({
    service: 'quiz', kind: 'read-only-validation', workClass: 'analysis', requiredOs: 'windows',
    idempotencyKey: `worker-smoke:${randomUUID()}`, title: 'Temporary read-only Worker integration check',
  }, databasePath);
  approveControllerJob(readOnlyJob.globalJobId, databasePath);
  const claim = await runWorker(['claim', `--job-id=${readOnlyJob.globalJobId}`, '--lease-ms=60000']);
  const lease = claim.result;
  if (!lease?.leaseId || !Number.isSafeInteger(lease.fencingToken)) throw new Error('Controller did not issue a valid Worker lease.');

  const transitions = [];
  for (const status of ['Running']) {
    const transition = await runWorker(['transition', `--job-id=${lease.jobId}`, `--lease-id=${lease.leaseId}`, `--fencing-token=${lease.fencingToken}`, `--policy-version=${lease.policyVersion}`, `--status=${status}`]);
    transitions.push(transition.result?.status ?? status);
  }

  const leaseDb = new Database(databasePath, { readonly: true, fileMustExist: true });
  const expiryBeforeRenewal = leaseDb.prepare('SELECT expires_at AS expiresAt FROM controller_jobs WHERE global_job_id=?').get(lease.jobId).expiresAt;
  leaseDb.close();
  const leaseWorker = startLeaseRenewalWorker(lease);
  try {
    await leaseWorker.acknowledged;
    const renewedDb = new Database(databasePath, { readonly: true, fileMustExist: true });
    const expiryAfterRenewal = renewedDb.prepare('SELECT expires_at AS expiresAt FROM controller_jobs WHERE global_job_id=?').get(lease.jobId).expiresAt;
    renewedDb.close();
    if (Date.parse(expiryAfterRenewal) < Date.now() + 30_000 || expiryAfterRenewal === expiryBeforeRenewal) throw new Error('Worker acknowledged but Controller did not persist a fresh lease expiry.');
    transitions.push('Lease Renewed');
  } finally {
    await stopWorker(leaseWorker.child);
  }
  for (const status of ['Testing', 'Completed']) {
    const transition = await runWorker(['transition', `--job-id=${lease.jobId}`, `--lease-id=${lease.leaseId}`, `--fencing-token=${lease.fencingToken}`, `--policy-version=${lease.policyVersion}`, `--status=${status}`]);
    transitions.push(transition.result?.status ?? status);
  }

  const expiredJob = submitControllerJob({
    service: 'quiz', kind: 'expired-lease-validation', workClass: 'analysis', requiredOs: 'windows',
    idempotencyKey: `worker-smoke-expired:${randomUUID()}`, title: 'Temporary expired lease rejection check',
  }, databasePath);
  approveControllerJob(expiredJob.globalJobId, databasePath);
  const expiredClaim = await runWorker(['claim', `--job-id=${expiredJob.globalJobId}`, '--lease-ms=60000']);
  const expiredLease = expiredClaim.result;
  const expireDb = new Database(databasePath);
  expireDb.prepare('UPDATE controller_jobs SET expires_at=? WHERE global_job_id=?').run(new Date(Date.now() - 1000).toISOString(), expiredLease.jobId);
  expireDb.close();
  const expiredWorker = startLeaseRenewalWorker(expiredLease);
  let expiredLeaseRejected = false;
  try {
    const rejection = await expiredWorker.waitFor(/LEASE_REJECTED/, 10_000);
    expiredLeaseRejected = rejection.includes('LEASE_REJECTED');
  } finally {
    await stopWorker(expiredWorker.child);
  }
  const expiredStateDb = new Database(databasePath, { readonly: true, fileMustExist: true });
  const expiredState = expiredStateDb.prepare('SELECT status,expires_at AS expiresAt FROM controller_jobs WHERE global_job_id=?').get(expiredLease.jobId);
  expiredStateDb.close();
  if (!expiredLeaseRejected || Date.parse(expiredState.expiresAt) >= Date.now()) throw new Error('Worker did not stop after the Controller rejected its expired lease.');
  const { recoverExpiredControllerJob } = await import(pathToFileURL(path.join(repositoryRoot, 'apps/cli/src/distributed-queue.ts')).href);
  recoverExpiredControllerJob({ jobId: expiredLease.jobId, processTerminated: true, verifiedBy: 'worker-process-smoke', evidence: 'Isolated Worker heartbeat process stopped after the Controller rejected an expired lease.' }, databasePath);

  const snapshot = controllerDashboardSnapshot(databasePath);
  const sameWorker = snapshot.workers.filter((worker) => worker.workerId === workerId);
  const currentAcknowledgement = snapshot.workerPolicyAcknowledgements.some((item) => item.workerId === workerId && item.policyVersion === snapshot.policyVersion);
  const blockedCodeChange = submitControllerJob({
    service: 'quiz', kind: 'feature', workClass: 'code_change', requiredOs: 'windows', complexity: 1,
    idempotencyKey: `worker-smoke-code-block:${randomUUID()}`, title: 'Temporary code-change policy gate check',
  }, databasePath);
  approveControllerJob(blockedCodeChange.globalJobId, databasePath);
  let codeChangeBlocked = false;
  try {
    const deniedClaim = await runWorker(['claim', `--job-id=${blockedCodeChange.globalJobId}`]);
    codeChangeBlocked = deniedClaim.result === null;
  } catch (error) {
    if (!(error instanceof Error) || !/code-change claims are restricted|POLICY_BLOCKED/i.test(error.message)) throw error;
    codeChangeBlocked = true;
  }

  const emergencyStopJob = submitControllerJob({
    service: 'quiz', kind: 'read-only-emergency-stop-check', workClass: 'analysis', requiredOs: 'windows',
    idempotencyKey: `worker-smoke-emergency-stop:${randomUUID()}`, title: 'Temporary emergency stop claim check',
  }, databasePath);
  approveControllerJob(emergencyStopJob.globalJobId, databasePath);
  const emergencyClaim = await runWorker(['claim', `--job-id=${emergencyStopJob.globalJobId}`, '--lease-ms=60000']);
  const emergencyLease = emergencyClaim.result;
  await runWorker(['transition', `--job-id=${emergencyLease.jobId}`, `--lease-id=${emergencyLease.leaseId}`, `--fencing-token=${emergencyLease.fencingToken}`, `--policy-version=${emergencyLease.policyVersion}`, '--status=Running']);
  const emergencyWorker = startLeaseRenewalWorker(emergencyLease);
  let emergencyPolicyVersion = 0;
  let expiryAtEmergencyStop = '';
  try {
    await emergencyWorker.acknowledged;
    const beforeStopDb = new Database(databasePath, { readonly: true, fileMustExist: true });
    expiryAtEmergencyStop = beforeStopDb.prepare('SELECT expires_at AS expiresAt FROM controller_jobs WHERE global_job_id=?').get(emergencyLease.jobId).expiresAt;
    beforeStopDb.close();
    const { getAgentPolicy, updateAgentPolicy } = await import(pathToFileURL(path.join(repositoryRoot, 'apps/cli/src/agent-policy.ts')).href);
    const beforeEmergencyStop = getAgentPolicy(databasePath);
    const emergencyStop = updateAgentPolicy({
      expectedVersion: beforeEmergencyStop.version,
      actor: 'worker-process-smoke',
      reason: 'Verify emergency stop through an active authenticated Worker process',
      patch: { emergencyStop: true },
    }, databasePath);
    if (emergencyStop.conflict) throw new Error('Could not set isolated test emergency stop policy.');
    emergencyPolicyVersion = emergencyStop.policy.version;
    const stopped = await emergencyWorker.waitFor(/POLICY_CHANGED|LEASE_REJECTED/, 20_000);
    if (!/POLICY_CHANGED|LEASE_REJECTED/.test(stopped) || emergencyPolicyVersion <= emergencyLease.policyVersion) throw new Error('The active Worker did not stop after Emergency Stop changed the policy version.');
  } finally {
    await stopWorker(emergencyWorker.child);
  }
  const afterStopDb = new Database(databasePath, { readonly: true, fileMustExist: true });
  const expiryAfterPolicyStop = afterStopDb.prepare('SELECT expires_at AS expiresAt FROM controller_jobs WHERE global_job_id=?').get(emergencyLease.jobId).expiresAt;
  afterStopDb.close();
  let emergencyStopBlocksActiveTransition = false;
  try { await runWorker(['transition', `--job-id=${emergencyLease.jobId}`, `--lease-id=${emergencyLease.leaseId}`, `--fencing-token=${emergencyLease.fencingToken}`, `--policy-version=${emergencyLease.policyVersion}`, '--status=Completed']); }
  catch (error) {
    if (!(error instanceof Error) || !/POLICY_BLOCKED|POLICY_VERSION_STALE/.test(error.message)) throw error;
    emergencyStopBlocksActiveTransition = true;
  }
  const emergencyDb = new Database(databasePath);
  emergencyDb.prepare('UPDATE controller_jobs SET expires_at=? WHERE global_job_id=?').run(new Date(Date.now() - 1000).toISOString(), emergencyLease.jobId);
  emergencyDb.close();
  recoverExpiredControllerJob({ jobId: emergencyLease.jobId, processTerminated: true, verifiedBy: 'worker-process-smoke', evidence: 'Emergency Stop terminated the isolated Worker heartbeat process; transition remained blocked.' }, databasePath);
  const blockedNewClaimJob = submitControllerJob({ service: 'quiz', kind: 'emergency-stop-claim-check', workClass: 'analysis', requiredOs: 'windows', idempotencyKey: `worker-smoke-emergency-claim:${randomUUID()}`, title: 'Temporary Emergency Stop new claim check' }, databasePath);
  approveControllerJob(blockedNewClaimJob.globalJobId, databasePath);
  let emergencyStopBlocksNewClaim = false;
  try { await runWorker(['claim', `--job-id=${blockedNewClaimJob.globalJobId}`]); }
  catch (error) {
    if (!(error instanceof Error) || !/POLICY_BLOCKED/.test(error.message)) throw error;
    emergencyStopBlocksNewClaim = true;
  }

  await stopController(controller);
  controller = await startController();
  const reconnected = await runWorker(['register']);
  const afterReconnect = controllerDashboardSnapshot(databasePath);

  console.log(JSON.stringify({
    status: 'Passed',
    isolatedTemporaryControllerDatabase: true,
    separateControllerAndWorkerProcesses: true,
    workerId,
    tokenValuesPrinted: false,
    registration: registration.result?.state,
    heartbeat: heartbeat.result?.state,
    policyVersion: policy.version,
    policyAcknowledged: currentAcknowledgement,
    workerCapability: sameWorker[0]?.capabilities,
    lease: { status: lease.status, fencingTokenIssued: Number.isSafeInteger(lease.fencingToken), jobId: lease.jobId },
    transitions,
    finalJobStatus: snapshot.jobs.find((job) => job.globalJobId === lease.jobId)?.status,
    expiredLeaseRejectedByWorkerProcess: expiredLeaseRejected,
    codeChangeBlockedUnderDefaultPolicy: codeChangeBlocked,
    emergencyStopBlocksActiveTransition,
    activeWorkerStoppedOnNewPolicyVersion: emergencyPolicyVersion > emergencyLease.policyVersion,
    leaseNotRenewedAfterEmergencyStop: expiryAfterPolicyStop === expiryAtEmergencyStop,
    emergencyStopBlocksNewClaim,
    reconnectState: reconnected.result?.state,
    workerCountAfterReconnect: afterReconnect.workers.filter((worker) => worker.workerId === workerId).length,
    heartbeatTimestampPresent: Boolean(afterReconnect.workers.find((worker) => worker.workerId === workerId)?.heartbeatAt),
  }));
} finally {
  await stopController(controller);
  const resolvedTemp = path.resolve(testRoot);
  if (!resolvedTemp.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Refusing to remove an unexpected Worker smoke-test path.');
  fs.rmSync(resolvedTemp, { recursive: true, force: true });
}
