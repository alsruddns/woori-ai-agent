import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import net from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  claimControllerJob, currentControllerLease, assertCurrentControllerLease,
  heartbeatControllerWorker, recordControllerNonce, registerControllerWorker, workerMatchesControllerPolicy,
  renewControllerLease, submitControllerJob, transitionControllerJob, controllerJobStatuses,
} from './distributed-queue.js';
import type { ControllerWorkerPolicy, WorkerOs } from './distributed-queue.js';

const envTokens = () => {
  const raw = process.env.WOORI_CONTROLLER_WORKER_TOKENS;
  if (!raw) return {} as Record<string, string>;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('WOORI_CONTROLLER_WORKER_TOKENS must be a JSON object.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Controller Worker token configuration is invalid.');
  const tokens = parsed as Record<string, unknown>;
  for (const [id, token] of Object.entries(tokens)) if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,100}$/.test(id) || typeof token !== 'string' || token.length < 32) throw new Error('Each configured Worker credential must have a valid ID and at least 32 characters.');
  return tokens as Record<string, string>;
};

const envWorkerPolicies = () => {
  const raw = process.env.WOORI_CONTROLLER_WORKER_POLICIES;
  if (!raw) return {} as Record<string, ControllerWorkerPolicy>;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('WOORI_CONTROLLER_WORKER_POLICIES must be a JSON object.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Controller Worker policy configuration is invalid.');
  const policies: Record<string, ControllerWorkerPolicy> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,100}$/.test(id) || !value || typeof value !== 'object') throw new Error('Controller Worker policy is invalid.');
    const policy = value as { os?: WorkerOs; allowCodeChanges?: boolean };
    if (!['windows', 'linux'].includes(String(policy.os)) || typeof policy.allowCodeChanges !== 'boolean' || policy.allowCodeChanges && policy.os !== 'windows') throw new Error('Worker policy must declare its OS; only a trusted Windows Worker can be provisioned for code-change claims.');
    policies[id] = { os: policy.os!, allowCodeChanges: policy.allowCodeChanges };
  }
  return policies;
};

type ControllerOptions = { host?: string; port?: number; dbPath?: string; workerTokens?: Record<string, string>; workerPolicies?: Record<string, ControllerWorkerPolicy>; tlsKey?: string; tlsCert?: string; privateNetworkEnabled?: boolean };
const isLoopback = (host: string) => ['127.0.0.1', '::1', 'localhost'].includes(host);
const isPrivateAddress = (host: string) => {
  const octets = host.split('.').map(Number);
  if (octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
    return octets[0] === 10 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31;
  }
  const ipv6 = host.toLowerCase();
  return net.isIP(host) === 6 && (ipv6.startsWith('fc') || ipv6.startsWith('fd'));
};

export function createDistributedControllerServer(options: ControllerOptions = {}) {
  const host = options.host ?? process.env.WOORI_CONTROLLER_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.WOORI_CONTROLLER_PORT ?? 4180);
  const dbPath = options.dbPath;
  const tokens = options.workerTokens ?? envTokens();
  const workerPolicies = options.workerPolicies ?? envWorkerPolicies();
  for (const [id, policy] of Object.entries(workerPolicies)) if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,100}$/.test(id) || !policy || !['windows', 'linux'].includes(policy.os) || typeof policy.allowCodeChanges !== 'boolean' || policy.allowCodeChanges && policy.os !== 'windows') throw new Error('Invalid Controller-provisioned Worker policy. Linux code modification cannot be provisioned.');
  const tlsKey = options.tlsKey ?? process.env.WOORI_CONTROLLER_TLS_KEY_FILE;
  const tlsCert = options.tlsCert ?? process.env.WOORI_CONTROLLER_TLS_CERT_FILE;
  const privateNetworkEnabled = options.privateNetworkEnabled ?? process.env.WOORI_CONTROLLER_PRIVATE_NETWORK === 'true';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid Controller port.');
  if (!isLoopback(host) && (!isPrivateAddress(host) || !privateNetworkEnabled || !tlsKey || !tlsCert || Object.keys(tokens).length === 0)) throw new Error('Remote Controller binding requires an RFC1918/ULA address, explicit private-network opt-in, TLS key/certificate, and Worker credentials.');
  if (Boolean(tlsKey) !== Boolean(tlsCert)) throw new Error('Both Controller TLS key and certificate files are required.');
  const handler: http.RequestListener = (req, res) => {
    const respond = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/')) { respond(404, { error: 'not_found' }); return; }
    let body = ''; let oversized = false;
    req.on('data', chunk => { if (oversized) return; body += chunk.toString(); if (body.length > 16_384) { oversized = true; body = ''; } });
    req.on('end', () => {
      if (oversized) { respond(413, { error: 'request_too_large' }); return; }
      try {
        const workerId = req.headers['x-woori-worker-id'];
        const timestamp = Number(req.headers['x-woori-timestamp']);
        const nonce = req.headers['x-woori-nonce'];
        const requestId = req.headers['x-woori-request-id'];
        const authorization = req.headers.authorization;
        if (typeof workerId !== 'string' || typeof nonce !== 'string' || typeof requestId !== 'string' || !/^[a-f0-9-]{32,64}$/i.test(requestId) || typeof authorization !== 'string') { respond(401, { error: 'authentication_required' }); return; }
        const token = tokens[workerId]; const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        if (!token || supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { respond(401, { error: 'authentication_failed' }); return; }
        const policy = workerPolicies[workerId];
        if (!policy) { respond(403, { error: 'worker_not_provisioned' }); return; }
        recordControllerNonce(workerId, nonce, timestamp, dbPath);
        if (req.url !== '/v1/workers/register' && req.url !== '/v1/workers/heartbeat' && !workerMatchesControllerPolicy(workerId, policy, dbPath)) { respond(403, { error: 'worker_policy_mismatch' }); return; }
        const input = body ? JSON.parse(body) : {};
        let result: unknown;
        if (req.url === '/v1/workers/register') result = registerControllerWorker({ ...input, workerId }, dbPath, policy);
        else if (req.url === '/v1/workers/heartbeat') result = heartbeatControllerWorker({ ...input, workerId }, dbPath, policy);
        else if (req.url === '/v1/jobs/submit') result = submitControllerJob(input, dbPath);
        else if (req.url === '/v1/jobs/status') result = controllerJobStatuses(input.jobIds, dbPath);
        else if (req.url === '/v1/jobs/claim') result = currentControllerLease(workerId, dbPath) ?? claimControllerJob(workerId, input.leaseMs, dbPath, policy);
        else if (req.url === '/v1/jobs/approve-local') { respond(403, { error: 'operator_action_is_local_only' }); return; }
        else if (req.url === '/v1/leases/renew') result = renewControllerLease({ ...input, workerId }, input.leaseMs, dbPath);
        else if (req.url === '/v1/jobs/transition') result = transitionControllerJob({ ...input, workerId }, dbPath);
        else if (req.url === '/v1/leases/assert') result = { valid: Boolean(assertLease(input, workerId, dbPath)) };
        else { respond(404, { error: 'not_found' }); return; }
        const response = { requestId, result };
        respond(200, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'request_failed';
        const status = /credential|authentication|nonce|timestamp/i.test(message) ? 401 : /stale|expired|fencing|lease/i.test(message) ? 409 : 400;
        respond(status, { error: message });
      }
    });
  };
  const server = tlsKey && tlsCert
    ? https.createServer({ key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCert), minVersion: 'TLSv1.2' }, handler)
    : http.createServer(handler);
  return { server, host, port, listen: () => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve()); }), close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

function assertLease(input: { jobId: string; fencingToken: number }, workerId: string, dbPath?: string) {
  return assertCurrentControllerLease({ jobId: input.jobId, workerId, fencingToken: input.fencingToken }, dbPath);
}

export async function controllerWorkerRequest<T>(endpoint: string, body: unknown, options: { workerId?: string; token?: string; timeoutMs?: number } = {}): Promise<T> {
  const workerId = options.workerId ?? process.env.WOORI_CONTROLLER_WORKER_ID ?? '';
  const token = options.token ?? process.env.WOORI_CONTROLLER_WORKER_TOKEN ?? '';
  if (!workerId || token.length < 32) throw new Error('Controller Worker credentials are not configured.');
  const base = process.env.WOORI_CONTROLLER_URL ?? '';
  if (!base) throw new Error('WOORI_CONTROLLER_URL is not configured; ownership is not acquired offline.');
  const url = new URL(endpoint, base);
  const local = isLoopback(url.hostname.replace(/^\[|\]$/g, ''));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Remote Controller communication requires HTTPS.');
  if (!local && !isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Remote Controller URL must use a private IP address; public endpoints and unverified hostnames are blocked.');
  const requestId = randomUUID(), timestamp = String(Date.now()), nonce = randomUUID();
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-woori-worker-id': workerId, 'x-woori-timestamp': timestamp, 'x-woori-nonce': nonce, 'x-woori-request-id': requestId }, body: JSON.stringify(body), signal: AbortSignal.timeout(options.timeoutMs ?? 5_000) });
  const payload = await response.json() as { error?: string; result?: T; requestId?: string };
  if (!response.ok) throw new Error(`Controller request rejected (${response.status}): ${payload.error ?? 'unknown_error'}`);
  if (payload.requestId !== requestId) throw new Error('Controller response request ID mismatch.');
  return payload.result as T;
}

export async function registerWorkerWithController(input: Omit<import('./distributed-queue.js').ControllerWorkerInput, 'workerId'>) {
  return controllerWorkerRequest('/v1/workers/register', input);
}

export async function heartbeatWorkerWithController(input: Omit<import('./distributed-queue.js').ControllerWorkerInput, 'workerId'>) {
  return controllerWorkerRequest('/v1/workers/heartbeat', input);
}

export function ensureDevelopmentGlobalJobMap(db: Database.Database) {
  db.exec('CREATE TABLE IF NOT EXISTS development_global_job_map(local_task_id TEXT PRIMARY KEY,global_job_id TEXT NOT NULL UNIQUE,controller_status TEXT NOT NULL DEFAULT \'Not Synced\',updated_at TEXT NOT NULL)');
  const columns = db.prepare('PRAGMA table_info(development_global_job_map)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'controller_status')) db.exec("ALTER TABLE development_global_job_map ADD COLUMN controller_status TEXT NOT NULL DEFAULT 'Not Synced'");
}

export async function submitWorkerQueueToController() {
  const { initDb } = await import('./core.js');
  const db = initDb();
  ensureDevelopmentGlobalJobMap(db);
  const rows = db.prepare("SELECT task_id AS taskId,service,kind,title,evidence,status FROM development_tasks WHERE status='Ready' ORDER BY updated_at").all() as Array<{ taskId: string; service: string; kind: string; title: string; evidence: string; status: string }>;
  const mapped = new Map((db.prepare('SELECT local_task_id AS localTaskId,global_job_id AS globalJobId FROM development_global_job_map').all() as Array<{ localTaskId: string; globalJobId: string }>).map(row => [row.localTaskId, row.globalJobId]));
  db.close();
  const results: Array<{ localTaskId: string; globalJobId?: string; status: string; reason?: string }> = [];
  const synchronized: Array<{ localTaskId: string; globalJobId: string }> = [];
  for (const row of rows) {
    if (mapped.has(row.taskId)) { synchronized.push({ localTaskId: row.taskId, globalJobId: mapped.get(row.taskId)! }); results.push({ localTaskId: row.taskId, globalJobId: mapped.get(row.taskId), status: 'Previously Synced' }); continue; }
    if (row.service === 'money') { results.push({ localTaskId: row.taskId, status: 'Blocked', reason: 'MoneyBook is excluded.' }); continue; }
    const workClass = /^(qa|seo|content|competitor|growth|ux|performance|localization|ads|change|analytics|improvement)$/i.test(row.kind) ? 'analysis' : 'code_change';
    let result: { globalJobId: string; status: string };
    try { result = await controllerWorkerRequest<{ globalJobId: string; status: string }>('/v1/jobs/submit', {
      localTaskId: row.taskId, service: row.service, kind: row.kind, workClass,
      requiredOs: workClass === 'code_change' ? 'windows' : 'any',
      idempotencyKey: `local-task:${row.service}:${row.taskId}`, title: row.title, evidence: row.evidence,
      resourceKeys: workClass === 'code_change' ? [`service:${row.service}`] : [],
    }); } catch (error) { results.push({ localTaskId: row.taskId, status: 'Blocked', reason: error instanceof Error ? error.message : 'Controller rejected job.' }); continue; }
    const localDb = initDb();
    localDb.prepare("INSERT OR IGNORE INTO development_global_job_map(local_task_id,global_job_id,controller_status,updated_at) VALUES(?,?,?,?)").run(row.taskId, result.globalJobId, result.status, new Date().toISOString());
    localDb.close();
    synchronized.push({ localTaskId: row.taskId, globalJobId: result.globalJobId });
    results.push({ localTaskId: row.taskId, globalJobId: result.globalJobId, status: result.status });
  }
  const statuses = await controllerWorkerRequest<Array<{ globalJobId: string; status: string }>>('/v1/jobs/status', { jobIds: synchronized.map(item => item.globalJobId) });
  const localDb = initDb();
  const update = localDb.prepare('UPDATE development_global_job_map SET controller_status=?,updated_at=? WHERE global_job_id=?');
  const tx = localDb.transaction((items: typeof statuses) => items.forEach(item => update.run(item.status, new Date().toISOString(), item.globalJobId)));
  tx(statuses); localDb.close();
  return { found: rows.length, synced: synchronized.length, results: results.map(item => ({ ...item, ...(statuses.find(status => status.globalJobId === item.globalJobId) ? { status: statuses.find(status => status.globalJobId === item.globalJobId)!.status } : {}) })) };
}

export function controllerNetworkPolicy(host: string, httpsEnabled: boolean, privateNetworkEnabled: boolean) {
  return isLoopback(host) || isPrivateAddress(host) && httpsEnabled && privateNetworkEnabled;
}
