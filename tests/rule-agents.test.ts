import { describe, expect, it } from 'vitest';
import { reviewContent } from '../apps/cli/src/rule-agents.js';
import type { Check } from '../apps/cli/src/core.js';

const page = (url: string): Check => ({ url, service: 'docs', locale: 'ko', status: 200, title: 'Guide', description: 'A guide', canonical: url, htmlLang: 'ko', hreflangCount: 1, h1Count: 1, links: [], errors: [] });

describe('free rule-based analysis', () => {
  it('flags missing metadata and duplicate titles without claiming subjective quality review', () => {
    const first = page('https://www.woori.today/ko/docs/a');
    const second = page('https://www.woori.today/ko/docs/b');
    second.description = undefined;
    const findings = reviewContent('test-run', [first, second]);
    expect(findings.some(item => item.title === 'Duplicate title in inspected pages')).toBe(true);
    expect(findings.some(item => item.title === 'Missing meta description' && item.url === second.url)).toBe(true);
    expect(findings.some(item => item.description.includes('does not assess writing quality'))).toBe(false);
  });
});
