import { randomUUID } from 'node:crypto';

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
};

const FIXED_FORBIDDEN_PATHS = ['.github/**', '.env*', '**/secrets/**', '**/credentials*', 'deploy/**', 'deployment/**', 'infra/**', 'docker/**', 'package.json', 'pnpm-lock.yaml', 'package-lock.json'];

export function planFeatureExecution(input: FeatureExecutionPlanInput) {
  const reasons: string[] = [];
  if (!input.developmentJobId.trim() || !input.featureId.trim() || !input.featureName.trim() || !input.reason.trim()) reasons.push('Job, feature, name and selection reason are required.');
  if (!input.requirements.length || !input.inputs.length || !input.outputs.length) reasons.push('Implementation requirements and input/output contracts must be explicit.');
  if (!input.allowedPaths.length || input.allowedPaths.some((path) => !/^(?:app|src|pages|tests?|messages|locales|public)\/[A-Za-z0-9_.*\-/]+$/.test(path) || path.includes('..'))) reasons.push('Allowed paths are missing or outside source, test, locale and public evidence directories.');
  if (!input.locales.authoritative || !input.locales.source.trim() || input.locales.publicLocales.length === 0) reasons.push('Authoritative public locale evidence is required.');
  if (input.risk === 'High' || input.risk === 'Unknown') reasons.push(`Risk ${input.risk} is not eligible for fixture execution planning.`);
  if (!Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1) reasons.push('A current Controller policy version is required.');
  if (!input.lease.workerId || !input.lease.leaseId || !Number.isSafeInteger(input.lease.fencingToken) || input.lease.fencingToken < 1 || Date.parse(input.lease.expiresAt) <= Date.now()) reasons.push('A current Worker Lease and Fencing Token are required.');
  const timeoutMs = Math.max(30_000, Math.min(20 * 60_000, input.timeoutMs ?? 5 * 60_000));
  const maxRetries = Math.max(0, Math.min(2, Math.floor(input.maxRetries ?? 2)));
  return {
    planId: randomUUID(),
    ...input,
    timeoutMs,
    maxRetries,
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
  locales: Record<string, { route: boolean; uiStrings: boolean; inputErrorResultStrings: boolean; title: string; description: string; canonical: boolean; hreflang: string[]; xDefault: boolean; robotsVerified: boolean; sitemapContainsRoute: boolean; buildOrRenderEvidence: boolean }>;
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
    if (!row.uiStrings || !row.inputErrorResultStrings) failures.push(`${locale}: translated UI/input/error/result strings incomplete.`);
    if (!row.title.trim() || !row.description.trim()) failures.push(`${locale}: title or description missing.`);
    if (!row.canonical) failures.push(`${locale}: canonical not verified.`);
    if (!row.hreflang.includes(locale) || !row.hreflang.includes('x-default')) failures.push(`${locale}: hreflang or x-default not verified.`);
    if (!row.xDefault || !row.robotsVerified || !row.sitemapContainsRoute) failures.push(`${locale}: x-default, robots or sitemap evidence missing.`);
    if (!row.buildOrRenderEvidence) failures.push(`${locale}: build/render evidence missing.`);
  }
  return { status: failures.length ? 'Not Ready' as const : 'Ready' as const, publicLocales: locales, localeSource: input.localeSource, evidenceBased: true, failures };
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
  const maxRetries = Math.max(0, Math.min(2, Math.floor(options.maxRetries)));
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
