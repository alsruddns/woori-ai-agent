import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
  const claim = await runWorker(['claim']);
  const lease = claim.result;
  if (!lease?.leaseId || !Number.isSafeInteger(lease.fencingToken)) throw new Error('Controller did not issue a valid Worker lease.');

  const transitions = [];
  for (const status of ['Running', 'Testing', 'Completed']) {
    const transition = await runWorker(['transition', `--job-id=${lease.jobId}`, `--lease-id=${lease.leaseId}`, `--fencing-token=${lease.fencingToken}`, `--policy-version=${lease.policyVersion}`, `--status=${status}`]);
    transitions.push(transition.result?.status ?? status);
  }

  const snapshot = controllerDashboardSnapshot(databasePath);
  const sameWorker = snapshot.workers.filter((worker) => worker.workerId === workerId);
  const currentAcknowledgement = snapshot.workerPolicyAcknowledgements.some((item) => item.workerId === workerId && item.policyVersion === snapshot.policyVersion);
  const blockedCodeChange = submitControllerJob({
    service: 'quiz', kind: 'feature', workClass: 'code_change', requiredOs: 'windows', complexity: 1,
    idempotencyKey: `worker-smoke-code-block:${randomUUID()}`, title: 'Temporary code-change policy gate check',
  }, databasePath);
  approveControllerJob(blockedCodeChange.globalJobId, databasePath);
  const deniedClaim = await runWorker(['claim']);

  const { getAgentPolicy, updateAgentPolicy } = await import(pathToFileURL(path.join(repositoryRoot, 'apps/cli/src/agent-policy.ts')).href);
  const beforeEmergencyStop = getAgentPolicy(databasePath);
  const emergencyStop = updateAgentPolicy({
    expectedVersion: beforeEmergencyStop.version,
    actor: 'worker-process-smoke',
    reason: 'Verify emergency stop through a real authenticated Worker process',
    patch: { emergencyStop: true },
  }, databasePath);
  if (emergencyStop.conflict) throw new Error('Could not set isolated test emergency stop policy.');
  await runWorker(['policy']);
  const emergencyStopJob = submitControllerJob({
    service: 'quiz', kind: 'read-only-emergency-stop-check', workClass: 'analysis', requiredOs: 'windows',
    idempotencyKey: `worker-smoke-emergency-stop:${randomUUID()}`, title: 'Temporary emergency stop claim check',
  }, databasePath);
  approveControllerJob(emergencyStopJob.globalJobId, databasePath);
  let emergencyStopBlocksNewClaim = false;
  try { await runWorker(['claim']); }
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
    codeChangeBlockedUnderDefaultPolicy: deniedClaim.result === null,
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
