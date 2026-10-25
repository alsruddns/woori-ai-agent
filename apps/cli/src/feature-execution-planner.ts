import { getAgentPolicy } from './agent-policy.js';
import { listFeatureFactoryData } from './feature-factory.js';
import { planFeatureExecution } from './feature-execution.js';

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
  if (!policy.services[service]?.featureDevelopment || !policy.services[service]?.codex) reasons.push('Service development/Codex policy is disabled.');
  if (process.platform !== 'win32') reasons.push('Linux source modification remains disabled pending sandbox verification.');
  return { ...generated, status: reasons.length ? 'Blocked' as const : 'Planned' as const, reasons: [...new Set(reasons)], executionAllowed: false, fixtureOnlyExecutionSupported: true };
}
