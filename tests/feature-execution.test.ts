import { describe, expect, it, vi } from 'vitest';
import { planFeatureExecution, runBoundedFeatureAttempts, validateFeatureReleaseReadiness } from '../apps/cli/src/feature-execution.js';

const planInput = {
  developmentJobId: 'FEATURE-2026-000001', featureId: 'FEATURE-2026-fixture', project: 'docs' as const, featureName: 'fixture converter', reason: 'Test a small local conversion tool.',
  requirements: ['Convert a valid number and reject invalid input.'], inputs: ['number'], outputs: ['converted number'], allowedPaths: ['src/**', 'tests/**', 'locales/**'],
  locales: { publicLocales: ['en', 'ko'], source: 'fixture manifest', authoritative: true }, risk: 'Low' as const, policyVersion: 3,
  lease: { workerId: 'fixture-worker', leaseId: 'lease-1', fencingToken: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }, maxRetries: 8,
};

describe('Feature Execution Planner', () => {
  it('creates a bounded plan with immutable protected paths', () => {
    const plan = planFeatureExecution(planInput);
    expect(plan.status).toBe('Planned');
    expect(plan.maxRetries).toBe(2);
    expect(plan.forbiddenPaths).toContain('.github/**');
    expect(plan.policyVersion).toBe(3);
  });
  it('blocks unknown public locales, unsafe paths and stale lease', () => {
    const plan = planFeatureExecution({ ...planInput, allowedPaths: ['**/*'], locales: { publicLocales: [], source: 'guessed tokens', authoritative: false }, lease: { ...planInput.lease, expiresAt: new Date(Date.now() - 1).toISOString() } });
    expect(plan.status).toBe('Blocked');
    expect(plan.reasons).toEqual(expect.arrayContaining(['Authoritative public locale evidence is required.', 'A current Worker Lease and Fencing Token are required.']));
  });
});

describe('Feature release readiness', () => {
  const complete = { route: true, uiStrings: true, inputErrorResultStrings: true, title: 'Tool', description: 'Tool description', canonical: true, hreflang: ['en', 'ko', 'x-default'], xDefault: true, robotsVerified: true, sitemapContainsRoute: true, buildOrRenderEvidence: true };
  it('requires complete evidence for every authoritative public locale', () => {
    expect(validateFeatureReleaseReadiness({ publicLocales: ['en', 'ko'], localeSource: 'fixture locale manifest', localeSourceAuthoritative: true, locales: { en: complete, ko: complete } }).status).toBe('Ready');
    const missing = validateFeatureReleaseReadiness({ publicLocales: ['en', 'ko'], localeSource: 'fixture locale manifest', localeSourceAuthoritative: true, locales: { en: complete, ko: { ...complete, sitemapContainsRoute: false } } });
    expect(missing.status).toBe('Not Ready');
    expect(missing.failures.join(' ')).toContain('sitemap evidence missing');
  });
  it('does not trust locale tokens as the public locale registry', () => {
    const result = validateFeatureReleaseReadiness({ publicLocales: ['en'], localeSource: 'filename scan', localeSourceAuthoritative: false, locales: { en: complete } });
    expect(result.status).toBe('Not Ready');
  });
});

describe('bounded retry orchestration', () => {
  it('retries a distinct failure once and stops on repeated error', async () => {
    let calls = 0;
    const events: any[] = [];
    const result = await runBoundedFeatureAttempts({ maxRetries: 2, policyVersion: 1, currentPolicyVersion: () => 1, leaseCurrent: () => true, execute: async () => ({ ok: false, value: undefined, error: ++calls === 1 ? 'test failed A' : 'test failed A' }), record: event => { events.push(event); } });
    expect(result).toMatchObject({ status: 'Failed', attempts: 2, stopReason: 'same-error' });
    expect(events).toHaveLength(2);
  });
  it('stops before execution if policy or lease changes', async () => {
    const execute = vi.fn(async () => ({ ok: true, value: 'ok' }));
    const policy = await runBoundedFeatureAttempts({ maxRetries: 2, policyVersion: 1, currentPolicyVersion: () => 2, leaseCurrent: () => true, execute, record: () => undefined });
    const lease = await runBoundedFeatureAttempts({ maxRetries: 2, policyVersion: 1, currentPolicyVersion: () => 1, leaseCurrent: () => false, execute, record: () => undefined });
    expect(policy).toMatchObject({ status: 'Blocked', stopReason: 'policy-changed' });
    expect(lease).toMatchObject({ status: 'Blocked', stopReason: 'lease-expired' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('never retries timeout or usage limit failures', async () => {
    const timeout = await runBoundedFeatureAttempts({ maxRetries: 2, policyVersion: 1, currentPolicyVersion: () => 1, leaseCurrent: () => true, execute: async () => ({ ok: false, value: undefined, error: 'timeout', timedOut: true }), record: () => undefined });
    const quota = await runBoundedFeatureAttempts({ maxRetries: 2, policyVersion: 1, currentPolicyVersion: () => 1, leaseCurrent: () => true, execute: async () => ({ ok: false, value: undefined, error: 'limit', usageLimit: true }), record: () => undefined });
    expect(timeout).toMatchObject({ status: 'Failed', stopReason: 'timeout' });
    expect(quota).toMatchObject({ status: 'Failed', stopReason: 'usage-limit' });
    const auth = await runBoundedFeatureAttempts({ maxRetries: 2, policyVersion: 1, currentPolicyVersion: () => 1, leaseCurrent: () => true, execute: async () => ({ ok: false, value: undefined, error: 'Not authenticated' }), record: () => undefined });
    expect(auth).toMatchObject({ status: 'Failed', stopReason: 'authentication' });
  });
});
