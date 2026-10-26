import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathMatchesAllowlist } from './codex-cli.js';

export type VerificationCommand = 'typecheck' | 'lint' | 'test' | 'build';
export type ExecutionContract = {
  version: 1;
  developmentJobId: string;
  featureId: string;
  project: 'calculator' | 'tools' | 'quiz' | 'docs';
  featureName: string;
  reason: string;
  inputs: string[];
  outputs: string[];
  publicLocales: string[];
  risk: 'Low' | 'Medium' | 'High' | 'Unknown';
  policyVersion: number;
  workerLease: { workerId: string; leaseId: string; fencingToken: number; expiresAt: string };
  timeoutMs: number;
  maxRetries: number;
  localeRequirements: string[];
  seoRequirements: string[];
  sitemapRequirements: string[];
  testRequirements: string[];
  workspaceRoot: string;
  sourceRoot: string;
  targetFilePaths: string[];
  allowedFileExtensions: string[];
  fileAllowlist: string[];
  immutableFilePaths: string[];
  requiredExports: Array<{ file: string; name: string }>;
  requiredBehavior: string[];
  requiredTests: string[];
  requiredTestPaths: string[];
  verificationCommands: VerificationCommand[];
  expectedArtifacts: string[];
};

function normalizedRelative(value: string) { return value.replace(/\\/g, '/').replace(/^\.\//, ''); }
function validRelative(value: string) { const normalized = normalizedRelative(value); return Boolean(normalized) && !path.isAbsolute(value) && !normalized.split('/').some(part => part === '..' || part === '.'); }

export function validateExecutionContractChanges(input: { contract: ExecutionContract; workspaceRoot: string; changedFiles: string[]; deletedFiles?: string[] }) {
  const { contract } = input;
  const failures: string[] = [];
  const root = path.resolve(input.workspaceRoot);
  if (contract.version !== 1 || path.resolve(contract.workspaceRoot) !== root) failures.push('Execution contract version or workspace root does not match the active worktree.');
  for (const list of [contract.targetFilePaths, contract.immutableFilePaths, contract.expectedArtifacts]) {
    if (list.some(file => !validRelative(file))) failures.push('Execution contract contains an unsafe or absolute file path.');
  }
  if (contract.requiredTestPaths.some(file => !validRelative(file) || !contract.immutableFilePaths.includes(file))) failures.push('Required test files must use safe paths and be declared immutable.');
  if (contract.fileAllowlist.some(pattern => path.isAbsolute(pattern) || pattern.split(/[\\/]/).some(part => part === '..')) || contract.allowedFileExtensions.some(extension => !/^\.[a-z0-9]+$/i.test(extension))) failures.push('Execution contract allowlist or extension policy is unsafe.');
  if (!contract.sourceRoot || !validRelative(contract.sourceRoot)) failures.push('Execution contract source root must be a safe workspace-relative path.');
  const changed = [...new Set(input.changedFiles.map(normalizedRelative))];
  const targets = new Set(contract.targetFilePaths.map(normalizedRelative));
  const immutable = new Set(contract.immutableFilePaths.map(normalizedRelative));
  for (const file of changed) {
    if (!contract.fileAllowlist.some(pattern => pathMatchesAllowlist(file, [pattern]))) failures.push(`Changed file is outside the execution contract allowlist: ${file}`);
    if (!targets.has(file)) failures.push(`Changed file is not an explicitly declared target: ${file}`);
    const extension = path.posix.extname(file).toLowerCase();
    if (!contract.allowedFileExtensions.map(value => value.toLowerCase()).includes(extension)) failures.push(`Changed file extension is not allowed by the execution contract: ${file}`);
    if (immutable.has(file)) failures.push(`Immutable verification input was modified: ${file}`);
  }
  for (const file of input.deletedFiles ?? []) failures.push(`Deletion is not permitted by the execution contract: ${normalizedRelative(file)}`);
  for (const file of contract.targetFilePaths) {
    const absolute = path.resolve(root, file);
    if (!absolute.startsWith(`${root}${path.sep}`) || !fs.existsSync(absolute)) failures.push(`Required target file is missing: ${file}`);
    else {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) failures.push(`Target must be a regular non-symlink file: ${file}`);
      try { const real = fs.realpathSync(absolute), relative = path.relative(root, real); if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) failures.push(`Target resolves outside the worktree: ${file}`); } catch { failures.push(`Target real path cannot be verified: ${file}`); }
      if (!changed.includes(normalizedRelative(file))) failures.push(`Declared target was not changed: ${file}`);
      if (!contract.allowedFileExtensions.map(value => value.toLowerCase()).includes(path.posix.extname(file).toLowerCase())) failures.push(`Declared target extension is not allowed: ${file}`);
    }
  }
  for (const artifact of contract.expectedArtifacts) {
    const absolute = path.resolve(root, artifact);
    if (!absolute.startsWith(`${root}${path.sep}`) || !fs.existsSync(absolute)) failures.push(`Expected artifact is missing: ${artifact}`);
  }
  for (const file of contract.immutableFilePaths) {
    const absolute = path.resolve(root, file);
    if (!absolute.startsWith(`${root}${path.sep}`) || !fs.existsSync(absolute)) failures.push(`Immutable verifier input is missing: ${file}`);
    else if (fs.lstatSync(absolute).isSymbolicLink() || !fs.lstatSync(absolute).isFile()) failures.push(`Immutable verifier input must be a regular non-symlink file: ${file}`);
  }
  for (const file of contract.requiredTestPaths) if (!fs.existsSync(path.resolve(root, file))) failures.push(`Required independent test is missing: ${file}`);
  for (const item of contract.requiredExports) {
    const absolute = path.resolve(root, item.file);
    if (!absolute.startsWith(`${root}${path.sep}`) || !fs.existsSync(absolute)) continue;
    const source = fs.readFileSync(absolute, 'utf8');
    const escaped = item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?(?:function|const|class|type|interface)\\s+${escaped}\\b|\\bexport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`).test(source)) failures.push(`Required named export ${item.name} is missing from ${item.file}.`);
  }
  return { passed: failures.length === 0, failures, changedFiles: changed };
}

export type FeatureExecutionPlanInput = {
  developmentJobId: string;
  featureId: string;
  project: 'calculator' | 'tools' | 'quiz' | 'docs';
  featureName: string;
  reason: string;
  requirements: string[];
  inputs: string[];
  outputs: string[];
  allowedPaths: string[];
  locales: { publicLocales: string[]; source: string; authoritative: boolean };
  risk: 'Low' | 'Medium' | 'High' | 'Unknown';
  policyVersion: number;
  lease: { workerId: string; leaseId: string; fencingToken: number; expiresAt: string };
  timeoutMs?: number;
  maxRetries?: number;
  executionContract?: ExecutionContract;
};

const FIXED_FORBIDDEN_PATHS = ['.github/**', '.env*', '**/secrets/**', '**/credentials*', 'deploy/**', 'deployment/**', 'infra/**', 'docker/**', 'package.json', 'pnpm-lock.yaml', 'package-lock.json'];

export function planFeatureExecution(input: FeatureExecutionPlanInput) {
  const reasons: string[] = [];
  if (!input.developmentJobId.trim() || !input.featureId.trim() || !input.featureName.trim() || !input.reason.trim()) reasons.push('Job, feature, name and selection reason are required.');
  if (!input.requirements.length || !input.inputs.length || !input.outputs.length) reasons.push('Implementation requirements and input/output contracts must be explicit.');
  if (!input.allowedPaths.length || input.allowedPaths.some((path) => !/^(?:app|src|pages|tests?|messages|locales|public)\/[A-Za-z0-9_.*\-/]+$/.test(path) || path.includes('..'))) reasons.push('Allowed paths are missing or outside source, test, locale and public evidence directories.');
  if (!input.executionContract || input.executionContract.version !== 1 || !input.executionContract.targetFilePaths.length || !input.executionContract.fileAllowlist.length || !input.executionContract.verificationCommands.length) reasons.push('A versioned execution contract with exact targets and fixed verification commands is required.');
  if (!input.locales.authoritative || !input.locales.source.trim() || input.locales.publicLocales.length === 0) reasons.push('Authoritative public locale evidence is required.');
  if (input.risk === 'High' || input.risk === 'Unknown') reasons.push(`Risk ${input.risk} is not eligible for fixture execution planning.`);
  if (!Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1) reasons.push('A current Controller policy version is required.');
  if (!input.lease.workerId || !input.lease.leaseId || !Number.isSafeInteger(input.lease.fencingToken) || input.lease.fencingToken < 1 || Date.parse(input.lease.expiresAt) <= Date.now()) reasons.push('A current Worker Lease and Fencing Token are required.');
  const timeoutMs = Math.max(30_000, Math.min(20 * 60_000, input.timeoutMs ?? 5 * 60_000));
  const maxRetries = Math.max(0, Math.min(3, Math.floor(input.maxRetries ?? 2)));
  const executionContract: ExecutionContract | undefined = input.executionContract ? {
    ...input.executionContract,
    version: 1,
    developmentJobId: input.developmentJobId,
    featureId: input.featureId,
    project: input.project,
    featureName: input.featureName,
    reason: input.reason,
    inputs: input.inputs,
    outputs: input.outputs,
    publicLocales: [...input.locales.publicLocales],
    risk: input.risk,
    policyVersion: input.policyVersion,
    workerLease: input.lease,
    timeoutMs,
    maxRetries,
    localeRequirements: ['Every authoritative public locale has a route and visible translated UI, input, error and result strings.'],
    seoRequirements: ['Title, description, canonical, hreflang, x-default and robots behavior are verified from build or render evidence.'],
    sitemapRequirements: ['The new public route is present in generated sitemap output for every public locale.'],
    testRequirements: ['TypeScript, ESLint, independent unit tests and build pass using fixed pre-approved commands.'],
  } : undefined;
  if (executionContract && (executionContract.workspaceRoot !== 'WORKTREE_ROOT' || executionContract.sourceRoot !== 'src' || executionContract.project !== input.project || executionContract.developmentJobId !== input.developmentJobId || executionContract.featureId !== input.featureId || executionContract.policyVersion !== input.policyVersion || executionContract.publicLocales.join('|') !== input.locales.publicLocales.join('|') || executionContract.fileAllowlist.some(pattern => !input.allowedPaths.includes(pattern)))) reasons.push('Execution Contract does not match the Feature Specification, locale evidence, policy, or path allowlist.');
  return {
    planId: randomUUID(),
    ...input,
    timeoutMs,
    maxRetries,
    executionContract,
    forbiddenPaths: FIXED_FORBIDDEN_PATHS,
    localeRequirements: ['Every authoritative public locale has a route and visible translated UI, input, error and result strings.'],
    seoRequirements: ['Title, description, canonical, hreflang, x-default and robots behavior are verified from build or render evidence.'],
    sitemapRequirements: ['The new public route is present in generated sitemap output for every public locale.'],
    testRequirements: ['Independent behavior tests, lint, test and production build pass.'],
    status: reasons.length ? 'Blocked' as const : 'Planned' as const,
    reasons,
  };
}

export type ReleaseReadinessInput = {
  publicLocales: string[];
  localeSource: string;
  localeSourceAuthoritative: boolean;
  locales: Record<string, { route: boolean; renderedHtml: boolean; uiStrings: boolean; inputErrorResultStrings: boolean; title: string; description: string; canonical: boolean; hreflang: string[]; xDefault: boolean; robotsVerified: boolean; sitemapContainsRoute: boolean; buildOrRenderEvidence: boolean }>;
  evidence?: { validatorVersion?: string; commitSha?: string | null; fileHashes?: Record<string, string>; localeSourceEvidence?: string; routeEvidence?: string[]; seoEvidence?: string[]; sitemapEvidence?: string[]; auditChainValid?: boolean };
};

export function validateFeatureReleaseReadiness(input: ReleaseReadinessInput) {
  const failures: string[] = [];
  if (!input.localeSourceAuthoritative || !input.localeSource.trim()) failures.push('Public locale list is not backed by an authoritative project configuration.');
  if (input.publicLocales.length === 0) failures.push('No confirmed public locales were supplied.');
  const locales = [...new Set(input.publicLocales)];
  for (const locale of locales) {
    const row = input.locales[locale];
    if (!row) { failures.push(`${locale}: no feature evidence.`); continue; }
    if (!row.route) failures.push(`${locale}: route missing.`);
    if (!row.renderedHtml) failures.push(`${locale}: rendered HTML evidence missing.`);
    if (!row.uiStrings || !row.inputErrorResultStrings) failures.push(`${locale}: translated UI/input/error/result strings incomplete.`);
    if (!row.title.trim() || !row.description.trim()) failures.push(`${locale}: title or description missing.`);
    if (!row.canonical) failures.push(`${locale}: canonical not verified.`);
    if (!row.hreflang.includes(locale) || !row.hreflang.includes('x-default')) failures.push(`${locale}: hreflang or x-default not verified.`);
    if (!row.xDefault || !row.robotsVerified || !row.sitemapContainsRoute) failures.push(`${locale}: x-default, robots or sitemap evidence missing.`);
    if (!row.buildOrRenderEvidence) failures.push(`${locale}: build/render evidence missing.`);
  }
  const checks: Record<string, { status: 'Verified' | 'Failed' | 'Missing Evidence' | 'Not Applicable'; reason?: string }> = {
    localeSource: { status: input.localeSourceAuthoritative && Boolean(input.localeSource.trim()) ? 'Verified' : 'Missing Evidence', ...(input.localeSourceAuthoritative && input.localeSource.trim() ? {} : { reason: 'Authoritative public locale source was not provided.' }) },
    routes: { status: locales.length && locales.every(locale => input.locales[locale]?.route && input.locales[locale]?.buildOrRenderEvidence) ? 'Verified' : 'Missing Evidence' },
    localeUi: { status: locales.length && locales.every(locale => input.locales[locale]?.uiStrings && input.locales[locale]?.inputErrorResultStrings) ? 'Verified' : 'Failed' },
    seo: { status: locales.length && locales.every(locale => input.locales[locale]?.title.trim() && input.locales[locale]?.description.trim() && input.locales[locale]?.canonical && input.locales[locale]?.hreflang.includes(locale) && input.locales[locale]?.hreflang.includes('x-default') && input.locales[locale]?.xDefault) ? 'Verified' : 'Failed' },
    robots: { status: locales.length && locales.every(locale => input.locales[locale]?.robotsVerified) ? 'Verified' : 'Failed' },
    sitemap: { status: locales.length && locales.every(locale => input.locales[locale]?.sitemapContainsRoute) ? 'Verified' : 'Missing Evidence' },
    build: { status: locales.length && locales.every(locale => input.locales[locale]?.buildOrRenderEvidence) ? 'Verified' : 'Missing Evidence' },
    security: { status: input.evidence?.fileHashes && Object.keys(input.evidence.fileHashes).length && input.evidence.commitSha ? 'Verified' : 'Missing Evidence' },
    audit: { status: input.evidence?.auditChainValid ? 'Verified' : 'Missing Evidence' },
  };
  return { status: failures.length ? 'Not Ready' as const : 'Ready' as const, readiness: Object.values(checks).some(item => item.status === 'Missing Evidence' || item.status === 'Failed') ? 'Not Ready' as const : 'Ready' as const, checks, validatorVersion: input.evidence?.validatorVersion ?? 'fixture-release-readiness/1.0.0', commitSha: input.evidence?.commitSha ?? null, fileHashes: input.evidence?.fileHashes ?? {}, localeSourceEvidence: input.evidence?.localeSourceEvidence ?? input.localeSource, routeEvidence: input.evidence?.routeEvidence ?? [], seoEvidence: input.evidence?.seoEvidence ?? [], sitemapEvidence: input.evidence?.sitemapEvidence ?? [], publicLocales: locales, localeSource: input.localeSource, evidenceBased: true, failures };
}

export type RetryStopReason = 'same-error' | 'timeout' | 'policy-changed' | 'lease-expired' | 'usage-limit' | 'authentication' | 'attempt-limit' | null;
export async function runBoundedFeatureAttempts<T>(options: {
  maxRetries: number;
  currentPolicyVersion: () => number;
  policyVersion: number;
  leaseCurrent: () => boolean;
  execute: (attempt: number) => Promise<{ ok: boolean; value: T; error?: string; timedOut?: boolean; usageLimit?: boolean }>;
  record: (event: { attempt: number; ok: boolean; error?: string; stopReason?: RetryStopReason }) => void | Promise<void>;
}) {
  const maxRetries = Math.max(0, Math.min(3, Math.floor(options.maxRetries)));
  let previousError: string | undefined;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.currentPolicyVersion() !== options.policyVersion) return { status: 'Blocked' as const, attempts: attempt - 1, stopReason: 'policy-changed' as const };
    if (!options.leaseCurrent()) return { status: 'Blocked' as const, attempts: attempt - 1, stopReason: 'lease-expired' as const };
    const result = await options.execute(attempt);
    if (result.ok) { await options.record({ attempt, ok: true }); return { status: 'Completed' as const, attempts: attempt, value: result.value }; }
    const authFailure = /not authenticated|authentication required|unauthorized|invalid credentials|login required|sign in to continue/i.test(result.error ?? '');
    const stopReason: RetryStopReason = result.timedOut ? 'timeout' : result.usageLimit ? 'usage-limit' : authFailure ? 'authentication' : previousError && previousError === result.error ? 'same-error' : attempt > maxRetries ? 'attempt-limit' : null;
    await options.record({ attempt, ok: false, error: result.error, stopReason: stopReason ?? undefined });
    if (stopReason) return { status: 'Failed' as const, attempts: attempt, stopReason };
    previousError = result.error;
  }
  return { status: 'Failed' as const, attempts: maxRetries + 1, stopReason: 'attempt-limit' as const };
}
