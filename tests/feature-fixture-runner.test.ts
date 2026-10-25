import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectFixtureLocale, parseJsonObjectFile, readFixtureFileDiff, validateDeterministicFixtureReadiness } from '../apps/cli/src/feature-fixture-runner.js';
import { revalidateFeatureExecution } from '../apps/cli/src/feature-revalidation.js';

describe('fixture locale evidence parser', () => {
  it('observes rendered locale, SEO, localized UI, robots, and sitemap evidence', () => {
    const locale = 'en', route = '/en/docs/normalize-input';
    const messages = { label: 'Normalize text', input: 'Enter text', invalid: 'Invalid input', result: 'Result' };
    const metadata = { title: 'Normalize', description: 'Normalize text.', canonical: `https://fixture.invalid${route}`, hreflang: ['en', 'ko', 'x-default'], xDefault: true };
    const html = '<!doctype html><html lang="en"><head><title>Normalize</title><meta name="description" content="Normalize text."><link rel="canonical" href="https://fixture.invalid/en/docs/normalize-input"><link rel="alternate" hreflang="en" href="https://fixture.invalid/en/docs/normalize-input"><link rel="alternate" hreflang="x-default" href="https://fixture.invalid/en/docs/normalize-input"></head><body><label>Normalize text</label><p>Enter text</p><p>Invalid input</p><output>Result</output></body></html>';
    const evidence = inspectFixtureLocale({ locale, route, messages, metadata, html, robots: 'User-agent: *\nAllow: /', sitemap: `<url><loc>https://fixture.invalid${route}</loc></url>`, buildEvidence: true });
    expect(evidence).toMatchObject({ route: true, renderedHtml: true, uiStrings: true, canonical: true, xDefault: true, robotsVerified: true, sitemapContainsRoute: true, buildOrRenderEvidence: true });
  });

  it('fails closed when rendered HTML evidence is absent', () => {
    const evidence = inspectFixtureLocale({ locale: 'ko', route: '/ko/docs/tool', messages: {}, metadata: {}, html: '', robots: '', sitemap: '', buildEvidence: false });
    expect(evidence).toMatchObject({ route: false, renderedHtml: false, canonical: false, xDefault: false, robotsVerified: false, sitemapContainsRoute: false, buildOrRenderEvidence: false });
  });

  it('rejects a route explicitly disallowed by robots and passes deterministic normal and defect fixtures', () => {
    const result = validateDeterministicFixtureReadiness();
    expect(result.passed).toBe(true);
    expect(result.good.robotsVerified).toBe(true);
    expect(result.bad).toMatchObject({ renderedHtml: false, robotsVerified: false, sitemapContainsRoute: false });
  });

  it('parses UTF-8 BOM JSON and reports malformed JSON', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-json-'));
    try {
      const file = path.join(root, 'metadata.json'); fs.writeFileSync(file, '\uFEFF{"title":"Fixture"}', 'utf8');
      expect(parseJsonObjectFile(file)).toEqual({ title: 'Fixture' });
      fs.writeFileSync(file, '{broken', 'utf8');
      expect(() => parseJsonObjectFile(file)).toThrow(/Invalid JSON/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('reports insufficient evidence without attempting a model call when artifacts are absent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-revalidate-empty-'));
    try {
      const result = await revalidateFeatureExecution({ jobId: 'FEATURE-2026-000099', artifactRoot: root });
      expect(result).toMatchObject({ status: 'Insufficient Evidence', jobId: 'FEATURE-2026-000099' });
      expect(JSON.stringify(result)).not.toContain('codex exec');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('captures an untracked fixture artifact diff without staging it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-diff-test-'));
    try {
      execFileSync('git', ['init', '-q', root]);
      fs.mkdirSync(path.join(root, 'public'), { recursive: true });
      fs.writeFileSync(path.join(root, 'public', 'new.txt'), 'new evidence\n');
      const diff = readFixtureFileDiff(root, 'public/new.txt');
      expect(diff).toContain('new file mode');
      expect(diff).toContain('+new evidence');
      expect(execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })).toContain('?? public/new.txt');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
