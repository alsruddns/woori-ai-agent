import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {initDb, type Finding, type FeatureResult} from './core.js';

export function applyCalculatorKnownIssues(features:FeatureResult[],findings:Finding[]){
 const policy=JSON.parse(fs.readFileSync('configs/calculator-known-issues.json','utf8')) as {issues:Array<{id:string;service:string;feature:string;matchUrl?:string;matchText?:string;state:string}>};
 const match=(service:string,text:string,url='')=>policy.issues.find(issue=>issue.service===service&&((text.toLowerCase().includes(issue.feature.toLowerCase()))||(Boolean(issue.matchUrl&&url.includes(issue.matchUrl)&&issue.matchText&&text.toLowerCase().includes(issue.matchText.toLowerCase())))));
 const mappedFeatures=features.map(item=>{const known=match(item.service,`${item.feature} ${item.reason??''}`,item.url);return known&&item.status==='Failed'?{...item,status:'Known Issue' as const,reason:`${item.reason??''} ${known.id}; retained as a visible known issue, not treated as a new regression.`.trim()}:item});
 const mappedFindings=findings.map(item=>{const known=match(item.service,`${item.title} ${item.description} ${item.evidence??''}`,item.url);return known?{...item,status:`Known Issue (${known.id})`}:item});
 return{features:mappedFeatures,findings:mappedFindings};
}

export function recordIssueLifecycle(runId:string,findings:Finding[],checkedUrls:string[],agents:string[]){
 const db=initDb(),now=new Date().toISOString(),current=new Set<string>();
 const find=db.prepare('SELECT state,occurrences FROM issue_registry WHERE fingerprint=?');
 const put=db.prepare(`INSERT INTO issue_registry(fingerprint,service,url,agent,severity,title,state,first_seen,last_seen,resolved_at,occurrences,evidence)
 VALUES(@fingerprint,@service,@url,@agent,@severity,@title,@state,@first_seen,@last_seen,@resolved_at,@occurrences,@evidence)
 ON CONFLICT(fingerprint) DO UPDATE SET severity=excluded.severity,title=excluded.title,state=excluded.state,last_seen=excluded.last_seen,resolved_at=NULL,occurrences=excluded.occurrences,evidence=excluded.evidence`);
 const event=db.prepare('INSERT INTO issue_events(fingerprint,run_id,event,occurred_at,detail) VALUES(?,?,?,?,?)');
 const transaction=db.transaction(()=>{
  for(const item of findings.filter(x=>x.status==='confirmed'||x.status.startsWith('Known Issue'))){
   let detailKey='';if(item.title.startsWith('Accessibility: ')&&item.evidence){try{const parsed=JSON.parse(item.evidence) as {selectors?:string[]};detailKey=(parsed.selectors??[]).slice().sort().join('|');}catch{detailKey=item.evidence}}
   const fingerprint=createHash('sha256').update([item.service,item.url,item.agent,item.title.trim().toLowerCase(),detailKey].join('|')).digest('hex');current.add(fingerprint);
   const previous=find.get(fingerprint) as {state:string;occurrences:number}|undefined;
   const known=item.status.startsWith('Known Issue');const state=known?'Known Issue':!previous?'New':previous.state==='Resolved'?'Recurred':'Existing';
   put.run({fingerprint,service:item.service,url:item.url,agent:item.agent,severity:item.severity,title:item.title,state,first_seen:now,last_seen:now,resolved_at:null,occurrences:(previous?.occurrences??0)+1,evidence:item.evidence??item.description});
   if(!previous||state!=='Existing')event.run(fingerprint,runId,state,now,JSON.stringify({severity:item.severity,status:item.status}));
  }
  if(checkedUrls.length&&agents.length){
   const checked=new Set(checkedUrls);
   const open=db.prepare("SELECT fingerprint,url,agent,state FROM issue_registry WHERE state NOT IN ('Resolved','Known Issue')").all() as Array<{fingerprint:string;url:string;agent:string;state:string}>;
   for(const item of open)if(checked.has(item.url)&&agents.includes(item.agent)&&!current.has(item.fingerprint)){
    db.prepare("UPDATE issue_registry SET state='Resolved',resolved_at=?,last_seen=? WHERE fingerprint=?").run(now,now,item.fingerprint);
    event.run(item.fingerprint,runId,'Resolved',now,'Issue not reproduced on a checked URL by the same agent.');
   }
  }
 });transaction();db.close();
}
