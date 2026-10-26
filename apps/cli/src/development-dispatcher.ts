import type { AgentPolicy } from './agent-policy.js';
import type { Lease } from './distributed-queue.js';

export type DispatchableControllerJob = {
  jobId: string;
  localTaskId: string | null;
  featureId?: string | null;
  service: string;
  kind: string;
  workClass: 'analysis' | 'code_change';
  title: string;
  status: string;
  policyVersion: number | null;
};

export type DevelopmentDispatchContext = {
  policy: AgentPolicy;
  worker: { os: string; allowCodeChanges: boolean; capabilities: string[]; sandboxStatus: string; codexCliStatus: string; chatgptLoginStatus: string };
  lease: Lease;
  projectUnlocked: boolean;
  invocationBudgetAvailable: boolean;
  auditReady: boolean;
  explicitExecutionRequest: boolean;
  jobAllowlisted: boolean;
  requestedFeatureId?: string | null;
};

export type DispatcherDecision = { allowed: true; mode: 'read-only' | 'feature-development'; reasons: [] } | { allowed: false; mode: 'blocked'; reasons: string[] };

const allowedQuizFeatureId = 'FEATURE-2026-000008';

export function evaluateDevelopmentDispatch(job: DispatchableControllerJob, context: DevelopmentDispatchContext): DispatcherDecision {
  const reasons: string[] = [];
  if (context.lease.jobId !== job.jobId || context.lease.status !== 'Claimed' || Date.parse(context.lease.expiresAt) <= Date.now()) reasons.push('A current Controller lease is required.');
  if (job.status !== 'Claimed') reasons.push('The Controller job must be claimed before dispatch.');
  if (job.workClass === 'analysis') return reasons.length ? { allowed: false, mode: 'blocked', reasons } : { allowed: true, mode: 'read-only', reasons: [] };
  if (job.service !== 'quiz') reasons.push('This dispatcher is restricted to the Quiz project.');
  if (job.featureId !== allowedQuizFeatureId || context.requestedFeatureId !== allowedQuizFeatureId) reasons.push(`Only the explicitly approved ${allowedQuizFeatureId} feature may be dispatched.`);
  if (!job.localTaskId) reasons.push('A linked local Development Queue task is required.');
  if (!context.explicitExecutionRequest) reasons.push('A one-job explicit development execution request is required.');
  if (!context.jobAllowlisted) reasons.push('The claimed job is not in the explicit dispatch allowlist.');
  if (context.policy.emergencyStop || context.policy.mode === 'PAUSED' || !context.policy.globalAutomationEnabled) reasons.push('Emergency Stop, PAUSED mode, or global automation policy blocks execution.');
  if (!['FEATURE_EXPANSION', 'FULL_AUTONOMOUS'].includes(context.policy.mode)) reasons.push('The current operating mode does not allow feature development.');
  if (!context.policy.global.featurePlanning || !context.policy.global.featureSpecification || !context.policy.global.autonomousFeatureDevelopment || !context.policy.global.codexExecution) reasons.push('Global Feature Planning, Specification, Autonomous Development, and Codex policies must all be enabled.');
  const service = context.policy.services[job.service as keyof AgentPolicy['services']];
  if (!service?.enabled || !service.featureDevelopment || !service.codex) reasons.push('Service feature-development and Codex policies must both be enabled.');
  if (service && (service.maximumConcurrentJobs < 1 || service.maximumDailyDevelopmentJobs < 1)) reasons.push('Service execution limits block a new development job.');
  if (context.worker.os !== 'windows' || !context.worker.allowCodeChanges || !context.worker.capabilities.includes('codex-write')) reasons.push('The Controller-provisioned Worker is read-only.');
  if (context.worker.sandboxStatus !== 'Ready') reasons.push('The Windows MXC Sandbox is not Ready.');
  if (context.worker.codexCliStatus !== 'Ready' || context.worker.chatgptLoginStatus !== 'ChatGPT') reasons.push('ChatGPT-authenticated Codex CLI readiness is not verified.');
  if (!context.invocationBudgetAvailable) reasons.push('The persisted Codex invocation budget is unavailable or exhausted.');
  if (!context.projectUnlocked) reasons.push('The project development lock is active or unverified.');
  if (!context.auditReady) reasons.push('Development Audit Trail is not available.');
  if (job.policyVersion !== context.policy.version || context.lease.policyVersion !== context.policy.version) reasons.push('The job or lease uses a stale Controller Policy Version.');
  return reasons.length ? { allowed: false, mode: 'blocked', reasons: [...new Set(reasons)] } : { allowed: true, mode: 'feature-development', reasons: [] };
}

export type DispatcherDependencies<T> = {
  readContext: (job: DispatchableControllerJob, lease: Lease) => Promise<DevelopmentDispatchContext>;
  assertLease: (job: DispatchableControllerJob, lease: Lease) => Promise<boolean>;
  transition: (job: DispatchableControllerJob, lease: Lease, status: 'Running' | 'Testing' | 'Completed' | 'Failed', result?: { summaryCode?: string; testsPassed?: boolean; changedFilesCount?: number }, failureCode?: string) => Promise<void>;
  executeReadOnly: (job: DispatchableControllerJob, lease: Lease) => Promise<T>;
  executeFeature: (job: DispatchableControllerJob, lease: Lease, context: DevelopmentDispatchContext) => Promise<T>;
  record: (event: string, job: DispatchableControllerJob, details: Record<string, unknown>) => Promise<void>;
};

/** Routes only an already claimed, caller-selected job. It never claims or drains the queue. */
export async function dispatchClaimedControllerJob<T>(job: DispatchableControllerJob, lease: Lease, dependencies: DispatcherDependencies<T>) {
  const context = await dependencies.readContext(job, lease);
  const decision = evaluateDevelopmentDispatch(job, context);
  await dependencies.record('WORKER_DISPATCH_EVALUATED', job, { mode: decision.mode, allowed: decision.allowed, reasons: decision.reasons });
  if (!decision.allowed) return { status: 'Blocked' as const, decision };
  if (!await dependencies.assertLease(job, lease)) return { status: 'Blocked' as const, decision: { allowed: false as const, mode: 'blocked' as const, reasons: ['Controller rejected the lease or Fencing Token.'] } };
  await dependencies.record('WORKER_DISPATCH_INTENT', job, { mode: decision.mode, leaseId: lease.leaseId, fencingToken: lease.fencingToken });
  await dependencies.transition(job, lease, 'Running');
  try {
    const value = decision.mode === 'read-only' ? await dependencies.executeReadOnly(job, lease) : await dependencies.executeFeature(job, lease, context);
    if (!await dependencies.assertLease(job, lease)) throw new Error('LEASE_REJECTED');
    if (decision.mode === 'feature-development') await dependencies.transition(job, lease, 'Testing');
    await dependencies.transition(job, lease, 'Completed', { summaryCode: decision.mode === 'read-only' ? 'READ_ONLY_COMPLETED' : 'FEATURE_VALIDATION_COMPLETED', testsPassed: decision.mode === 'feature-development', changedFilesCount: 0 });
    await dependencies.record('WORKER_DISPATCH_COMPLETED', job, { mode: decision.mode });
    return { status: 'Completed' as const, decision, value };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_.-]{1,64}$/i.test(error.message) ? error.message : 'DISPATCH_FAILED';
    try { await dependencies.transition(job, lease, 'Failed', undefined, code); } catch { /* The lease may have expired; retain the dispatch failure event below. */ }
    await dependencies.record('WORKER_DISPATCH_FAILED', job, { failureCode: code });
    return { status: 'Failed' as const, decision, failureCode: code };
  }
}
