import {afterEach,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {classifyGscPage,collectGscPages,discoverGscProperties,gscReport,isWooriGscProperty,resolveGscRange,selectGscProperty,summarizeGscRows} from '../apps/cli/src/google-analytics.js';
import {apiRequestsUsed,initDb,reserveApiRequest} from '../apps/cli/src/core.js';

const before={...process.env};
afterEach(()=>{for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before)});

describe('Search Console read-only data helpers',()=>{
 it('recognizes only exact woori.today domain properties and their subdomains',()=>{
  expect(isWooriGscProperty('sc-domain:woori.today')).toBe(true);
  expect(isWooriGscProperty('https://www.woori.today/')).toBe(true);
  expect(isWooriGscProperty('https://notwoori.today/')).toBe(false);
  expect(isWooriGscProperty('sc-domain:example.com')).toBe(false);
 });
 it('classifies known service routes and leaves ambiguous paths unknown',()=>{
  expect(classifyGscPage('https://www.woori.today/ko/calculators/compound-interest')).toBe('calculator');
  expect(classifyGscPage('https://www.woori.today/ko/tools/json-formatter')).toBe('tools');
  expect(classifyGscPage('https://www.woori.today/ko/world/population')).toBe('home');
  expect(classifyGscPage('https://www.woori.today/ko/unmapped-route')).toBe('unknown');
  expect(classifyGscPage('https://external.example/ko/tools/json-formatter')).toBe('unknown');
 });
 it('calculates CTR from totals and position weighted by impressions',()=>{
  expect(summarizeGscRows([{clicks:10,impressions:100,ctr:0.1,position:2},{clicks:20,impressions:100,ctr:0.2,position:4}])).toEqual({clicks:30,impressions:200,ctr:0.15,position:3});
 });
 it('paginates with startRow offsets and detects an exact final-page boundary',async()=>{
  const offsets:number[]=[];const result=await collectGscPages(async(startRow,rowLimit)=>{offsets.push(startRow);return startRow===0?Array.from({length:rowLimit},(_,i)=>i):[];},()=>true,2);
  expect(offsets).toEqual([0,2]);expect(result.rows).toEqual([0,1]);expect(result.requests).toBe(2);expect(result.partial).toBe(false);
 });
 it('stops at the request budget and marks returned detail rows partial',async()=>{
  const offsets:number[]=[];let remaining=1;const result=await collectGscPages(async(startRow,rowLimit)=>{offsets.push(startRow);return Array.from({length:rowLimit},(_,i)=>startRow+i);},()=>remaining-->0,2);
  expect(offsets).toEqual([0]);expect(result.rows).toEqual([0,1]);expect(result.requests).toBe(1);expect(result.partial).toBe(true);
 });
 it('resolves recent, previous, and custom periods without overlapping comparisons',()=>{
  expect(resolveGscRange('7d','2026-10-22')).toMatchObject({start:'2026-10-16',end:'2026-10-22',previousStart:'2026-10-09',previousEnd:'2026-10-15'});
  expect(resolveGscRange('28d','2026-10-22')).toMatchObject({start:'2026-09-25',end:'2026-10-22',previousStart:'2026-08-28',previousEnd:'2026-09-24'});
  expect(resolveGscRange('previous28d','2026-10-22')).toMatchObject({start:'2026-08-28',end:'2026-09-24'});
  expect(resolveGscRange('custom','2026-10-22','2026-09-01','2026-09-30')).toMatchObject({start:'2026-09-01',end:'2026-09-30',previousStart:'2026-08-02',previousEnd:'2026-08-31'});
  expect(()=>resolveGscRange('custom','2026-10-22','2026-02-30','2026-03-01')).toThrow(/valid start and end/);
 });
 it('does not call Google without explicit local opt-in',async()=>{
  process.env.GSC_API_ENABLED='false';let requests=0;
  const props=await discoverGscProperties('gsc-not-opted-in',async()=>{requests++;throw new Error('unexpected request')});
  const report=await gscReport('gsc-not-opted-in',async()=>{requests++;throw new Error('unexpected request')});
  expect(props.status).toBe('Not Configured');expect(report.status).toBe('Not Configured');expect(requests).toBe(0);
 });
 it('does not call Google when Windows OAuth is absent',async()=>{
  process.env.GSC_API_ENABLED='true';process.env.GOOGLE_LOCAL_OAUTH_FILE='data/missing-gsc-oauth-for-test.dpapi';
  let requests=0;const result=await discoverGscProperties('gsc-no-oauth-test',async()=>{requests++;throw new Error('unexpected request')});
  expect(result.status).toBe('Not Configured');expect(requests).toBe(0);
 });
 it.skipIf(process.platform!=='win32')('stops before a request when the local daily API cap is exhausted',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'woori-gsc-quota-'));process.env.WOORI_AGENT_DB_PATH=path.join(temp,'agent.sqlite');process.env.GSC_API_ENABLED='true';process.env.GOOGLE_LOCAL_OAUTH_FILE=path.join(temp,'oauth.dpapi');process.env.GOOGLE_OAUTH_CLIENT_ID='fixture';process.env.GOOGLE_OAUTH_CLIENT_SECRET='fixture';fs.writeFileSync(process.env.GOOGLE_LOCAL_OAUTH_FILE,'placeholder');
  try{for(let i=0;i<12;i++)expect(reserveApiRequest('gsc',12)).toBe(true);expect(apiRequestsUsed('gsc')).toBe(12);let requests=0;const result=await discoverGscProperties('gsc-quota-test',async()=>{requests++;throw new Error('quota preflight should stop before fetch')});expect(result.status).toBe('Skipped');expect(requests).toBe(0);}finally{fs.rmSync(temp,{recursive:true,force:true});}
 });
 it.skipIf(process.platform!=='win32')('stores actual-shaped API rows once and generates all report formats',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'woori-gsc-')),runId=`gsc-fixture-${randomUUID()}`,oauthFile=path.join(temp,'oauth.dpapi');
  process.env.WOORI_AGENT_DB_PATH=path.join(temp,'agent.sqlite');process.env.WOORI_REPORTS_DIR=path.join(temp,'reports');process.env.GSC_API_ENABLED='true';process.env.GOOGLE_LOCAL_OAUTH_FILE=oauthFile;process.env.GOOGLE_OAUTH_CLIENT_ID='fixture-client';process.env.GOOGLE_OAUTH_CLIENT_SECRET='fixture-secret';
  const {protectForCurrentWindowsUser}=await import('../apps/cli/src/local-dpapi.js');fs.writeFileSync(oauthFile,`${protectForCurrentWindowsUser(JSON.stringify({refreshToken:'fixture-refresh-token',scopes:['https://www.googleapis.com/auth/webmasters.readonly']}))}\n`,'ascii');
  let queryNumber=0;
  const fetcher:typeof fetch=async(input,init)=>{
   const url=String(input);
   if(url==='https://oauth2.googleapis.com/token')return new Response(JSON.stringify({access_token:'fixture-access-token',expires_in:3600}),{status:200,headers:{'content-type':'application/json'}});
   if(url==='https://www.googleapis.com/webmasters/v3/sites')return new Response(JSON.stringify({siteEntry:[{siteUrl:'sc-domain:woori.today',permissionLevel:'siteOwner'},{siteUrl:'https://www.woori.today/',permissionLevel:'siteRestrictedUser'},{siteUrl:'https://notwoori.today/',permissionLevel:'siteOwner'}]}),{status:200,headers:{'content-type':'application/json'}});
   const body=JSON.parse(String(init?.body)) as {dimensions:string[];startDate:string};const dimension=body.dimensions.join(',');queryNumber++;
   const row=(keys:string[],clicks:number,impressions:number,position:number)=>({keys,clicks,impressions,ctr:impressions?clicks/impressions:0,position});
   const previous=queryNumber>6;
   const rows=dimension==='date'?[row(['2026-10-10'],previous?4:10,100,previous?5:3),row(['2026-10-11'],previous?6:20,100,previous?4:2)]:dimension==='query'?[row(['compound interest calculator'],1,100,3)]:dimension==='page'?[row(['https://www.woori.today/ko/calculators/compound-interest'],previous?9:25,300,previous?5:3)]:dimension==='country'?[row(['KOR'],12,100,3)]:dimension==='device'?[row(['MOBILE'],12,100,3)]:[row(['https://www.woori.today/ko/calculators/compound-interest','compound interest calculator'],12,100,3)];
   return new Response(JSON.stringify({rows}),{status:200,headers:{'content-type':'application/json'}});
  };
  try{
   const listed=await discoverGscProperties(runId,fetcher);expect(listed.status).toBe('Completed');expect((listed.payload as any).properties.map((entry:any)=>entry.wooriRelated)).toEqual([true,true,false]);selectGscProperty('sc-domain:woori.today');
   const result=await gscReport(runId,fetcher);expect(result.status).toBe('Completed');const payload=result.payload as any;expect(payload.requestCount).toBe(8);expect(payload.totals.clicks).toBe(30);expect(payload.totals.impressions).toBe(200);expect(payload.totalSource).toContain('date dimension');expect(payload.detailTotals.clicks).toBe(25);expect(payload.detailToTotalDifference.clicks).toBe(5);expect(payload.services).toHaveLength(1);expect(payload.services[0].service).toBe('calculator');expect(payload.services[0].clicks).toBe(25);expect(payload.opportunities.some((item:any)=>item.type==='high-impressions-low-ctr-query')).toBe(true);
   const callsAfterCollection=queryNumber;const cached=await gscReport(runId,fetcher);expect(cached.status).toBe('Completed');expect((cached as any).cached).toBe(true);expect(queryNumber).toBe(callsAfterCollection);
   const checkDb=initDb();expect((checkDb.prepare('SELECT COUNT(*) n FROM gsc_report_sets WHERE id=?').get(`${runId}:gsc:28d`) as {n:number}).n).toBe(1);expect((checkDb.prepare("SELECT COUNT(*) n FROM gsc_report_rows WHERE report_id=? AND period_key='current' AND dimension='page'").get(`${runId}:gsc:28d`) as {n:number}).n).toBe(1);expect((checkDb.prepare("SELECT COUNT(*) n FROM analytics_daily WHERE provider='gsc' AND metric_date IN ('2026-10-10','2026-10-11')").get() as {n:number}).n).toBe(2);expect((checkDb.prepare("SELECT COUNT(*) n FROM api_cache WHERE provider='gsc' AND cache_key LIKE 'gsc:searchanalytics:%'").get() as {n:number}).n).toBe(1);checkDb.close();
   for(const file of ['summary.json','summary.md','summary.html'])expect(fs.existsSync(path.join(temp,'reports','gsc',runId,file))).toBe(true);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
 });
});
