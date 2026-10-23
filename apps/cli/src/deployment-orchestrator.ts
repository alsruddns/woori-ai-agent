import { initDb } from './core.js';
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
  const result = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 2_000_000 });
  return { ok: result.status === 0, stdout: result.status === 0 ? result.stdout : '' };
};

/** Opt-in read-only GitHub query; stores deployment step evidence and never dispatches or changes a workflow. */
export function refreshDeploymentRuns(runner: GhRunner = runGh) {
  const results: Array<{ service: string; status: string; runId?: number; headSha?: string; evidence?: ReturnType<typeof classifyDeploymentEvidence>; reason?: string }> = [];
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
      recordDeploymentState({ service: service.service, headSha: run.headSha, target: 'main', status: classified.status, runId: run.databaseId, runUrl: run.url ?? undefined, detail: classified.detail, startedAt: classified.startedAt ?? undefined, finishedAt: classified.finishedAt ?? undefined });
      results.push({ service: service.service, status: classified.status, runId: run.databaseId, headSha: run.headSha, evidence: classified.evidence });
      observed = true; break;
    }
    if (!observed) results.push({ service: service.service, status: 'No Deployment Evidence', reason: 'No recent main workflow run contained a successful/attempted production deploy step.' });
  }
  return { checkedAt: new Date().toISOString(), mode: 'read-only GitHub Actions query', externalActionsPerformed: false, services: results };
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
  db.prepare(`INSERT INTO deployment_records(deployment_key,service,pr_number,head_sha,target,status,run_id,run_url,detail,started_at,finished_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(deployment_key) DO UPDATE SET status=excluded.status,run_id=excluded.run_id,run_url=excluded.run_url,detail=excluded.detail,started_at=excluded.started_at,finished_at=excluded.finished_at,updated_at=excluded.updated_at`)
    .run(key, input.service, input.prNumber ?? 0, input.headSha, input.target, input.status, input.runId ?? null, input.runUrl ?? null, input.detail ?? null, input.startedAt ?? null, input.finishedAt ?? null, now, now);
  db.close();
  return { deploymentKey: key, stored: true, externalActionsPerformed: false };
}

export function listDeploymentRecords(limit = 50) {
  schema();
  const db = initDb();
  const records = db.prepare('SELECT deployment_key AS deploymentKey,service,pr_number AS prNumber,head_sha AS headSha,target,status,run_id AS runId,run_url AS runUrl,detail,started_at AS startedAt,finished_at AS finishedAt,created_at AS createdAt,updated_at AS updatedAt FROM deployment_records ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(200, limit)));
  db.close();
  return records;
}

/** Static, read-only readiness snapshot. Workflow presence is not evidence of a successful deployment. */
export function deploymentReadiness() {
  const snapshotAt = '2026-10-23T14:49:47Z';
  const workflowEvidence = [
    { service: 'home', workflow: 'publish.yml', trigger: 'push to main; workflow_dispatch; schedule', deployRisk: 'High', mainNextVersion: '16.4.1 at main SHA 8414cbf2d6ca1440bcec5135448d8b45db031f45', developNextVersion: '16.4.1 at develop SHA 614a1f122f9423d1ea0ac7fbf6e7d23bcf51f257 (develop is 61 commits behind main)', runtimeNextVersion: 'Unconfirmed: successful deployment workflow identifies artifact SHA/digest, but no read-only inspection of the currently running VPS container was available', observedDeploymentRunId: 39963970414, observedDeploymentSha: '8414cbf2d6ca1440bcec5135448d8b45db031f45', observedDeploymentConclusion: 'success; image publish and portal deploy steps succeeded; Docker health and HTTP checks were logged', runtimeVersionConfirmed: false, postDeployQa: 'Not Configured: deployment workflow smoke checks are not Playwright/SEO post-deploy QA', rollback: 'Run 39953548770 reached HTTP smoke and got 503, then invoked rollback; rollback completion is unconfirmed. Later successful deployment run 39963970414 supersedes it at workflow level.' },
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
    protectionPlan: { dryRunOnly: true, branches: ['develop', 'main'], requirePullRequest: true, requiredCheck: 'validate', blockForcePush: true, blockDeletion: true, adminBypass: 'Review separately before application; not configured', currentObservedState: 'Home main/develop protection API returned unprotected and rulesets count was zero. Previous five-repository inspection is recorded in docs; this refresh queried Home only.', mainBranchCi: 'Home pr-ci.yml currently triggers only pull_request to develop; do not require validate on main until a main-targeting PR CI run succeeds.' },
    homeSecurityPromotion: { status: 'Security dependency version is present on main and develop; branch promotion is not pending for this dependency', mainSha: '8414cbf2d6ca1440bcec5135448d8b45db031f45', developSha: '614a1f122f9423d1ea0ac7fbf6e7d23bcf51f257', mainNext: '16.4.1', developNext: '16.4.1', lockfileNext: '16.4.1 on both refs', currentMainCi: 'PR CI is configured for develop only; no current-main targeted PR validation evidence was found', latestSuccessfulDeployRun: 39963970414, latestSuccessfulDeploySha: '8414cbf2d6ca1440bcec5135448d8b45db031f45', runtimeVersion: 'Unconfirmed: require operator-side read-only docker inspect/image label check', productionApprovalRequired: true, mergeOrDeployPerformedByAgent: false },
    approvals: 'No actionable dashboard approval control; exact SHA and target approval is required by the gate contract',
    automaticMerge: false,
    automaticDeploy: false,
    automaticRollback: false,
    workflows: workflowEvidence,
    records: listDeploymentRecords()
  };
}
