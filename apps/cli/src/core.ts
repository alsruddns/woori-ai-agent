import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { load } from 'cheerio';

export type Service = { id: string; name: string; label: string; basePaths: string[]; sitemaps: string[]; pathPrefix: string };
export type Finding = { id: string; service: string; url: string; locale: string; agent: string; severity: 'Critical'|'High'|'Medium'|'Low'|'Info'; status: string; title: string; description: string; evidence?: string };
export type Check = { url: string; service: string; locale: string; status: number|null; title?: string; description?: string; canonical?: string; htmlLang?: string; hreflangCount: number; h1Count: number; links: string[]; errors: string[] };
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
  db.exec(`CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, started_at TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS discovered_urls(url TEXT PRIMARY KEY, service TEXT NOT NULL, locale TEXT NOT NULL, discovered_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS checks(id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, url TEXT NOT NULL, service TEXT NOT NULL, locale TEXT NOT NULL, status INTEGER, title TEXT, description TEXT, canonical TEXT, html_lang TEXT, hreflang_count INTEGER, h1_count INTEGER, errors TEXT, checked_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS findings(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, service TEXT NOT NULL, url TEXT NOT NULL, locale TEXT NOT NULL, agent TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, evidence TEXT);`);
  try { db.exec('ALTER TABLE checks ADD COLUMN html_lang TEXT'); } catch { /* existing DB already migrated */ }
  return db;
}
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
    try {const res=await fetch(new URL(sitemap,config.baseUrl),{signal:AbortSignal.timeout(20000),headers:{'user-agent':'WooriSiteIntelligence/0.1 (read-only quality monitoring)'}}); if(!res.ok)continue; const xml=await res.text(); const $=load(xml,{xmlMode:true}); $('loc').each((_,el)=>{const u=$(el).text().trim(); if(u.startsWith(config.baseUrl))urls.add(u);});} catch {}
  }
  // Prioritize one representative route per service/locale, then fill from sitemap in source order.
  const selected:string[]=[]; const seen=new Set<string>();
  const services=serviceId==='all'?config.services:config.services.filter(s=>s.id===serviceId);
  // Ensure initial coverage across services, or locales for the requested service, first.
  if(serviceId==='all') for(const s of services) {const candidate=`${config.baseUrl}/ko${s.pathPrefix?`/${s.pathPrefix}`:''}`; if(urls.has(candidate)&&!seen.has(candidate)){selected.push(candidate);seen.add(candidate);}}
  for(const locale of config.locales) for(const s of services) {const candidate=`${config.baseUrl}/${locale}${s.pathPrefix?`/${s.pathPrefix}`:''}`; if(urls.has(candidate)&&!seen.has(candidate)){selected.push(candidate);seen.add(candidate);}}
  for(const u of urls) if(selected.length<limit&&!seen.has(u)&&(serviceId==='all'||serviceFor(u).id===serviceId)){selected.push(u);seen.add(u);}
  const insert=db.prepare('INSERT OR REPLACE INTO discovered_urls(url,service,locale,discovered_at) VALUES(?,?,?,?)'); const now=new Date().toISOString();
  const tx=db.transaction((items:string[])=>items.forEach(u=>insert.run(u,serviceFor(u).id,localeFor(u),now))); tx([...urls]);
  return {total:urls.size,selected:selected.slice(0,limit),db};
}
export async function inspect(urls:string[],runId:string,agent='qa',gap=Number(process.env.REQUEST_DELAY_MS??1000)) {
  const db=initDb(); const checks:Check[]=[];
  const ins=db.prepare('INSERT INTO checks(run_id,url,service,locale,status,title,description,canonical,html_lang,hreflang_count,h1_count,errors,checked_at) VALUES(@run_id,@url,@service,@locale,@status,@title,@description,@canonical,@html_lang,@hreflang_count,@h1_count,@errors,@checked_at)');
  for(let i=0;i<urls.length;i++){const c=await fetchPage(urls[i]!); checks.push(c); ins.run({run_id:runId,url:c.url,service:c.service,locale:c.locale,status:c.status,title:c.title??null,description:c.description??null,canonical:c.canonical??null,html_lang:c.htmlLang??null,hreflang_count:c.hreflangCount,h1_count:c.h1Count,errors:JSON.stringify(c.errors),checked_at:new Date().toISOString()}); if(i<urls.length-1)await delay(gap);}
  const findings:Finding[]=[];
  for(const c of checks){ const add=(severity:Finding['severity'],title:string,description:string,evidence?:string)=>findings.push({id:`${runId}-${findings.length+1}`,service:c.service,url:c.url,locale:c.locale,agent,severity,status:'confirmed',title,description,evidence});
    if(c.status===null||c.status>=400)add(c.status===null?'High':'High','Page request failed',c.errors.join('; ')||`HTTP ${c.status}`,String(c.status));
    if(agent==='seo'){if(!c.title)add('Medium','Missing title','The page has no title element.');if(!c.description)add('Low','Missing meta description','The page has no meta description.');if(!c.canonical)add('Medium','Missing canonical','The page has no canonical link.');if(c.h1Count!==1)add('Low','Unexpected H1 count',`Expected one H1, found ${c.h1Count}.`);}
    if(agent==='localization'){const normalize=(v:string)=>v.toLowerCase().replace('_','-');if(!c.htmlLang)add('Medium','Missing document language','The HTML root has no lang attribute.');else if(c.locale!=='unknown'&&!normalize(c.htmlLang).startsWith(normalize(c.locale)))add('Medium','Document language mismatch',`Route locale ${c.locale} differs from html lang=${c.htmlLang}.`);if(c.hreflangCount===0)add('Low','No hreflang alternates','No alternate language links were found on this route.');}
    if(agent==='qa'&&c.errors.length)add('High','Page could not be fetched',c.errors.join('; '));
  }
  const db2=initDb(); const put=db2.prepare('INSERT OR REPLACE INTO findings(id,run_id,service,url,locale,agent,severity,status,title,description,evidence) VALUES(@id,@run_id,@service,@url,@locale,@agent,@severity,@status,@title,@description,@evidence)');
  const tx=db2.transaction((items:Finding[])=>items.forEach(f=>put.run({...f,run_id:runId,evidence:f.evidence??null})));tx(findings);
  return {checks,findings};
}
export function writeReports(runId:string,mode:string,checks:Check[],findings:Finding[]) {
  const now=new Date(); const dir=path.join('reports',now.toISOString().slice(0,10),runId); fs.mkdirSync(dir,{recursive:true});
  const data={runId,mode,startedAt:now.toISOString(),checks,findings,summary:{checked:checks.length,findings:findings.length,failed:checks.filter(c=>c.status===null||c.status>=400).length}};
  fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(data,null,2));
  fs.writeFileSync(path.join(dir,'summary.md'),`# woori.today 검사 보고서\n\n- Run: ${runId}\n- 모드: ${mode}\n- 검사 URL: ${checks.length}\n- 발견 항목: ${findings.length}\n\n## 검사 결과\n\n${checks.map(c=>`- ${c.status??'ERR'} ${c.url}`).join('\n')}\n\n## 발견 항목\n\n${findings.map(f=>`- **${f.severity}** ${f.title} (${f.url}): ${f.description}`).join('\n')||'- 발견 항목 없음'}\n`);
  const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  fs.writeFileSync(path.join(dir,'summary.html'),`<!doctype html><meta charset="utf-8"><title>Woori Agent Report</title><h1>woori.today 검사 보고서</h1><p>검사 ${checks.length}개 · 발견 ${findings.length}개</p><h2>발견 항목</h2><ul>${findings.map(f=>`<li><b>${esc(f.severity)} — ${esc(f.title)}</b> <a href="${esc(f.url)}">${esc(f.url)}</a><p>${esc(f.description)}</p></li>`).join('')}</ul><h2>페이지</h2><ul>${checks.map(c=>`<li>${c.status??'ERR'} <a href="${esc(c.url)}">${esc(c.url)}</a> ${esc(c.title??'')}</li>`).join('')}</ul>`);
  initDb().prepare('INSERT OR REPLACE INTO runs(id,started_at,mode,status) VALUES(?,?,?,?)').run(runId,now.toISOString(),mode,findings.some(f=>f.severity==='Critical'||f.severity==='High')?'Failed':'Completed');
  return dir;
}
