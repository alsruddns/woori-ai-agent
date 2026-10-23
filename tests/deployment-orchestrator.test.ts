import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assessMergeDeployGate, assessPostDeploymentVerification, assessRollbackReadiness, classifyDeploymentEvidence, classifyDeploymentRisk, classifyDeploymentRun, deploymentReadiness, listDeploymentRecords, listRuntimeVerifications, recordDeploymentState, recordRuntimeVerification } from '../apps/cli/src/deployment-orchestrator.js';

const priorDb = process.env.WOORI_AGENT_DB_PATH;
let tempDir: string | undefined;
afterEach(() => {
  if (priorDb === undefined) delete process.env.WOORI_AGENT_DB_PATH;
  else process.env.WOORI_AGENT_DB_PATH = priorDb;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});
function db() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woori-deploy-gate-'));
  process.env.WOORI_AGENT_DB_PATH = path.join(tempDir, 'agent.sqlite');
}
const sha = 'a'.repeat(40);
const passed = (overrides: Record<string, unknown> = {}) => ({ service: 'docs', prNumber: 12, prHeadSha: sha, approvedHeadSha: sha, approvedTarget: 'main', target: 'main', authorizedTask: true, localValidationPassed: true, changedFilesAllowed: true, ciPassedForHead: true, requiredChecksPresent: true, conflictFree: true, secretsClear: true, deploymentRiskReviewed: true, approvedByUser: true, ...overrides });

describe('Phase 9D merge/deploy gate', () => {
  it('blocks a missing exact-SHA approval, failed CI, and changed PR SHA', () => {
    expect(assessMergeDeployGate(passed({ approvedByUser: false })).ready).toBe(false);
    expect(assessMergeDeployGate(passed({ ciPassedForHead: false })).blocked).toContain('Required CI has not passed for the current PR head SHA.');
    expect(assessMergeDeployGate(passed({ prHeadSha: 'b'.repeat(40) })).blocked).toContain('Approval SHA does not match the current PR head; approval is stale.');
  });
  it('blocks MoneyBook, Calculator lock, non-main targets, and direct-push assumptions', () => {
    expect(assessMergeDeployGate(passed({ service: 'money' })).ready).toBe(false);
    expect(assessMergeDeployGate(passed({ service: 'calculator' })).blocked).toContain('Calculator automated changes and deployment remain locked.');
    expect(assessMergeDeployGate(passed({ target: 'develop', approvedTarget: 'develop' })).ready).toBe(false);
  });
  it('classifies AdSense, SEO, locale, and public route changes for manual review', () => {
    const result = classifyDeploymentRisk(['public/ads.txt', 'app/[locale]/layout.tsx', 'lib/date.ts']);
    expect(result.level).toBe('High');
    expect(result.requiresManualReview).toBe(true);
    expect(result.highRiskFiles).toHaveLength(2);
  });
  it('stores idempotent deployment evidence without executing external actions', () => {
    db();
    const input = { service: 'docs', prNumber: 15, headSha: sha, target: 'main', status: 'Awaiting Approval' as const, detail: 'Dry-run evidence only' };
    const first = recordDeploymentState(input);
    const second = recordDeploymentState(input);
    expect(first.deploymentKey).toBe(second.deploymentKey);
    expect(second.externalActionsPerformed).toBe(false);
    expect(listDeploymentRecords()).toHaveLength(1);
    recordDeploymentState({ service: 'docs', headSha: sha, target: 'main', status: 'Failed', runId: 23 });
    expect(listDeploymentRecords()).toHaveLength(2);
    expect(() => recordDeploymentState({ ...input, service: 'money' })).toThrow(/excluded/i);
    expect(recordDeploymentState({ ...input, service: 'calculator' }).externalActionsPerformed).toBe(false);
  });
  it('stores append-only runtime evidence and invalidates it when a newer SHA is deployed', () => {
    db();
    const laterSha = 'c'.repeat(40);
    const digest = `sha256:${'a'.repeat(64)}`;
    recordDeploymentState({ service: 'home', headSha: sha, target: 'main', status: 'Deployed', runId: 100, expectedImageDigest: digest });
    const first = recordRuntimeVerification({ service: 'home', expectedSha: sha, actualRuntimeSha: sha, revisionLabel: sha, expectedImageDigest: digest, actualImageDigest: digest, imageId: `sha256:${'b'.repeat(64)}`, containerHealth: 'passed', workflowStatus: 'success', deploymentStatus: 'confirmed', postDeployQaStatus: 'not_run', evidenceSource: 'approved read-only docker inspect' });
    expect(first.status).toBe('Runtime Verified');
    expect(listRuntimeVerifications()).toHaveLength(1);
    recordDeploymentState({ service: 'home', headSha: laterSha, target: 'main', status: 'Deployed', runId: 101 });
    expect(() => recordRuntimeVerification({ service: 'home', expectedSha: sha, containerHealth: 'passed', workflowStatus: 'success', deploymentStatus: 'confirmed', postDeployQaStatus: 'passed', evidenceSource: 'stale' })).toThrow(/stale/i);
    expect(deploymentReadiness().runtimeVerifications.find(row => row.service === 'home')).toMatchObject({ expectedSha: laterSha, status: 'Deployment Confirmed', currentEvidence: false });
  });
  it('does not accept an expected image digest that conflicts with GitHub deployment evidence', () => {
    db();
    const expected = `sha256:${'a'.repeat(64)}`;
    recordDeploymentState({ service: 'home', headSha: sha, target: 'main', status: 'Deployed', runId: 101, expectedImageDigest: expected });
    expect(() => recordRuntimeVerification({ service: 'home', expectedSha: sha, expectedImageDigest: `sha256:${'c'.repeat(64)}`, containerHealth: 'passed', workflowStatus: 'success', deploymentStatus: 'confirmed', postDeployQaStatus: 'passed', evidenceSource: 'test' })).toThrow(/does not match/i);
  });
  it('does not treat partial identity, digest mismatch, or failed health as verified runtime', () => {
    db();
    const expected = `sha256:${'e'.repeat(64)}`;
    const actual = `sha256:${'f'.repeat(64)}`;
    recordDeploymentState({ service: 'docs', headSha: sha, target: 'main', status: 'Deployed', runId: 102, expectedImageDigest: expected });
    const base = { service: 'docs', expectedSha: sha, expectedImageDigest: expected, actualImageDigest: actual, actualRuntimeSha: sha, revisionLabel: sha, containerHealth: 'passed' as const, workflowStatus: 'success' as const, deploymentStatus: 'confirmed' as const, postDeployQaStatus: 'not_run' as const, evidenceSource: 'test fixture' };
    expect(recordRuntimeVerification(base).status).toBe('Failed');
    expect(recordRuntimeVerification({ ...base, actualImageDigest: expected, containerHealth: 'failed' }).status).toBe('Failed');
    expect(recordRuntimeVerification({ ...base, actualImageDigest: undefined, actualRuntimeSha: undefined, revisionLabel: undefined }).status).toBe('Deployment Confirmed');
  });
  it('separates deployment workflow success from post-deployment service verification', () => {
    expect(assessPostDeploymentVerification({ deploymentRun: 'success', containerHealth: 'unknown', httpSmoke: 'passed', playwrightSmoke: 'not_run', pageErrors: null, seoMetadata: 'passed' }).status).toBe('Verification Incomplete');
    expect(assessPostDeploymentVerification({ deploymentRun: 'success', containerHealth: 'passed', httpSmoke: 'failed', playwrightSmoke: 'passed', pageErrors: 0, seoMetadata: 'passed' }).status).toBe('Service Verification Failed');
    expect(assessPostDeploymentVerification({ deploymentRun: 'success', containerHealth: 'passed', httpSmoke: 'passed', playwrightSmoke: 'passed', pageErrors: 0, seoMetadata: 'passed' }).status).toBe('Verified');
    expect(assessPostDeploymentVerification({ deploymentRun: 'failure', containerHealth: 'unknown', httpSmoke: 'not_run', playwrightSmoke: 'not_run', pageErrors: null, seoMetadata: 'not_run' }).status).toBe('Deployment Failed');
  });
  it('requires matching runtime image identity, healthcheck, and post-deploy QA for full verification', () => {
    const validDigest = `sha256:${'d'.repeat(64)}`;
    const evidence = { workflowConclusion: 'success' as const, deployStepConclusion: 'success' as const, deploymentSha: sha, runtimeImageRevision: null, runtimeImageDigest: null, expectedImageDigest: validDigest, healthcheck: 'passed' as const, postDeployQa: 'not_run' as const };
    const partial = classifyDeploymentEvidence(evidence);
    expect(partial.workflowSucceeded).toBe(true);
    expect(partial.deploymentConfirmed).toBe(true);
    expect(partial.runtimeVersionConfirmed).toBe(false);
    expect(partial.fullyVerified).toBe(false);
    expect(partial.blockers).toContain('The running container image revision and digest are not confirmed.');
    expect(classifyDeploymentEvidence({ ...evidence, runtimeImageRevision: sha, runtimeImageDigest: validDigest, postDeployQa: 'passed' }).status).toBe('Fully Verified');
    expect(classifyDeploymentEvidence({ ...evidence, workflowConclusion: 'failure' }).deploymentConfirmed).toBe(false);
  });
  it('only advertises Home guarded rollback and never enables automatic rollback', () => {
    expect(assessRollbackReadiness('home').status).toContain('Guarded workflow path exists');
    expect(assessRollbackReadiness('docs').status).toContain('Not Configured');
    expect(assessRollbackReadiness('docs').automatic).toBe(false);
  });
  it('records only an actual main deployment step, not PR CI or a skipped deployment job', () => {
    const service = { service: 'home', repository: 'alsruddns/woori-home', workflow: 'publish.yml', job: 'deploy', deployStep: 'Deploy only the portal service' };
    const run = { databaseId: 99, workflowName: 'Publish', status: 'completed', conclusion: 'success', url: 'https://example.invalid/run/99', createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:01:00Z', headSha: sha, event: 'workflow_dispatch', headBranch: 'main' };
    expect(classifyDeploymentRun(service, { ...run, event: 'pull_request' }, [])).toBeNull();
    const deployed = classifyDeploymentRun(service, run, [{ name: 'deploy', status: 'completed', conclusion: 'success', startedAt: run.createdAt, completedAt: run.updatedAt, steps: [{ name: service.deployStep, status: 'completed', conclusion: 'success' }] }]);
    expect(deployed?.status).toBe('Deployed');
    expect(deployed?.evidence.runtimeVersionConfirmed).toBe(false);
    expect(deployed?.evidence.healthcheckPassed).toBe(false);
    expect(deployed?.evidence.fullyVerified).toBe(false);
    expect(classifyDeploymentRun(service, run, [{ name: 'deploy', status: 'completed', conclusion: 'success', startedAt: run.createdAt, completedAt: run.updatedAt, steps: [{ name: service.deployStep, status: 'completed', conclusion: 'skipped' }] }])).toBeNull();
  });
  it('keeps merges, deployment and rollback off in readiness output', () => {
    db();
    const result = deploymentReadiness();
    expect(result.automaticMerge).toBe(false);
    expect(result.automaticDeploy).toBe(false);
    expect(result.automaticRollback).toBe(false);
    expect(result.workflows).toHaveLength(5);
    expect(result.homeSecurityPromotion.mainNext).toBe('16.4.1');
    expect(result.homeSecurityPromotion.runtimeVersion).toContain('Unconfirmed');
    expect(result.protectionPlan.mainBranchCi).toContain('main');
  });
});
