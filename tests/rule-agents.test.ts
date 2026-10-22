import { describe, expect, it } from 'vitest';
import { reviewContent } from '../apps/cli/src/rule-agents.js';
import type { Check } from '../apps/cli/src/core.js';
import{buildGrowthCandidates}from'../apps/cli/src/free-analysis.js';
import fs from'node:fs';import os from'node:os';import path from'node:path';
import{initDb}from'../apps/cli/src/core.js';

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
  it('filters ideas that exactly overlap stored capabilities and marks remaining candidates as hypotheses',()=>{
    const cwd=process.cwd(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'woori-growth-'));
    try{process.chdir(tmp);const db=initDb();db.prepare("INSERT INTO feature_results(run_id,service,locale,url,agent,feature,status,created_at) VALUES('old','home','ko','https://www.woori.today/ko','qa','Data provenance and update cards','Passed',?)").run(new Date().toISOString());db.close();const ideas=buildGrowthCandidates();expect(ideas.some(x=>x.service==='home'&&x.name==='Data provenance and update cards')).toBe(false);expect(ideas.every(x=>x.kind==='Hypothesis'&&x.searchDemand==='Not measured')).toBe(true);}finally{process.chdir(cwd);fs.rmSync(tmp,{recursive:true,force:true});}
  });
});
