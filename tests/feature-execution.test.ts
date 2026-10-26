import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planFeatureExecution, runBoundedFeatureAttempts, validateExecutionContractChanges, validateFeatureReleaseReadiness, type ExecutionContract } from '../apps/cli/src/feature-execution.js';

const makeContract = (workspaceRoot = 'WORKTREE_ROOT'): ExecutionContract => ({ version: 1, developmentJobId: 'FEATURE-2026-000001', featureId: 'FEATURE-2026-fixture', project: 'docs', featureName: 'fixture normalizer', reason: 'exercise a disposable fixture', inputs: ['unknown'], outputs: ['normalized result'], publicLocales: ['en', 'ko'], risk: 'Low', policyVersion: 3, workerLease: { workerId: 'fixture-worker', leaseId: 'lease-1', fencingToken: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }, timeoutMs: 240_000, maxRetries: 2, localeRequirements: ['all declared locales'], seoRequirements: ['metadata per locale'], sitemapRequirements: ['route per locale'], testRequirements: ['fixed typecheck, lint, build, test'], workspaceRoot, sourceRoot: 'src', targetFilePaths: ['src/normalize-input.ts', 'locales/en.json', 'locales/ko.json', 'src/metadata.json', 'public/robots.txt', 'public/sitemap.xml'], allowedFileExtensions: ['.ts', '.json', '.txt', '.xml'], fileAllowlist: ['src/**', 'locales/**', 'public/**'], immutableFilePaths: ['package.json', 'tests/normalize-input.test.cjs'], requiredExports: [{ file: 'src/normalize-input.ts', name: 'normalizeTextInput' }], requiredBehavior: ['trim and normalize'], requiredTests: ['normal input', 'empty input', 'bad input'], requiredTestPaths: ['tests/normalize-input.test.cjs'], verificationCommands: ['typecheck', 'lint', 'build', 'test'], expectedArtifacts: ['src/normalize-input.ts', 'locales/en.json', 'locales/ko.json', 'src/metadata.json', 'public/robots.txt', 'public/sitemap.xml'] });
function seedContractRoot(root: string, contract: ExecutionContract) {
  for (const file of contract.immutableFilePaths) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, '{}\n'); }
  for (const file of contract.expectedArtifacts) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file === 'src/normalize-input.ts' ? 'export function normalizeTextInput(input: unknown) { return input; }\n' : '{}\n'); }
}

const planInput = {
  developmentJobId: 'FEATURE-2026-000001', featureId: 'FEATURE-2026-fixture', project: 'docs' as const, featureName: 'fixture converter', reason: 'Test a small local conversion tool.',
  requirements: ['Convert a valid number and reject invalid input.'], inputs: ['number'], outputs: ['converted number'], allowedPaths: ['src/**', 'locales/**', 'public/**'], executionContract: makeContract(),
  locales: { publicLocales: ['en', 'ko'], source: 'fixture manifest', authoritative: true }, risk: 'Low' as const, policyVersion: 3,
  lease: { workerId: 'fixture-worker', leaseId: 'lease-1', fencingToken: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }, maxRetries: 8,
};

describe('Feature Execution Planner', () => {
  it('creates a bounded plan with immutable protected paths', () => {
    const plan = planFeatureExecution(planInput);
    expect(plan.status).toBe('Planned');
    expect(plan.maxRetries).toBe(3);
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
  const complete = { route: true, renderedHtml: true, uiStrings: true, inputErrorResultStrings: true, title: 'Tool', description: 'Tool description', canonical: true, hreflang: ['en', 'ko', 'x-default'], xDefault: true, robotsVerified: true, sitemapContainsRoute: true, buildOrRenderEvidence: true };
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

describe('Execution Contract file boundary', () => {
  it('accepts exact expected target paths and required export', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-contract-test-'));
    try {
      const contract = makeContract(root); seedContractRoot(root, contract);
      const result = validateExecutionContractChanges({ contract, workspaceRoot: root, changedFiles: contract.targetFilePaths });
      expect(result.passed).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects wrong filenames/extensions, test changes, deletions, and missing exports', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-contract-fail-'));
    try {
      const contract = makeContract(root); seedContractRoot(root, contract); fs.writeFileSync(path.join(root, 'src/normalize-input.ts'), 'const normalizeTextInput = () => 1;\n');
      const result = validateExecutionContractChanges({ contract, workspaceRoot: root, changedFiles: ['src/normalize-input.mjs', 'tests/normalize-input.test.cjs', ...contract.targetFilePaths], deletedFiles: ['locales/en.json'] });
      expect(result.passed).toBe(false);
      expect(result.failures.join(' ')).toContain('not an explicitly declared target');
      expect(result.failures.join(' ')).toContain('Immutable verification input was modified');
      expect(result.failures.join(' ')).toContain('Deletion is not permitted');
      expect(result.failures.join(' ')).toContain('Required named export normalizeTextInput is missing');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
