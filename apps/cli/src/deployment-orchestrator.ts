import { initDb } from './core.js';
import {linkExternalEvidenceByCommit} from './development-audit.js';
import { spawnSync } from 'node:child_process';

export type MergeDeployGateInput = {
  service: string;
  prNumber: number;
  prHeadSha: string;
  approvedHeadSha?: string;
  approvedTarget?: string;
  target: string;
  authorizedTask: boolean;
  localValidationPassed: boolean;
  changedFilesAllowed: boolean;
  ciPassedForHead: boolean;
  requiredChecksPresent: boolean;
  conflictFree: boolean;
  secretsClear: boolean;
  deploymentRiskReviewed: boolean;
  approvedByUser: boolean;
};

const shaPattern = /^[a-f0-9]{40}$/i;
const deployableServices = new Set(['home', 'calculator', 'tools', 'docs', 'quiz']);

export function assessMergeDeployGate(input: MergeDeployGateInput) {
  const blocked: string[] = [];
  if (!deployableServices.has(input.service)) blocked.push('Service is outside the deployment allowlist.');
  if (input.service === 'calculator') blocked.push('Calculator automated changes and deployment remain locked.');
  if (!Number.isInteger(input.prNumber) || input.prNumber < 1) blocked.push('A valid pull request number is required.');
  if (!shaPattern.test(input.prHeadSha)) blocked.push('Current PR head SHA is invalid.');
  if (input.target !== 'main') blocked.push('Production deployment target must be the verified main branch.');
  if (!input.authorizedTask) blocked.push('The development task has no recorded approval.');
  if (!input.localValidationPassed) blocked.push('Local validation has not passed.');
  if (!input.changedFilesAllowed) blocked.push('Changed files exceed the approved scope.');
  if (!input.ciPassedForHead) blocked.push('Required CI has not passed for the current PR head SHA.');
  if (!input.requiredChecksPresent) blocked.push('Required checks are missing or not configured.');
  if (!input.conflictFree) blocked.push('The pull request has conflicts.');
  if (!input.secretsClear) blocked.push('Secret scanning is not clear.');
  if (!input.deploymentRiskReviewed) blocked.push('Deployment risk has not been reviewed.');
  if (!input.approvedByUser) blocked.push('Explicit user approval for this exact SHA and deployment target is missing.');
  if (input.approvedHeadSha !== input.prHeadSha) blocked.push('Approval SHA does not match the current PR head; approval is stale.');
  if (input.approvedTarget !== input.target) blocked.push('Approval target does not match the requested deployment target.');
  return { ready: blocked.length === 0, status: blocked.length === 0 ? 'Ready for separately controlled execution' : 'Awaiting Approval', blocked };
}

export function classifyDeploymentRisk(changedFiles: string[]) {
  const protectedPatterns = [
    /(^|\/)(ads\.txt|robots\.txt)$/i,
    /adsense|ads-by-google|publisher/i,
    /privacy|terms|policy/i,
    /sitemap|canonical|hreflang|metadata|seo/i,
    /locale|i18n|translation/i,
    /(^|\/)app\/.*\/(page|layout)\.[^/]+$/i
  ];
  const highRiskFiles = [...new Set(changedFiles.map(file => file.replace(/\\/g, '/')))].filter(file => protectedPatterns.some(pattern => pattern.test(file)));
  return {
    level: highRiskFiles.length ? 'High' : 'Review Required',
    requiresManualReview: true,
    highRiskFiles,
    reason: highRiskFiles.length
      ? 'Sensitive public, AdSense, SEO, or locale surface changed; manual review is required.'
      : 'Every production change requires a user review; automated risk classification is advisory.'
  };
}

export function assessPostDeploymentVerification(input: {
  deploymentRun: 'success' | 'failure' | 'in_progress' | 'unknown';
  containerHealth: 'passed' | 'failed' | 'unknown';
  httpSmoke: 'passed' | 'failed' | 'not_run';
  playwrightSmoke: 'passed' | 'failed' | 'not_run';
  pageErrors: number | null;
  seoMetadata: 'passed' | 'failed' | 'not_run';
}) {
  if (input.deploymentRun === 'in_progress') return { status: 'Deploying', serviceHealthy: false, blockers: ['Deployment workflow is still running.'] };
  if (input.deploymentRun !== 'success') return { status: 'Deployment Failed', serviceHealthy: false, blockers: ['No successful deployment run is recorded.'] };
  const blockers: string[] = [];
  if (input.containerHealth === 'failed') blockers.push('Container healthcheck failed.');
  if (input.httpSmoke === 'failed') blockers.push('HTTP smoke failed.');
  if (input.playwrightSmoke === 'failed') blockers.push('Playwright smoke failed.');
  if (input.pageErrors !== null && input.pageErrors > 0) blockers.push(`Browser pageerror count is ${input.pageErrors}.`);
  if (input.seoMetadata === 'failed') blockers.push('SEO metadata validation failed.');
  if (blockers.length) return { status: 'Service Verification Failed', serviceHealthy: false, blockers };
  const missing: string[] = [];
  if (input.containerHealth !== 'passed') missing.push('container healthcheck');
  if (input.httpSmoke !== 'passed') missing.push('HTTP smoke');
  if (input.playwrightSmoke !== 'passed') missing.push('Playwright smoke');
  if (input.pageErrors === null) missing.push('browser pageerror check');
  if (input.seoMetadata !== 'passed') missing.push('SEO metadata');
  if (missing.length) return { status: 'Verification Incomplete', serviceHealthy: false, blockers: missing.map(item => `${item} has no passing evidence.`) };
  return { status: 'Verified', serviceHealthy: true, blockers: [] };
}

export type DeploymentEvidence = {
  workflowConclusion: 'success' | 'failure' | 'cancelled' | 'unknown';
  deployStepConclusion: 'success' | 'failure' | 'skipped' | 'unknown';
  deploymentSha: string | null;
  runtimeImageRevision: string | null;
  runtimeImageDigest: string | null;
  expectedImageDigest: string | null;
  healthcheck: 'passed' | 'failed' | 'unknown';
  postDeployQa: 'passed' | 'failed' | 'not_run';
};

/** Keeps workflow, deployment, runtime identity, health, and browser QA as separate evidence claims. */
export function classifyDeploymentEvidence(input: DeploymentEvidence) {
  const workflowSucceeded = input.workflowConclusion === 'success';
  const deploymentConfirmed = workflowSucceeded && input.deployStepConclusion === 'success';
  const runtimeVersionConfirmed = Boolean(
    deploymentConfirmed && input.deploymentSha && input.runtimeImageRevision === input.deploymentSha &&
    input.runtimeImageDigest && input.expectedImageDigest === input.runtimeImageDigest
  );
  const healthcheckPassed = deploymentConfirmed && input.healthcheck === 'passed';
  const postDeployQaPassed = deploymentConfirmed && input.postDeployQa === 'passed';
  const fullyVerified = workflowSucceeded && deploymentConfirmed && runtimeVersionConfirmed && healthcheckPassed && postDeployQaPassed;
  return {
    workflowSucceeded,
    deploymentConfirmed,
    runtimeVersionConfirmed,
    healthcheckPassed,
    postDeployQaPassed,
    fullyVerified,
    status: fullyVerified ? 'Fully Verified' : workflowSucceeded ? 'Workflow Succeeded' : input.workflowConclusion === 'failure' ? 'Workflow Failed' : 'Unconfirmed',
    blockers: [
      ...(!workflowSucceeded ? ['Deployment workflow has not succeeded.'] : []),
      ...(workflowSucceeded && !deploymentConfirmed ? ['The deployment step has no successful result.'] : []),
      ...(deploymentConfirmed && !runtimeVersionConfirmed ? ['The running container image revision and digest are not confirmed.'] : []),
      ...(deploymentConfirmed && !healthcheckPassed ? ['A passing runtime healthcheck is not recorded.'] : []),
      ...(deploymentConfirmed && !postDeployQaPassed ? ['Post-deployment Playwright/SEO QA is not recorded as passed.'] : [])
    ]
  };
}

export function assessRollbackReadiness(service: string) {
  if (service === 'home') return { status: 'Guarded workflow path exists; operator approval and run-specific review required', automatic: false };
  if (deployableServices.has(service)) return { status: 'Not Configured: no verified rollback mechanism recorded', automatic: false };
  return { status: 'Excluded', automatic: false };
}

export type DeploymentRecordInput = {
  service: string;
  prNumber?: number;
  headSha: string;
  target: string;
  status: 'Awaiting Approval' | 'Deploying' | 'Deployed' | 'Failed' | 'Verified' | 'Rolled Back';
  runId?: number;
  runUrl?: string;
  detail?: string;
  expectedImageDigest?: string;
  startedAt?: string;
  finishedAt?: string;
};

type DeploymentService = { service: string; repository: string; workflow: string; job: string; deployStep: string };
const deploymentServices: DeploymentService[] = [
  { service: 'home', repository: 'alsruddns/woori-home', workflow: 'publish.yml', job: 'deploy', deployStep: 'Deploy only the portal service' },
  { service: 'calculator', repository: 'alsruddns/woori-calculator', workflow: 'deploy.yml', job: 'build-and-deploy', deployStep: 'Deploy to iwinv' },
  { service: 'tools', repository: 'alsruddns/woori-tools', workflow: 'deploy.yml', job: 'build-and-deploy', deployStep: 'Deploy on iwinv' },
  { service: 'docs', repository: 'alsruddns/woori-docs', workflow: 'deploy.yml', job: 'build-and-deploy', deployStep: 'Deploy on iwinv' },
  { service: 'quiz', repository: 'alsruddns/woori-quiz', workflow: 'deploy.yml', job: 'build-and-deploy', deployStep: 'Deploy on iwinv' }
];
type RunEvidence = { databaseId: number; workflowName: string; status: string; conclusion: string | null; url: string | null; createdAt: string | null; updatedAt: string | null; headSha: string; event: string; headBranch: string };
type StepEvidence = { name: string; status: string; conclusion: string | null };
type JobEvidence = { name: string; status: string; conclusion: string | null; startedAt: string | null; completedAt: string | null; steps: StepEvidence[] };

export function classifyDeploymentRun(service: DeploymentService, run: RunEvidence, jobs: JobEvidence[]) {
  if (run.headBranch !== 'main' || !['push', 'workflow_dispatch', 'schedule'].includes(run.event)) return null;
  const evidence = (deployStepConclusion: DeploymentEvidence['deployStepConclusion']) => classifyDeploymentEvidence({
    workflowConclusion: (['success', 'failure', 'cancelled'].includes(run.conclusion ?? '') ? run.conclusion : 'unknown') as DeploymentEvidence['workflowConclusion'],
    deployStepConclusion,
    deploymentSha: run.headSha,
    runtimeImageRevision: null,
    runtimeImageDigest: null,
    expectedImageDigest: null,
    healthcheck: 'unknown',
    postDeployQa: 'not_run'
  });
  const deployJob = jobs.find(job => job.name === service.job);
  const step = deployJob?.steps.find(item => item.name === service.deployStep);
  if (!deployJob || !step || step.conclusion === 'skipped') return null;
  if (step.status !== 'completed') return { status: 'Deploying' as const, evidence: evidence('unknown'), detail: `GitHub deployment step is ${step.status}.`, startedAt: deployJob.startedAt ?? run.createdAt, finishedAt: null };
  if (step.conclusion !== 'success') return { status: 'Failed' as const, evidence: evidence('failure'), detail: `GitHub deployment step concluded ${step.conclusion ?? 'without a result'}; deployment and service state need review.`, startedAt: deployJob.startedAt ?? run.createdAt, finishedAt: deployJob.completedAt ?? run.updatedAt };
  return { status: 'Deployed' as const, evidence: evidence('success'), detail: `Deployment step succeeded in workflow ${run.workflowName}; runtime image identity, healthcheck evidence, and post-deployment QA remain separately unconfirmed.`, startedAt: deployJob.startedAt ?? run.createdAt, finishedAt: deployJob.completedAt ?? run.updatedAt };
}

type GhRunner = (args: string[]) => { ok: boolean; stdout: string };
const runGh: GhRunner = args => {
  const result = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 8_000_000 });
  return { ok: result.status === 0, stdout: result.status === 0 ? result.stdout : '' };
};

/** Opt-in read-only GitHub query; stores deployment step evidence and never dispatches or changes a workflow. */
export function refreshDeploymentRuns(runner: GhRunner = runGh) {
  const results: Array<{ service: string; status: string; runId?: number; headSha?: string; expectedImageDigest?: string; evidence?: ReturnType<typeof classifyDeploymentEvidence>; reason?: string }> = [];
  for (const service of deploymentServices) {
    const listed = runner(['run', 'list', '--repo', service.repository, '--workflow', service.workflow, '--branch', 'main', '--limit', '3', '--json', 'databaseId,workflowName,status,conclusion,url,createdAt,updatedAt,headSha,event,headBranch']);
    if (!listed.ok) { results.push({ service: service.service, status: 'Query Failed', reason: 'Could not read deployment workflow runs; no success was inferred.' }); continue; }
    let runs: RunEvidence[];
    try { runs = JSON.parse(listed.stdout) as RunEvidence[]; } catch { results.push({ service: service.service, status: 'Query Failed', reason: 'GitHub returned an unreadable workflow run response.' }); continue; }
    let observed = false;
    for (const run of runs) {
      const viewed = runner(['run', 'view', String(run.databaseId), '--repo', service.repository, '--json', 'jobs']);
      if (!viewed.ok) { results.push({ service: service.service, status: 'Query Failed', runId: run.databaseId, headSha: run.headSha, reason: 'Could not read the deployment job evidence.' }); observed = true; break; }
      let jobs: JobEvidence[];
      try { jobs = (JSON.parse(viewed.stdout) as { jobs: JobEvidence[] }).jobs; } catch { results.push({ service: service.service, status: 'Query Failed', runId: run.databaseId, headSha: run.headSha, reason: 'GitHub returned unreadable deployment job evidence.' }); observed = true; break; }
      const classified = classifyDeploymentRun(service, run, jobs);
      if (!classified) continue;
      const expectedImageDigest = classified.status === 'Deployed' ? extractWorkflowImageDigest(runner(['run', 'view', String(run.databaseId), '--repo', service.repository, '--log']).stdout, service, run) : undefined;
      recordDeploymentState({ service: service.service, headSha: run.headSha, target: 'main', status: classified.status, runId: run.databaseId, runUrl: run.url ?? undefined, detail: classified.detail, expectedImageDigest, startedAt: classified.startedAt ?? undefined, finishedAt: classified.finishedAt ?? undefined });
      linkExternalEvidenceByCommit(service.service,run.headSha,'DEPLOYMENT_EVIDENCE_OBSERVED',{workflow:run.workflowName,runId:run.databaseId,runUrl:run.url??null,status:classified.status,imageDigest:expectedImageDigest??null,detail:classified.detail,startedAt:classified.startedAt??null,finishedAt:classified.finishedAt??null,claim:'Recorded GitHub workflow evidence; runtime is not implied.'},'deployment-run:'+run.databaseId);
      results.push({ service: service.service, status: classified.status, runId: run.databaseId, headSha: run.headSha, expectedImageDigest, evidence: classified.evidence });
      observed = true; break;
    }
    if (!observed) results.push({ service: service.service, status: 'No Deployment Evidence', reason: 'No recent main workflow run contained a successful/attempted production deploy step.' });
  }
  return { checkedAt: new Date().toISOString(), mode: 'read-only GitHub Actions query', externalActionsPerformed: false, services: results };
}

function extractWorkflowImageDigest(log: string, service: DeploymentService, run: RunEvidence) {
  const explicit = /Calculator image digest:\s*(sha256:[a-f0-9]{64})/i.exec(log)?.[1];
  if (explicit) return explicit;
  const lines = log.split(/\r?\n/);
  let pendingDigest: string | undefined;
  for (const line of lines) {
    const digest = /"containerimage\.digest"\s*:\s*"(sha256:[a-f0-9]{64})"/i.exec(line)?.[1];
    if (digest) pendingDigest = digest;
    const imageName = /"image\.name"\s*:\s*"([^"]+)"/i.exec(line)?.[1];
    if (imageName && pendingDigest) {
      const matchingTag = service.service === 'home'
        ? imageName.includes(`:${run.headSha}-${run.databaseId}-`)
        : imageName.includes(run.headSha);
      if (matchingTag) return pendingDigest;
      pendingDigest = undefined;
    }
  }
  return undefined;
}

function schema() {
  const db = initDb();
  db.exec(`CREATE TABLE IF NOT EXISTS deployment_records(
    deployment_key TEXT PRIMARY KEY, service TEXT NOT NULL, pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL,
    run_id INTEGER, run_url TEXT, detail TEXT, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(service, pr_number, head_sha, target)
  );`);
  for (const [column, definition] of [['started_at', 'TEXT'], ['finished_at', 'TEXT']] as const) try { db.exec(`ALTER TABLE deployment_records ADD COLUMN ${column} ${definition}`); } catch { /* existing schema already migrated */ }
  const uniqueIndexes = db.prepare("PRAGMA index_list('deployment_records')").all() as Array<{ name: string; unique: number; origin: string }>;
  if (uniqueIndexes.some(index => index.unique === 1 && index.origin === 'u')) {
    db.exec(`ALTER TABLE deployment_records RENAME TO deployment_records_legacy;
      CREATE TABLE deployment_records(deployment_key TEXT PRIMARY KEY,service TEXT NOT NULL,pr_number INTEGER NOT NULL,head_sha TEXT NOT NULL,target TEXT NOT NULL,status TEXT NOT NULL,run_id INTEGER,run_url TEXT,detail TEXT,started_at TEXT,finished_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT OR IGNORE INTO deployment_records SELECT deployment_key,service,pr_number,head_sha,target,status,run_id,run_url,detail,started_at,finished_at,created_at,updated_at FROM deployment_records_legacy;
      DROP TABLE deployment_records_legacy;`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_deployment_records_service ON deployment_records(service, updated_at)');
  try { db.exec('ALTER TABLE deployment_records ADD COLUMN expected_image_digest TEXT'); } catch { /* existing schema already migrated */ }
  db.close();
}

/** Stores an idempotent request/evidence record only. It never merges, pushes, dispatches a workflow, or deploys. */
export function recordDeploymentState(input: DeploymentRecordInput) {
  if (!deployableServices.has(input.service) || input.service === 'money') throw new Error('Service is excluded from production orchestration.');
  if (!shaPattern.test(input.headSha)) throw new Error('A full verified commit SHA is required.');
  if (input.target !== 'main') throw new Error('Deployment target must be main.');
  if (input.prNumber !== undefined && (!Number.isInteger(input.prNumber) || input.prNumber < 1)) throw new Error('Pull request number must be valid when provided.');
  schema();
  const key = input.runId !== undefined ? `run:${input.service}:${input.runId}:${input.target}` : `${input.service}:pr-${input.prNumber}:${input.headSha}:${input.target}`;
  const now = new Date().toISOString();
  const db = initDb();
  db.prepare(`INSERT INTO deployment_records(deployment_key,service,pr_number,head_sha,target,status,run_id,run_url,detail,started_at,finished_at,created_at,updated_at,expected_image_digest)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(deployment_key) DO UPDATE SET status=excluded.status,run_id=excluded.run_id,run_url=excluded.run_url,detail=excluded.detail,started_at=excluded.started_at,finished_at=excluded.finished_at,updated_at=excluded.updated_at,expected_image_digest=COALESCE(excluded.expected_image_digest,deployment_records.expected_image_digest)`)
    .run(key, input.service, input.prNumber ?? 0, input.headSha, input.target, input.status, input.runId ?? null, input.runUrl ?? null, input.detail ?? null, input.startedAt ?? null, input.finishedAt ?? null, now, now, input.expectedImageDigest ?? null);
  db.close();
  return { deploymentKey: key, stored: true, externalActionsPerformed: false };
}

export function listDeploymentRecords(limit = 50) {
  schema();
  const db = initDb();
  const records = db.prepare('SELECT deployment_key AS deploymentKey,service,pr_number AS prNumber,head_sha AS headSha,target,status,run_id AS runId,run_url AS runUrl,detail,started_at AS startedAt,finished_at AS finishedAt,created_at AS createdAt,updated_at AS updatedAt,expected_image_digest AS expectedImageDigest FROM deployment_records ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(200, limit)));
  db.close();
  return records;
}

export type RuntimeVerificationInput = {
  service: string;
  expectedSha: string;
  actualRuntimeSha?: string;
  expectedImageDigest?: string;
  actualImageDigest?: string;
  imageId?: string;
  revisionLabel?: string;
  containerHealth: 'passed' | 'failed' | 'unknown';
  workflowStatus: 'success' | 'failure' | 'unknown';
  deploymentStatus: 'confirmed' | 'failed' | 'unknown';
  postDeployQaStatus: 'passed' | 'failed' | 'not_run';
  evidenceSource: string;
  failureReason?: string;
};

const runtimeVerificationServices = new Set(['home', 'calculator', 'tools', 'docs', 'quiz']);

function runtimeVerificationSchema() {
  const db = initDb();
  db.exec(`CREATE TABLE IF NOT EXISTS deployment_verifications(
    verification_id TEXT PRIMARY KEY, service TEXT NOT NULL, expected_sha TEXT NOT NULL,
    actual_runtime_sha TEXT, expected_image_digest TEXT, actual_image_digest TEXT, image_id TEXT,
    revision_label TEXT, container_health TEXT NOT NULL, workflow_status TEXT NOT NULL,
    deployment_status TEXT NOT NULL, post_deploy_qa_status TEXT NOT NULL, verification_status TEXT NOT NULL,
    verified_at TEXT NOT NULL, evidence_source TEXT NOT NULL, failure_reason TEXT, run_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deployment_verifications_service_time ON deployment_verifications(service, verified_at DESC);
  CREATE INDEX IF NOT EXISTS idx_deployment_verifications_service_sha ON deployment_verifications(service, expected_sha, verified_at DESC);`);
  db.close();
}

function runtimeVerificationStatus(input: RuntimeVerificationInput) {
  const revisionProvided = Boolean(input.actualRuntimeSha && input.revisionLabel);
  const revisionMatches = Boolean(revisionProvided && input.actualRuntimeSha === input.expectedSha && input.revisionLabel === input.expectedSha);
  const revisionMismatch = Boolean((input.actualRuntimeSha && input.actualRuntimeSha !== input.expectedSha) || (input.revisionLabel && input.revisionLabel !== input.expectedSha));
  const digestProvided = Boolean(input.expectedImageDigest && input.actualImageDigest);
  const digestMatches = Boolean(digestProvided && input.expectedImageDigest === input.actualImageDigest);
  const digestMismatch = Boolean(digestProvided && !digestMatches);
  if (input.workflowStatus === 'failure' || input.deploymentStatus === 'failed' || input.containerHealth === 'failed' || input.postDeployQaStatus === 'failed') return 'Failed';
  if (revisionMismatch || digestMismatch) return 'Failed';
  if (input.workflowStatus !== 'success') return 'Unknown';
  if (input.deploymentStatus !== 'confirmed') return 'Workflow Succeeded';
  if (input.postDeployQaStatus === 'passed' && (!revisionMatches || !digestMatches || input.containerHealth !== 'passed')) return 'Post-deploy QA Passed';
  if (!revisionProvided || !revisionMatches || !digestMatches || input.containerHealth !== 'passed') return 'Deployment Confirmed';
  if (input.postDeployQaStatus === 'passed') return 'Fully Verified';
  return 'Runtime Verified';
}

/** Append-only manual evidence record. The expected SHA must match the latest recorded deployment for this service. */
export function recordRuntimeVerification(input: RuntimeVerificationInput) {
  if (!runtimeVerificationServices.has(input.service)) throw new Error('Service is excluded from runtime verification.');
  if (!shaPattern.test(input.expectedSha) || (input.actualRuntimeSha && !shaPattern.test(input.actualRuntimeSha))) throw new Error('Expected and actual runtime SHA values must be full commit SHAs.');
  const digestPattern = /^sha256:[a-f0-9]{64}$/i;
  if ((input.expectedImageDigest && !digestPattern.test(input.expectedImageDigest)) || (input.actualImageDigest && !digestPattern.test(input.actualImageDigest))) throw new Error('Image digests must use the sha256:<64 hex> format.');
  if (input.revisionLabel && !shaPattern.test(input.revisionLabel)) throw new Error('OCI revision label must be a full commit SHA.');
  if (!input.evidenceSource.trim()) throw new Error('An evidence source is required.');
  const latest = listDeploymentRecords(200) as Array<{ service: string; target: string; headSha: string; status: string; runId: number | null; expectedImageDigest: string | null }>;
  const current = latest.find(item => item.service === input.service && item.target === 'main' && ['Deployed', 'Verified'].includes(item.status));
  if (!current || current.headSha !== input.expectedSha) throw new Error('Verification SHA is stale or has no matching latest successful deployment record.');
  if (input.expectedImageDigest && current.expectedImageDigest && input.expectedImageDigest !== current.expectedImageDigest) throw new Error('Expected image digest does not match the latest GitHub deployment evidence.');
  const evidenceInput = { ...input, expectedImageDigest: current.expectedImageDigest ?? undefined };
  const status = runtimeVerificationStatus(evidenceInput);
  const verificationId = `${input.service}:${input.expectedSha}:${new Date().toISOString()}`;
  const verifiedAt = new Date().toISOString();
  runtimeVerificationSchema();
  const db = initDb();
  db.prepare(`INSERT INTO deployment_verifications(verification_id,service,expected_sha,actual_runtime_sha,expected_image_digest,actual_image_digest,image_id,revision_label,container_health,workflow_status,deployment_status,post_deploy_qa_status,verification_status,verified_at,evidence_source,failure_reason,run_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(verificationId,input.service,input.expectedSha,input.actualRuntimeSha??null,current.expectedImageDigest??null,input.actualImageDigest??null,input.imageId??null,input.revisionLabel??null,input.containerHealth,input.workflowStatus,input.deploymentStatus,input.postDeployQaStatus,status,verifiedAt,input.evidenceSource.trim(),input.failureReason??null,current.runId??null,verifiedAt);
  db.close();
  linkExternalEvidenceByCommit(input.service,input.expectedSha,'RUNTIME_VERIFICATION_RECORDED',{verificationId,expectedSha:input.expectedSha,actualRuntimeSha:input.actualRuntimeSha??null,expectedImageDigest:current.expectedImageDigest??null,actualImageDigest:input.actualImageDigest??null,revisionLabel:input.revisionLabel??null,containerHealth:input.containerHealth,workflowStatus:input.workflowStatus,deploymentStatus:input.deploymentStatus,postDeployQaStatus:input.postDeployQaStatus,status,verifiedAt,evidenceSource:input.evidenceSource,failureReason:input.failureReason??null},'runtime-verification:'+verificationId);
  return { verificationId, service: input.service, expectedSha: input.expectedSha, status, stored: true };
}

export function listRuntimeVerifications(limit = 100) {
  runtimeVerificationSchema();
  const db = initDb();
  const rows = db.prepare(`SELECT verification_id AS verificationId,service,expected_sha AS expectedSha,actual_runtime_sha AS actualRuntimeSha,expected_image_digest AS expectedImageDigest,actual_image_digest AS actualImageDigest,image_id AS imageId,revision_label AS revisionLabel,container_health AS containerHealth,workflow_status AS workflowStatus,deployment_status AS deploymentStatus,post_deploy_qa_status AS postDeployQaStatus,verification_status AS status,verified_at AS verifiedAt,evidence_source AS evidenceSource,failure_reason AS failureReason,run_id AS runId FROM deployment_verifications ORDER BY verified_at DESC LIMIT ?`).all(Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;
  db.close();
  return rows;
}

function currentRuntimeVerificationStatus(service: string, expectedSha: string, verificationRows: Array<Record<string, unknown>>, deploymentStatus: string) {
  const record = verificationRows.find(row => row.service === service);
  if (!record || record.expectedSha !== expectedSha) return { status: deploymentStatus === 'Deployed' || deploymentStatus === 'Verified' ? 'Deployment Confirmed' : deploymentStatus === 'Failed' ? 'Failed' : 'Unknown', currentEvidence: false, record: null };
  return { status: String(record.status), currentEvidence: true, record };
}

/** Static, read-only readiness snapshot. Workflow presence is not evidence of a successful deployment. */
export function deploymentReadiness() {
  const snapshotAt = '2026-10-23T16:54:24Z';
  const workflowEvidence = [
    { service: 'home', workflow: 'publish.yml', trigger: 'push to main; workflow_dispatch; schedule', deployRisk: 'High', mainNextVersion: '16.4.1 at main SHA e216bd3c21b1ec1ddd7a66dd2f791b4f3ce005e4', developNextVersion: '16.4.1 at develop (latest observed develop SHA b72773094deee348659e4fb0d21c7350e9f6b229)', runtimeNextVersion: 'Unconfirmed: latest main push deployment succeeded, but no read-only inspection of the currently running VPS container was available', observedDeploymentRunId: 39989900060, observedDeploymentSha: 'e216bd3c21b1ec1ddd7a66dd2f791b4f3ce005e4', observedDeploymentConclusion: 'success; independent push event, image build and portal deployment steps succeeded. This was not triggered by Phase 9D-4 PR CI.', expectedImageDigest: null, runtimeVersionConfirmed: false, postDeployQa: 'Not Configured: deployment workflow smoke checks are not Playwright/SEO post-deploy QA', rollback: 'Run 39953548770 reached HTTP smoke and got 503, then invoked rollback; rollback completion is unconfirmed.' },
    { service: 'calculator', workflow: 'deploy.yml', trigger: 'push to main', deployRisk: 'High', lastKnownFailureRunId: 39936981274, lastKnownFailureSha: 'caa5b2de713dca6cc8dfd3b115bf3721c8344dc6', lastKnownFailure: 'Build/push succeeded; remote Compose interpolation failed before pull/up because Portal-required environment values were absent from the .env.moneybook invocation. No evidence that calculator container changed in this failed run.', laterSuccessRunId: 39965563732, laterSuccessSha: 'caffc59985826d3dbf9fe549db008e64b59a853f', laterWorkflowStatus: 'success, including deploy and route/locale/sitemap validation', healthcheck: 'Workflow route/sitemap checks succeeded; no direct running-image inspection recorded', rollback: 'No verified rollback mechanism recorded' },
    { service: 'tools', workflow: 'deploy.yml', trigger: 'push to main', deployRisk: 'High', healthcheck: 'robots.txt HTTP check only', rollback: 'Not configured/verified' },
    { service: 'docs', workflow: 'deploy.yml', trigger: 'push to main', deployRisk: 'High', healthcheck: 'Conditional /ko/docs HTTP check', rollback: 'Not configured/verified' },
    { service: 'quiz', workflow: 'deploy.yml', trigger: 'push to main', deployRisk: 'High', healthcheck: '/ko/quiz HTTP check', rollback: 'Not configured/verified' }
  ];
  return {
    checkedAt: new Date().toISOString(),
    evidenceSnapshotAt: snapshotAt,
    mode: 'read-only readiness; merge/deploy/rollback disabled',
    productionTarget: 'main',
    branchProtection: 'Not Configured; no protection rules were changed',
    protectionPlan: { dryRunOnly: true, branches: ['develop', 'main'], requirePullRequest: true, requiredCheck: 'validate', blockForcePush: true, blockDeletion: true, adminBypass: 'Review separately before application; not configured', currentObservedState: 'All five repositories were previously observed unprotected; fresh 2026-10-23 Home query also returned unprotected with zero rulesets. Protections were not changed.', mainBranchCi: 'All five main-target Draft PR smoke checks succeeded, but PRs were closed without merge. Do not require validate on main until the workflow is merged to main and a main-configured check succeeds.' },
    homeSecurityPromotion: { status: 'Next.js 16.4.1 is present on the latest inspected main SHA; production runtime remains unconfirmed', mainSha: 'e216bd3c21b1ec1ddd7a66dd2f791b4f3ce005e4', developSha: 'b72773094deee348659e4fb0d21c7350e9f6b229', mainNext: '16.4.1', developNext: '16.4.1', lockfileNext: '16.4.1 on the inspected main revision', currentMainCi: 'main-target PR CI smoke succeeded in closed, unmerged PR #24 (run 39986317222); workflow is not yet present on main', latestSuccessfulDeployRun: 39989900060, latestSuccessfulDeploySha: 'e216bd3c21b1ec1ddd7a66dd2f791b4f3ce005e4', runtimeVersion: 'Unconfirmed: latest successful workflow does not establish which container is currently running; approved read-only VPS inspection was unavailable', productionApprovalRequired: true, mergeOrDeployPerformedByAgent: false },
    approvals: 'No actionable dashboard approval control; exact SHA and target approval is required by the gate contract',
    automaticMerge: false,
    automaticDeploy: false,
    automaticRollback: false,
    workflows: workflowEvidence,
    records: listDeploymentRecords(),
    runtimeVerifications: (() => {
      const records = listDeploymentRecords(200) as Array<{ service: string; target: string; headSha: string; status: string; runId?: number }>;
      const verifications = listRuntimeVerifications(500) as Array<Record<string, unknown>>;
      return [...runtimeVerificationServices].map(service => {
        const deployment = records.find(item => item.service === service && item.target === 'main');
        return { service, expectedSha: deployment?.headSha ?? null, workflowStatus: deployment?.status === 'Failed' ? 'failure' : deployment?.status === 'Deployed' || deployment?.status === 'Verified' ? 'success' : 'unknown', deploymentStatus: deployment?.status ?? 'Unknown', ...deployment ? currentRuntimeVerificationStatus(service, deployment.headSha, verifications, deployment.status) : { status: 'Unknown', currentEvidence: false, record: null } };
      });
    })()
  };
}
