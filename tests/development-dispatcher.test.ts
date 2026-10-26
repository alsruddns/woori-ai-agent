import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAgentPolicy } from '../apps/cli/src/agent-policy.js';
import { dispatchClaimedControllerJob, evaluateDevelopmentDispatch, type DevelopmentDispatchContext, type DispatchableControllerJob } from '../apps/cli/src/development-dispatcher.js';

let root = '';
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = ''; });
function base() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'woori-dispatcher-'));
  const policy = getAgentPolicy(path.join(root, 'controller.sqlite'));
  const lease = { jobId: 'job-test-001', workerId: 'windows-worker-01', leaseId: 'lease-test', fencingToken: 7, expiresAt: new Date(Date.now() + 60_000).toISOString(), status: 'Claimed', policyVersion: policy.version };
  const job: DispatchableControllerJob = { jobId: lease.jobId, localTaskId: 'task-feature-008', featureId: 'FEATURE-2026-000008', service: 'quiz', kind: 'feature-development', workClass: 'code_change', title: 'Retry incorrect answers', status: 'Claimed', policyVersion: policy.version };
  const context: DevelopmentDispatchContext = { policy, worker: { os: 'windows', allowCodeChanges: false, capabilities: ['qa'], sandboxStatus: 'Ready', codexCliStatus: 'Ready', chatgptLoginStatus: 'ChatGPT' }, lease, projectUnlocked: true, invocationBudgetAvailable: true, auditReady: true, explicitExecutionRequest: true, jobAllowlisted: true, requestedFeatureId: 'FEATURE-2026-000008' };
  return { policy, lease, job, context };
}

describe('Windows Worker Development Dispatcher', () => {
  it('blocks code changes while global and service policy is off or the Worker is read-only', () => {
    const { job, context } = base();
    const decision = evaluateDevelopmentDispatch(job, context);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasons).toEqual(expect.arrayContaining(['Global Feature Planning, Specification, Autonomous Development, and Codex policies must all be enabled.', 'Service feature-development and Codex policies must both be enabled.', 'The Controller-provisioned Worker is read-only.']));
  });

  it('routes a gated feature job to the supplied Codex Executor only after every execution gate passes', async () => {
    const { job, lease, context } = base();
    context.policy.mode = 'FEATURE_EXPANSION';
    context.policy.global.featurePlanning = true;
    context.policy.global.featureSpecification = true;
    context.policy.global.autonomousFeatureDevelopment = true;
    context.policy.global.codexExecution = true;
    context.policy.services.quiz.featureDevelopment = true;
    context.policy.services.quiz.codex = true;
    context.worker.allowCodeChanges = true;
    context.worker.capabilities.push('codex-write');
    const executeFeature = vi.fn().mockResolvedValue({ status: 'Completed' });
    const transitions: string[] = [];
    const result = await dispatchClaimedControllerJob(job, lease, {
      readContext: async () => context,
      assertLease: async () => true,
      transition: async (_job, _lease, status) => { transitions.push(status); },
      executeReadOnly: async () => { throw new Error('wrong route'); },
      executeFeature,
      record: async () => undefined,
    });
    expect(result.status).toBe('Completed');
    expect(executeFeature).toHaveBeenCalledOnce();
    expect(transitions).toEqual(['Running', 'Testing', 'Completed']);
  });

  it('does not start execution when the lease cannot be revalidated', async () => {
    const { job, lease, context } = base();
    const executeFeature = vi.fn();
    const result = await dispatchClaimedControllerJob(job, lease, {
      readContext: async () => context,
      assertLease: async () => false,
      transition: async () => undefined,
      executeReadOnly: async () => undefined,
      executeFeature,
      record: async () => undefined,
    });
    expect(result.status).toBe('Blocked');
    expect(executeFeature).not.toHaveBeenCalled();
  });

  it('blocks a different feature even if the job ID was explicitly selected', () => {
    const { job, context } = base();
    job.featureId = 'FEATURE-OTHER';
    context.requestedFeatureId = 'FEATURE-OTHER';
    const decision = evaluateDevelopmentDispatch(job, context);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasons).toContain('Only the explicitly approved FEATURE-2026-000008 feature may be dispatched.');
  });

  it('blocks a different service even when the feature ID matches', () => {
    const { job, context } = base();
    job.service = 'docs';
    const decision = evaluateDevelopmentDispatch(job, context);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasons).toContain('This dispatcher is restricted to the Quiz project.');
  });
});
