import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, agents, discover, inspect, serviceFor, writeReports, startRun, finishRun, saveFindings, saveFeatureResults, type Check, type Finding, type FeatureResult } from './core.js';
import { runBrowserSuite,planQaUrls } from './service-qa.js';
import {runLighthouse} from './performance.js';
import {assertNoPaidAiApi,getAiPolicy} from './ai-policy.js';
import {writeCodexPrompts} from './codex-prompts.js';
import {reviewContent,comparePageMetadata,writeGrowthIdeas} from './rule-agents.js';
import {analyzeCompetitors,buildGrowthCandidates,googleReport,inspectContentAndAds} from './free-analysis.js';
import {discoverGscProperties,gscReport,selectGscProperty} from './google-analytics.js';
import {aggregateRunStatus} from './run-status.js';
import {applyCalculatorKnownIssues,recordIssueLifecycle} from './issue-tracker.js';
import {runAdSenseApprovalAudit} from './adsense-approval.js';
import {developmentEnvironment,discoverDevelopmentTasks,dryRunDevelopmentTask,enqueueDevelopmentTask,listDevelopmentTasks,listDevelopmentRepositories,transitionDevelopmentTask,updateDevelopmentSettings,type DevelopmentStatus} from './development-orchestrator.js';
import {cleanupDevelopmentWorktree,codexReadiness,executeApprovedTask,listDevelopmentExecutions} from './codex-executor.js';

const args=process.argv.slice(2); const command=args[0]??'help';
const option=(name:string,fallback:string)=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
const allowedService=option('service','all').toLowerCase();
const inspection=JSON.parse(fs.readFileSync('configs/inspection-strategy.json','utf8')) as {daily:{maxBrowserPages:number};weekly:{maxBrowserPages:number};monthly:{maxMetadataPages:number};changed:{maxBrowserPages:number}};
const profile=option('profile','daily');
const profileLimit=profile==='weekly'?inspection.weekly.maxBrowserPages:profile==='monthly'?inspection.monthly.maxMetadataPages:profile==='changed'?inspection.changed.maxBrowserPages:inspection.daily.maxBrowserPages;
const defaultLimit=Math.min(command==='adsense-approval'?48:profileLimit,Math.max(1,Number(process.env.MAX_PAGES??(command==='adsense-approval'?24:profileLimit))));
const limit=Math.max(1,Math.min(command==='adsense-approval'?48:200,Number(option('max-pages',String(defaultLimit)))));
const runId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
const configured=new Set(['qa','seo','content','growth','change','localization','performance','improvement','competitor','ads']);
async function main(){
 assertNoPaidAiApi();
 if(command==='gsc'){
  const subcommand=args[1]??'run';
  if(subcommand==='properties'){const result=await discoverGscProperties(runId);console.log(JSON.stringify(result,null,2));if(result.status==='Failed')process.exitCode=1;return;}
  if(subcommand==='select'){const siteUrl=option('site-url','');if(!siteUrl)throw new Error('Use `pnpm agent gsc select --site-url=<exact siteUrl from properties>`; the application never guesses properties.');console.log(`Selected Search Console property: ${selectGscProperty(siteUrl)}`);return;}
  if(subcommand==='run'){const result=await gscReport(runId);console.log(JSON.stringify(result,null,2));if(result.status==='Failed')process.exitCode=1;return;}
  throw new Error('GSC commands: properties | select --site-url=<exact API property> | run --range=7d|28d|previous28d|custom');
 }
 if(command==='development'){
  const action=args[1]??'status';
  if(action==='status'||action==='doctor'){console.log(JSON.stringify(developmentEnvironment(),null,2));return;}
  if(action==='codex'){const result=codexReadiness();console.log(JSON.stringify(result,null,2));if(!result.executionReady)process.exitCode=2;return;}
  if(action==='repositories'){console.log(JSON.stringify(listDevelopmentRepositories(),null,2));return;}
  if(action==='settings'){const service=option('service',''),code=option('code','off')==='on',deploy=option('deploy','off')==='on';console.log(JSON.stringify(updateDevelopmentSettings(service,code,deploy),null,2));return;}
  if(action==='queue'){const discovered=option('discover','false')==='true'?discoverDevelopmentTasks():null;console.log(JSON.stringify({discovered,...listDevelopmentTasks()},null,2));return;}
  if(action==='add'){const result=enqueueDevelopmentTask({service:option('service',''),title:option('title',''),kind:option('kind','manual-review'),priority:option('priority','Medium') as 'Critical'|'High'|'Medium'|'Low',evidence:option('evidence',''),acceptanceCriteria:option('acceptance',''),sourceAgent:'manual'});console.log(JSON.stringify(result,null,2));return;}
  if(action==='transition'){const taskId=option('task-id',''),next=option('to','Triaged') as DevelopmentStatus;console.log(JSON.stringify(transitionDevelopmentTask(taskId,next),null,2));return;}
  if(action==='executions'){console.log(JSON.stringify(listDevelopmentExecutions(),null,2));return;}
  if(action==='cleanup'){console.log(JSON.stringify(cleanupDevelopmentWorktree(option('task-id','')),null,2));return;}
  if(action==='run'){const taskId=option('task-id','');if(option('approve','false')!=='true'){const result=dryRunDevelopmentTask(taskId);console.log(JSON.stringify({...result,approvalRequired:'Repeat with --approve=true only after reviewing the task and passing --allow-paths=<glob,...>.'},null,2));if(!result.wouldExecute)process.exitCode=2;return;}const result=await executeApprovedTask({taskId,approved:true,allowedPaths:option('allow-paths',''),timeoutMs:Number(option('timeout-ms','600000'))});console.log(JSON.stringify(result,null,2));if(result.status!=='Completed')process.exitCode=2;return;}
  throw new Error('Development commands: status | doctor | codex | repositories | queue [--discover=true] | settings --service=<id> --code=on|off --deploy=off | add --service --title --evidence --acceptance | transition --task-id --to | executions | run --task-id [--approve=true --allow-paths=src/**,tests/**] | cleanup --task-id (clean worktree only)');
 }
 if(command==='help'){console.log(`Woori AI Agent\nCommands: discover | smoke | qa | seo | content | competitor | growth | ux | performance | localization | ads | adsense-approval | development | change | analytics | improvement | all | report | status\nOptions: --service=all|home|calculator|tools|money|docs|quiz --profile=daily|weekly|monthly|changed --max-pages=50`);return;}
 if(command==='explore'){console.error('Not Configured: no autonomous model API is permitted. Use the user-run Codex interactive session with Playwright MCP; no browser actions were attempted.');process.exitCode=2;return;}
 if(command==='status'){console.log(JSON.stringify({services:config.services.map(s=>({id:s.id,label:s.label})),agents:agents.map(a=>({id:a,status:configured.has(a)?'Ready':'Not Configured'})),aiPolicy:getAiPolicy(),paidAi:'Not Configured (prohibited)'},null,2));return;}
 if(command==='report'){const db=(await import('./core.js')).initDb();const run=db.prepare('SELECT id,mode FROM runs ORDER BY started_at DESC LIMIT 1').get() as {id:string;mode:string}|undefined;if(!run){console.log('No completed scan is available yet.');return;}const checks=db.prepare('SELECT url,service,locale,status,title,description,canonical,html_lang AS htmlLang,hreflang_count AS hreflangCount,h1_count AS h1Count,errors FROM checks WHERE run_id=?').all(run.id) as Check[];const findings=db.prepare('SELECT id,service,url,locale,agent,severity,status,title,description,evidence FROM findings WHERE run_id=?').all(run.id) as Finding[];console.log(`Report: ${writeReports(run.id,run.mode,checks.map(c=>({...c,links:[],errors:JSON.parse(String(c.errors??'[]'))})),findings)}`);db.close();return;}
 const discovery=await discover(limit,allowedService);
 if(command==='adsense-approval'){
  discovery.db.close();startRun(runId,command,discovery.total);
  const result=await runAdSenseApprovalAudit(runId,discovery.availableUrls,limit);
  const failed=result.snapshots.filter(page=>!page.status||page.status>=400).length;
  finishRun(runId,failed?'Failed':'Completed',result.snapshots.length,failed,0);
  console.log(JSON.stringify({runId,status:result.status,discovered:discovery.total,checked:result.snapshots.length,selected:result.selected,services:[...new Set(result.snapshots.map(page=>page.service))],findings:result.issues.length,reportDir:result.reportDir},null,2));
  if(failed)process.exitCode=1;return;
 }
 let candidates=discovery.availableUrls.filter(u=>allowedService==='all'||serviceFor(u).id===allowedService);
 const inspectedHistory=new Map((discovery.db.prepare('SELECT url,MAX(checked_at) checkedAt FROM checks GROUP BY url').all() as Array<{url:string;checkedAt:string|null}>).map(x=>[x.url,x.checkedAt??'']));
 const sitemapHistory=new Map((discovery.db.prepare('SELECT url,sitemap_lastmod AS lastmod FROM discovered_urls WHERE sitemap_lastmod IS NOT NULL').all() as Array<{url:string;lastmod:string}>).map(x=>[x.url,x.lastmod]));
 const changed=(url:string)=>{const lastmod=sitemapHistory.get(url),checked=inspectedHistory.get(url);if(!lastmod)return false;if(!checked)return true;return lastmod.length===10?lastmod>checked.slice(0,10):Date.parse(lastmod)>Date.parse(checked);};
 const oldestFirst=(a:string,b:string)=>Number(changed(b))-Number(changed(a))||(inspectedHistory.get(a)??'').localeCompare(inspectedHistory.get(b)??'')||a.localeCompare(b);
 if(profile==='monthly')candidates=candidates.sort(oldestFirst);
 else if(profile==='changed'){
   const cutoff=new Date(Date.now()-24*60*60*1000).toISOString();
   const recent=new Set((discovery.db.prepare('SELECT url FROM checks GROUP BY url HAVING MAX(checked_at)>=?').all(cutoff) as Array<{url:string}>).map(x=>x.url));
   candidates=candidates.filter(u=>!recent.has(u)||changed(u)).sort(oldestFirst);
 }else candidates=discovery.selected.filter(u=>allowedService==='all'||serviceFor(u).id===allowedService).slice(0,limit);
 discovery.db.close();
 let chosen=candidates;
 if(profile==='daily'||profile==='weekly')chosen=planQaUrls(allowedService,discovery.availableUrls,limit);
 else if(profile==='monthly'||profile==='changed')chosen=planQaUrls(allowedService,candidates,limit);
 console.log(`Discovered ${discovery.sitemapTotal} sitemap URLs + ${discovery.supplementalTotal} verified route URL(s); selected ${chosen.length} URL(s) (limit ${limit}).`);
 if(command==='discover'){console.log(`Stored discovered URLs in data/woori-agent.sqlite`);return;}
 const profileAgents=profile==='weekly'?['qa','seo','content','change','ux']:profile==='monthly'?['seo','content','change']:profile==='changed'?['qa','seo','content','change']:['qa','seo','localization'];
 const targetAgents=command==='audit'?profileAgents:command==='all'?agents:command==='smoke'?['qa','seo','localization'] as const:agents.includes(command as typeof agents[number])?[command as typeof agents[number]]:[];
 if(!targetAgents.length){console.error(`Unknown command: ${command}`);process.exitCode=1;return;}
 startRun(runId,command,discovery.total);const checks:Check[]=[]; const findings:Finding[]=[]; const statuses:Record<string,string>={};
 for(const agent of targetAgents){
   if(agent==='qa'){try{const qaUrls=profile==='changed'?chosen:planQaUrls(allowedService,discovery.availableUrls,limit);console.log(`QA routes selected: ${qaUrls.length}`);const result=await runBrowserSuite(runId,qaUrls,discovery.availableUrls,limit,allowedService);const mapped=applyCalculatorKnownIssues(result.features,result.findings);result.features.splice(0,result.features.length,...mapped.features);result.findings.splice(0,result.findings.length,...mapped.findings);const issueDb=(await import('./core.js')).initDb();const update=issueDb.prepare("UPDATE feature_results SET status=?,reason=? WHERE run_id=? AND url=? AND feature=?");for(const item of result.features)if(item.status==='Known Issue')update.run(item.status,item.reason??null,runId,item.url,item.feature);issueDb.close();saveFindings(runId,result.findings);checks.push(...result.checks);findings.push(...result.findings);statuses[agent]=result.features.some(x=>x.status==='Failed')?'Failed':'Completed';}catch(e){statuses[agent]='Failed';console.error(`Playwright QA failed: ${String(e)}`);}}
   else if(agent==='seo'||agent==='localization'||agent==='content'||agent==='change'){let result:{checks:Check[];findings:Finding[]};if(checks.length&&['all','smoke','audit'].includes(command)){const newFindings=agent==='seo'||agent==='localization'?metadataReview(checks,agent,runId).findings:agent==='content'?reviewContent(runId,checks):comparePageMetadata(runId,checks);result={checks,findings:newFindings};saveFindings(runId,newFindings);if(agent==='seo'||agent==='localization'){const rows:FeatureResult[]=checks.map(c=>({runId,service:c.service,locale:c.locale,url:c.url,agent,feature:agent==='seo'?'Technical SEO metadata':'Locale routing metadata',status:result.findings.some(f=>f.url===c.url)?'Failed':'Passed',evidence:`title=${Boolean(c.title)}; canonical=${Boolean(c.canonical)}; hreflang=${c.hreflangCount}; lang=${c.htmlLang??'missing'}`}));saveFeatureResults(rows);}}else{result=await inspect(chosen,runId,agent);if(agent==='content')result.findings.push(...reviewContent(runId,result.checks));if(agent==='change')result.findings.push(...comparePageMetadata(runId,result.checks));saveFindings(runId,result.findings);}if(agent==='content'){await inspectContentAndAds(runId,[...new Set(result.checks.length?result.checks.map(c=>c.url):chosen)],true);}findings.push(...result.findings);statuses[agent]=result.findings.some(f=>f.severity==='Critical'||f.severity==='High')?'Failed':'Completed';}
   else if(agent==='competitor'){const result=await analyzeCompetitors(runId,allowedService);statuses[agent]=result.status;console.log(`Competitor: ${result.status}; ${result.items.length} configured-page result(s).`);}
   else if(agent==='growth'){const output=writeGrowthIdeas(path.resolve('reports','codex-review'));const candidates=buildGrowthCandidates();const core=await import('./core.js');core.saveAgentData(runId,'growth','Completed','discovered routes + rule hypotheses',{candidates,searchVolume:'Not measured'} ,allowedService);console.log(`Rule-based feature hypotheses written: ${output}`);statuses[agent]='Completed';}
   else if(agent==='performance'){const result=await runLighthouse(runId,chosen.slice(0,2));saveFeatureResults(result.features);saveFindings(runId,result.findings);findings.push(...result.findings);statuses[agent]=result.features.some(f=>f.status==='Failed')?'Failed':result.features.length>0&&result.features.every(f=>f.status==='Not Covered')?'Not Covered':'Completed';}
   else if(agent==='analytics'){const gsc=await googleReport('gsc',runId);const ga=await googleReport('ga4',runId);statuses[agent]=gsc.status==='Completed'||ga.status==='Completed'?'Completed':gsc.status==='Failed'||ga.status==='Failed'?'Failed':'Not Configured';}
   else if(agent==='ads'){const adsUrls=chosen.slice(0,Math.min(5,limit));const pageScan=await inspect(adsUrls,runId,'ads');checks.push(...pageScan.checks);const results=await inspectContentAndAds(runId,adsUrls);const revenue=await googleReport('adsense',runId);statuses[agent]=revenue.status==='Failed'?'Failed':results.ads.length?'Completed':revenue.status;}
   else if(agent==='improvement'){const core=await import('./core.js');const d=core.initDb();const all=d.prepare('SELECT id,run_id AS runId,service,url,locale,agent,severity,status,title,description,evidence FROM findings ORDER BY rowid DESC LIMIT 200').all() as Finding[];const integrated=d.prepare("SELECT agent,service,status,source,updated_at,payload FROM agent_data WHERE agent<>'improvement' ORDER BY updated_at DESC LIMIT 100").all().map((r:any)=>({...r,payload:JSON.parse(r.payload)}));d.close();const unique=new Map<string,Finding>();for(const f of all){const key=`${f.service}|${f.url}|${f.title.toLowerCase()}`;if(!unique.has(key))unique.set(key,f)}const items=[...unique.values()].map(f=>({...f,userImpact:f.severity==='Critical'||f.severity==='High'?'Potentially blocks or degrades a key user task':'Quality improvement; validate with users',scope:'Inspect the affected page and relevant service repository; prepare a minimal fix and regression check.',codexPrompt:`Review ${f.service} at ${f.url}. Evidence: ${f.evidence??f.description}. Propose a minimal fix and regression test. Do not modify production.`}));core.saveAgentData(runId,'improvement','Completed','SQLite findings + saved free-agent analysis',{items,sourceFindings:all.length,deduplicated:items.length,integratedAgentData:integrated,analysisSources:[...new Set(integrated.map((x:any)=>x.agent))]},allowedService);const output=writeCodexPrompts(items as Finding[],path.resolve('reports','codex-review'));console.log(`Improvement candidates: ${items.length}; integrated agent datasets: ${integrated.length}; prompts: ${output}`);statuses[agent]='Completed';}
   else statuses[agent]='Not Configured';
 }
 if(command==='audit'&&['daily','weekly','monthly'].includes(profile)){
  const approvalLimit=profile==='daily'?6:profile==='weekly'?12:24;
  const approval=await runAdSenseApprovalAudit(runId,discovery.availableUrls,Math.min(limit,approvalLimit));
  statuses.adsenseApproval=approval.status;
  console.log(JSON.stringify({adsenseApproval:{checked:approval.snapshots.length,findings:approval.issues.length,reportDir:approval.reportDir}},null,2));
 }
 const resultsDb=(await import('./core.js')).initDb();const notCovered=(resultsDb.prepare("SELECT COUNT(*) n FROM feature_results WHERE run_id=? AND status='Not Covered'").get(runId) as {n:number}).n;const failedFeatures=(resultsDb.prepare("SELECT COUNT(*) n FROM feature_results WHERE run_id=? AND status='Failed'").get(runId) as {n:number}).n;const featureResults=resultsDb.prepare('SELECT status,COUNT(*) count FROM feature_results WHERE run_id=? GROUP BY status').all(runId);const inspected=(resultsDb.prepare('SELECT COUNT(DISTINCT url) n FROM checks WHERE run_id=?').get(runId) as {n:number}).n;const pageFailures=checks.filter(c=>c.status===null||c.status>=400).length;const highFindings=findings.filter(f=>f.severity==='Critical'||f.severity==='High').length;const failed=pageFailures+Math.max(failedFeatures,highFindings);const status=aggregateRunStatus(Boolean(failed),statuses);resultsDb.close();recordIssueLifecycle(runId,findings,checks.map(c=>c.url),[...targetAgents]);finishRun(runId,status,inspected,failed,notCovered);const dir=writeReports(runId,command,checks,findings); console.log(JSON.stringify({runId,status,statuses,checked:inspected,featureResults,findings:findings.length,report:dir},null,2));
 if(failed||Object.values(statuses).includes('Failed'))process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});

function metadataReview(pages:Check[],agent:'seo'|'localization',runId:string){const findings:Finding[]=[];for(const c of pages){const add=(severity:Finding['severity'],title:string,description:string)=>findings.push({id:`${runId}-${agent}-${findings.length+1}`,service:c.service,url:c.url,locale:c.locale,agent,severity,status:'confirmed',title,description});if(agent==='seo'){if(!c.title)add('Medium','Missing title','No document title was observed.');if(!c.description)add('Low','Missing meta description','No meta description was observed.');if(!c.canonical)add('Medium','Missing canonical','No canonical link was observed.');if(c.h1Count!==1)add('Low','Unexpected H1 count',`Expected 1; observed ${c.h1Count}.`);}else{const normalize=(v:string)=>v.toLowerCase().replace('_','-');if(!c.htmlLang)add('Medium','Missing document language','No html lang attribute was observed.');else if(c.locale!=='unknown'&&!normalize(c.htmlLang).startsWith(normalize(c.locale)))add('Medium','Document language mismatch',`Route locale ${c.locale}, html lang=${c.htmlLang}.`);if(!c.hreflangCount)add('Low','No hreflang alternates','No alternate locale links were observed.');}}return{checks:pages,findings};}
