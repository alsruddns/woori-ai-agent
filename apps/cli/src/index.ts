import { randomUUID } from 'node:crypto';
import { config, agents, discover, inspect, serviceFor, localeFor, writeReports, type Check, type Finding } from './core.js';
import { chromium } from 'playwright';

const args=process.argv.slice(2); const command=args[0]??'help';
const option=(name:string,fallback:string)=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
const allowedService=option('service','all').toLowerCase(); const limit=Math.max(1,Math.min(200,Number(option('max-pages',process.env.MAX_PAGES??'50'))));
const runId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
const configured=new Set(['qa','seo','localization']);

async function browserQa(urls:string[]):Promise<{checks:Check[];findings:Finding[]}> {
  const browser=await chromium.launch({headless:true}); const checks:Check[]=[]; const findings:Finding[]=[];
  try {for(const url of urls){const page=await browser.newPage({viewport:{width:1440,height:900}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
    let status:number|null=null;try{const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});status=response?.status()??null;await page.locator('body').waitFor({state:'visible',timeout:10000});}catch(e){errors.push(e instanceof Error?e.message:String(e));}
    const title=await page.title().catch(()=>undefined);const description=await page.locator('meta[name="description"]').getAttribute('content').catch(()=>null)??undefined;const canonical=await page.locator('link[rel="canonical"]').getAttribute('href').catch(()=>null)??undefined;const hreflangCount=await page.locator('link[rel="alternate"][hreflang]').count().catch(()=>0);const h1Count=await page.locator('h1').count().catch(()=>0);
    const check:Check={url,service:serviceFor(url).id,locale:localeFor(url),status,title,description,canonical,hreflangCount,h1Count,links:[],errors}; checks.push(check);
    if(status===null||status>=400)findings.push({id:`${runId}-${findings.length+1}`,service:check.service,url,locale:check.locale,agent:'qa',severity:'High',status:'confirmed',title:'Browser navigation failed',description:errors.join('; ')||`HTTP ${status}`,evidence:String(status)});
    if(errors.length)findings.push({id:`${runId}-${findings.length+1}`,service:check.service,url,locale:check.locale,agent:'qa',severity:'Medium',status:'confirmed',title:'Browser console or runtime error',description:errors.slice(0,10).join('; ')});
    await page.close();
    if(urls.indexOf(url)<urls.length-1) await new Promise(r=>setTimeout(r,Number(process.env.REQUEST_DELAY_MS??1000)));
  }} finally {await browser.close();}
  return {checks,findings};
}
async function main(){
 if(command==='help'){console.log(`Woori AI Agent\nCommands: discover | smoke | qa | seo | content | competitor | growth | ux | performance | localization | ads | change | analytics | improvement | all | report | status\nOptions: --service=all|home|calculator|tools|money|docs|quiz --max-pages=50`);return;}
 if(command==='status'){console.log(JSON.stringify({services:config.services.map(s=>({id:s.id,label:s.label})),agents:agents.map(a=>({id:a,status:configured.has(a)?'Ready':'Not Configured'})),aiEnabled:process.env.AI_ENABLED==='true'},null,2));return;}
 if(command==='report'){const db=(await import('./core.js')).initDb();const run=db.prepare('SELECT id,mode FROM runs ORDER BY started_at DESC LIMIT 1').get() as {id:string;mode:string}|undefined;if(!run){console.log('No completed scan is available yet.');return;}const checks=db.prepare('SELECT url,service,locale,status,title,description,canonical,html_lang AS htmlLang,hreflang_count AS hreflangCount,h1_count AS h1Count,errors FROM checks WHERE run_id=?').all(run.id) as Check[];const findings=db.prepare('SELECT id,service,url,locale,agent,severity,status,title,description,evidence FROM findings WHERE run_id=?').all(run.id) as Finding[];console.log(`Report: ${writeReports(run.id,run.mode,checks.map(c=>({...c,links:[],errors:JSON.parse(String(c.errors??'[]'))})),findings)}`);db.close();return;}
 const discovery=await discover(limit); discovery.db.close();
 const chosen=discovery.selected.filter(u=>allowedService==='all'||serviceFor(u).id===allowedService);
 console.log(`Discovered ${discovery.total} sitemap URLs; selected ${chosen.length} URL(s) (limit ${limit}).`);
 if(command==='discover'){console.log(`Stored discovered URLs in data/woori-agent.sqlite`);return;}
 if(command==='explore'){console.error('Not Configured: autonomous AI exploration requires an AI provider adapter and credentials. No browser actions were attempted.');process.exitCode=2;return;}
 const targetAgents=command==='all'?agents:command==='smoke'?['qa','seo','localization'] as const:agents.includes(command as typeof agents[number])?[command as typeof agents[number]]:[];
 if(!targetAgents.length){console.error(`Unknown command: ${command}`);process.exitCode=1;return;}
 const checks:Check[]=[]; const findings:Finding[]=[]; const statuses:Record<string,string>={};
 for(const agent of targetAgents){
   if(agent==='qa'){try{const result=await browserQa(chosen);checks.push(...result.checks);findings.push(...result.findings);statuses[agent]='Completed';}catch(e){statuses[agent]='Failed';console.error(`Playwright QA failed: ${String(e)}`);}}
   else if(agent==='seo'||agent==='localization'){const result=await inspect(chosen,runId,agent);checks.push(...result.checks);findings.push(...result.findings);statuses[agent]='Completed';}
   else statuses[agent]='Not Configured';
 }
 const dir=writeReports(runId,command,checks,findings); console.log(JSON.stringify({runId,statuses,checked:checks.length,findings:findings.length,report:dir},null,2));
 if(Object.values(statuses).includes('Failed'))process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
