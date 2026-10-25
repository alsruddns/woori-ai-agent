import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { appendDevelopmentAuditEvent, createDevelopmentAuditJob, verifyDevelopmentAuditChain } from './development-audit.js';
import { codexReadiness, executeApprovedTask } from './codex-executor.js';
import { discoverFeatureCandidates, generateFeatureSpecification } from './feature-factory.js';
import { planFeatureExecution, validateFeatureReleaseReadiness, type ExecutionContract } from './feature-execution.js';
import { getAgentPolicy, updateAgentPolicy } from './agent-policy.js';
import { enqueueDevelopmentTask, transitionDevelopmentTask, updateDevelopmentSettings } from './development-orchestrator.js';
import { approveControllerJob, assertCurrentControllerLease, claimControllerJob, registerControllerWorker, submitControllerJob, transitionControllerJob } from './distributed-queue.js';

function git(cwd: string, ...args: string[]) { execFileSync('git', args, { cwd, stdio: 'pipe', windowsHide: true, timeout: 15_000 }); }
function write(root: string, relative: string, value: string) { const target = path.resolve(root, relative); if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Fixture path escaped its temporary root.'); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value, 'utf8'); }
function findTaskAuditId(dbPath: string, taskId: string) { const db = new Database(dbPath, { readonly: true, fileMustExist: true }); try { return (db.prepare('SELECT display_id AS id FROM development_audit_jobs WHERE source_key=?').get(`development-task:${taskId}`) as { id: string } | undefined)?.id ?? null; } finally { db.close(); } }
function readJsonObject(file: string): Record<string, any> | undefined { try { const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined; } catch { return undefined; } }
export function inspectFixtureLocale(input: { locale: string; route: string; messages: Record<string, any>; metadata: Record<string, any>; html: string; robots: string; sitemap: string; buildEvidence: boolean }) {
  const { locale, route, messages, metadata: m, html, robots, sitemap, buildEvidence } = input;
  const attribute = (tag: string, name: string) => { const match = tag.match(new RegExp(`\\b${name}=(?:"([^"]+)"|'([^']+)')`, 'i')); return match?.[1] ?? match?.[2] ?? ''; };
  const htmlTags = [...html.matchAll(/<(?:html|title|meta|link)\b[^>]*>/gi)].map(match => match[0]);
  const htmlHreflang = htmlTags.filter(tag => /^<link/i.test(tag)).map(tag => attribute(tag, 'hreflang')).filter(Boolean);
  const canonicalTag = htmlTags.find(tag => /^<link/i.test(tag) && attribute(tag, 'rel').toLowerCase() === 'canonical');
  const descriptionTag = htmlTags.find(tag => /^<meta/i.test(tag) && attribute(tag, 'name').toLowerCase() === 'description');
  const title = String(m.title ?? ''), description = String(m.description ?? ''), canonical = `https://fixture.invalid${route}`;
  const renderedHtml = htmlTags.some(tag => /^<html/i.test(tag) && attribute(tag, 'lang') === locale)
    && html.includes(`<title>${title}</title>`) && Boolean(descriptionTag && attribute(descriptionTag, 'content') === description)
    && Boolean(canonicalTag && attribute(canonicalTag, 'href') === canonical)
    && htmlHreflang.includes(locale) && htmlHreflang.includes('x-default')
    && Boolean(messages.label && html.includes(String(messages.label)) && messages.input && html.includes(String(messages.input)) && messages.invalid && html.includes(String(messages.invalid)) && messages.result && html.includes(String(messages.result)));
  return { route: html.length > 0 && sitemap.includes(route), renderedHtml, uiStrings: Boolean(messages.label && messages.input && messages.invalid && messages.result), inputErrorResultStrings: Boolean(messages.input && messages.invalid && messages.result), title, description, canonical: m.canonical === canonical && Boolean(canonicalTag && attribute(canonicalTag, 'href') === canonical), hreflang: Array.isArray(m.hreflang) ? m.hreflang : [], xDefault: Boolean(m.xDefault && htmlHreflang.includes('x-default')), robotsVerified: /User-agent:\s*\*/i.test(robots) && /(?:Allow|Disallow):/i.test(robots), sitemapContainsRoute: sitemap.includes(route), buildOrRenderEvidence: buildEvidence };
}
export function readFixtureFileDiff(worktree: string, file: string) {
  const tracked = spawnSync('git', ['-C', worktree, 'ls-files', '--error-unmatch', '--', file], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  const args = tracked.status === 0 ? ['-C', worktree, 'diff', 'HEAD', '--', file] : ['-C', worktree, 'diff', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', file];
  const result = spawnSync('git', args, { cwd: worktree, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0 && result.status !== 1) throw new Error(`Could not collect fixture diff for ${file}.`);
  return result.stdout;
}

export async function runFeatureFactoryFixture(options: { execute: boolean }) {
  if (!options.execute) return { status: 'Blocked', reason: 'Use the explicit --execute=true switch to start the disposable fixture run; the Codex attempt and repair loop are capped.' };
  const readiness = codexReadiness();
  if (!readiness.executionReady || readiness.platform !== 'win32' || readiness.auth.status !== 'ChatGPT' || readiness.sandbox.status !== 'Ready' || readiness.paidApiEnvPresent || process.env.GITHUB_ACTIONS === 'true') {
    return { status: 'Blocked', phase: 'preflight', reason: 'Windows ChatGPT login, MXC sandbox, paid API absence, or local-only execution check failed.', readiness: { platform: readiness.platform, auth: readiness.auth.status, sandbox: readiness.sandbox.status, paidApiEnvPresent: readiness.paidApiEnvPresent, executionReady: readiness.executionReady } };
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woori-feature-fixture-'));
  const previousAgentDb = process.env.WOORI_AGENT_DB_PATH, previousControllerDb = process.env.WOORI_CONTROLLER_DB_PATH;
  const controllerDb = path.join(root, 'state', 'controller.sqlite'), agentDb = controllerDb;
  process.env.WOORI_AGENT_DB_PATH = agentDb; process.env.WOORI_CONTROLLER_DB_PATH = controllerDb;
  const repoPath = path.join(root, 'fixture-repository'), agentRoot = path.join(root, 'orchestrator');
  try {
    fs.mkdirSync(repoPath, { recursive: true });
    const tsc = path.resolve('node_modules/typescript/bin/tsc');
    const eslint = path.resolve('node_modules/eslint/bin/eslint.js');
    const eslintConfig = path.resolve('eslint.config.mjs');
    write(repoPath, 'package.json', JSON.stringify({ name: 'feature-factory-fixture', private: true, scripts: {
      typecheck: `node "${tsc}" -p tsconfig.json --noEmit`,
      lint: `node "${eslint}" --config "${eslintConfig}" src/normalize-input.ts`,
      build: `node "${tsc}" -p tsconfig.json`,
      test: 'node --test tests/normalize-input.test.cjs',
    } }, null, 2));
    write(repoPath, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'CommonJS', moduleResolution: 'Node', rootDir: 'src', outDir: '.fixture-build', skipLibCheck: true, types: [] }, include: ['src/normalize-input.ts'] }, null, 2));
    write(repoPath, '.gitignore', '.fixture-build/\n');
    write(repoPath, 'tests/normalize-input.test.cjs', `const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { normalizeTextInput } = require('../.fixture-build/normalize-input.js');\ntest('normalizes valid user input', () => assert.deepEqual(normalizeTextInput('  Hello\\t  world  '), { ok: true, value: 'Hello world' }));\ntest('rejects an empty normalized string', () => assert.deepEqual(normalizeTextInput('   '), { ok: false, error: 'empty-input' }));\ntest('rejects non-string input', () => assert.deepEqual(normalizeTextInput(42), { ok: false, error: 'invalid-type' }));\n`);
    write(repoPath, 'src/normalize-input.ts', 'export function normalizeTextInput(input: unknown): { ok: boolean; value?: unknown } { return { ok: true, value: input }; }\n');
    write(repoPath, 'locales/public-locales.json', JSON.stringify({ publicLocales: ['en', 'ko'] }, null, 2));
    write(repoPath, 'locales/en.json', '{}\n');
    write(repoPath, 'locales/ko.json', '{}\n');
    git(repoPath, 'init', '-b', 'fixture-base'); git(repoPath, 'config', 'user.email', 'fixture@invalid.local'); git(repoPath, 'config', 'user.name', 'Fixture'); git(repoPath, 'add', '.'); git(repoPath, 'commit', '-m', 'fixture: immutable verifier and failing feature tests');

    const current = getAgentPolicy(controllerDb);
    updateAgentPolicy({ expectedVersion: current.version, actor: 'FixtureRunner', reason: 'Isolated temporary fixture feature discovery only', patch: { mode: 'FEATURE_EXPANSION', globalAutomationEnabled: true, global: { featureDiscovery: true, featurePlanning: true, featureSpecification: true } } }, controllerDb);
    const repository = { id: 'docs', name: 'Temporary Docs Fixture', repositoryUrl: 'https://example.invalid/fixture/docs', localPath: repoPath, prBaseBranch: 'fixture-base', stack: ['Node.js fixture'], commands: { lint: 'npm run lint', test: 'npm test', build: 'npm run build' }, writeLocked: false } as any;
    const discovered = discoverFeatureCandidates('docs', controllerDb, { repositories: [repository], states: [{ id: 'docs', repositoryVerified: true, observedCurrentBranch: 'fixture-base', dirtyFileCount: 0, writeLocked: false, worktreeEligible: true }] });
    const candidate = discovered.candidates.find((item: any) => item.id === 'docs-document-format-validation');
    if (!candidate) throw new Error('No docs feature candidate was discovered for the isolated fixture.');
    const specResult = generateFeatureSpecification(candidate.id, controllerDb);
    const policyVersion = getAgentPolicy(controllerDb).version;
    const workerPolicy = { os: 'windows' as const, allowCodeChanges: true };
    const workerId = `fixture-windows-${randomUUID()}`;
    registerControllerWorker({ workerId, os: 'windows', hostLabel: 'disposable-fixture', capabilities: ['codex-write', 'build'], codexCliStatus: 'Ready', chatgptLoginStatus: 'ChatGPT', sandboxStatus: 'Ready', cpuCount: Math.max(1, os.cpus().length), availableMemoryBytes: Math.max(os.freemem(), 1_300_000_000), executionStatus: 'Idle' }, controllerDb, workerPolicy);
    const controllerJob = submitControllerJob({ localTaskId: specResult.displayJobId, service: 'docs', kind: 'fixture-feature', workClass: 'code_change', idempotencyKey: `feature-fixture:${randomUUID()}`, title: 'Isolated feature fixture execution', evidence: 'Disposable temporary Git repository only.', requiredOs: 'windows', resourceKeys: ['docs:fixture-only'] }, controllerDb);
    approveControllerJob(controllerJob.globalJobId, controllerDb);
    const lease = claimControllerJob(workerId, 300_000, controllerDb, workerPolicy);
    if (!lease) throw new Error('Temporary Controller did not issue a Worker Lease for the approved fixture job.');
    transitionControllerJob({ ...lease, status: 'Running' }, controllerDb);
    const leaseIsCurrent = () => assertCurrentControllerLease({ jobId: lease.jobId, workerId: lease.workerId, fencingToken: lease.fencingToken }, controllerDb) && Date.parse(lease.expiresAt) > Date.now();
    const auditContext = { workerId: lease.workerId, controllerId: 'fixture-controller', fencingToken: lease.fencingToken, leaseJobId: lease.jobId };
    const targetFiles = ['src/normalize-input.ts', 'locales/en.json', 'locales/ko.json', 'src/metadata.json', 'public/robots.txt', 'public/sitemap.xml', 'public/en/docs/normalize-input/index.html', 'public/ko/docs/normalize-input/index.html'];
    // The fixture's total live-model budget is capped at three calls for the entire run; the final corrective call gets no further retries.
    const contract: ExecutionContract = { version: 1, developmentJobId: specResult.displayJobId, featureId: specResult.specification.featureId, project: 'docs', featureName: 'Normalized text input helper', reason: 'Exercise real isolated source edits and independent checks without touching a service repository.', inputs: ['unknown input value'], outputs: ['success result containing normalized text or a typed error'], publicLocales: ['en', 'ko'], risk: 'Low', policyVersion, workerLease: lease, timeoutMs: 240_000, maxRetries: 0, localeRequirements: [], seoRequirements: [], sitemapRequirements: [], testRequirements: [], workspaceRoot: 'WORKTREE_ROOT', sourceRoot: 'src', targetFilePaths: targetFiles, allowedFileExtensions: ['.ts', '.json', '.txt', '.xml', '.html'], fileAllowlist: ['src/**', 'locales/**', 'public/**'], immutableFilePaths: ['package.json', 'tsconfig.json', '.gitignore', 'tests/normalize-input.test.cjs', 'locales/public-locales.json'], requiredExports: [{ file: 'src/normalize-input.ts', name: 'normalizeTextInput' }], requiredBehavior: ['NFKC normalize Unicode, trim ends, and collapse internal whitespace.', 'Reject non-string inputs with error invalid-type.', 'Reject whitespace-only inputs with error empty-input.', 'For en and ko provide label, input, invalid, and result messages.', 'For /{locale}/docs/normalize-input provide title, description, canonical, locale hreflang and x-default metadata.', 'Render an HTML page per locale with a matching lang attribute, title/description, canonical, hreflang links, visible localized labels/messages, and the expected route.', 'Add both locale routes to public/sitemap.xml and state the robots policy in public/robots.txt.'], requiredTests: ['Three fixed node:test cases for normal input, empty input and invalid input.'], requiredTestPaths: ['tests/normalize-input.test.cjs'], verificationCommands: ['typecheck', 'lint', 'build', 'test'], expectedArtifacts: targetFiles };
    const executionPlan = planFeatureExecution({ developmentJobId: specResult.displayJobId, featureId: specResult.specification.featureId, project: 'docs', featureName: contract.featureName, reason: contract.reason, requirements: contract.requiredBehavior, inputs: contract.inputs, outputs: contract.outputs, allowedPaths: contract.fileAllowlist, locales: { publicLocales: ['en', 'ko'], source: 'fixture locales/public-locales.json', authoritative: true }, risk: contract.risk, policyVersion, lease, timeoutMs: contract.timeoutMs, maxRetries: contract.maxRetries, executionContract: contract });
    if (executionPlan.status !== 'Planned') throw new Error(`Fixture execution plan blocked: ${executionPlan.reasons.join('; ')}`);
    appendDevelopmentAuditEvent({ jobId: specResult.displayJobId, type: 'FEATURE_EXECUTION_PLAN_CREATED', payload: { featureId: specResult.specification.featureId, planId: executionPlan.planId, scope: 'temporary fixture only', maxRetries: executionPlan.maxRetries, publicLocales: ['en', 'ko'], controllerJobId: lease.jobId, leaseId: lease.leaseId, executionContract: executionPlan.executionContract }, idempotencyKey: `fixture-plan:${executionPlan.planId}`, ...auditContext, policyVersion }, controllerDb);

    const task = enqueueDevelopmentTask({ service: 'docs', title: `Fixture feature: ${contract.featureName}`, kind: 'feature', priority: 'Low', evidence: `Temporary fixture only; Feature ${contract.featureId}; ${contract.reason}`, acceptanceCriteria: JSON.stringify(executionPlan.executionContract), sourceAgent: 'FeatureFactoryFixture', url: '/fixture/docs/normalize-input' });
    if (!task.created) throw new Error('Fixture task ID collided with an existing queue item.');
    transitionDevelopmentTask(task.taskId, 'Triaged'); transitionDevelopmentTask(task.taskId, 'Ready');
    updateDevelopmentSettings('docs', true, false, false);
    const repoOverride = { ...repository, observedCurrentBranch: 'fixture-base', observedDirtyFiles: [], dirtyPaths: [], dirtyFileCount: 0, repositoryVerified: true, worktreeEligible: true, codeAutomationEnabled: true, prAutomationEnabled: false, autoDeployEnabled: false, deploymentWorkflow: 'Not Configured' } as any;
    const result: any = await executeApprovedTask({ taskId: task.taskId, approved: true, allowedPaths: contract.fileAllowlist.join(','), timeoutMs: contract.timeoutMs, maxRetries: contract.maxRetries, expectedPolicyVersion: getAgentPolicy().version, leaseIsCurrent, auditContext: { ...auditContext, correlationId: executionPlan.planId }, executionContract: executionPlan.executionContract, repositoryOverride: repoOverride, agentDataRoot: agentRoot, executionLogRoot: path.join(root, 'logs') });
    const changedFiles = result.changedFiles ?? [];
    let releaseReadiness: ReturnType<typeof validateFeatureReleaseReadiness> | undefined;
    if (result.worktreePath) {
      const worktree = result.worktreePath;
      const localePath = path.join(worktree, 'locales/public-locales.json'), metadataPath = path.join(worktree, 'src/metadata.json'), sitemapPath = path.join(worktree, 'public/sitemap.xml'), robotsPath = path.join(worktree, 'public/robots.txt');
      const localesData = readJsonObject(localePath), locales = Array.isArray(localesData?.publicLocales) && localesData.publicLocales.every((locale: unknown) => typeof locale === 'string') ? localesData as { publicLocales: string[] } : { publicLocales: [] };
      const metadata = readJsonObject(metadataPath) ?? {};
      const sitemap = fs.existsSync(sitemapPath) ? fs.readFileSync(sitemapPath, 'utf8') : '';
      const robots = fs.existsSync(robotsPath) ? fs.readFileSync(robotsPath, 'utf8') : '';
      const buildEvidence = result.verification?.scripts?.some((item: any) => item.script === 'build' && item.exitCode === 0) && fs.existsSync(path.join(worktree, '.fixture-build', 'normalize-input.js'));
      const localeEvidence = Object.fromEntries(locales.publicLocales.map(locale => {
        const localePath = path.join(worktree, `locales/${locale}.json`), messages = readJsonObject(localePath) ?? {}, route = `/${locale}/docs/normalize-input`, htmlPath = path.join(worktree, `public/${locale}/docs/normalize-input/index.html`), html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
        return [locale, inspectFixtureLocale({ locale, route, messages, metadata: metadata[locale] ?? {}, html, robots, sitemap, buildEvidence: Boolean(buildEvidence) })];
      }));
      releaseReadiness = validateFeatureReleaseReadiness({ publicLocales: locales.publicLocales, localeSource: 'locales/public-locales.json (fixture authoritative declaration)', localeSourceAuthoritative: fs.existsSync(localePath), locales: localeEvidence });
      if (releaseReadiness.status === 'Ready') appendDevelopmentAuditEvent({ jobId: specResult.displayJobId, type: 'FEATURE_RELEASE_READINESS_VERIFIED', payload: { publicLocales: locales.publicLocales, changedFiles, releaseReadiness, source: 'Observed fixture files after independent lint/test/build validation' }, idempotencyKey: `fixture-release-gate:${executionPlan.planId}`, ...auditContext, policyVersion }, controllerDb);
      else appendDevelopmentAuditEvent({ jobId: specResult.displayJobId, type: 'FEATURE_RELEASE_READINESS_FAILED', payload: { publicLocales: locales.publicLocales, changedFiles, releaseReadiness }, idempotencyKey: `fixture-release-gate:${executionPlan.planId}`, ...auditContext, policyVersion }, controllerDb);
    }
    const diff = result.worktreePath ? changedFiles.map((file: string) => readFixtureFileDiff(result.worktreePath, file)).join('\n').slice(0, 20_000) : '';
    const finalStatus = result.status === 'Completed' && releaseReadiness?.status === 'Ready' ? 'Completed' : 'Failed';
    appendDevelopmentAuditEvent({ jobId: specResult.displayJobId, type: 'FEATURE_FIXTURE_EXECUTION_RESULT', payload: { executionStatus: finalStatus, codexExecutionStatus: result.status, changedFiles, observedGitDiff: diff, verification: result.verification, retryCount: result.retryCount ?? 0, releaseReadiness: releaseReadiness?.status ?? 'Not Covered', productionRepositoryModified: false, PRCreated: false, deploymentPerformed: false }, idempotencyKey: `fixture-result:${executionPlan.planId}`, ...auditContext, policyVersion }, controllerDb);
    transitionControllerJob({ ...lease, status: finalStatus, result: { testsPassed: finalStatus === 'Completed', changedFilesCount: changedFiles.length, summaryCode: finalStatus === 'Completed' ? 'FIXTURE_COMPLETED' : 'FIXTURE_VALIDATION_FAILED' }, ...(finalStatus === 'Failed' ? { failureCode: result.status === 'Completed' ? 'RELEASE_READINESS_FAILED' : 'CODEX_EXECUTION_FAILED' } : {}) }, controllerDb);
    const audit = verifyDevelopmentAuditChain(specResult.displayJobId, controllerDb);
    const taskAuditId = findTaskAuditId(controllerDb, task.taskId);
    const taskAudit = taskAuditId ? verifyDevelopmentAuditChain(taskAuditId, controllerDb) : { valid: false, events: 0, reason: 'task_audit_not_found' };
    const durableAuditPath = previousAgentDb ?? path.resolve('data/woori-agent.sqlite');
    const durableJob = createDevelopmentAuditJob({ kind: 'Feature', service: 'docs', title: 'Disposable Codex fixture execution', reason: 'Record the actual bounded Phase 11C-2.1 fixture run and its independent verification outcome.', evidence: { state: finalStatus, executionMode: 'actual ChatGPT-login Codex CLI', fixtureOnly: true }, discoveryAgent: 'FeatureFactoryFixture', risk: 'Low', status: finalStatus, sourceKey: `codex-fixture-run:${result.executionId}`, actor: 'System', metadata: { productionRepositoryModified: false, PRCreated: false, deploymentPerformed: false } }, durableAuditPath);
    const durableEvent = appendDevelopmentAuditEvent({ jobId: durableJob.uuid, type: finalStatus === 'Completed' ? 'FEATURE_FIXTURE_VERIFIED' : 'FEATURE_FIXTURE_FAILED', payload: { executionId: result.executionId, featureId: specResult.specification.featureId, executionContractVersion: contract.version, codexVersion: readiness.cli?.version, attempts: result.attemptCount, retries: result.retryCount ?? 0, changedFiles, verification: result.verification, releaseReadiness: releaseReadiness?.status ?? 'Not Covered', releaseReadinessFailures: releaseReadiness?.failures ?? ['No independent release readiness evidence was available.'], temporaryAudit: { jobId: specResult.displayJobId, featureChainValid: audit.valid, featureEvents: audit.events, taskChainValid: taskAudit.valid, taskEvents: taskAudit.events }, temporaryAuditDatabaseDeletedAfterImport: true, PRCreated: false, deploymentPerformed: false }, idempotencyKey: `codex-fixture-result:${result.executionId}`, actor: 'System', policyVersion: getAgentPolicy(durableAuditPath).version }, durableAuditPath);
    const durableChain = verifyDevelopmentAuditChain(durableJob.uuid, durableAuditPath);
    if (!durableChain.valid) throw new Error('Durable fixture audit chain failed verification; refusing to report the run as complete.');
    return { status: finalStatus, executionMode: 'actual Codex CLI attempt; no paid model API', featureId: specResult.specification.featureId, developmentJobId: specResult.displayJobId, executionPlan: { status: executionPlan.status, retriesAllowed: executionPlan.maxRetries, policyVersion: executionPlan.policyVersion, workerId: lease.workerId, fencingToken: lease.fencingToken }, codex: { version: readiness.cli?.version, auth: readiness.auth.status, sandbox: readiness.sandbox.status, paidApiEnvPresent: readiness.paidApiEnvPresent }, taskId: task.taskId, executionId: result.executionId, attemptCount: result.attemptCount, retryCount: result.retryCount, worktreePath: result.worktreePath, branchName: result.branchName, changedFiles, observedGitDiff: diff, verification: result.verification, releaseReadiness, audit: { featureSpecification: { valid: audit.valid, events: audit.events, reason: audit.reason }, taskExecution: { valid: taskAudit.valid, events: taskAudit.events, reason: taskAudit.reason }, durableImport: { valid: durableChain.valid, jobId: durableJob.id, eventId: durableEvent.eventId, events: durableChain.events } }, productionRepositoryModified: false, PRCreated: false, deploymentPerformed: false, error: result.error ?? null };
  } finally {
    if (previousAgentDb === undefined) delete process.env.WOORI_AGENT_DB_PATH; else process.env.WOORI_AGENT_DB_PATH = previousAgentDb;
    if (previousControllerDb === undefined) delete process.env.WOORI_CONTROLLER_DB_PATH; else process.env.WOORI_CONTROLLER_DB_PATH = previousControllerDb;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
