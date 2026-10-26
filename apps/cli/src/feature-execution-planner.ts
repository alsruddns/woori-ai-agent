import { getAgentPolicy } from './agent-policy.js';
import { listFeatureFactoryData } from './feature-factory.js';
import { planFeatureExecution } from './feature-execution.js';
import { listProjectDevelopmentLocks } from './project-development-locks.js';

export function buildFeatureExecutionPlan(displayJobId: string, lease: { workerId: string; leaseId: string; fencingToken: number; expiresAt: string } | null, dbPath?: string) {
  const data = listFeatureFactoryData(dbPath);
  const spec = data.specs.find((item: any) => item.displayJobId === displayJobId);
  if (!spec) throw new Error('Feature specification was not found.');
  const candidate = data.candidates.find((item: any) => item.candidateId === spec.candidateId);
  if (!candidate) throw new Error('Candidate evidence is missing.');
  const policy = getAgentPolicy(dbPath);
  const generated = planFeatureExecution({
    developmentJobId: displayJobId,
    featureId: spec.specification.featureId,
    project: spec.specification.project,
    featureName: spec.specification.name,
    reason: candidate.payload.purpose,
    requirements: [candidate.payload.logic, ...(candidate.payload.errors ?? [])],
    inputs: candidate.payload.inputs ?? [],
    outputs: candidate.payload.outputs ?? [],
    allowedPaths: candidate.payload.filePatterns ?? [],
    locales: {
      publicLocales: spec.specification.locales?.publicLocales ?? [],
      source: spec.specification.locales?.source ?? '',
      authoritative: spec.specification.locales?.authoritative === true,
    },
    risk: 'Medium',
    policyVersion: policy.version,
    lease: lease ?? { workerId: '', leaseId: '', fencingToken: 0, expiresAt: new Date(0).toISOString() },
  });
  const reasons = [...generated.reasons];
  if (spec.status !== 'Approved') reasons.push('Specification is not approved for execution.');
  if (spec.policyVersion !== policy.version) reasons.push('Specification Controller Policy Version is stale.');
  if (policy.emergencyStop || policy.mode === 'PAUSED' || !policy.globalAutomationEnabled) reasons.push('Controller is paused or automation is globally disabled.');
  if (policy.mode !== 'FEATURE_EXPANSION' && policy.mode !== 'FULL_AUTONOMOUS') reasons.push(`Operating mode ${policy.mode} does not permit feature expansion.`);
  if (!policy.global.autonomousFeatureDevelopment || !policy.global.codexExecution) reasons.push('Global autonomous development and Codex execution remain locked OFF.');
  if (spec.specification.project === 'calculator') reasons.push('Calculator source modification lock is active.');
  const service = spec.specification.project as keyof typeof policy.services;
  const servicePolicy = policy.services[service];
  const complexity = Number.isInteger(candidate.payload.complexity) ? Number(candidate.payload.complexity) : null;
  if (complexity === null) reasons.push('Feature complexity is Unknown; execution is blocked until an evidence-based 0–5 score is recorded.');
  else if (complexity > servicePolicy.maximumFeatureComplexity) reasons.push(`Feature complexity ${complexity} exceeds the service limit ${servicePolicy.maximumFeatureComplexity}.`);
  const projectLock = listProjectDevelopmentLocks({ databasePath: dbPath }).projects.find((item) => item.projectId === service);
  if (!projectLock || projectLock.state !== 'AVAILABLE') reasons.push(`PROJECT_LOCKED:${projectLock?.state ?? 'LOCKED_UNVERIFIED'}`);
  if (!servicePolicy?.featureDevelopment || !servicePolicy?.codex) reasons.push('Service development/Codex policy is disabled.');
  if (servicePolicy?.maximumConcurrentJobs < 1) reasons.push('Maximum concurrent development jobs is 0.');
  if (servicePolicy?.maximumDailyDevelopmentJobs < 1) reasons.push('Daily development job limit is 0.');
  const retryLimit = policy.global.automaticRetry ? servicePolicy.maximumRetryCount : 0;
  const executionContract = generated.executionContract ? { ...generated.executionContract, timeoutMs: Math.min(generated.executionContract.timeoutMs, servicePolicy.maximumCodexExecutionTimeSeconds * 1000), maxRetries: Math.min(generated.executionContract.maxRetries, retryLimit) } : undefined;
  const maxRetries = Math.min(generated.maxRetries, retryLimit);
  if (process.platform !== 'win32') reasons.push('Linux source modification remains disabled pending sandbox verification.');
  return { ...generated, ...(executionContract ? { executionContract } : {}), maxRetries, status: reasons.length ? 'Blocked' as const : 'Planned' as const, reasons: [...new Set(reasons)], executionAllowed: false, fixtureOnlyExecutionSupported: true };
}
