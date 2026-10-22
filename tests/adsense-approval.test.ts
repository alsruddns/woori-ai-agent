import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adsTxtLines, classifyContent, robotsAllowsGoogle, selectAdsenseAuditUrls } from '../apps/cli/src/adsense-approval.js';
import { config } from '../apps/cli/src/core.js';

const originalDb = process.env.WOORI_AGENT_DB_PATH;
let tempDir: string | undefined;
afterEach(() => {
  if (originalDb === undefined) delete process.env.WOORI_AGENT_DB_PATH;
  else process.env.WOORI_AGENT_DB_PATH = originalDb;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('AdSense Approval Auditor rules', () => {
  it('parses ads.txt records without making absence a failure condition', () => {
    expect(adsTxtLines('')).toEqual([]);
    expect(adsTxtLines('google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0')).toEqual([
      { domain: 'google.com', accountId: 'pub-1234567890123456', relationship: 'DIRECT', certificationId: 'f08c47fec0942fa0', valid: true, line: 1 }
    ]);
    expect(adsTxtLines('not-a-record').length).toBe(0);
  });

  it('applies matching Google crawler robots rules with longest path precedence', () => {
    const rules = 'User-agent: *\nDisallow: /private\nAllow: /private/public\nUser-agent: Mediapartners-Google\nDisallow: /ads';
    expect(robotsAllowsGoogle(rules, '/private/page', 'Googlebot')).toBe(false);
    expect(robotsAllowsGoogle(rules, '/private/public/page', 'Googlebot')).toBe(true);
    expect(robotsAllowsGoogle(rules, '/ads.txt', 'Mediapartners-Google')).toBe(false);
    expect(robotsAllowsGoogle(rules, '/public', 'Googlebot')).toBe(true);
  });

  it('uses service-specific content signals instead of a universal word-count approval threshold', () => {
    const snapshot = {
      service: 'calculator', mainText: 'Calculate this value.', hasHowTo: false, hasFormula: false,
      headings: ['Compound interest'], text: 'Calculate this value.', hasSource: false,
      hasExplanation: false, hasExample: false, hasFaq: false
    } as Parameters<typeof classifyContent>[0];
    const checks = classifyContent(snapshot);
    expect(checks.find(check => check.key === 'main-content')?.ok).toBe(true);
    expect(checks.find(check => check.key === 'formula')?.ok).toBe(false);
    expect(checks.find(check => check.key === 'faq')?.message).toContain('optional');
  });

  it('selects a deduplicated sample that includes every configured service', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woori-adsense-'));
    process.env.WOORI_AGENT_DB_PATH = path.join(tempDir, 'audit.sqlite');
    const urls = [...config.services.flatMap(service => config.locales.slice(0, 2).map(locale => `${config.baseUrl}/${locale}${service.pathPrefix ? `/${service.pathPrefix}` : ''}`)), `${config.baseUrl}/bn/privacy`];
    const selected = selectAdsenseAuditUrls(urls, 12);
    expect(selected).toHaveLength(12);
    expect(new Set(selected).size).toBe(selected.length);
    expect(selected).not.toContain(`${config.baseUrl}/bn/privacy`);
    expect(new Set(selected.map(url => new URL(url).pathname.split('/')[2] ?? 'home')).size).toBeGreaterThanOrEqual(6);
    expect(selected.every(url => url.startsWith(config.baseUrl))).toBe(true);
  });
});
