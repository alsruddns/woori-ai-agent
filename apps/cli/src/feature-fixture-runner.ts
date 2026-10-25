import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { appendDevelopmentAuditEvent, verifyDevelopmentAuditChain } from './development-audit.js';
import { codexReadiness, executeApprovedTask } from './codex-executor.js';
import { discoverFeatureCandidates, generateFeatureSpecification } from './feature-factory.js';
import { planFeatureExecution, validateFeatureReleaseReadiness } from './feature-execution.js';
import { getAgentPolicy, updateAgentPolicy } from './agent-policy.js';
import { enqueueDevelopmentTask, transitionDevelopmentTask, updateDevelopmentSettings } from './development-orchestrator.js';

function git(cwd: string, ...args: string[]) { execFileSync('git', args, { cwd, stdio: 'pipe', windowsHide: true, timeout: 15_000 }); }
function write(root: string, relative: string, value: string) { const target = path.resolve(root, relative); if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Fixture path escaped its temporary root.'); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value, 'utf8'); }
function findTaskAuditId(dbPath: string, taskId: string) { const db = new Database(dbPath, { readonly: true, fileMustExist: true }); try { return (db.prepare('SELECT display_id AS id FROM development_audit_jobs WHERE source_key=?').get(`development-task:${taskId}`) as { id: string } | undefined)?.id ?? null; } finally { db.close(); } }

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
    write(repoPath, 'package.json', JSON.stringify({ name: 'feature-factory-fixture', private: true, scripts: { lint: 'node --check src/format-validator.js', test: 'node --test', build: 'node --check src/format-validator.js' } }, null, 2));
    write(repoPath, 'tests/format-validator.test.js', `const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { validateDocumentDescriptor } = require('../src/format-validator.js');\ntest('accepts a supported descriptor and rejects unsupported or invalid sizes', () => { assert.deepEqual(validateDocumentDescriptor({ name: 'sample.json', mediaType: 'application/json', sizeBytes: 24 }), { valid: true, format: 'json' }); assert.equal(validateDocumentDescriptor({ name: 'x.bin', mediaType: 'application/octet-stream', sizeBytes: 10 }).valid, false); assert.equal(validateDocumentDescriptor({ name: 'x.txt', mediaType: 'text/plain', sizeBytes: -1 }).valid, false); });\n`);
    write(repoPath, 'locales/public-locales.json', JSON.stringify({ publicLocales: ['en', 'ko'] }, null, 2));
    write(repoPath, 'locales/en.json', JSON.stringify({ label: 'Celsius', result: 'Fahrenheit', invalid: 'Enter a number' }, null, 2));
    write(repoPath, 'locales/ko.json', JSON.stringify({ label: '\\uC12D\\uC528', result: '\\uD654\\uC528', invalid: '\\uC22B\\uC790\\uB97C \\uC785\\uB825\\uD558\\uC138\\uC694' }, null, 2));
    git(repoPath, 'init', '-b', 'fixture-base'); git(repoPath, 'config', 'user.email', 'fixture@invalid.local'); git(repoPath, 'config', 'user.name', 'Fixture'); git(repoPath, 'add', '.'); git(repoPath, 'commit', '-m', 'fixture: initial failing feature tests');

    const current = getAgentPolicy(controllerDb);
    updateAgentPolicy({ expectedVersion: current.version, actor: 'FixtureRunner', reason: 'Isolated temporary fixture feature discovery only', patch: { mode: 'FEATURE_EXPANSION', globalAutomationEnabled: true, global: { featureDiscovery: true, featurePlanning: true, featureSpecification: true } } }, controllerDb);
    const repository = { id: 'docs', name: 'Temporary Docs Fixture', repositoryUrl: 'https://example.invalid/fixture/docs', localPath: repoPath, prBaseBranch: 'fixture-base', stack: ['Node.js fixture'], commands: { lint: 'npm run lint', test: 'npm test', build: 'npm run build' }, writeLocked: false } as any;
    const discovered = discoverFeatureCandidates('docs', controllerDb, { repositories: [repository], states: [{ id: 'docs', repositoryVerified: true, observedCurrentBranch: 'fixture-base', dirtyFileCount: 0, writeLocked: false, worktreeEligible: true }] });
    const candidate = discovered.candidates.find((item: any) => item.id === 'docs-document-format-validation');
    if (!candidate) throw new Error('No docs feature candidate was discovered for the isolated fixture.');
    const specResult = generateFeatureSpecification(candidate.id, controllerDb);
    const policyVersion = getAgentPolicy(controllerDb).version;
    const lease = { workerId: 'fixture-windows-worker', leaseId: randomUUID(), fencingToken: 1, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    const executionPlan = planFeatureExecution({ developmentJobId: specResult.displayJobId, featureId: specResult.specification.featureId, project: 'docs', featureName: 'Document format validation helper fixture', reason: 'Exercise the actual source-edit and validation path in a disposable repository.', requirements: ['Validate supported JSON/text document descriptor metadata locally.', 'Provide English and Korean UI messages.', 'Provide locale-specific SEO title/description and a sitemap route.'], inputs: ['File name, MIME type and byte size'], outputs: ['Format validation result'], allowedPaths: ['src/**', 'tests/**', 'locales/**', 'public/**'], locales: { publicLocales: ['en', 'ko'], source: 'fixture locales/public-locales.json', authoritative: true }, risk: 'Low', policyVersion, lease, timeoutMs: 240_000, maxRetries: 2 });
    if (executionPlan.status !== 'Planned') throw new Error(`Fixture execution plan blocked: ${executionPlan.reasons.join('; ')}`);
    appendDevelopmentAuditEvent({ jobId: specResult.displayJobId, type: 'FEATURE_EXECUTION_PLAN_CREATED', payload: { featureId: specResult.specification.featureId, planId: executionPlan.planId, scope: 'temporary fixture only', maxRetries: executionPlan.maxRetries, publicLocales: ['en', 'ko'], leaseId: lease.leaseId }, idempotencyKey: `fixture-plan:${executionPlan.planId}`, workerId: lease.workerId, controllerId: 'fixture-controller', fencingToken: lease.fencingToken, policyVersion }, controllerDb);

    const task = enqueueDevelopmentTask({ service: 'docs', title: 'Fixture feature: document format validation helper', kind: 'feature', priority: 'Low', evidence: `Temporary fixture only; Feature ${specResult.specification.featureId}; ${executionPlan.reason}`, acceptanceCriteria: 'Implement CommonJS src/format-validator.js exporting validateDocumentDescriptor. Support application/json and text/plain, require a nonempty name and a finite sizeBytes from 0 through 1048576. Add tests/format-validator.test.js. Add actual locales/en.json and locales/ko.json strings with label/result/invalid. Add src/metadata.json with en and ko title, description, canonical, hreflang including en/ko/x-default, and xDefault true. Add public/robots.txt and public/sitemap.xml containing /en/docs/format-validator and /ko/docs/format-validator. Do not edit package scripts or unrelated files.', sourceAgent: 'FeatureFactoryFixture', url: '/fixture/docs/format-validator' });
    if (!task.created) throw new Error('Fixture task ID collided with an existing queue item.');
    transitionDevelopmentTask(task.taskId, 'Triaged'); transitionDevelopmentTask(task.taskId, 'Ready');
    updateDevelopmentSettings('docs', true, false, false);
    const repoOverride = { ...repository, observedCurrentBranch: 'fixture-base', observedDirtyFiles: [], dirtyPaths: [], dirtyFileCount: 0, repositoryVerified: true, worktreeEligible: true, codeAutomationEnabled: true, prAutomationEnabled: false, autoDeployEnabled: false, deploymentWorkflow: 'Not Configured' } as any;
    const result: any = await executeApprovedTask({ taskId: task.taskId, approved: true, allowedPaths: 'src/**,tests/**,locales/**,public/**', timeoutMs: 240_000, maxRetries: 2, expectedPolicyVersion: getAgentPolicy().version, leaseIsCurrent: () => Date.parse(lease.expiresAt) > Date.now(), auditContext: { workerId: lease.workerId, controllerId: 'fixture-controller', fencingToken: lease.fencingToken, correlationId: executionPlan.planId }, repositoryOverride: repoOverride, agentDataRoot: agentRoot, executionLogRoot: path.join(root, 'logs') });
    const changedFiles = result.changedFiles ?? [];
    let releaseReadiness: ReturnType<typeof validateFeatureReleaseReadiness> | undefined;
    if (result.status === 'Completed' && result.worktreePath) {
      const worktree = result.worktreePath;
      const localePath = path.join(worktree, 'locales/public-locales.json'), metadataPath = path.join(worktree, 'src/metadata.json'), sitemapPath = path.join(worktree, 'public/sitemap.xml'), robotsPath = path.join(worktree, 'public/robots.txt');
      const locales = fs.existsSync(localePath) ? JSON.parse(fs.readFileSync(localePath, 'utf8')) as { publicLocales: string[] } : { publicLocales: [] };
      const metadata = fs.existsSync(metadataPath) ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as Record<string, any> : {};
      const sitemap = fs.existsSync(sitemapPath) ? fs.readFileSync(sitemapPath, 'utf8') : '';
      const robots = fs.existsSync(robotsPath) ? fs.readFileSync(robotsPath, 'utf8') : '';
      const localeEvidence = Object.fromEntries(locales.publicLocales.map(locale => { const localePath = path.join(worktree, `locales/${locale}.json`), messages = fs.existsSync(localePath) ? JSON.parse(fs.readFileSync(localePath, 'utf8')) : {}, m = metadata[locale] ?? {}; return [locale, { route: sitemap.includes(`/${locale}/docs/format-validator`), uiStrings: Boolean(messages.label && messages.result && messages.invalid), inputErrorResultStrings: Boolean(messages.invalid && messages.result), title: String(m.title ?? ''), description: String(m.description ?? ''), canonical: typeof m.canonical === 'string' && m.canonical.startsWith('https://fixture.invalid/'), hreflang: Array.isArray(m.hreflang) ? m.hreflang : [], xDefault: Boolean(m.xDefault), robotsVerified: /User-agent:\s*\*/i.test(robots) && /(?:Allow|Disallow):/i.test(robots), sitemapContainsRoute: sitemap.includes(`/${locale}/docs/format-validator`), buildOrRenderEvidence: true }]; }));
      releaseReadiness = validateFeatureReleaseReadiness({ publicLocales: locales.publicLocales, localeSource: 'locales/public-locales.json (fixture authoritative declaration)', localeSourceAuthoritative: fs.existsSync(localePath), locales: localeEvidence });
      if (releaseReadiness.status === 'Ready') appendDevelopmentAuditEvent({ jobId: specResult.displayJobId, type: 'FEATURE_RELEASE_READINESS_VERIFIED', payload: { publicLocales: locales.publicLocales, changedFiles, releaseReadiness, source: 'Observed fixture files after independent lint/test/build validation' }, idempotencyKey: `fixture-release-gate:${executionPlan.planId}`, workerId: lease.workerId, controllerId: 'fixture-controller', fencingToken: lease.fencingToken, policyVersion }, controllerDb);
      else appendDevelopmentAuditEvent({ jobId: specResult.displayJobId, type: 'FEATURE_RELEASE_READINESS_FAILED', payload: { publicLocales: locales.publicLocales, changedFiles, releaseReadiness }, idempotencyKey: `fixture-release-gate:${executionPlan.planId}`, workerId: lease.workerId, controllerId: 'fixture-controller', fencingToken: lease.fencingToken, policyVersion }, controllerDb);
    }
    const diff = result.worktreePath ? changedFiles.map((file: string) => { try { return execFileSync('git', ['diff', '--no-index', '--', '/dev/null', file], { cwd: result.worktreePath, encoding: 'utf8', windowsHide: true, timeout: 5000 }); } catch (error) { return (error as { stdout?: Buffer }).stdout?.toString('utf8') ?? ''; } }).join('\n').slice(0, 20_000) : '';
    appendDevelopmentAuditEvent({ jobId: specResult.displayJobId, type: 'FEATURE_FIXTURE_EXECUTION_RESULT', payload: { executionStatus: result.status, changedFiles, observedGitDiff: diff, verification: result.verification, retryCount: result.retryCount ?? 0, releaseReadiness: releaseReadiness?.status ?? 'Not Covered', productionRepositoryModified: false, PRCreated: false, deploymentPerformed: false }, idempotencyKey: `fixture-result:${executionPlan.planId}`, workerId: lease.workerId, controllerId: 'fixture-controller', fencingToken: lease.fencingToken, policyVersion }, controllerDb);
    const audit = verifyDevelopmentAuditChain(specResult.displayJobId, controllerDb);
    const taskAuditId = findTaskAuditId(controllerDb, task.taskId);
    const taskAudit = taskAuditId ? verifyDevelopmentAuditChain(taskAuditId, controllerDb) : { valid: false, events: 0, reason: 'task_audit_not_found' };
    return { status: result.status, executionMode: 'actual Codex CLI attempt; no paid model API', featureId: specResult.specification.featureId, developmentJobId: specResult.displayJobId, executionPlan: { status: executionPlan.status, retriesAllowed: executionPlan.maxRetries, policyVersion: executionPlan.policyVersion, workerId: lease.workerId, fencingToken: lease.fencingToken }, codex: { version: readiness.cli?.version, auth: readiness.auth.status, sandbox: readiness.sandbox.status, paidApiEnvPresent: readiness.paidApiEnvPresent }, taskId: task.taskId, executionId: result.executionId, attemptCount: result.attemptCount, retryCount: result.retryCount, worktreePath: result.worktreePath, branchName: result.branchName, changedFiles, observedGitDiff: diff, verification: result.verification, releaseReadiness, audit: { featureSpecification: { valid: audit.valid, events: audit.events, reason: audit.reason }, taskExecution: { valid: taskAudit.valid, events: taskAudit.events, reason: taskAudit.reason } }, productionRepositoryModified: false, PRCreated: false, deploymentPerformed: false, error: result.error ?? null };
  } finally {
    if (previousAgentDb === undefined) delete process.env.WOORI_AGENT_DB_PATH; else process.env.WOORI_AGENT_DB_PATH = previousAgentDb;
    if (previousControllerDb === undefined) delete process.env.WOORI_CONTROLLER_DB_PATH; else process.env.WOORI_CONTROLLER_DB_PATH = previousControllerDb;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
