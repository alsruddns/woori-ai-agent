import{afterEach,describe,expect,it}from'vitest';
import fs from'node:fs';
import os from'node:os';
import path from'node:path';
import{recordIssueLifecycle}from'../apps/cli/src/issue-tracker.js';
import{initDb,type Finding}from'../apps/cli/src/core.js';

const original=process.cwd();let temporary='';
afterEach(()=>{process.chdir(original);if(temporary)fs.rmSync(temporary,{recursive:true,force:true});temporary='';});
describe('issue lifecycle registry',()=>{
 it('retains locale and evidence, resolves only after a checked repro attempt, and records recurrence',()=>{
  temporary=fs.mkdtempSync(path.join(os.tmpdir(),'woori-issues-'));process.chdir(temporary);
  const finding:Finding={id:'one',runId:'one',service:'quiz',url:'https://www.woori.today/de/quiz',locale:'de',agent:'qa',severity:'Medium',status:'Known Issue (quiz-lang)',title:'Document language mismatch',description:'Route and document language differ.',evidence:'html lang=ko'};
  recordIssueLifecycle('run-1',[finding,{...finding,id:'duplicate-location',url:'https://www.woori.today/de/quiz/category'}],[],['qa']);
  let db=initDb();let row=db.prepare('SELECT * FROM issue_registry').get() as any;expect(row.state).toBe('Known Issue');expect(row.locale).toBe('de');expect(row.confidence).toBe('Confirmed');expect(row.occurrences).toBe(1);db.close();
  recordIssueLifecycle('run-2',[],[finding.url],['qa']);db=initDb();row=db.prepare('SELECT * FROM issue_registry').get() as any;expect(row.state).toBe('Resolved');expect(row.resolved_at).toBeTruthy();db.close();
  recordIssueLifecycle('run-3',[{...finding,id:'three'}],[],['qa']);db=initDb();row=db.prepare('SELECT * FROM issue_registry').get() as any;expect(row.state).toBe('Recurred');expect(row.occurrences).toBe(2);expect(db.prepare('SELECT event FROM issue_events ORDER BY id').all().map((x:any)=>x.event)).toEqual(['Known Issue','Resolved','Recurred']);db.close();
 });
 it('records uncertain findings separately from confirmed issues',()=>{
  temporary=fs.mkdtempSync(path.join(os.tmpdir(),'woori-issues-'));process.chdir(temporary);
  const finding:Finding={id:'suspected',service:'docs',url:'https://www.woori.today/ko/docs/x',locale:'ko',agent:'qa',severity:'Low',status:'suspected',title:'Possible content issue',description:'Needs review'};
  recordIssueLifecycle('run-1',[finding],[],['qa']);const db=initDb();const row=db.prepare('SELECT state,confidence FROM issue_registry').get() as any;expect(row).toEqual({state:'Suspected',confidence:'Suspected'});db.close();
 });
});
