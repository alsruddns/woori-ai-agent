import{afterEach,describe,expect,it}from'vitest';
import fs from'node:fs';import os from'node:os';import path from'node:path';
import{initDb}from'../apps/cli/src/core.js';
import{planQaUrls}from'../apps/cli/src/service-qa.js';
const original=process.cwd();let temporary='';
afterEach(()=>{process.chdir(original);if(temporary)fs.rmSync(temporary,{recursive:true,force:true});temporary='';});
describe('history aware URL planning',()=>{it('prioritizes unresolved failures over unchecked URLs within the same service and locale',()=>{
 temporary=fs.mkdtempSync(path.join(os.tmpdir(),'woori-qa-plan-'));process.chdir(temporary);const db=initDb();
 const failed='https://www.woori.today/ko/docs/failed',fresh='https://www.woori.today/ko/docs/fresh';
 for(const url of [failed,fresh])db.prepare("INSERT INTO discovered_urls(url,service,locale,discovered_at,source) VALUES(?,?,?,?,?)").run(url,'docs','ko',new Date().toISOString(),'sitemap');
 db.prepare("INSERT INTO feature_results(run_id,service,locale,url,agent,feature,status,created_at) VALUES('old','docs','ko',?,'qa','docs','Failed',?)").run(failed,new Date(Date.now()-86400000).toISOString());db.close();
 expect(planQaUrls('docs',[fresh,failed],1)).toEqual([failed]);
 });});
