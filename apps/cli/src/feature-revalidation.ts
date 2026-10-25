import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { appendDevelopmentAuditEvent, createDevelopmentAuditJob, verifyDevelopmentAuditChain } from './development-audit.js';
import { codexReadiness, runFeatureFixedVerification } from './codex-executor.js';
import { discoverCodexCli, probeCodexSandbox } from './codex-cli.js';
import { inspectFixtureLocale, parseJsonObjectFile } from './feature-fixture-runner.js';
import { validateExecutionContractChanges, validateFeatureReleaseReadiness, type ExecutionContract } from './feature-execution.js';

const files = ['src/normalize-input.ts', 'locales/public-locales.json', 'locales/en.json', 'locales/ko.json', 'src/metadata.json', 'public/robots.txt', 'public/sitemap.xml', 'public/en/docs/normalize-input/index.html', 'public/ko/docs/normalize-input/index.html', 'tests/normalize-input.test.cjs', 'tsconfig.json', '.gitignore', 'package.json'] as const;
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as any;

export async function revalidateFeatureExecution(input: { jobId: string; invocationId?: string; artifactRoot?: string; databasePath?: string }) {
  const repoRoot = path.resolve(process.cwd());
  const artifactRoot = path.resolve(input.artifactRoot ?? path.join(repoRoot, 'artifacts/feature-execution'));
  const safeJob = input.jobId.replace(/[^A-Za-z0-9._-]/g, '_');
  const jobRoot = path.resolve(artifactRoot, safeJob);
  if (!jobRoot.startsWith(artifactRoot + path.sep) || !fs.existsSync(jobRoot)) return { status: 'Insufficient Evidence', jobId: input.jobId, reason: 'No retained execution artifact exists for this job.' };
  const candidates = fs.readdirSync(jobRoot, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => path.join(jobRoot, item.name));
  const selected = input.invocationId ? candidates.find(dir => path.basename(dir) === input.invocationId) : candidates.sort().at(-1);
  if (!selected || !fs.existsSync(path.join(selected, 'manifest.json'))) return { status: 'Insufficient Evidence', jobId: input.jobId, reason: 'No matching invocation evidence manifest exists.' };
  const manifest = readJson(path.join(selected, 'manifest.json')) as { schemaVersion: number; jobId: string; invocationId: string; fileHashes: Record<string, string>; artifactHashes: Record<string, string>; status: string; sourceCommit?: string | null };
  if (manifest.schemaVersion !== 1 || manifest.jobId !== input.jobId || manifest.invocationId !== path.basename(selected)) return { status: 'Failed', jobId: input.jobId, invocationId: manifest.invocationId, reason: 'Artifact manifest identity mismatch.' };
  const evidenceFiles = path.join(selected, 'files');
  const integrityFailures: string[] = [];
  for (const [relative, expectedHash] of Object.entries(manifest.fileHashes ?? {})) {
    if (!(files as readonly string[]).includes(relative)) { integrityFailures.push(`File is outside the evidence allowlist: ${relative}`); continue; }
    const target = path.resolve(evidenceFiles, relative);
    if (!target.startsWith(path.resolve(evidenceFiles) + path.sep) || !fs.existsSync(target)) { integrityFailures.push(`Evidence file is missing: ${relative}`); continue; }
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || hash(fs.readFileSync(target)) !== expectedHash) integrityFailures.push(`Evidence file hash or type differs: ${relative}`);
  }
  for (const [relative, expectedHash] of Object.entries(manifest.artifactHashes ?? {})) {
    const target = path.resolve(selected, relative);
    if (!['execution-contract.json','changed-files.json','verification.json','execution-environment.json','readiness.json','git-diff.patch'].includes(relative) || !target.startsWith(path.resolve(selected) + path.sep) || !fs.existsSync(target) || !fs.lstatSync(target).isFile() || hash(fs.readFileSync(target)) !== expectedHash) integrityFailures.push(`Artifact evidence hash differs or path is not allowed: ${relative}`);
  }
  const contract = readJson(path.join(selected, 'execution-contract.json')) as ExecutionContract;
  const changedFiles = readJson(path.join(selected, 'changed-files.json')) as string[];
  const diffPath = path.join(selected, 'git-diff.patch');
  const diffText = fs.existsSync(diffPath) ? fs.readFileSync(diffPath, 'utf8') : '';
  const diffFiles = [...diffText.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]!.replace(/\\/g, '/'));
  const recordedVerification = readJson(path.join(selected, 'verification.json'));
  const contractResult = validateExecutionContractChanges({ contract: { ...contract, workspaceRoot: evidenceFiles }, workspaceRoot: evidenceFiles, changedFiles, deletedFiles: [] });
  // Evidence files are selected by the preservation allowlist; only files declared in the original contract count as required artifacts.
  const targetFailures = contract.targetFilePaths.filter(relative => !fs.existsSync(path.resolve(evidenceFiles, relative))).map(relative => `Original target artifact was not retained: ${relative}`);
  const changedFailures = changedFiles.filter(relative => !contract.targetFilePaths.includes(relative)).map(relative => `Recorded changed file is outside declared target set: ${relative}`);
  const diffFailures = !diffText.trim() ? ['Git diff evidence is missing.'] : changedFiles.filter(relative => !diffFiles.includes(relative)).map(relative => `Git diff does not contain the recorded changed file: ${relative}`);
  const localesFile = path.join(evidenceFiles, 'locales/public-locales.json');
  const localeData = fs.existsSync(localesFile) ? parseJsonObjectFile(localesFile) : undefined;
  const publicLocales = Array.isArray(localeData?.publicLocales) && localeData.publicLocales.every((value: unknown) => typeof value === 'string') ? localeData.publicLocales as string[] : [];
  const metadataFile = path.join(evidenceFiles, 'src/metadata.json');
  const metadata = fs.existsSync(metadataFile) ? parseJsonObjectFile(metadataFile) : {};
  const robots = fs.existsSync(path.join(evidenceFiles, 'public/robots.txt')) ? fs.readFileSync(path.join(evidenceFiles, 'public/robots.txt'), 'utf8') : '';
  const sitemap = fs.existsSync(path.join(evidenceFiles, 'public/sitemap.xml')) ? fs.readFileSync(path.join(evidenceFiles, 'public/sitemap.xml'), 'utf8') : '';
  const localeEvidence = Object.fromEntries(publicLocales.map(locale => {
    const route = `/${locale}/docs/normalize-input`, messagesFile = path.join(evidenceFiles, `locales/${locale}.json`), htmlFile = path.join(evidenceFiles, `public/${locale}/docs/normalize-input/index.html`);
    const messages = fs.existsSync(messagesFile) ? parseJsonObjectFile(messagesFile) : {};
    const html = fs.existsSync(htmlFile) ? fs.readFileSync(htmlFile, 'utf8') : '';
    return [locale, inspectFixtureLocale({ locale, route, messages, metadata: metadata[locale] ?? {}, html, robots, sitemap, buildEvidence: Boolean(recordedVerification.scripts?.some((row: any) => row.script === 'build' && row.exitCode === 0)) })];
  }));
  const databasePath = path.resolve(input.databasePath ?? process.env.WOORI_AGENT_DB_PATH ?? 'data/woori-agent.sqlite');
  let auditChainValid = false;
  try {
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const auditRow = db.prepare('SELECT audit_job_uuid AS jobUuid FROM codex_invocations WHERE invocation_id=?').get(manifest.invocationId) as { jobUuid: string } | undefined;
      if (auditRow?.jobUuid) auditChainValid = verifyDevelopmentAuditChain(auditRow.jobUuid, databasePath).valid;
    } finally { db.close(); }
  } catch { auditChainValid = false; }
  const readiness = validateFeatureReleaseReadiness({ publicLocales, localeSource: fs.existsSync(localesFile) ? 'retained public-locales.json with SHA-256 manifest' : '', localeSourceAuthoritative: Boolean(localeData), locales: localeEvidence, evidence: { validatorVersion: 'feature-revalidate/1.0.0', commitSha: manifest.sourceCommit ?? null, fileHashes: manifest.fileHashes, localeSourceEvidence: 'Hash-verified preserved locale registry and route artifacts.', routeEvidence: publicLocales.map(locale => `public/${locale}/docs/normalize-input/index.html`), seoEvidence: publicLocales.map(locale => `src/metadata.json#${locale}`), sitemapEvidence: ['public/sitemap.xml'], auditChainValid } });
  const missingValidationEvidence = ['typecheck', 'lint', 'build', 'test'].filter(script => !recordedVerification.scripts?.some((row: any) => row.script === script && row.exitCode === 0 && !row.timedOut));
  const cli = discoverCodexCli();
  const platformReady = Boolean(cli && (process.platform === 'win32' || process.platform === 'linux') && probeCodexSandbox(cli).status === 'Ready' && process.env.GITHUB_ACTIONS !== 'true' && codexReadiness().paidApiEnvPresent === false);
  const recheckResults: Array<{ script: string; exitCode: number | null; timedOut: boolean; output: string }> = [];
  let verificationStatus: 'Verified' | 'Failed' | 'Missing Evidence' = 'Missing Evidence';
  let tempRoot = '';
  if (!integrityFailures.length && !targetFailures.length && !changedFailures.length && !contractResult.failures.length && !missingValidationEvidence.length && platformReady && cli) {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'woori-feature-revalidate-'));
    try {
      for (const relative of files) {
        if (relative === 'package.json') continue;
        const source = path.resolve(evidenceFiles, relative);
        if (!source.startsWith(path.resolve(evidenceFiles) + path.sep) || !fs.existsSync(source)) continue;
        const destination = path.resolve(tempRoot, relative);
        if (!destination.startsWith(tempRoot + path.sep)) throw new Error('Revalidation copy path escaped its temporary workspace.');
        fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      }
      const tsc = path.resolve('node_modules/typescript/bin/tsc'), eslint = path.resolve('node_modules/eslint/bin/eslint.js'), config = path.resolve('eslint.config.mjs');
      fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ private: true, packageManager: 'npm@10.0.0', scripts: { typecheck: `node "${tsc}" -p tsconfig.json --noEmit`, lint: `node "${eslint}" --config "${config}" src/normalize-input.ts`, build: `node "${tsc}" -p tsconfig.json`, test: 'node --test tests/normalize-input.test.cjs' } }), { mode: 0o600, flag: 'wx' });
      for (const script of ['typecheck', 'lint', 'build', 'test'] as const) {
        const result = runFeatureFixedVerification(cli, tempRoot, script, 120_000);
        recheckResults.push(result);
        if (result.exitCode !== 0 || result.timedOut) break;
      }
      verificationStatus = recheckResults.length === 4 && recheckResults.every(row => row.exitCode === 0 && !row.timedOut) ? 'Verified' : 'Failed';
    } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  }
  const failures = [...integrityFailures, ...targetFailures, ...changedFailures, ...diffFailures, ...contractResult.failures, ...missingValidationEvidence.map(name => `Recorded successful ${name} evidence is absent.`), ...readiness.failures, ...recheckResults.filter(row => row.exitCode !== 0 || row.timedOut).map(row => `${row.script} failed or timed out during no-AI revalidation.`)];
  const confirmedReadinessFailure = Object.values(readiness.checks).some(check => check.status === 'Failed');
  const status = verificationStatus === 'Verified' && readiness.status === 'Ready' && readiness.readiness === 'Ready' && failures.length === 0 ? 'Revalidated' : verificationStatus === 'Failed' || integrityFailures.length || contractResult.failures.length || confirmedReadinessFailure ? 'Failed' : 'Insufficient Evidence';
  const result = { status, jobId: input.jobId, invocationId: manifest.invocationId, revalidatedAt: new Date().toISOString(), validatorVersion: 'feature-revalidate/1.0.0', codexModelCalls: 0, artifactIntegrity: integrityFailures.length ? 'Failed' : 'Verified', contract: contractResult, readiness, priorValidationEvidence: recordedVerification.scripts ?? [], noAiValidation: recheckResults, missingValidationEvidence, failures };
  const audit = createDevelopmentAuditJob({ kind: 'Feature', service: 'docs', title: 'No-AI fixture release revalidation', reason: 'Re-evaluate preserved fixture evidence without invoking Codex.', risk: 'Low', status: status === 'Revalidated' ? 'Verified' : status, sourceKey: `feature-revalidation:${manifest.invocationId}:${randomUUID()}`, actor: 'System', metadata: { invocationId: manifest.invocationId } }, databasePath);
  appendDevelopmentAuditEvent({ jobId: audit.uuid, type: 'READINESS_REVALIDATED', payload: result, idempotencyKey: `readiness-revalidated:${manifest.invocationId}:${randomUUID()}`, actor: 'System' }, databasePath);
  return { ...result, auditJobId: audit.id };
}
