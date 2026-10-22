import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { load } from 'cheerio';

export type Service = { id: string; name: string; label: string; basePaths: string[]; sitemaps: string[]; pathPrefix: string; qaPaths?:string[] };
export type Finding = { id: string; runId?:string; service: string; url: string; locale: string; agent: string; severity: 'Critical'|'High'|'Medium'|'Low'|'Info'; status: string; title: string; description: string; evidence?: string };
export type Check = { url: string; service: string; locale: string; status: number|null; title?: string; description?: string; canonical?: string; htmlLang?: string; hreflangCount: number; h1Count: number; links: string[]; errors: string[] };
export type FeatureResult = { runId:string; service:string; locale:string; url:string; agent:string; feature:string; status:'Passed'|'Failed'|'Not Covered'|'Skipped'; reason?:string; evidence?:string; screenshot?:string; trace?:string; durationMs?:number };
export const config = JSON.parse(fs.readFileSync('configs/services.json','utf8')) as { baseUrl: string; locales: string[]; services: Service[] };
export const agents = ['qa','seo','content','competitor','growth','ux','performance','localization','ads','change','analytics','improvement'] as const;

export function serviceFor(url: string): Service {
  const pathname = new URL(url).pathname.toLowerCase();
  const localePrefix = /^\/(?:[a-z]{2}(?:-[a-z]{2})?)(?:\/|$)/i;
  const stripped = pathname.replace(localePrefix,'').replace(/^\//,'');
  const match = config.services.filter(s=>s.pathPrefix).sort((a,b)=>b.pathPrefix.length-a.pathPrefix.length).find(s=>stripped===s.pathPrefix || stripped.startsWith(`${s.pathPrefix}/`));
  return match ?? config.services[0]!;
}
export function localeFor(url: string): string { const first=new URL(url).pathname.split('/').filter(Boolean)[0]?.toLowerCase(); return config.locales.includes(first ?? '') ? first! : 'unknown'; }
export function initDb() {
  fs.mkdirSync('data',{recursive:true});
  const db=new Database('data/woori-agent.sqlite');
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, started_at TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, finished_at TEXT, discovered_count INTEGER NOT NULL DEFAULT 0, inspected_count INTEGER NOT NULL DEFAULT 0, failed_count INTEGER NOT NULL DEFAULT 0, not_covered_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS discovered_urls(url TEXT PRIMARY KEY, service TEXT NOT NULL, locale TEXT NOT NULL, discovered_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'sitemap');
    CREATE TABLE IF NOT EXISTS checks(id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, url TEXT NOT NULL, service TEXT NOT NULL, locale TEXT NOT NULL, status INTEGER, title TEXT, description TEXT, canonical TEXT, html_lang TEXT, hreflang_count INTEGER, h1_count INTEGER, errors TEXT, checked_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS findings(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, service TEXT NOT NULL, url TEXT NOT NULL, locale TEXT NOT NULL, agent TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, evidence TEXT);
    CREATE TABLE IF NOT EXISTS feature_results(id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, service TEXT NOT NULL, locale TEXT NOT NULL, url TEXT NOT NULL, agent TEXT NOT NULL, feature TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, evidence TEXT, screenshot TEXT, trace TEXT, duration_ms INTEGER, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS performance_metrics(id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, service TEXT NOT NULL, url TEXT NOT NULL, strategy TEXT NOT NULL, lcp_ms REAL, cls REAL, fcp_ms REAL, tbt_ms REAL, performance_score INTEGER, accessibility_score INTEGER, report_path TEXT, created_at TEXT NOT NULL);`);
  try { db.exec('ALTER TABLE checks ADD COLUMN html_lang TEXT'); } catch { /* existing DB already migrated */ }
  try { db.exec("ALTER TABLE discovered_urls ADD COLUMN source TEXT NOT NULL DEFAULT 'sitemap'"); } catch { /* existing DB already migrated */ }
  for(const [column,definition] of [['finished_at','TEXT'],['discovered_count','INTEGER NOT NULL DEFAULT 0'],['inspected_count','INTEGER NOT NULL DEFAULT 0'],['failed_count','INTEGER NOT NULL DEFAULT 0'],['not_covered_count','INTEGER NOT NULL DEFAULT 0']] as const) try { db.exec(`ALTER TABLE runs ADD COLUMN ${column} ${definition}`); } catch { /* schema already migrated */ }
  return db;
}
export function startRun(runId:string,mode:string,discoveredCount:number){const db=initDb();db.prepare('INSERT OR REPLACE INTO runs(id,started_at,mode,status,discovered_count) VALUES(?,?,?,?,?)').run(runId,new Date().toISOString(),mode,'Running',discoveredCount);db.close();}
export function saveChecks(runId:string,checks:Check[]){const db=initDb();const put=db.prepare('INSERT INTO checks(run_id,url,service,locale,status,title,description,canonical,html_lang,hreflang_count,h1_count,errors,checked_at) VALUES(@run_id,@url,@service,@locale,@status,@title,@description,@canonical,@html_lang,@hreflang_count,@h1_count,@errors,@checked_at)');const tx=db.transaction((rows:Check[])=>rows.forEach(c=>put.run({run_id:runId,url:c.url,service:c.service,locale:c.locale,status:c.status,title:c.title??null,description:c.description??null,canonical:c.canonical??null,html_lang:c.htmlLang??null,hreflang_count:c.hreflangCount,h1_count:c.h1Count,errors:JSON.stringify(c.errors),checked_at:new Date().toISOString()})));tx(checks);db.close();}
export function saveFindings(runId:string,findings:Finding[]){const db=initDb();const put=db.prepare('INSERT OR REPLACE INTO findings(id,run_id,service,url,locale,agent,severity,status,title,description,evidence) VALUES(@id,@run_id,@service,@url,@locale,@agent,@severity,@status,@title,@description,@evidence)');const tx=db.transaction((rows:Finding[])=>rows.forEach(f=>put.run({...f,run_id:runId,evidence:f.evidence??null})));tx(findings);db.close();}
export function saveFeatureResults(results:FeatureResult[]){if(!results.length)return;const db=initDb();const put=db.prepare('INSERT INTO feature_results(run_id,service,locale,url,agent,feature,status,reason,evidence,screenshot,trace,duration_ms,created_at) VALUES(@runId,@service,@locale,@url,@agent,@feature,@status,@reason,@evidence,@screenshot,@trace,@durationMs,@created_at)');const tx=db.transaction((rows:FeatureResult[])=>rows.forEach(x=>put.run({...x,reason:x.reason??null,evidence:x.evidence??null,screenshot:x.screenshot??null,trace:x.trace??null,durationMs:x.durationMs??null,created_at:new Date().toISOString()})));tx(results);db.close();}
export function finishRun(runId:string,status:string,inspected:number,failed:number,notCovered:number){const db=initDb();db.prepare('UPDATE runs SET status=?,finished_at=?,inspected_count=?,failed_count=?,not_covered_count=? WHERE id=?').run(status,new Date().toISOString(),inspected,failed,notCovered,runId);db.close();}
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export async function fetchPage(url:string):Promise<Check> {
  const check:Check={url,service:serviceFor(url).id,locale:localeFor(url),status:null,hreflangCount:0,h1Count:0,links:[],errors:[]};
  try {
    const response=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(20000),headers:{'user-agent':'WooriSiteIntelligence/0.1 (read-only quality monitoring)'}});
    check.status=response.status;
    const type=response.headers.get('content-type')??'';
    if(!type.includes('text/html')) return check;
    const html=await response.text(); const $=load(html);
    check.title=$('title').first().text().trim()||undefined;
    check.description=$('meta[name="description"]').attr('content')?.trim();
    check.canonical=$('link[rel="canonical"]').attr('href'); check.htmlLang=$('html').attr('lang'); check.hreflangCount=$('link[rel="alternate"][hreflang]').length; check.h1Count=$('h1').length;
    const origin=new URL(url).origin;
    check.links=[...new Set($('a[href]').toArray().map(a=>$(a).attr('href')).filter((h):h is string=>!!h).map(h=>{try{return new URL(h,url).href}catch{return ''}}).filter(h=>h.startsWith(origin) && !/\.(?:png|jpe?g|svg|pdf|zip)(?:$|\?)/i.test(h)))];
  } catch(e) {check.errors.push(e instanceof Error?e.message:String(e));}
  return check;
}
export async function discover(limit=50,serviceId='all') {
  const db=initDb(); const urls=new Set<string>();
  for(const service of config.services) for(const sitemap of service.sitemaps) {
    try {const res=await fetch(new URL(sitemap,config.baseUrl),{signal:AbortSignal.timeout(20000),headers:{'user-agent':'WooriSiteIntelligence/0.1 (read-only quality monitoring)'}}); if(!res.ok)continue; const xml=await res.text(); const $=load(xml,{xmlMode:true}); $('loc').each((_,el)=>{const u=$(el).text().trim(); if(u.startsWith(config.baseUrl))urls.add(u);});} catch(e) {if(process.env.DEBUG)console.warn(`Sitemap discovery skipped ${sitemap}: ${String(e)}`);}
  }
  // Prioritize one representative route per service/locale, then fill from sitemap in source order.
  const selected:string[]=[]; const seen=new Set<string>();
  const services=serviceId==='all'?config.services:config.services.filter(s=>s.id===serviceId);
  // Ensure initial coverage across services, or locales for the requested service, first.
  if(serviceId==='all') for(const s of services) {const candidate=`${config.baseUrl}/ko${s.pathPrefix?`/${s.pathPrefix}`:''}`; if(urls.has(candidate)&&!seen.has(candidate)){selected.push(candidate);seen.add(candidate);}}
  for(const locale of config.locales) for(const s of services) {const candidate=`${config.baseUrl}/${locale}${s.pathPrefix?`/${s.pathPrefix}`:''}`; if(urls.has(candidate)&&!seen.has(candidate)){selected.push(candidate);seen.add(candidate);}}
  for(const u of urls) if(selected.length<limit&&!seen.has(u)&&(serviceId==='all'||serviceFor(u).id===serviceId)){selected.push(u);seen.add(u);}
  const supplements=new Set(config.services.flatMap(s=>(s.qaPaths??[]).map(p=>new URL(p,config.baseUrl).href)).filter(u=>!urls.has(u)));
  const insert=db.prepare('INSERT OR REPLACE INTO discovered_urls(url,service,locale,discovered_at,source) VALUES(?,?,?,?,?)'); const now=new Date().toISOString();
  const tx=db.transaction((items:string[],source:string)=>items.forEach(u=>insert.run(u,serviceFor(u).id,localeFor(u),now,source)));tx([...urls],'sitemap');tx([...supplements],'verified-link');
  return {total:urls.size+supplements.size,sitemapTotal:urls.size,supplementalTotal:supplements.size,selected:selected.slice(0,limit),availableUrls:[...new Set([...urls,...supplements])],db};
}
export async function inspect(urls:string[],runId:string,agent='qa',gap=Number(process.env.REQUEST_DELAY_MS??1000)) {
  const checks:Check[]=[];
  for(let i=0;i<urls.length;i++){checks.push(await fetchPage(urls[i]!));if(i<urls.length-1)await delay(gap);}
  const findings:Finding[]=[];
  for(const c of checks){ const add=(severity:Finding['severity'],title:string,description:string,evidence?:string)=>findings.push({id:`${runId}-${findings.length+1}`,service:c.service,url:c.url,locale:c.locale,agent,severity,status:'confirmed',title,description,evidence});
    if(c.status===null||c.status>=400)add(c.status===null?'High':'High','Page request failed',c.errors.join('; ')||`HTTP ${c.status}`,String(c.status));
    if(agent==='seo'){if(!c.title)add('Medium','Missing title','The page has no title element.');if(!c.description)add('Low','Missing meta description','The page has no meta description.');if(!c.canonical)add('Medium','Missing canonical','The page has no canonical link.');if(c.h1Count!==1)add('Low','Unexpected H1 count',`Expected one H1, found ${c.h1Count}.`);}
    if(agent==='localization'){const normalize=(v:string)=>v.toLowerCase().replace('_','-');if(!c.htmlLang)add('Medium','Missing document language','The HTML root has no lang attribute.');else if(c.locale!=='unknown'&&!normalize(c.htmlLang).startsWith(normalize(c.locale)))add('Medium','Document language mismatch',`Route locale ${c.locale} differs from html lang=${c.htmlLang}.`);if(c.hreflangCount===0)add('Low','No hreflang alternates','No alternate language links were found on this route.');}
    if(agent==='qa'&&c.errors.length)add('High','Page could not be fetched',c.errors.join('; '));
  }
  saveChecks(runId,checks);saveFindings(runId,findings);
  return {checks,findings};
}
export function writeReports(runId:string,mode:string,checks:Check[],findings:Finding[]) {
  const now=new Date(); const dir=path.join('reports',now.toISOString().slice(0,10),runId); fs.mkdirSync(dir,{recursive:true});
  const db=initDb();const features=db.prepare('SELECT service,locale,url,agent,feature,status,reason,evidence,screenshot,trace,duration_ms AS durationMs FROM feature_results WHERE run_id=? ORDER BY id').all(runId) as Array<{status:string}>;const coverage={passed:features.filter(x=>x.status==='Passed').length,failed:features.filter(x=>x.status==='Failed').length,notCovered:features.filter(x=>x.status==='Not Covered').length,skipped:features.filter(x=>x.status==='Skipped').length};const runStats=db.prepare('SELECT started_at,discovered_count,inspected_count FROM runs WHERE id=?').get(runId) as {started_at:string;discovered_count:number;inspected_count:number}|undefined;
  const sitemapCount=(db.prepare("SELECT COUNT(*) n FROM discovered_urls WHERE source='sitemap'").get() as {n:number}).n;const supplementalCount=(db.prepare("SELECT COUNT(*) n FROM discovered_urls WHERE source<>'sitemap'").get() as {n:number}).n;
  const data={runId,mode,startedAt:runStats?.started_at??now.toISOString(),finishedAt:now.toISOString(),checks,findings,features,coverage,summary:{discovered:runStats?.discovered_count??0,sitemapDiscovered:sitemapCount,supplementalDiscovered:supplementalCount,checked:runStats?.inspected_count??new Set(checks.map(c=>c.url)).size,findings:findings.length,failed:coverage.failed+checks.filter(c=>c.status===null||c.status>=400).length,notCovered:coverage.notCovered}};db.close();
  fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(data,null,2));
  fs.writeFileSync(path.join(dir,'summary.md'),`# woori.today 검사 보고서\n\n- Run: ${runId}\n- 모드: ${mode}\n- 발견 sitemap URL: ${data.summary.discovered}\n- 실제 검사 URL: ${data.summary.checked}\n- 기능 통과/실패/미검사: ${coverage.passed}/${coverage.failed}/${coverage.notCovered}\n- 발견 항목: ${findings.length}\n\n## 검사 결과\n\n${checks.map(c=>`- ${c.status??'ERR'} ${c.url}`).join('\n')}\n\n## 기능 커버리지\n\n${features.map((f:any)=>`- ${f.status} · ${f.service}/${f.locale} · ${f.feature}${f.reason?`: ${f.reason}`:''}`).join('\n')||'- 기능 결과 없음'}\n\n## 발견 항목\n\n${findings.map(f=>`- **${f.severity}** ${f.title} (${f.url}): ${f.description}`).join('\n')||'- 발견 항목 없음'}\n`);
  const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  fs.writeFileSync(path.join(dir,'summary.html'),`<!doctype html><html lang="ko"><meta charset="utf-8"><title>Woori Agent Report</title><h1>woori.today 검사 보고서</h1><p>발견 URL ${data.summary.discovered}개 · 실제 검사 ${data.summary.checked}개 · 기능 통과 ${coverage.passed} · 실패 ${coverage.failed} · 미검사 ${coverage.notCovered} · 발견 항목 ${findings.length}</p><h2>기능 결과</h2><ul>${features.map((f:any)=>`<li>${esc(f.status)} · ${esc(f.service)}/${esc(f.locale)} · ${esc(f.feature)} ${esc(f.reason??'')}</li>`).join('')}</ul><h2>발견 항목</h2><ul>${findings.map(f=>`<li><b>${esc(f.severity)} — ${esc(f.title)}</b> <a href="${esc(f.url)}">${esc(f.url)}</a><p>${esc(f.description)}</p></li>`).join('')}</ul><h2>페이지</h2><ul>${checks.map(c=>`<li>${c.status??'ERR'} <a href="${esc(c.url)}">${esc(c.url)}</a> ${esc(c.title??'')}</li>`).join('')}</ul></html>`);
  return dir;
}
